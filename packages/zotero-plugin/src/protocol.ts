/**
 * Wire protocol between the reader *tab* and `fast-reader-helper --serve`
 * (see packages/reader-helper/src/serve.rs for the authoritative
 * description, and docs/adr/002-in-tab-reader.md). Newline-delimited JSON
 * over the helper's stdin/stdout. Pure -- no Zotero APIs -- so it is
 * unit-tested directly.
 */

export type HelperCommand =
  | { cmd: "viewport"; width: number; height: number; dpr: number }
  | { cmd: "goto"; page: number } // 1-indexed
  | { cmd: "next" }
  | { cmd: "prev" }
  | { cmd: "zoom"; factor: number }
  | { cmd: "fit"; mode: "width" | "page" }
  | { cmd: "search"; query: string }
  | { cmd: "search_next"; query: string; backwards: boolean }
  | { cmd: "clear_search" }
  | { cmd: "trim" }
  | { cmd: "resume" }
  | { cmd: "quit" };

export interface FrameEvent {
  event: "frame";
  seq: number;
  /** Raw opaque RGBA8 of the whole page, `width*height*4` bytes. Host reads, then deletes it. */
  path: string;
  width: number;
  height: number;
  page: number; // 1-indexed
  pageCount: number;
  zoomPct: number;
  zoomMode: "width" | "page" | "fixed";
  /** [x, y, w, h] in frame pixels, for the current page only. */
  highlights: Array<[number, number, number, number]>;
  search: { pages: number; total: number; index: number };
}

export type HelperEvent =
  | { event: "ready"; pageCount: number }
  | FrameEvent
  | { event: "error"; message: string };

export function encodeCommand(command: HelperCommand): string {
  return JSON.stringify(command) + "\n";
}

/** Parses one stdout line; returns null (never throws) for anything that isn't a known event. */
export function parseEvent(line: string): HelperEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const ev = (value as { event?: unknown }).event;
  if (ev === "ready" || ev === "frame" || ev === "error") return value as HelperEvent;
  return null;
}

/**
 * Reassembles newline-delimited lines from arbitrarily chunked pipe reads
 * (a read can end mid-line, or carry several lines at once).
 */
export class LineSplitter {
  private rest = "";

  push(chunk: string): string[] {
    this.rest += chunk;
    const parts = this.rest.split("\n");
    this.rest = parts.pop() ?? "";
    return parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l)).filter((l) => l.length > 0);
  }
}
