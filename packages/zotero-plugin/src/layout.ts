// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

/**
 * Continuous-scroll layout and the coordinate transforms between page space and what is drawn.
 * Pure (no DOM), so the geometry that selection, search hits and annotations depend on is unit-tested.
 *
 * View space = page space, then optionally cropped by `insets` ([left, top, right, bottom] points),
 * then rotated clockwise by `rotation`. Sizes below are in points unless a name says `px`.
 */

import type { PageInfo, Rect, Rotation } from "./protocol.ts";

export interface ViewSettings {
  rotation: Rotation;
  /** [left, top, right, bottom] points trimmed from every page; null = no crop */
  insets: [number, number, number, number] | null;
}

export const DEFAULT_VIEW: ViewSettings = { rotation: 0, insets: null };

/** The cropped (pre-rotation) area of a page, `[x, y, w, h]` in page space. */
export function clipRect(page: PageInfo, view: ViewSettings): Rect {
  const [l, t, r, b] = view.insets ?? [0, 0, 0, 0];
  // never crop a page to nothing, even if a narrower-than-average page is in the document
  const w = Math.max(10, page.w - l - r);
  const h = Math.max(10, page.h - t - b);
  return [Math.min(l, page.w - w), Math.min(t, page.h - h), w, h];
}

/** Size of the page as displayed (after crop and rotation), in points. */
export function viewSize(page: PageInfo, view: ViewSettings): { w: number; h: number } {
  const [, , cw, ch] = clipRect(page, view);
  return view.rotation % 180 === 90 ? { w: ch, h: cw } : { w: cw, h: ch };
}

function rotatePoint(x: number, y: number, cw: number, ch: number, rot: Rotation): [number, number] {
  switch (rot) {
    case 90:
      return [ch - y, x];
    case 180:
      return [cw - x, ch - y];
    case 270:
      return [y, cw - x];
    default:
      return [x, y];
  }
}

function unrotatePoint(x: number, y: number, cw: number, ch: number, rot: Rotation): [number, number] {
  switch (rot) {
    case 90:
      return [y, ch - x];
    case 180:
      return [cw - x, ch - y];
    case 270:
      return [cw - y, x];
    default:
      return [x, y];
  }
}

/** Page-space point -> view-space point (points). */
export function pageToView(page: PageInfo, view: ViewSettings, x: number, y: number): [number, number] {
  const [cx, cy, cw, ch] = clipRect(page, view);
  return rotatePoint(x - cx, y - cy, cw, ch, view.rotation);
}

/** View-space point (points) -> page-space point. */
export function viewToPage(page: PageInfo, view: ViewSettings, x: number, y: number): [number, number] {
  const [cx, cy, cw, ch] = clipRect(page, view);
  const [px, py] = unrotatePoint(x, y, cw, ch, view.rotation);
  return [px + cx, py + cy];
}

/** Page-space rect -> axis-aligned view-space rect (rotation is a multiple of 90, so it stays a rect). */
export function rectToView(page: PageInfo, view: ViewSettings, r: Rect): Rect {
  const [x0, y0] = pageToView(page, view, r[0], r[1]);
  const [x1, y1] = pageToView(page, view, r[0] + r[2], r[1] + r[3]);
  return [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)];
}

/** How pages are arranged, mirroring Zotero's own reader: scrolling (vertical / wrapped) and spreads. */
export type ScrollMode = "vertical" | "wrapped";
/** none = one page per row; odd = (1,2)(3,4)...; even = 1 alone, then (2,3)(4,5)... */
export type SpreadMode = "none" | "odd" | "even";

export interface Arrangement {
  scroll: ScrollMode;
  spread: SpreadMode;
}

export const DEFAULT_ARRANGEMENT: Arrangement = { scroll: "vertical", spread: "none" };

export function isScrollMode(v: unknown): v is ScrollMode {
  return v === "vertical" || v === "wrapped";
}
export function isSpreadMode(v: unknown): v is SpreadMode {
  return v === "none" || v === "odd" || v === "even";
}

/** Groups page indices into spreads (units that always sit side by side). */
export function spreadGroups(count: number, spread: SpreadMode): number[][] {
  const groups: number[][] = [];
  let i = 0;
  if (spread === "even" && count > 0) groups.push([i++]);
  while (i < count) {
    if (spread !== "none" && i + 1 < count) groups.push([i, i + 1]);
    else groups.push([i]);
    i += spread === "none" ? 1 : 2;
  }
  return groups;
}

