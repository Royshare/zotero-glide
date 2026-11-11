// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

/**
 * Numbered citations ("...bacteria,7,10,11", "[3, 5-7]") and the reference list they point to. Pure,
 * unit-tested. Superscript markers come from the helper (`TextLineData.s`); bracketed ones are found in the
 * text. The reference list is the numbered entries after a "References" heading: each starts with its number
 * at the start of a line and continues on the lines that follow, up to the next number in sequence.
 */

import { codePoints, type PageText } from "./textModel.ts";
import type { Rect, TextLineData } from "./protocol.ts";

export interface Citation {
  line: number;
  /** [from, to) code-point range in the line */
  from: number;
  to: number;
  nums: number[];
}

export interface RefEntry {
  n: number;
  page: number;
  /** top of the entry's first line, page space */
  y: number;
  text: string;
}

const MAX_NUM = 999;

/** "7", "7,10,11", "7-9", "1–3, 5" -> [7], [7,10,11], [7,8,9], [1,2,3,5]; null if it isn't a plain list of numbers. */
export function parseNumberList(s: string): number[] | null {
  const parts = s.replace(/[ \s]/g, "").split(",");
  const out: number[] = [];
  for (const part of parts) {
    const m = /^(\d{1,3})(?:[-–−](\d{1,3}))?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (b < a || b - a > 60 || a < 1 || b > MAX_NUM) return null;
    for (let n = a; n <= b; n++) out.push(n);
  }
  return out.length ? out : null;
}

/** Citation markers in one line: the helper's superscript runs, and `[12]`-style brackets. */
export function citationsInLine(line: TextLineData, lineIndex: number): Citation[] {
  const chars = codePoints(line.t);
  const out: Citation[] = [];
  for (const [from, to] of line.s ?? []) {
    const nums = parseNumberList(chars.slice(from, to).join(""));
    if (nums) out.push({ line: lineIndex, from, to, nums });
  }
  const re = /\[(\d[\d,\s \-–−]*)\]/g;
  const text = chars.join("");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const nums = parseNumberList(m[1]!);
    if (!nums) continue;
    const from = codePoints(text.slice(0, m.index)).length;
    out.push({ line: lineIndex, from, to: from + codePoints(m[0]).length, nums });
  }
  return out;
}

/** Page-space rectangle of a citation marker. */
export function citationRect(line: TextLineData, c: Citation): Rect | null {
  const xs = line.x;
  if (!xs.length) return null;
  const x0 = xs[Math.min(c.from, xs.length - 1)]!;
  const x1 = xs[Math.min(c.to, xs.length - 1)]!;
  return x1 > x0 ? [x0, line.b[1], x1 - x0, line.b[3]] : null;
}

const HEADING = /^(references|bibliography|literature cited|reference list|notes and references|works cited)$/i;

/** Where the reference list starts: the last "References"-style heading, as {page, line} (pages given in order). */
export function findReferenceStart(pages: Array<{ page: number; text: PageText }>): { page: number; line: number } | null {
  let found: { page: number; line: number } | null = null;
  for (const { page, text } of pages) {
    text.lines.forEach((l, i) => {
      if (HEADING.test(l.t.trim())) found = { page, line: i };
    });
  }
  return found;
}

/** The numbered entries from `start` on. Entries must run 1, 2, 3, ... so a stray number in a title cannot split one. */
export function parseReferences(pages: Array<{ page: number; text: PageText }>, start: { page: number; line: number }): Map<number, RefEntry> {
  const out = new Map<number, RefEntry>();
  let current: RefEntry | null = null;
  let last = 0;
  for (const { page, text } of pages) {
    if (page < start.page) continue;
    text.lines.forEach((l, i) => {
      if (page === start.page && i <= start.line) return;
      const m = /^\s*\[?(\d{1,3})[\].]?\s+(\S.*)$/.exec(l.t);
      const n = m ? Number(m[1]) : 0;
      if (m && n === last + 1) {
        current = { n, page, y: l.b[1], text: m[2]!.trim() };
        out.set(n, current);
        last = n;
      } else if (current && l.b[1] < 740) {
        // continuation line (skips the page footer)
        current.text += (current.text.endsWith("-") ? "" : " ") + l.t.trim();
      }
    });
  }
  return out;
}

/** The text of a line segment-by-segment inside a page-space rectangle (what a link covers). */
export function textInRect(text: PageText, rect: Rect): string {
  const [rx, ry, rw, rh] = rect;
  let out = "";
  for (const l of text.lines) {
    if (l.b[1] + l.b[3] < ry || l.b[1] > ry + rh) continue;
    const chars = codePoints(l.t);
    for (let i = 0; i < chars.length; i++) {
      const cx = ((l.x[i] ?? 0) + (l.x[i + 1] ?? l.x[i] ?? 0)) / 2;
      if (cx >= rx && cx <= rx + rw) out += chars[i];
    }
  }
  return out.trim();
}

/** Does a link's text look like a citation ("[15]", "7-9", "Smith et al., 2010", "(2010)") rather than "Figure 3"? */
export function looksLikeCitationLabel(s: string): boolean {
  const t = s.trim();
  if (!t || t.length > 60) return false;
  if (/^\[?\s*\d[\d\s,–−-]*\]?$/.test(t)) return true;
  return /(?:\b(?:1[5-9]|20)\d{2}[a-z]?)\)?[,;\]]?$/.test(t) && !/^(fig|table|eq|section|sec|chapter)/i.test(t);
}

/**
 * The reference entry that starts at (about) `y` on a page: its first line is the one nearest `y`, and it runs
 * until the next entry starts -- a line with the same numbering style, or (for hanging indents) one back at the
 * entry's left edge.
 */
export function referenceAt(text: PageText, y: number): string | null {
  const lines = text.lines;
  let first = -1;
  let best = Infinity;
  lines.forEach((l, i) => {
    if (l.b[1] + l.b[3] < y - 3) return;
    const d = Math.abs(l.b[1] - y);
    if (d < best) (best = d), (first = i);
  });
  if (first < 0 || best > 30) return null;
  const numbered = /^\s*\[?\d{1,3}[\].]?\s/;
  const head = lines[first]!;
  const isNum = numbered.test(head.t);
  const x0 = head.b[0];
  const parts = [head.t.trim()];
  for (let i = first + 1; i < lines.length && parts.length < 8; i++) {
    const l = lines[i]!;
    if (isNum ? numbered.test(l.t) : l.b[0] <= x0 + 1 && Math.abs(l.b[1] - lines[i - 1]!.b[1]) < 40) break;
    if (l.b[1] < head.b[1] - 1) break; // jumped back up the page (another column)
    parts.push(l.t.trim());
  }
  const joined = parts.reduce((a, p) => a + (a.endsWith("-") ? "" : " ") + p, "").trim();
  return joined.length > 700 ? joined.slice(0, 700) + "…" : joined;
}

/** The y of the entry numbered `n` ("[15] ..." or "15 ...") on a page, if the page has it. */
export function numberedEntryY(text: PageText, n: number): number | null {
  const re = new RegExp(`^\\s*\\[${n}\\]|^\\s*${n}[.\\s]\\s*\\S`);
  const hit = text.lines.find((l) => re.test(l.t));
  return hit ? hit.b[1] : null;
}

/** "15" or "[15]" -> 15 (a single number only) */
export function singleNumber(label: string): number | null {
  const m = /^\[?\s*(\d{1,3})\s*\]?$/.exec(label.trim());
  return m ? Number(m[1]) : null;
}
