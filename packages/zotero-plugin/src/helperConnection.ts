// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

/**
 * Owns one `glide-helper --serve` child process for one reader tab:
 * serialized command writes, an incremental stdout read loop that turns
 * lines into events, and a bounded shutdown (polite `quit`, then kill).
 * The process type is injected (Subprocess.sys.mjs in Zotero, a fake in
 * tests), so none of this needs Zotero.
 */

import { encodeCommand, LineSplitter, parseEvent, type HelperCommand, type HelperEvent } from "./protocol.ts";

export interface HelperProcess {
  stdin: { write(data: string): Promise<unknown>; close(): Promise<unknown> | void };
  stdout: { readString(): Promise<string> };
  kill(timeoutMs?: number): Promise<unknown> | void;
  wait(): Promise<{ exitCode: number }>;
}

export interface HelperConnectionHandlers {
  onEvent(event: HelperEvent): void;
  /** Optional: stdout/stderr lines that aren't protocol events (the helper's own error text, debug logs). */
  onOutput?(line: string): void;
  /** Fired once when the process is gone, whether we asked for it or not. */
  onExit(exitCode: number, requested: boolean): void;
}

export class HelperConnection {
  private closed = false;
  private writeChain: Promise<unknown> = Promise.resolve();
  private readonly splitter = new LineSplitter();

  private readonly proc: HelperProcess;
  private readonly handlers: HelperConnectionHandlers;
  private readonly sleep: (ms: number) => Promise<void>;

  // Explicit fields, not constructor parameter properties: Node's
  // type-stripping test runner doesn't support the latter.
  constructor(
    proc: HelperProcess,
    handlers: HelperConnectionHandlers,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
  ) {
    this.proc = proc;
    this.handlers = handlers;
    this.sleep = sleep;
  }

  /** Starts the read loop and the exit watcher. Call once. */
  start(): void {
    void this.readLoop();
    void this.proc.wait().then(
      (r) => this.handlers.onExit(r.exitCode, this.closed),
      () => this.handlers.onExit(-1, this.closed)
    );
  }

  private async readLoop(): Promise<void> {
    for (;;) {
      let chunk: string;
      try {
        chunk = await this.proc.stdout.readString();
      } catch {
        return; // pipe closed under us
      }
      if (chunk === "") return; // EOF
      for (const line of this.splitter.push(chunk)) {
        const ev = parseEvent(line);
        if (ev) this.handlers.onEvent(ev);
        else this.handlers.onOutput?.(line);
      }
    }
  }

  /** Writes are chained so concurrent sends can never interleave on the pipe. No-op once closed. */
  send(command: HelperCommand): Promise<void> {
    if (this.closed) return Promise.resolve();
    const data = encodeCommand(command);
    const next = this.writeChain.then(() => this.proc.stdin.write(data)).then(
      () => undefined,
      () => undefined // helper already gone; onExit reports it
    );
    this.writeChain = next;
    return next;
  }

  /** Asks the helper to quit; kills it if it hasn't gone within `graceMs`. */
  async close(graceMs = 1000): Promise<void> {
    if (this.closed) return;
    // Send quit *before* flagging closed (send() is a no-op afterwards).
    const quit = this.send({ cmd: "quit" });
    this.closed = true;
    await quit;
    try {
      await this.proc.stdin.close();
    } catch {
      /* already closed */
    }
    const exited = await Promise.race([this.proc.wait().then(() => true), this.sleep(graceMs).then(() => false)]);
    if (!exited) {
      try {
        await this.proc.kill(0);
      } catch {
        /* gone */
      }
    }
  }
}
