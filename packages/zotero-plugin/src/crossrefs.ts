// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

/**
 * In-text references to the document's own figures, tables and equations ("Fig. 3", "Table 2", "Eq. (5)"),
 * the places they point to (caption lines, equation numbers) and the page region worth previewing. Pure.
 */

import { isEquationNumber, pageStream } from "./citations.ts";
import type { PageText } from "./textModel.ts";
import type { Rect } from "./protocol.ts";

export type RefKind = "fig" | "table" | "eq";

export interface CrossRef {
  kind: RefKind;
  n: number;
  /** "3", "3a": what follows the number, if a letter */
  sub: string;
  rects: Rect[];
  key: string;
  /** a bare "(5)" in running text: an equation if the document has one numbered 5, otherwise maybe a citation */
  bare?: boolean;
}

export interface Target {
  kind: RefKind;
  n: number;
  page: number;
  /** the preview region, page space */
  rect: Rect;
  /** where to scroll to (top of the region) */
  y: number;
  label: string;
}

const KIND_OF = (w: string): RefKind => (/^fig/i.test(w) ? "fig" : /^tab/i.test(w) ? "table" : "eq");
const WORD = "(Figs?\\.?|Figures?|FIGS?\\.?|FIGURES?|Tables?|TABLES?|Eqs?\\.?|Equations?)";
const REF_RE = new RegExp(`\\b${WORD}\\s*\\(?\\s*(\\d{1,3})([a-z])?(?![\\w.]*\\d)\\)?`, "g");

/** Cross-references in a page's text ("see Fig. 3b", "Table 2", "Eq. (5)"). */
export function findCrossRefs(text: PageText): CrossRef[] {
  const ps = pageStream(text);
  const out: CrossRef[] = [];
  const used: Array<[number, number]> = [];
  for (let m = REF_RE.exec(ps.stream); m; m = REF_RE.exec(ps.stream)) {
    // a caption itself ("Fig. 3. Results...") starts its line: it is the target, not a reference
    const li = ps.lineOf[m.index]!;
    if (ps.idxOf[m.index] === 0 && /^[A-Za-z]+\.?\s*\(?\d+[a-z]?\)?\s*[.:|]/.test(text.lines[li]!.t.trim())) continue;
    const rects = ps.rectsFor(m.index, m.index + m[0].length);
    used.push([m.index, m.index + m[0].length]);
    if (rects.length) out.push({ kind: KIND_OF(m[1]!), n: Number(m[2]), sub: m[3] ?? "", rects, key: `x${m.index}` });
  }
  // a bare "(5)" inside a sentence ("from (5) we get", "Eqs. (3) and (4)"); the equation's own number at a line end is not one
  const bare = /\((\d{1,3})([a-z])?\)/g;
  for (let m = bare.exec(ps.stream); m; m = bare.exec(ps.stream)) {
    const before = ps.stream.slice(Math.max(0, m.index - 14), m.index);
    if (m.index < 3 || /(?:Figs?|Figures?|Tables?|Sec|Section|Ref)\.?\s*$/i.test(before) || /[=+*/<>−-]\s*$/.test(before)) continue;
    if (/\w\s*$/.test(before) && !/(?:\b(?:Eqs?|Equations?|and|or|to|in|by|of|from|using|via|see|with|into|Eq)\.?|[,;])\s*$/i.test(before)) continue; // "word(5)": a footnote-like marker or a function call
    if (used.some(([a, b]) => m!.index < b && m!.index + m![0].length > a)) continue; // already found as "Eq. (5)"
    if (isEquationNumber(text, ps, m.index, m.index + m[0].length)) continue;
    const rects = ps.rectsFor(m.index, m.index + m[0].length);
    if (rects.length) out.push({ kind: "eq", n: Number(m[1]), sub: m[2] ?? "", rects, key: `b${m.index}`, bare: true });
  }
  return out;
}

const CAPTION = /^(?:fig(?:ure)?s?|table)\.?\s*(\d{1,3})\s*[.:|\-–—]?(?:\s|$)/i;

interface Caption {
  kind: RefKind;
  n: number;
  page: number;
  line: number;
}

/** Caption lines ("Fig. 3. ...", "Table 2: ...") of every page, by kind and number (first one wins). */
export function indexCaptions(pages: Array<{ page: number; text: PageText }>): Map<string, Caption> {
  const out = new Map<string, Caption>();
  for (const { page, text } of pages) {
    text.lines.forEach((l, line) => {
      const m = CAPTION.exec(l.t.trim());
      if (!m) return;
      const kind: RefKind = /^tab/i.test(l.t.trim()) ? "table" : "fig";
      const key = `${kind}${Number(m[1])}`;
      if (!out.has(key)) out.set(key, { kind, n: Number(m[1]), page, line });
    });
  }
  return out;
}

