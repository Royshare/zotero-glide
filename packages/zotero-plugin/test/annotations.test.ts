// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANNOTATION_COLORS, buildMarkup, buildNote, hexToRgb, invertMatrix, NOTE_SIZE, pageRectsToPdf, parsePosition, pdfRectsToPage, sortIndex,
} from "../src/annotations.ts";
import type { Matrix, PageInfo, Rect } from "../src/protocol.ts";

// the helper's PDF->page matrices (see geometry.rs): rotation 0 on a 612x792 page, and rotations of a 100x300 box
const letter: PageInfo = { w: 612, h: 792, m: [1, 0, 0, -1, 0, 792] };
const rot = (r: 0 | 90 | 180 | 270, box = [0, 0, 100, 300]): PageInfo => {
  const [x0, y0, x1, y1] = box as [number, number, number, number];
  const m: Matrix = r === 90 ? [0, 1, 1, 0, -y0, -x0] : r === 180 ? [-1, 0, 0, 1, x1, -y0] : r === 270 ? [0, -1, -1, 0, y1, x1] : [1, 0, 0, -1, -x0, y1];
  return { w: r % 180 ? y1 - y0 : x1 - x0, h: r % 180 ? x1 - x0 : y1 - y0, m };
};
const close = (a: number, b: number, eps = 1e-2) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test("a page-space rect becomes a PDF-space rect with y flipped (rotation 0)", () => {
  // 100x20 box at page (72, 92): top-left origin. In PDF space: y from 792-112 to 792-92
  const [r] = pageRectsToPdf([[72, 92, 100, 20]], letter.m);
  assert.deepEqual(r, [72, 680, 172, 700]);
});

test("pdf -> page -> pdf round-trips for every rotation (the annotation you save is the one you draw)", () => {
  for (const r of [0, 90, 180, 270] as const) {
    const p = rot(r, [10, 20, 110, 320]);
    const pdf: [number, number, number, number][] = [[20, 40, 60, 80], [30, 200, 90, 230]];
    const page = pdfRectsToPage(pdf, p.m);
    const back = pageRectsToPdf(page, p.m);
    back.forEach((b, i) => b.forEach((v, j) => close(v, pdf[i]![j]!)));
  }
});

test("drawn rects stay inside the displayed page for every rotation", () => {
  for (const r of [0, 90, 180, 270] as const) {
    const p = rot(r);
    const [rect] = pdfRectsToPage([[10, 10, 90, 290]], p.m) as [Rect];
    assert.ok(rect[0] >= -1e-6 && rect[1] >= -1e-6 && rect[0] + rect[2] <= p.w + 1e-6 && rect[1] + rect[3] <= p.h + 1e-6, `rotation ${r}: ${rect}`);
  }
});

test("rects come out normalized (x1<x2, y1<y2) no matter the rotation", () => {
  for (const r of [0, 90, 180, 270] as const) {
    const [a] = pageRectsToPdf([[5, 5, 30, 10]], rot(r).m);
    assert.ok(a![0] < a![2] && a![1] < a![3], `rotation ${r}: ${a}`);
  }
});

test("invertMatrix refuses a singular matrix and inverts a real one", () => {
  assert.throws(() => invertMatrix([0, 0, 0, 0, 0, 0]));
  const inv = invertMatrix(letter.m);
  [1, 0, 0, -1, 0, 792].forEach((v, i) => close(inv[i]!, v, 1e-9)); // (-0 vs 0 is not a difference)
});

test("sortIndex follows Zotero's format: page(5)|offset(6)|top(5), top = page height - highest y", () => {
  const rects: [number, number, number, number][] = [[72, 680, 172, 700], [72, 660, 172, 680]];
  assert.equal(sortIndex(3, 1234, rects, letter), "00003|001234|00092");
  assert.equal(sortIndex(0, 0, [[0, 0, 10, 800]], letter), "00000|000000|00000", "above the page top: clamped at 0");
});

test("sortIndex orders annotations by page, then reading position, then vertical position (string compare)", () => {
  const r = (top: number): [number, number, number, number][] => [[0, 792 - top - 10, 10, 792 - top]];
  const a = sortIndex(1, 50, r(100), letter);
  const b = sortIndex(1, 900, r(50), letter);
  const c = sortIndex(2, 0, r(700), letter);
  assert.ok(a < b && b < c, [a, b, c].join(" "));
});

test("sortIndex uses the PDF-space page height even when the page is rotated", () => {
  const p = rot(90); // 100 wide x 300 tall in PDF space, displayed 300x100
  assert.equal(sortIndex(0, 0, [[0, 250, 10, 290]], p), "00000|000000|00010", "300 - 290");
});

test("buildMarkup produces the JSON Zotero's saveFromJSON expects", () => {
  const a = buildMarkup({ kind: "highlight", text: "Hello world", color: "#ffd400", pageIndex: 0, pageLabel: "1", pageRects: [[72, 92, 100, 20]], charOffset: 12, page: letter });
  assert.equal(a.type, "highlight");
  assert.equal(a.text, "Hello world");
  assert.equal(a.comment, "");
  assert.equal(a.color, "#ffd400");
  assert.equal(a.pageLabel, "1");
  assert.deepEqual(a.position, { pageIndex: 0, rects: [[72, 680, 172, 700]] });
  assert.equal(a.sortIndex, "00000|000012|00092");
  assert.deepEqual(a.tags, []);
});

test("buildNote makes a 22pt square centered on the click", () => {
  const a = buildNote({ comment: "remember", color: "#ff6666", pageIndex: 2, pageLabel: "iii", x: 100, y: 200, page: letter });
  assert.equal(a.type, "note");
  assert.equal(a.text, undefined, "notes carry a comment, not text");
  const [x1, y1, x2, y2] = a.position.rects[0]!;
  close(x2 - x1, NOTE_SIZE); close(y2 - y1, NOTE_SIZE);
  close((x1 + x2) / 2, 100); close((y1 + y2) / 2, 792 - 200);
});

test("parsePosition accepts Zotero's JSON and rejects junk without throwing", () => {
  assert.deepEqual(parsePosition('{"pageIndex":4,"rects":[[1,2,3,4]]}'), { pageIndex: 4, rects: [[1, 2, 3, 4]] });
  assert.equal(parsePosition("not json"), null);
  assert.equal(parsePosition('{"pageIndex":"x","rects":[]}'), null);
  assert.equal(parsePosition('{"pageIndex":1,"rects":[[1,2,3]]}'), null, "a malformed rect drops the whole annotation, not the page");
  assert.deepEqual(parsePosition('{"pageIndex":1,"rects":[[1,2,3,4],[1,2]]}')?.rects, [[1, 2, 3, 4]]);
  assert.equal(parsePosition('{"pageIndex":1,"paths":[[1,2]]}'), null, "ink annotations are not drawn by this reader");
});

test("the palette is Zotero's eight colors and hexToRgb handles them", () => {
  assert.equal(ANNOTATION_COLORS.length, 8);
  assert.equal(ANNOTATION_COLORS[0]!.hex, "#ffd400");
  assert.deepEqual(hexToRgb("#ff0000"), [1, 0, 0]);
  assert.deepEqual(hexToRgb("garbage"), hexToRgb("#ffd400"));
});