export interface Layout {
  /** px from the top of the scroll content to the top of each page */
  tops: number[];
  /** px from the left edge of the widest row to the left of each page (rows are centred within it) */
  lefts: number[];
  heights: number[];
  widths: number[];
  total: number;
  /** width of the widest row, px */
  maxWidth: number;
  /** px per point each page was laid out at; all equal unless a fit mode scaled every page on its own */
  scales: number[];
}

/**
 * Pages at `scale` px per point (one number for all pages, or one per page) with `gap` px between them and `margin` px around. Pages form spreads
 * (see `spreadGroups`); spreads are stacked one per row ("vertical") or packed into rows of up to
 * `availWidth` px ("wrapped"). `tops` never decreases with the page index, which the lookups below rely on.
 */
export function computeLayout(
  pages: PageInfo[], view: ViewSettings, scale: number | number[], gap = 8, margin = 8,
  arrange: Arrangement = DEFAULT_ARRANGEMENT, availWidth = Infinity,
): Layout {
  const n = pages.length;
  const tops = new Array<number>(n).fill(0);
  const lefts = new Array<number>(n).fill(0);
  const heights = new Array<number>(n).fill(0);
  const widths = new Array<number>(n).fill(0);
  const scales = pages.map((_, i) => (typeof scale === "number" ? scale : scale[i] ?? 1));
  pages.forEach((p, i) => {
    const s = viewSize(p, view);
    widths[i] = s.w * scales[i]!;
    heights[i] = s.h * scales[i]!;
  });
  const units = spreadGroups(n, arrange.spread).map((idx) => ({
    idx,
    w: idx.reduce((a, i) => a + widths[i]!, 0) + gap * (idx.length - 1),
    h: Math.max(...idx.map((i) => heights[i]!)),
  }));
  // rows of units
  const rows: Array<typeof units> = [];
  const limit = availWidth - 2 * margin;
  for (const u of units) {
    const row = rows[rows.length - 1];
    const rowW = row ? row.reduce((a, r) => a + r.w, 0) + gap * (row.length - 1) : 0;
    if (arrange.scroll === "wrapped" && row && rowW + gap + u.w <= limit) row.push(u);
    else rows.push([u]);
  }
  const rowWidth = (row: typeof units) => row.reduce((a, r) => a + r.w, 0) + gap * (row.length - 1);
  const maxWidth = rows.reduce((m, r) => Math.max(m, rowWidth(r)), 0);
  let y = margin;
  for (const row of rows) {
    const h = Math.max(...row.map((u) => u.h));
    let x = (maxWidth - rowWidth(row)) / 2;
    for (const u of row) {
      for (const i of u.idx) {
        tops[i] = y;
        lefts[i] = x;
        x += widths[i]! + gap;
      }
    }
    y += h + gap;
  }
  return { tops, lefts, heights, widths, total: Math.max(0, y - gap) + margin, maxWidth, scales };
}

