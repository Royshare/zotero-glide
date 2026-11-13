// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

import { test } from "node:test";
import assert from "node:assert/strict";
import { HelperConnection, type HelperProcess } from "../src/helperConnection.ts";
import type { HelperEvent } from "../src/protocol.ts";

/** A controllable fake child process. */
function fakeProc() {
  const written: string[] = [];
  const chunks: Array<string | Error> = [];
  let wake: (() => void) | null = null;
  let exit: ((r: { exitCode: number }) => void) | null = null;
  const exited = new Promise<{ exitCode: number }>((r) => (exit = r));
  let stdinClosed = false;
  let killed = false;
  const proc: HelperProcess = {
    stdin: {
      write: async (d) => { written.push(d); },
      close: async () => { stdinClosed = true; },
    },
    stdout: {
      readString: async () => {
        while (chunks.length === 0) await new Promise<void>((r) => (wake = r));
        const c = chunks.shift()!;
        if (c instanceof Error) throw c;
        return c;
      },
    },
    kill: async () => { killed = true; exit?.({ exitCode: -9 }); },
    wait: () => exited,
  };
  return {
    proc, written,
    feed: (c: string | Error) => { chunks.push(c); wake?.(); },
    exit: (code: number) => exit?.({ exitCode: code }),
    get stdinClosed() { return stdinClosed; },
    get killed() { return killed; },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("emits events for complete lines even when chunked, ignoring garbage", async () => {
  const f = fakeProc();
  const events: HelperEvent[] = [];
  const c = new HelperConnection(f.proc, { onEvent: (e) => events.push(e), onExit: () => {} });
  c.start();
  f.feed('{"event":"ready","pageC');
  f.feed('ount":3}\ngarbage\n{"event":"error","message":"m"}\n');
  await tick(); await tick();
  assert.deepEqual(events.map((e) => e.event), ["ready", "error"]);
});

test("sends are written in order, one JSON line each", async () => {
  const f = fakeProc();
  const c = new HelperConnection(f.proc, { onEvent: () => {}, onExit: () => {} });
  c.start();
  await Promise.all([c.send({ cmd: "outline" }), c.send({ cmd: "text", page: 2 }), c.send({ cmd: "margins" })]);
  assert.deepEqual(f.written, ['{"cmd":"outline"}\n', '{"cmd":"text","page":2}\n', '{"cmd":"margins"}\n']);
});

test("an unexpected exit is reported as not requested", async () => {
  const f = fakeProc();
  const exits: Array<[number, boolean]> = [];
  const c = new HelperConnection(f.proc, { onEvent: () => {}, onExit: (code, req) => exits.push([code, req]) });
  c.start();
  await tick();
  f.exit(101);
  await tick();
  assert.deepEqual(exits, [[101, false]]);
});

test("close() sends quit, closes stdin, and does not kill a helper that exits promptly", async () => {
  const f = fakeProc();
  const exits: Array<[number, boolean]> = [];
  const c = new HelperConnection(f.proc, { onEvent: () => {}, onExit: (code, req) => exits.push([code, req]) }, () => new Promise(() => {}));
  c.start();
  await tick();
  const closing = c.close();
  await tick();
  f.exit(0);
  await closing;
  assert.deepEqual(f.written, ['{"cmd":"quit"}\n']);
  assert.equal(f.stdinClosed, true);
  assert.equal(f.killed, false);
  assert.deepEqual(exits, [[0, true]]);
});

test("close() kills a helper that ignores quit after the grace period", async () => {
  const f = fakeProc();
  const c = new HelperConnection(f.proc, { onEvent: () => {}, onExit: () => {} }, async () => {});
  c.start();
  await tick();
  await c.close();
  assert.equal(f.killed, true);
});

test("send after close is a silent no-op, and close is idempotent", async () => {
  const f = fakeProc();
  const c = new HelperConnection(f.proc, { onEvent: () => {}, onExit: () => {} }, async () => {});
  c.start();
  await tick();
  await c.close();
  await c.send({ cmd: "outline" });
  await c.close();
  assert.deepEqual(f.written, ['{"cmd":"quit"}\n']);
});

test("a read error ends the loop quietly instead of throwing", async () => {
  const f = fakeProc();
  const c = new HelperConnection(f.proc, { onEvent: () => {}, onExit: () => {} });
  c.start();
  f.feed(new Error("pipe closed"));
  await tick();
});

test("non-event lines (e.g. the helper's stderr text) go to onOutput", async () => {
  const f = fakeProc();
  const out: string[] = [];
  const c = new HelperConnection(f.proc, { onEvent: () => {}, onExit: () => {}, onOutput: (l) => out.push(l) });
  c.start();
  f.feed("[glide] failed to open document: broken\n");
  await tick(); await tick();
  assert.deepEqual(out, ["[glide] failed to open document: broken"]);
});
