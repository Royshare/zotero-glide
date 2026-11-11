// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  referencePage, capRenderScale, MAX_FRAME_PIXELS, DEFAULT_VIEW, captureAnchor, clipRect, computeLayout, currentPage, fitScale, pageAtOffset, pageToView, rectToView,
  scrollTopForAnchor, viewSize, viewToPage, visibleRange, type ViewSettings,
} from "../src/layout.ts";
import type { PageInfo, Rotation } from "../src/protocol.ts";

const page = (w: number, h: number): PageInfo => ({ w, h, m: [1, 0, 0, -1, 0, h] });
const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test("view size accounts for crop and rotation", () => {
  const p = page(600, 800);
  assert.deepEqual(viewSize(p, DEFAULT_VIEW), { w: 600, h: 800 });
  assert.deepEqual(viewSize(p, { rotation: 90, insets: null }), { w: 800, h: 600 });
  assert.deepEqual(viewSize(p, { rotation: 0, insets: [50, 40, 50, 60] }), { w: 500, h: 700 });
  assert.deepEqual(viewSize(p, { rotation: 270, insets: [50, 40, 50, 60] }), { w: 700, h: 500 });
});

test("a crop can never remove a whole (small) page", () => {
  const [, , w, h] = clipRect(page(100, 100), { rotation: 0, insets: [80, 80, 80, 80] });
  assert.ok(w >= 10 && h >= 10);
});

test("pageToView and viewToPage are inverses for every rotation, with and without a crop", () => {
  const p = page(600, 800);
  for (const rotation of [0, 90, 180, 270] as Rotation[]) {
    for (const insets of [null, [30, 20, 10, 40] as ViewSettings["insets"]]) {
      const v: ViewSettings = { rotation, insets };
      const [vx, vy] = pageToView(p, v, 123, 456);
      const [px, py] = viewToPage(p, v, vx, vy);
      close(px, 123); close(py, 456);
    }
  }
});

test("rotation maps corners the way a clockwise turn does", () => {
  const p = page(100, 200);
  // the page's top-left corner goes to the top-right after a 90 degree clockwise turn
  assert.deepEqual(pageToView(p, { rotation: 90, insets: null }, 0, 0), [200, 0]);
  assert.deepEqual(pageToView(p, { rotation: 180, insets: null }, 0, 0), [100, 200]);
  assert.deepEqual(pageToView(p, { rotation: 270, insets: null }, 0, 0), [0, 100]);
});

test("rectToView returns a proper, positive-size rect", () => {
  const p = page(100, 200);
  for (const rotation of [0, 90, 180, 270] as Rotation[]) {
    const r = rectToView(p, { rotation, insets: null }, [10, 20, 30, 40]);
    assert.ok(r[2] > 0 && r[3] > 0);
    const swap = rotation % 180 === 90;
    close(r[2], swap ? 40 : 30); close(r[3], swap ? 30 : 40);
  }
});

test("layout stacks pages with gaps and reports total height", () => {
  const pages = [page(100, 200), page(100, 100), page(200, 100)];
  const l = computeLayout(pages, DEFAULT_VIEW, 2, 10, 5);
  assert.deepEqual(l.tops, [5, 415, 625]);
  assert.deepEqual(l.heights, [400, 200, 200]);
  assert.equal(l.maxWidth, 400);
  assert.equal(l.total, 830, "last page ends at 825, plus the 5px bottom margin");
});

