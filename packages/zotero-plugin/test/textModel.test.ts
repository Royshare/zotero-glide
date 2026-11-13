// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

import { test } from "node:test";
import assert from "node:assert/strict";
import { charOffsetOnPage, codePoints, comparePos, hitTest, ordered, selectionRects, selectionText, wordRange, type PageText } from "../src/textModel.ts";
import type { TextLineData } from "../src/protocol.ts";

/** A line of monospace text: each char `w` wide, starting at x0, top at y, height h. */
function line(t: string, x0: number, y: number, w = 10, h = 12): TextLineData {
  const n = codePoints(t).length;
  return { b: [x0, y, n * w, h], t, x: Array.from({ length: n + 1 }, (_, i) => x0 + i * w) };
}
const page = (...lines: TextLineData[]): PageText => ({ lines });

test("hitTest finds the line under the pointer and the nearest caret between characters", () => {
  const t = page(line("hello world", 100, 100), line("second line", 100, 114));
  assert.deepEqual(hitTest(t, 0, 124, 105), { page: 0, line: 0, ch: 2 }, "x=124 is closer to boundary 2 (120) than 3 (130)");
  assert.deepEqual(hitTest(t, 0, 126, 105), { page: 0, line: 0, ch: 3 });
  assert.deepEqual(hitTest(t, 0, 50, 105), { page: 0, line: 0, ch: 0 }, "left of the line: caret at its start");
  assert.deepEqual(hitTest(t, 0, 999, 105), { page: 0, line: 0, ch: 11 }, "right of the line: caret at its end");
  assert.deepEqual(hitTest(t, 0, 130, 120), { page: 0, line: 1, ch: 3 });
});

test("hitTest between lines picks the nearer one, and honours maxDistance", () => {
  const t = page(line("aaaa", 0, 0), line("bbbb", 0, 30));
  assert.equal(hitTest(t, 0, 5, 16)?.line, 0, "closer to line 0's bottom (12) than line 1's top (30)");
  assert.equal(hitTest(t, 0, 5, 24)?.line, 1);
  assert.equal(hitTest(t, 0, 5, 200, { maxDistance: 10 }), null, "far below everything: not a text hit");
  assert.equal(hitTest(page(), 0, 5, 5), null, "a page with no text");
});

test("with two columns at the same height the pointer picks the column it is over", () => {
  const t = page(line("left col", 50, 100), line("right col", 300, 100));
  assert.equal(hitTest(t, 0, 320, 105)?.line, 1);
  assert.equal(hitTest(t, 0, 60, 105)?.line, 0);
});

test("positions order by page, then line, then char", () => {
  const a = { page: 0, line: 5, ch: 9 };
  const b = { page: 1, line: 0, ch: 0 };
  assert.ok(comparePos(a, b) < 0);
  assert.deepEqual(ordered(b, a), [a, b]);
});

test("wordRange selects words, treats a caret at a word's end as in that word, and punctuation singly", () => {
  const l = line("foo, bar_baz!", 0, 0);
  assert.deepEqual(wordRange(l, 1), [0, 3]);
  assert.deepEqual(wordRange(l, 3), [0, 3], "caret right after 'foo'");
  assert.deepEqual(wordRange(l, 5), [5, 12], "underscores are word characters");
  assert.deepEqual(wordRange(l, 3 + 0), [0, 3]);
  assert.deepEqual(wordRange(line("", 0, 0), 0), [0, 0]);
  assert.deepEqual(wordRange(line("日本語 text", 0, 0), 1), [0, 3], "non-Latin words");
});

test("selectionRects covers partial first/last lines and whole lines in between", () => {
  const t = new Map([[0, page(line("aaaaaaaaaa", 100, 100), line("bbbbbbbbbb", 100, 114), line("cccccccccc", 100, 128))]]);
  const r = selectionRects(t, { page: 0, line: 2, ch: 3 }, { page: 0, line: 0, ch: 4 }); // given in reverse order
  assert.deepEqual(r.get(0), [
    [140, 100, 60, 12], // line 0 from char 4 to end (100+40 .. 200)
    [100, 114, 100, 12], // line 1 whole
    [100, 128, 30, 12], // line 2 up to char 3
  ]);
});

test("a selection spanning pages yields rects on every loaded page and skips unloaded ones", () => {
  const t = new Map([
    [0, page(line("p0 line", 10, 10))],
    [2, page(line("p2 line", 10, 10))],
  ]);
  const r = selectionRects(t, { page: 0, line: 0, ch: 0 }, { page: 2, line: 0, ch: 7 });
  assert.deepEqual([...r.keys()], [0, 2], "page 1 is not loaded");
});

test("an empty selection has no rects", () => {
  const t = new Map([[0, page(line("abc", 0, 0))]]);
  assert.equal(selectionRects(t, { page: 0, line: 0, ch: 2 }, { page: 0, line: 0, ch: 2 }).size, 0);
});

test("selectionText joins wrapped lines with spaces and keeps paragraph breaks", () => {
  const t = new Map([[0, page(
    line("The quick brown fox", 10, 10), line("jumps over the dog.", 10, 24),
    line("A new paragraph here", 10, 60),
  )]]);
  const text = selectionText(t, { page: 0, line: 0, ch: 0 }, { page: 0, line: 2, ch: 20 });
  assert.equal(text, "The quick brown fox jumps over the dog.\nA new paragraph here");
});

test("selectionText re-joins a word broken by a hyphen at the end of a line, but not a real compound", () => {
  const broken = new Map([[0, page(line("an inter-", 0, 0), line("national group", 0, 14))]]);
  assert.equal(selectionText(broken, { page: 0, line: 0, ch: 0 }, { page: 0, line: 1, ch: 14 }), "an international group");
  const compound = new Map([[0, page(line("a well-", 0, 0), line("Known thing", 0, 14))]]);
  assert.equal(selectionText(compound, { page: 0, line: 0, ch: 0 }, { page: 0, line: 1, ch: 11 }), "a well- Known thing", "capital letter: not a broken word");
});

test("selectionText of a partial selection takes exactly the selected characters", () => {
  const t = new Map([[0, page(line("hello world", 0, 0))]]);
  assert.equal(selectionText(t, { page: 0, line: 0, ch: 6 }, { page: 0, line: 0, ch: 11 }), "world");
  assert.equal(selectionText(t, { page: 0, line: 0, ch: 3 }, { page: 0, line: 0, ch: 3 }), "");
});

test("selectionText works across a page break and with astral characters", () => {
  const t = new Map([[0, page(line("end of page one", 0, 0))], [1, page(line("start 😀 two", 0, 0))]]);
  assert.equal(selectionText(t, { page: 0, line: 0, ch: 0 }, { page: 1, line: 0, ch: 11 }), "end of page one start 😀 two");
});

test("charOffsetOnPage counts characters before the position (annotation sort order)", () => {
  const t = page(line("abcde", 0, 0), line("fghij", 0, 14));
  assert.equal(charOffsetOnPage(t, { page: 0, line: 1, ch: 2 }), 7);
  assert.equal(charOffsetOnPage(t, { page: 0, line: 0, ch: 0 }), 0);
});
