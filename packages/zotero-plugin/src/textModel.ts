// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

/**
 * Text selection over the helper's per-page text geometry. Pure, unit-tested.
 *
 * A page's text is a list of lines in reading order; each line carries its box and the x position of every
 * character boundary, so a selection is just a pair of (page, line, char) positions and everything else
 * (highlight rectangles, copied text, annotation geometry) is derived from it. Characters are counted by
 * Unicode code point, matching the helper (a code point is one `char` in Rust).
 */

import type { Rect, TextLineData } from "./protocol.ts";

export interface PageText {
  lines: TextLineData[];
}

/** A caret position: between characters `ch-1` and `ch` of line `line` on `page`. */
export interface TextPos {
  page: number;
  line: number;
  ch: number;
}

export const codePoints = (s: string): string[] => Array.from(s);

export function comparePos(a: TextPos, b: TextPos): number {
  return a.page - b.page || a.line - b.line || a.ch - b.ch;
}

export function ordered(a: TextPos, b: TextPos): [TextPos, TextPos] {
  return comparePos(a, b) <= 0 ? [a, b] : [b, a];
}

/** Caret index in `line` nearest to x (page space). */
function nearestBoundary(xs: number[], x: number): number {
  if (xs.length === 0) return 0;
  if (x <= xs[0]!) return 0;
  const last = xs.length - 1;
  if (x >= xs[last]!) return last;
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= x) lo = mid;
    else hi = mid;
  }
  return x - xs[lo]! < xs[hi]! - x ? lo : hi;
}

export interface HitOptions {
  /** If the nearest line is farther than this many points (vertically), return null. Default: unlimited. */
  maxDistance?: number;
}

/** The line and caret nearest to a point in page space. */
export function hitTest(text: PageText, page: number, x: number, y: number, opts: HitOptions = {}): TextPos | null {
  let best = -1;
  let bestDist = Infinity;
  let bestInside = false;
  text.lines.forEach((l, i) => {
    const [bx, by, bw, bh] = l.b;
    const dy = y < by ? by - y : y > by + bh ? y - (by + bh) : 0;
    const inside = x >= bx && x <= bx + bw;
    // among lines at the same vertical distance (stacked columns), prefer the one the pointer is over
    if (dy < bestDist - 1e-6 || (Math.abs(dy - bestDist) < 1e-6 && inside && !bestInside)) {
      best = i;
      bestDist = dy;
      bestInside = inside;
    }
  });
  if (best < 0 || bestDist > (opts.maxDistance ?? Infinity)) return null;
  return { page, line: best, ch: nearestBoundary(text.lines[best]!.x, x) };
}

const isWordChar = (c: string): boolean => /[\p{L}\p{N}_]/u.test(c);

/** The `[from, to)` character range of the word under a caret (a single punctuation mark/space if not on a word). */
export function wordRange(line: TextLineData, ch: number): [number, number] {
  const chars = codePoints(line.t);
  if (chars.length === 0) return [0, 0];
  let i = Math.min(Math.max(ch, 0), chars.length - 1);
  // a caret at the end of a word belongs to that word
  if (i > 0 && !isWordChar(chars[i]!) && isWordChar(chars[i - 1]!)) i--;
  if (!isWordChar(chars[i]!)) return [i, i + 1];
  let from = i;
  let to = i + 1;
  while (from > 0 && isWordChar(chars[from - 1]!)) from--;
  while (to < chars.length && isWordChar(chars[to]!)) to++;
  return [from, to];
}

/** `[x, y, w, h]` of characters `[c0, c1)` of a line. */
function segmentRect(line: TextLineData, c0: number, c1: number): Rect | null {
  const xs = line.x;
  if (c1 <= c0 || xs.length === 0) return null;
  const x0 = xs[Math.min(c0, xs.length - 1)]!;
  const x1 = xs[Math.min(c1, xs.length - 1)]!;
  if (x1 <= x0) return null;
  return [x0, line.b[1], x1 - x0, line.b[3]];
}

/** Per page, the line-segment rectangles covered by the selection `[start, end)` (page space). */
export function selectionRects(texts: Map<number, PageText>, a: TextPos, b: TextPos): Map<number, Rect[]> {
  const [s, e] = ordered(a, b);
  const out = new Map<number, Rect[]>();
  for (let page = s.page; page <= e.page; page++) {
    const t = texts.get(page);
    if (!t) continue;
    const firstLine = page === s.page ? s.line : 0;
    const lastLine = page === e.page ? e.line : t.lines.length - 1;
    const rects: Rect[] = [];
    for (let li = firstLine; li <= lastLine && li < t.lines.length; li++) {
      const line = t.lines[li]!;
      const n = codePoints(line.t).length;
      const c0 = page === s.page && li === s.line ? s.ch : 0;
      const c1 = page === e.page && li === e.line ? e.ch : n;
      const r = segmentRect(line, c0, c1);
      if (r) rects.push(r);
    }
    if (rects.length) out.set(page, rects);
  }
  return out;
}

/** Index of the first character of the selection on its first page, for annotation sort order. */
export function charOffsetOnPage(text: PageText, pos: TextPos): number {
  let n = 0;
  for (let i = 0; i < pos.line && i < text.lines.length; i++) n += codePoints(text.lines[i]!.t).length;
  return n + pos.ch;
}

/**
 * The text of a selection as a reader expects to paste it: lines of a paragraph joined with spaces,
 * words broken by a hyphen at the end of a line re-joined, and a newline where the vertical gap is
 * larger than a normal line spacing (a paragraph break).
 */
export function selectionText(texts: Map<number, PageText>, a: TextPos, b: TextPos): string {
  const [s, e] = ordered(a, b);
  let out = "";
  let prev: { line: TextLineData; text: string } | null = null;
  for (let page = s.page; page <= e.page; page++) {
    const t = texts.get(page);
    if (!t) continue;
    const firstLine = page === s.page ? s.line : 0;
    const lastLine = page === e.page ? e.line : t.lines.length - 1;
    for (let li = firstLine; li <= lastLine && li < t.lines.length; li++) {
      const line = t.lines[li]!;
      const chars = codePoints(line.t);
      const c0 = page === s.page && li === s.line ? s.ch : 0;
      const c1 = page === e.page && li === e.line ? e.ch : chars.length;
      const piece = chars.slice(c0, c1).join("");
      if (piece.length === 0) continue;
      if (prev === null) {
        out = piece;
      } else if (/[A-Za-z\p{L}]-$/u.test(prev.text) && /^\p{Ll}/u.test(piece.trimStart())) {
        out = out.slice(0, -1) + piece.trimStart(); // "inter-" + "national" -> "international"
      } else {
        const gap = line.b[1] - (prev.line.b[1] + prev.line.b[3]);
        const sep = gap > Math.max(prev.line.b[3], line.b[3]) * 0.9 || line.b[1] < prev.line.b[1] ? "\n" : " ";
        out += (sep === " " && /\s$/.test(out) ? "" : sep) + piece.trimStart();
      }
      prev = { line, text: piece };
    }
  }
  return out.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").trim();
}
