// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

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

const HEADING = /^(?:\d+\.?\s*)?(?:references?(?: and notes| cited)?|bibliography|literature cited|reference list|works cited|notes and references|cited literature)\s*:?$/i;

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

/**
 * For papers with no "References" heading (APS journals): the last place where a numbered list 1, 2, 3, ... of at
 * least five entries starts. Returned as the position just before entry 1, so `parseReferences` begins there.
 */
export function findNumberedRunStart(pages: Array<{ page: number; text: PageText }>): { page: number; line: number } | null {
  const first = /^\s*[\[(]?1(?:[\]).]\s*|\s+|(?=\p{Lu}))\S/u;
  const candidates: Array<{ page: number; line: number }> = [];
  for (const { page, text } of pages) text.lines.forEach((l, i) => first.test(l.t) && candidates.push({ page, line: i - 1 }));
  for (let k = candidates.length - 1; k >= 0; k--) {
    if (parseReferences(pages, candidates[k]!).size >= 5) return candidates[k]!;
  }
  return null;
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
      const m = /^\s*[\[(]?(\d{1,3})(?:[\]).]\s*|\s+|(?=\p{Lu}))(\S.*)$/u.exec(l.t); // "1. ", "[1] ", "(1) ", "1 ", and "1P. G. Saffman" (AIP: the number is a superscript)
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

// ---------------------------------------------------------------------------------------------
// Every citation style: numeric ([1], [1,2], [1-3], (1), Ref. 3, superscript) and author-year
// ((Smith et al., 2020), (Smith and Jones 2020; Brown 2019), Smith (2020), [Smith, 2020]).
// A marker only counts when it resolves to an entry of the document's own reference list.
// ---------------------------------------------------------------------------------------------

export interface AyEntry {
  /** first author's surname, normalised (lower case, no accents) */
  surname: string;
  /** "2020" or "2020a" */
  year: string;
  page: number;
  y: number;
  text: string;
}

export interface ReferenceSet {
  mode: "num" | "ay";
  numbered: Map<number, RefEntry>;
  ay: AyEntry[];
}

export interface CiteItem {
  label: string;
  page: number;
  y: number;
  text: string;
}

export interface CiteMatch {
  /** page-space rectangles of the marker (one per line it spans) */
  rects: Rect[];
  items: CiteItem[];
  key: string;
}

const normName = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();

const PARTICLE = "(?:(?:van|von|de|der|den|del|della|da|di|la|le|el|al|bin|ibn|dos|du|ter|ten)\\s+){0,2}";
const NAME = `${PARTICLE}\\p{Lu}[\\p{L}'’\\-]*\\p{L}`;
const GROUP = `${NAME}(?:\\s+et\\s+al\\.?|(?:\\s*,\\s*${NAME})*\\s*,?\\s*(?:and|&)\\s+${NAME})?`;
const YEAR = "(?:1[5-9]|20)\\d\\d[a-z]?";
const YEARS = `${YEAR}(?:\\s*(?:,|&|and)\\s*${YEAR})*`;
const PAGES = "(?:\\s*,\\s*(?:p|pp)\\.?\\s*\\d+(?:\\s*[–-]\\s*\\d+)?)?";
const PART_RE = new RegExp(`^\\s*(?:(?:e\\.g\\.|i\\.e\\.|see(?: also)?|cf\\.|but see|also)[,.]?\\s+)?(${GROUP})\\s*,?\\s*(${YEARS})${PAGES}\\s*$`, "u");
const YEARS_ONLY_RE = new RegExp(`^\\s*(${YEARS})${PAGES}\\s*$`, "u");
const NARRATIVE_RE = new RegExp(`(${GROUP})\\s*\\(\\s*(${YEARS})${PAGES}\\s*\\)`, "gu");
const GROUPED_RE = /[(\[]([^()\[\]]{4,300})[)\]]/g;

const firstAuthor = (group: string): string => (group.split(/\s+et\s+al|\s+and\s+|\s*&\s*|,/)[0] ?? group).trim();
const yearsOf = (s: string): string[] => s.match(new RegExp(YEAR, "g")) ?? [];

/** Entries of an author-year reference list: "Smith, J. A. (2020). Title..." / "Smith AB, Jones C. Title. 2020;..." */
export function parseAuthorYearReferences(pages: Array<{ page: number; text: PageText }>, start: { page: number; line: number }): AyEntry[] {
  const startA = new RegExp(`^(${PARTICLE}\\p{Lu}[\\p{L}'’\\- ]*?),\\s*(?:\\p{Lu}\\.|\\p{Lu}\\p{Ll}+\\b)`, "u");
  const startB = new RegExp(`^(${PARTICLE}\\p{Lu}[\\p{L}'’\\-]+)\\s+\\p{Lu}{1,3}[,.\\s]`, "u");
  const startC = new RegExp(`^(?:\\p{Lu}\\.\\s*){1,3}(${NAME})\\b`, "u");
  const out: AyEntry[] = [];
  let cur: { surname: string; x: number; page: number; y: number; parts: string[] } | null = null;
  let prev = "";
  const flush = () => {
    if (!cur) return;
    const text = cur.parts.reduce((a, p) => a + (a.endsWith("-") ? "" : " ") + p, "").trim();
    const year = (/\(((?:1[5-9]|20)\d\d[a-z]?)\)/.exec(text) ?? new RegExp(`\\b(${YEAR})\\b`).exec(text))?.[1];
    if (year) out.push({ surname: cur.surname, year, page: cur.page, y: cur.y, text });
    cur = null;
  };
  for (const { page, text } of pages) {
    if (page < start.page) continue;
    text.lines.forEach((l, i) => {
      if (page === start.page && i <= start.line) return;
      const t = l.t.trim();
      if (t.length < 3 || /^\d+$/.test(t)) return;
      let m = startA.exec(t);
      if (m && /\s\p{Lu}{1,3}$/u.test(m[1]!)) m = startB.exec(t); // "Smith AB, Jones C.": initials after the surname, not part of it
      m = m ?? startB.exec(t) ?? startC.exec(t);
      const newEntry = !!m && (!cur || l.b[0] <= cur.x + 1.5 || /[.)\d]$/.test(prev));
      if (newEntry && m) {
        flush();
        cur = { surname: normName(m[1]!), x: l.b[0], page, y: l.b[1], parts: [t] };
      } else if (cur) {
        cur.parts.push(t);
      }
      prev = t;
    });
  }
  flush();
  return out;
}

