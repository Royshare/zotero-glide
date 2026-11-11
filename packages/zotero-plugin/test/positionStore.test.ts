// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

import { test } from "node:test";
import assert from "node:assert/strict";
import { PositionStore, type SavedPosition } from "../src/positionStore.ts";

function mem(initial?: string) {
  let v = initial;
  return { get: () => v, set: (s: string) => { v = s; }, raw: () => v };
}
const pos = (page: number, fraction = 0): SavedPosition => ({ page, fraction, zoom: { mode: "width" }, rotation: 0, insets: null });

test("saves and loads a position per document", () => {
  const s = new PositionStore(mem());
  s.save("1/ABCD", { ...pos(41, 0.25), zoom: { mode: "fixed", scale: 1.5 }, rotation: 90, insets: [10, 20, 30, 40] });
  s.save("1/EFGH", pos(3));
  assert.deepEqual(s.load("1/ABCD"), { page: 41, fraction: 0.25, zoom: { mode: "fixed", scale: 1.5 }, rotation: 90, insets: [10, 20, 30, 40] });
  assert.equal(s.load("1/EFGH")?.page, 3);
  assert.equal(s.load("1/NONE"), null);
});

test("the oldest documents are forgotten beyond the limit", () => {
  let t = 0;
  const s = new PositionStore(mem(), () => ++t, 3);
  for (const k of ["a", "b", "c", "d"]) s.save(k, pos(1));
  assert.equal(s.load("a"), null, "oldest dropped");
  assert.ok(s.load("b") && s.load("c") && s.load("d"));
  s.save("b", pos(9)); // touching b makes it the newest
  s.save("e", pos(1));
  assert.equal(s.load("c"), null);
  assert.equal(s.load("b")?.page, 9);
});

test("a corrupt or hostile pref value never throws and just means 'no saved position'", () => {
  for (const raw of ["{not json", "[]", "null", '"str"', '{"k":{"page":"x"}}', '{"k":{"page":-4,"fraction":0}}']) {
    const s = new PositionStore(mem(raw));
    assert.equal(s.load("k"), null, raw);
    s.save("k", pos(2)); // and saving still works afterwards
    assert.equal(s.load("k")?.page, 2);
  }
});

test("fraction is clamped to 0..1 on load", () => {
  const s = new PositionStore(mem(JSON.stringify({ k: { page: 1, fraction: 7, zoom: { mode: "width" }, rotation: 0, insets: null, t: 1 } })));
  assert.equal(s.load("k")?.fraction, 1);
});
