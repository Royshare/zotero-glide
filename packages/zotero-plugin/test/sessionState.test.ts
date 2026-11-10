import { test } from "node:test";
import assert from "node:assert/strict";
import { withoutTabType } from "../src/sessionState.ts";

test("withoutTabType removes only the given type and returns the same array when there is nothing to remove", () => {
  const tabs = [{ type: "library", selected: true }, { type: "reader" }];
  assert.equal(withoutTabType(tabs, "fastreader"), tabs);
  assert.deepEqual(withoutTabType([...tabs, { type: "fastreader" }], "fastreader"), tabs);
});

test("removing the selected tab falls back to selecting the first remaining one", () => {
  const out = withoutTabType([{ type: "library" }, { type: "reader" }, { type: "fastreader", selected: true }], "fastreader");
  assert.deepEqual(out, [{ type: "library", selected: true }, { type: "reader" }]);
});

test("an existing selection elsewhere is left alone", () => {
  const out = withoutTabType([{ type: "library" }, { type: "fastreader" }, { type: "reader", selected: true }], "fastreader");
  assert.deepEqual(out, [{ type: "library" }, { type: "reader", selected: true }]);
});
