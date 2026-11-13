// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

import { test } from "node:test";
import assert from "node:assert/strict";
import { darken } from "../src/tabView.ts";

function img(w: number, h: number, f: (x: number, y: number) => number): Uint8ClampedArray<ArrayBuffer> {
  const a = new Uint8ClampedArray(new ArrayBuffer(w * h * 4));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a.fill(f(x, y), (y * w + x) * 4, (y * w + x) * 4 + 3), (a[(y * w + x) * 4 + 3] = 255);
  return a;
}

test("white paper becomes slate and black text becomes light", () => {
  const out = darken(img(8, 1, (x) => (x < 4 ? 0 : 255)), 8, 1);
  assert.ok(out[0]! > 180);
  assert.ok(out[7 * 4]! < 80);
  assert.equal(out[3], 255);
});

test("pixels inside an image rectangle are left exactly as they are", () => {
  const src = img(20, 20, () => 255);
  const out = darken(src, 20, 20, [[5, 5, 10, 10]]);
  assert.equal(out[(10 * 20 + 10) * 4], 255, "inside the image: still white");
  assert.ok(out[0]! < 80, "outside: recolored");
});

test("colored pixels are dimmed, not inverted", () => {
  const a = new Uint8ClampedArray(new ArrayBuffer(4));
  a.set([200, 40, 40, 255]);
  const out = darken(a, 1, 1);
  assert.ok(out[0]! > out[1]! && out[0]! < 200);
});