/** The document's reference list in whichever form it takes. */
export function buildReferenceSet(pages: Array<{ page: number; text: PageText }>, start: { page: number; line: number }): ReferenceSet {
  const numbered = parseReferences(pages, start);
  const ay = parseAuthorYearReferences(pages, start);
  // whichever reading of the list yields more entries (stray numbers in a table must not beat a real author-year list)
  if (numbered.size >= 3 && numbered.size * 2 >= ay.length) return { mode: "num", numbered, ay: [] };
  return ay.length >= 5 ? { mode: "ay", numbered: new Map(), ay } : { mode: "num", numbered, ay: [] };
}

function lookupAy(set: ReferenceSet, author: string, year: string): AyEntry[] {
  const a = normName(author);
  if (!a) return [];
  const sameYear = (e: AyEntry) => (/[a-z]$/.test(year) ? e.year === year : e.year.slice(0, 4) === year.slice(0, 4));
  return set.ay.filter((e) => sameYear(e) && (e.surname === a || a.endsWith(" " + e.surname) || e.surname.endsWith(" " + a) || a.startsWith(e.surname + " ")));
}

export interface PageStream {
  stream: string;
  lineOf: number[];
  idxOf: number[];
  rectsFor(from: number, to: number): Rect[];
}

/** One stream of a page's text, so a marker wrapped over two lines is still found; maps stream offsets back to lines and rectangles. */
export function pageStream(text: PageText): PageStream {
  const lineOf: number[] = [];
  const idxOf: number[] = [];
  let stream = "";
  text.lines.forEach((l, li) => {
    const chars = codePoints(l.t);
    const next = text.lines[li + 1]?.t ?? "";
    chars.forEach((ch, ci) => {
      if (ch === "-" && ci === chars.length - 1 && /^[a-z]/.test(next)) return; // a word broken at the line end
      for (let k = 0; k < ch.length; k++) {
        stream += ch[k];
        lineOf.push(li);
        idxOf.push(ci);
      }
    });
    stream += " ";
    lineOf.push(li);
    idxOf.push(chars.length);
  });
  const rectsFor = (from: number, to: number): Rect[] => {
    const per = new Map<number, [number, number]>();
    for (let p = from; p < to; p++) {
      const li = lineOf[p]!, ci = idxOf[p]!;
      if (ci >= codePoints(text.lines[li]!.t).length) continue;
      const r = per.get(li);
      per.set(li, r ? [Math.min(r[0], ci), Math.max(r[1], ci)] : [ci, ci]);
    }
    const rects: Rect[] = [];
    for (const [li, [a, b]] of per) {
      const l = text.lines[li]!;
      const x0 = l.x[Math.min(a, l.x.length - 1)]!;
      const x1 = l.x[Math.min(b + 1, l.x.length - 1)]!;
      if (x1 > x0) rects.push([x0, l.b[1], x1 - x0, l.b[3]]);
    }
    return rects;
  };
  return { stream, lineOf, idxOf, rectsFor };
}

/**
 * Is the "(N)" at stream offsets [from, to) an equation number rather than a citation? Equation numbers sit
 * at the right end of their line, either alone on it or after a gap (or after maths), never inside a sentence.
 */