/** Index of the page that contains scroll offset `y`, or the nearest page if `y` is in a gap. */
export function pageAtOffset(layout: Layout, y: number): number {
  const n = layout.tops.length;
  if (n === 0) return 0;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (layout.tops[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  // several pages share a row: report the first one
  while (lo > 0 && layout.tops[lo - 1] === layout.tops[lo]) lo--;
  // in the gap below the row: whichever neighbouring row is closer
  let rowEnd = lo;
  let bottom = layout.tops[lo]! + layout.heights[lo]!;
  while (rowEnd + 1 < n && layout.tops[rowEnd + 1] === layout.tops[lo]) {
    rowEnd++;
    bottom = Math.max(bottom, layout.tops[rowEnd]! + layout.heights[rowEnd]!);
  }
  if (y > bottom && rowEnd + 1 < n && layout.tops[rowEnd + 1]! - y < y - bottom) return rowEnd + 1;
  return lo;
}

/** First and last page that intersect the viewport `[scrollTop - overscan, scrollTop + height + overscan]`. */
export function visibleRange(layout: Layout, scrollTop: number, viewportHeight: number, overscan = 0): [number, number] {
  const n = layout.tops.length;
  if (n === 0) return [0, -1];
  const top = scrollTop - overscan;
  const bottom = scrollTop + viewportHeight + overscan;
  let first = pageAtOffset(layout, top);
  while (first < n - 1 && layout.tops[first]! + layout.heights[first]! < top) first++;
  let last = first;
  while (last < n - 1 && layout.tops[last + 1]! <= bottom) last++;
  return [first, last];
}

/** The page the user is "on": the one under the line a third of the way down the viewport. */
export function currentPage(layout: Layout, scrollTop: number, viewportHeight: number): number {
  return pageAtOffset(layout, scrollTop + viewportHeight / 3);
}

/** Scale (px per point) that fits the page's width, or the whole page, into the viewport. */
export function fitScale(
  mode: "width" | "page",
  page: PageInfo,
  view: ViewSettings,
  viewportWidth: number,
  viewportHeight: number,
  padding = 16,
  columns = 1,
  gap = 8
): number {
  const s = viewSize(page, view);
  const byWidth = (viewportWidth - padding - gap * (columns - 1)) / (s.w * columns);
  if (mode === "width") return byWidth;
  return Math.min(byWidth, (viewportHeight - padding) / s.h);
}

export const MIN_SCALE = 0.15;
export const MAX_SCALE = 8;
export const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/**
 * Where to scroll so a given spot stays put across a re-layout (zoom, rotate, crop, window resize):
 * remember which page is at the viewport anchor and how far into it, then restore.
 */
export interface ScrollAnchor {
  page: number;
  /** fraction of the page's height already above the anchor line (can be <0 or >1 in gaps) */
  fraction: number;
  /** distance in px from the viewport top to the anchor line */
  offset: number;
}

export function captureAnchor(layout: Layout, scrollTop: number, offset = 0): ScrollAnchor {
  const y = scrollTop + offset;
  const page = pageAtOffset(layout, y);
  const h = layout.heights[page] || 1;
  return { page, fraction: (y - layout.tops[page]!) / h, offset };
}

export function scrollTopForAnchor(layout: Layout, a: ScrollAnchor): number {
  const page = Math.min(Math.max(a.page, 0), layout.tops.length - 1);
  if (page < 0) return 0;
  return Math.max(0, layout.tops[page]! + a.fraction * layout.heights[page]! - a.offset);
}

/**
 * Largest frame the reader will ask for, in pixels. A retina page at high zoom would otherwise be hundreds
 * of MB; above this the helper is asked for a lower resolution and the browser stretches it (softer, but the
 * memory stays bounded). 16M px = 64 MB of RGBA.
 */
export const MAX_FRAME_PIXELS = 16_000_000;

/** The render scale (px per point) to request: `want`, reduced so the frame stays within `maxPixels`. */
export function capRenderScale(widthPt: number, heightPt: number, want: number, maxPixels = MAX_FRAME_PIXELS): number {
  const px = widthPt * heightPt * want * want;
  if (px <= maxPixels || px <= 0) return want;
  return Math.sqrt(maxPixels / (widthPt * heightPt));
}

/**
 * Per-page scales for the fit modes: every page (or, in a spread, every spread) is fitted to the viewport on
 * its own, so a landscape page among portrait ones fills the width just like they do, instead of inheriting
 * one document-wide scale. Each scale depends only on that page's own size and the viewport, never on the
 * layout or the scroll position, so there is no feedback loop (fitting a single shared scale to the *current*
 * page made the scale depend on the layout and the layout on the scale, which diverged to the zoom limit on a
 * real article that mixes a 595pt and a 425pt page).
 */
export function fitScales(
  mode: "width" | "page",
  pages: PageInfo[],
  view: ViewSettings,
  spread: SpreadMode,
  viewportWidth: number,
  viewportHeight: number,
  padding = 24,
  gap = 8,
): number[] {
  const out = new Array<number>(pages.length).fill(1);
  for (const group of spreadGroups(pages.length, spread)) {
    const sizes = group.map((i) => viewSize(pages[i]!, view));
    const w = sizes.reduce((a, s) => a + s.w, 0);
    const h = Math.max(...sizes.map((s) => s.h));
    // a spread shares one scale so its pages sit side by side at the same size
    const byWidth = (viewportWidth - padding - gap * (group.length - 1)) / w;
    const scale = clampScale(mode === "width" ? byWidth : Math.min(byWidth, (viewportHeight - padding) / h));
    for (const i of group) out[i] = scale;
  }
  return out;
}