const isBody = (t: string): boolean => t.trim().length > 55;

/**
 * The region to preview for a figure or table caption: figures lie above their caption, tables below it
 * (and the caption is included). The region stops at the first line of running text and stays in the
 * caption's column.
 */
export function captionRegion(text: PageText, line: number, pageW: number, pageH: number, kind: RefKind): Rect {
  const cap = text.lines[line]!;
  const full = cap.b[2] > pageW * 0.6;
  const mid = pageW / 2;
  const [cx0, cx1] = full ? [0, pageW] : cap.b[0] < mid - 10 ? [0, mid + 4] : [mid - 4, pageW];
  const inCol = (l: { b: Rect }) => l.b[0] + l.b[2] / 2 >= cx0 && l.b[0] + l.b[2] / 2 <= cx1;
  const capEnd = (() => {
    // the caption's own lines: the ones that follow it closely
    let end = cap.b[1] + cap.b[3];
    for (let i = line + 1; i < text.lines.length; i++) {
      const l = text.lines[i]!;
      if (!inCol(l) || l.b[1] - end > cap.b[3] * 0.9 || l.b[1] < cap.b[1]) break;
      end = l.b[1] + l.b[3];
    }
    return end;
  })();
  const above = kind !== "table";
  let top: number;
  let bottom: number;
  if (above) {
    let edge = Math.max(0, cap.b[1] - 330);
    for (const l of text.lines) {
      if (!inCol(l) || l.b[1] + l.b[3] > cap.b[1] - 1) continue;
      if (isBody(l.t) && l.b[1] + l.b[3] > edge) edge = l.b[1] + l.b[3];
    }
    top = edge + 2;
    bottom = capEnd + 2;
    if (bottom - top < cap.b[3] * 4) top = Math.max(0, bottom - cap.b[3] * 10); // a figure with no text before it: show some of the page
  } else {
    top = cap.b[1] - 2;
    let edge = Math.min(pageH, capEnd + 330);
    for (const l of text.lines) {
      if (!inCol(l) || l.b[1] < capEnd + 2) continue;
      if (isBody(l.t) && l.b[1] < edge) edge = l.b[1];
    }
    bottom = edge - 1;
    if (bottom - top < cap.b[3] * 4) bottom = Math.min(pageH, top + cap.b[3] * 10);
  }
  const x0 = Math.max(0, cx0 + (cx0 === 0 ? 8 : 0));
  const x1 = Math.min(pageW, cx1 - (cx1 === pageW ? 8 : 0));
  return [x0, Math.max(0, top), Math.max(10, x1 - x0), Math.max(10, Math.min(pageH, bottom) - Math.max(0, top))];
}

/** Lines that carry an equation number "(5)" at their right end. */
export function equationLines(text: PageText, n: number): number[] {
  const re = new RegExp(`\\(\\s*${n}\\s*\\)\\s*$`);
  const out: number[] = [];
  text.lines.forEach((l, i) => {
    const t = l.t.trim();
    if (!re.test(t)) return;
    const before = t.replace(re, "").trim();
    if (before === "" || !/[a-z]{4,}\s*$/.test(before)) out.push(i); // alone, or not the end of a sentence
  });
  return out;
}

/** The band around an equation line, widened to the lines on either side that belong to the same display. */
export function equationRegion(text: PageText, line: number, pageW: number, pageH: number): Rect {
  const l = text.lines[line]!;
  let top = l.b[1];
  let bottom = l.b[1] + l.b[3];
  const near = (a: number, b: number) => Math.abs(a - b) < l.b[3] * 1.4;
  // stacked fractions, sub- and superscript lines above/below that are short
  for (const o of text.lines) {
    if (o === l || isBody(o.t)) continue;
    if (near(o.b[1] + o.b[3], top) && o.b[1] < top) top = o.b[1];
    if (near(o.b[1], bottom) && o.b[1] + o.b[3] > bottom) bottom = o.b[1] + o.b[3];
  }
  top = Math.max(0, top - 6);
  bottom = Math.min(pageH, bottom + 6);
  const x0 = Math.max(0, Math.min(l.b[0], pageW * 0.12) - 6);
  const x1 = Math.min(pageW, Math.max(l.b[0] + l.b[2], pageW * 0.9) + 6);
  return [x0, top, x1 - x0, bottom - top];
}

export const refLabel = (kind: RefKind, n: number): string => (kind === "fig" ? `Figure ${n}` : kind === "table" ? `Table ${n}` : `Equation (${n})`);
