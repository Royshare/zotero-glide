// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

/**
 * Wire protocol between the reader *tab* and `glide-helper --serve` (authoritative description:
 * packages/reader-helper/src/serve.rs; design: docs/adr/002 and 003). Newline-delimited JSON over the
 * helper's stdin/stdout. Pure -- no Zotero APIs -- so it is unit-tested directly.
 *
 * The helper is stateless per request: this side decides which pages to show at what scale, and asks for
 * exactly those. Coordinates named "page space" are points, origin top-left, y down, after the page's own
 * /Rotate and CropBox; "PDF space" is origin bottom-left, y up (what Zotero stores).
 */

/** [x, y, w, h] */
export type Rect = [number, number, number, number];
/** [a, b, c, d, e, f]: x' = a*x + c*y + e, y' = b*x + d*y + f */
export type Matrix = [number, number, number, number, number, number];

export interface PageInfo {
  w: number;
  h: number;
  /** PDF space -> page space */
  m: Matrix;
}

export type Rotation = 0 | 90 | 180 | 270;

export interface ExportAnnotation {
  page: number;
  kind: "highlight" | "underline" | "note";
  rects: Rect[];
  color: [number, number, number];
  contents: string;
}

export type HelperCommand =
  | { cmd: "render"; id: number; page: number; scale: number; rotate: Rotation; clip: Rect | null }
  | { cmd: "text"; page: number }
  | { cmd: "search"; query: string }
  | { cmd: "outline" }
  | { cmd: "links"; page: number }
  | { cmd: "images"; page: number }
  | { cmd: "annots"; page: number }
  | { cmd: "margins" }
  | { cmd: "export"; path: string; annotations: ExportAnnotation[] }
  | { cmd: "trim" }
  | { cmd: "quit" };

export interface FrameEvent {
  event: "frame";
  id: number;
  page: number;
  scale: number;
  /** Raw opaque RGBA8, `width*height*4` bytes. The host reads it, then deletes it. */
  path: string;
  width: number;
  height: number;
}

export interface TextLineData {
  /** line box, page space */
  b: Rect;
  t: string;
  /** `t.length + 1`-ish boundaries: char i spans x[i]..x[i+1]. (Indexed by code point, see textModel.) */
  x: number[];
  /** superscript digit runs (citation markers) as [from, to) code-point ranges; absent from older helpers */
  s?: Array<[number, number]>;
}

export interface OutlineNode {
  t: string;
  p: number | null;
  u: string | null;
  c: OutlineNode[];
}

export interface LinkData {
  r: Rect;
  p: number | null;
  u: string | null;
  /** where on the destination page it points, [left, top] in PDF space; absent from older helpers */
  d?: [number, number] | null;
}

export type HelperEvent =
  | { event: "ready"; pageCount: number; pages: PageInfo[] }
  | FrameEvent
  | { event: "skipped"; id: number }
  | { event: "text"; page: number; lines: TextLineData[] }
  | { event: "search"; query: string; hits: Array<{ page: number; rects: Rect[] }>; truncated: boolean }
  | { event: "outline"; items: OutlineNode[] }
  | { event: "links"; page: number; links: LinkData[] }
  /** where raster images are painted, page space; dark mode leaves them alone */
  | { event: "images"; page: number; rects: Rect[] }
  /** annotations stored inside the PDF file: kind, page-space rects, color (0..1 rgb), contents, author, text under it */
  | { event: "annots"; page: number; items: Array<{ k: string; r: Rect[]; c: [number, number, number] | null; t: string; a: string; x: string }> }
  | { event: "margins"; insets: [number, number, number, number] | null }
  | { event: "exported"; path: string; count: number }
  | { event: "error"; message: string; cmd?: string };

const KNOWN = new Set(["ready", "frame", "skipped", "text", "search", "outline", "links", "images", "annots", "margins", "exported", "error"]);

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
  return typeof ev === "string" && KNOWN.has(ev) ? (value as HelperEvent) : null;
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