export function isEquationNumber(text: PageText, ps: PageStream, from: number, to: number): boolean {
  const li = ps.lineOf[from]!;
  if (ps.lineOf[to - 1] !== li) return false;
  const line = text.lines[li]!;
  const chars = codePoints(line.t);
  const a = ps.idxOf[from]!;
  const b = ps.idxOf[to - 1]!;
  if (chars.slice(b + 1).join("").trim() !== "") return false; // something follows: in running text
  const before = chars.slice(0, a).join("");
  if (before.trim() === "") return true; // "(12)" alone on its line
  if (/[=+*/<>−±∑∫∂∇≈≤≥×·]\s*[\w)\]}]*\s*$/.test(before) && !/[a-z]{3,}\s*$/.test(before)) return true; // the line ends in maths
  let k = a - 1;
  while (k > 0 && /\s/.test(chars[k]!)) k--;
  return (line.x[a] ?? 0) - (line.x[k + 1] ?? 0) > 12; // a wide gap before it: a right-aligned number
}

/** Every resolvable citation on a page, with the page-space rectangles to hit-test and the entries it points to. */
export function findPageCitations(text: PageText, set: ReferenceSet): CiteMatch[] {
  const out: CiteMatch[] = [];
  const claimed: Array<[number, number]> = []; // stream ranges already used
  const ps = pageStream(text);
  const { stream, rectsFor } = ps;
  const free = (a: number, b: number) => !claimed.some(([x, y]) => a < y && b > x);
  const add = (from: number, to: number, items: CiteItem[]) => {
    if (!items.length || !free(from, to)) return;
    const rects = rectsFor(from, to);
    if (!rects.length) return;
    claimed.push([from, to]);
    out.push({ rects, items, key: `${from}:${to}` });
  };

  if (set.mode === "num") {
    const lookup = (nums: number[]): CiteItem[] =>
      nums.flatMap((n) => {
        const e = set.numbered.get(n);
        return e ? [{ label: String(n), page: e.page, y: e.y, text: e.text }] : [];
      });
    // superscript markers (flagged by the helper) are per line
    text.lines.forEach((l, li) => {
      const chars = codePoints(l.t);
      for (const c of citationsInLine(l, li)) {
        if (chars[c.from] === "[") continue; // brackets are matched on the page stream below
        const r = citationRect(l, c);
        const items = lookup(c.nums);
        if (r && items.length) out.push({ rects: [r], items, key: `s${li}:${c.from}` });
      }
    });
    const rules: Array<[RegExp, number]> = [
      [/\[(\d[\d,;\s –−-]*)\]/g, 1],
      [/\bRefs?\.?\s*\[?(\d[\d,\s –−-]*(?:\s*(?:and|&)\s*\d+)?)\]?/g, 1],
      [/\((\d{1,3}(?:\s*[,–−-]\s*\d{1,3})*)\)/g, 1], // (1), (1,2), (1-3)
    ];
    rules.forEach(([re, grp], ri) => {
      for (let m = re.exec(stream); m; m = re.exec(stream)) {
        if (ri === 2) {
          const before = stream.slice(Math.max(0, m.index - 14), m.index);
          if (/(?:Eqs?|Equations?|Figs?|Figures?|Tables?|Sec|Section|Ref)\.?\s*$/i.test(before) || /[=+*/<>−-]\s*$/.test(before) || m.index < 3) continue;
          if (/\b(?:Eqs?|Equations?)\.?[^.;]{0,30}$/i.test(stream.slice(Math.max(0, m.index - 40), m.index))) continue; // "Eqs. (3) and (4)"
          if (/^\(\d{1,3}\)$/.test(m[0]) && isEquationNumber(text, ps, m.index, m.index + m[0].length)) continue;
        }
        const nums = parseNumberList(m[grp]!.replace(/\s*(?:and|&)\s*/g, ","));
        if (nums) add(m.index, m.index + m[0].length, lookup(nums));
      }
    });
    return out;
  }

  // author-year
  const resolve = (author: string, years: string[]): CiteItem[] =>
    years.flatMap((y) => lookupAy(set, author, y).map((e) => ({ label: `${author.replace(/\s+/g, " ")} ${y}`, page: e.page, y: e.y, text: e.text })));
  for (let m = GROUPED_RE.exec(stream); m; m = GROUPED_RE.exec(stream)) {
    const items: CiteItem[] = [];
    let author = "";
    for (const part of m[1]!.split(";")) {
      const pm = PART_RE.exec(part);
      if (pm) {
        author = firstAuthor(pm[1]!);
        items.push(...resolve(author, yearsOf(pm[2]!)));
      } else {
        const ym = YEARS_ONLY_RE.exec(part);
        if (ym && author) items.push(...resolve(author, yearsOf(ym[1]!)));
      }
    }
    add(m.index, m.index + m[0].length, dedupe(items));
  }
  for (let m = NARRATIVE_RE.exec(stream); m; m = NARRATIVE_RE.exec(stream)) {
    add(m.index, m.index + m[0].length, dedupe(resolve(firstAuthor(m[1]!), yearsOf(m[2]!))));
  }
  return out;
}

function dedupe(items: CiteItem[]): CiteItem[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(`${i.page}:${i.y}`) ? false : (seen.add(`${i.page}:${i.y}`), true)));
}
