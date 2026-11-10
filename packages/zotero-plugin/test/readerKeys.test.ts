import { test } from "node:test";
import assert from "node:assert/strict";
import { keyToAction, ZOOM_STEP, type KeyContext, type KeyLike } from "../src/readerKeys.ts";

const key = (k: string, extra: Partial<KeyLike> = {}): KeyLike => ({
  key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...extra,
});
const mid: KeyContext = { isMac: true, atTop: false, atBottom: false };

test("Space/PageDown only flip pages at the bottom; otherwise they scroll natively (null)", () => {
  assert.equal(keyToAction(key(" "), mid), null);
  assert.equal(keyToAction(key("PageDown"), mid), null);
  assert.deepEqual(keyToAction(key(" "), { ...mid, atBottom: true }), { type: "next" });
  assert.deepEqual(keyToAction(key("PageDown"), { ...mid, atBottom: true }), { type: "next" });
});

test("Shift+Space / PageUp flip back only at the top and land at the bottom of the previous page", () => {
  assert.equal(keyToAction(key(" ", { shiftKey: true }), mid), null);
  assert.deepEqual(keyToAction(key(" ", { shiftKey: true }), { ...mid, atTop: true }), { type: "prev", scroll: "bottom" });
  assert.deepEqual(keyToAction(key("PageUp"), { ...mid, atTop: true }), { type: "prev", scroll: "bottom" });
});

test("arrow left/right always change page", () => {
  assert.deepEqual(keyToAction(key("ArrowRight"), mid), { type: "next" });
  assert.deepEqual(keyToAction(key("ArrowLeft"), mid), { type: "prev", scroll: "top" });
  assert.equal(keyToAction(key("ArrowDown"), mid), null, "vertical arrows scroll natively");
});

test("the primary modifier is Cmd on macOS but Ctrl elsewhere", () => {
  assert.deepEqual(keyToAction(key("f", { metaKey: true }), mid), { type: "focusSearch" });
  assert.equal(keyToAction(key("f", { ctrlKey: true }), mid), null);
  const win = { ...mid, isMac: false };
  assert.deepEqual(keyToAction(key("f", { ctrlKey: true }), win), { type: "focusSearch" });
  assert.deepEqual(keyToAction(key("G", { ctrlKey: true }), win), { type: "focusPage" });
});

test("zoom and fit keys", () => {
  assert.deepEqual(keyToAction(key("+"), mid), { type: "zoom", factor: ZOOM_STEP });
  assert.deepEqual(keyToAction(key("="), mid), { type: "zoom", factor: ZOOM_STEP });
  assert.deepEqual(keyToAction(key("-"), mid), { type: "zoom", factor: 1 / ZOOM_STEP });
  assert.deepEqual(keyToAction(key("1"), mid), { type: "fit", mode: "width" });
  assert.deepEqual(keyToAction(key("2"), mid), { type: "fit", mode: "page" });
  assert.deepEqual(keyToAction(key("=", { metaKey: true }), mid), { type: "zoom", factor: ZOOM_STEP });
});

test("unrelated modified keys are left to Zotero/the browser", () => {
  assert.equal(keyToAction(key("w", { metaKey: true }), mid), null, "Cmd+W must still close the tab");
  assert.equal(keyToAction(key("ArrowRight", { altKey: true }), mid), null);
  assert.equal(keyToAction(key("a"), mid), null);
});

test("Home/End/Escape", () => {
  assert.deepEqual(keyToAction(key("Home"), mid), { type: "first" });
  assert.deepEqual(keyToAction(key("End"), mid), { type: "last" });
  assert.deepEqual(keyToAction(key("Escape"), mid), { type: "escape" });
});