test("pageAtOffset and visibleRange binary-search the stack, including gaps and extremes", () => {
  const pages = Array.from({ length: 100 }, () => page(100, 100));
  const l = computeLayout(pages, DEFAULT_VIEW, 1, 10, 0);
  assert.equal(pageAtOffset(l, -50), 0);
  assert.equal(pageAtOffset(l, 0), 0);
  assert.equal(pageAtOffset(l, 103), 0, "in the gap, nearer to page 0");
  assert.equal(pageAtOffset(l, 109), 1, "in the gap, nearer to page 1");
  assert.equal(pageAtOffset(l, 110 * 50 + 5), 50);
  assert.equal(pageAtOffset(l, 1e9), 99);
  assert.deepEqual(visibleRange(l, 0, 250), [0, 2]);
  assert.deepEqual(visibleRange(l, 110 * 10 + 50, 100), [10, 11]);
  assert.deepEqual(visibleRange(l, 110 * 10 + 50, 100, 200), [8, 13], "overscan widens both ends (page 8 ends at 980, inside the window starting at 950)");
  assert.deepEqual(visibleRange(computeLayout([], DEFAULT_VIEW, 1), 0, 100), [0, -1]);
});

test("currentPage follows the line a third of the way down the viewport", () => {
  const l = computeLayout(Array.from({ length: 10 }, () => page(100, 100)), DEFAULT_VIEW, 1, 0, 0);
  assert.equal(currentPage(l, 0, 300), 1);
  assert.equal(currentPage(l, 250, 300), 3);
});

test("fit modes", () => {
  const p = page(600, 800);
  close(fitScale("width", p, DEFAULT_VIEW, 616, 500), 1);
  close(fitScale("page", p, DEFAULT_VIEW, 1016, 516), 0.625);
  close(fitScale("width", p, { rotation: 90, insets: null }, 816, 500), 1, 1e-9);
});

test("an anchor survives a re-layout at a different scale: the same part of the page stays under the line", () => {
  const pages = Array.from({ length: 20 }, () => page(100, 100));
  const before = computeLayout(pages, DEFAULT_VIEW, 1, 8, 8);
  const scrollTop = before.tops[7]! + 30;
  const a = captureAnchor(before, scrollTop, 100);
  const after = computeLayout(pages, DEFAULT_VIEW, 2, 8, 8);
  const restored = scrollTopForAnchor(after, a);
  const a2 = captureAnchor(after, restored, 100);
  assert.equal(a2.page, a.page);
  close(a2.fraction, a.fraction, 1e-9);
});

test("capRenderScale leaves normal renders alone and bounds extreme ones", () => {
  assert.equal(capRenderScale(612, 792, 3.4), 3.4, "a retina page at fit-width: 2.3M... well under the cap");
  const capped = capRenderScale(612, 792, 16);
  assert.ok(capped < 16);
  close(612 * 792 * capped * capped, MAX_FRAME_PIXELS, 1);
  assert.equal(capRenderScale(0, 0, 2), 2, "degenerate sizes don't divide by zero");
});

test("referencePage is the median-width page, stable and independent of scroll", () => {
  const mixed = [page(595, 878), page(425, 637), page(595, 878), page(425, 637), page(595, 878)];
  // widths sorted: 425, 425, 595, 595, 595 -> the median is the first 595-wide page (index 0)
  assert.equal(referencePage(mixed, DEFAULT_VIEW), 0);
  assert.equal(referencePage([], DEFAULT_VIEW), 0);
  assert.equal(referencePage([page(100, 100)], DEFAULT_VIEW), 0);
  // rotation changes which dimension is the width
  assert.equal(viewSize(mixed[0]!, { rotation: 90, insets: null }).w, 878);
});

test("fit-width against the reference page is a fixed point: relaying out never changes the scale", () => {
  const pages = [page(595, 878), page(425, 637), page(595, 878), page(425, 637), page(595, 878), page(425, 637)];
  const ref = pages[referencePage(pages, DEFAULT_VIEW)]!;
  const scale = fitScale("width", ref, DEFAULT_VIEW, 1000, 700, 24);
  for (let i = 0; i < 5; i++) {
    // no matter which page is "current", the scale is the same
    close(fitScale("width", pages[referencePage(pages, DEFAULT_VIEW)]!, DEFAULT_VIEW, 1000, 700, 24), scale);
  }
});
