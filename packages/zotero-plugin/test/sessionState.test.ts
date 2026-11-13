// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

import { test } from "node:test";
import assert from "node:assert/strict";
import { withoutTabType } from "../src/sessionState.ts";

test("withoutTabType removes only the given type and returns the same array when there is nothing to remove", () => {
  const tabs = [{ type: "library", selected: true }, { type: "reader" }];
  assert.equal(withoutTabType(tabs, "glide"), tabs);
  assert.deepEqual(withoutTabType([...tabs, { type: "glide" }], "glide"), tabs);
});

test("removing the selected tab falls back to selecting the first remaining one", () => {
  const out = withoutTabType([{ type: "library" }, { type: "reader" }, { type: "glide", selected: true }], "glide");
  assert.deepEqual(out, [{ type: "library", selected: true }, { type: "reader" }]);
});

test("an existing selection elsewhere is left alone", () => {
  const out = withoutTabType([{ type: "library" }, { type: "glide" }, { type: "reader", selected: true }], "glide");
  assert.deepEqual(out, [{ type: "library" }, { type: "reader", selected: true }]);
});
