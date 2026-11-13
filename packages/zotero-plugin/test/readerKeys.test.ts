// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

import { test } from "node:test";
import assert from "node:assert/strict";
import { keyToAction, ZOOM_STEP, type KeyContext, type KeyLike } from "../src/readerKeys.ts";

const key = (k: string, extra: Partial<KeyLike> = {}): KeyLike => ({
  key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...extra,
});
const mac: KeyContext = { isMac: true };

test("keys that scroll a continuous page are left to the browser", () => {
  for (const k of [" ", "PageDown", "PageUp", "ArrowDown", "ArrowUp"]) assert.equal(keyToAction(key(k), mac), null, k);
  assert.equal(keyToAction(key(" ", { shiftKey: true }), mac), null);
});

test("arrow left/right jump a page; Home/End go to the ends", () => {
  assert.deepEqual(keyToAction(key("ArrowRight"), mac), { type: "next" });
  assert.deepEqual(keyToAction(key("ArrowLeft"), mac), { type: "prev" });
  assert.deepEqual(keyToAction(key("Home"), mac), { type: "first" });
  assert.deepEqual(keyToAction(key("End"), mac), { type: "last" });
});

test("the primary modifier is Cmd on macOS but Ctrl elsewhere", () => {
  assert.deepEqual(keyToAction(key("f", { metaKey: true }), mac), { type: "focusSearch" });
  assert.equal(keyToAction(key("f", { ctrlKey: true }), mac), null);
  const win = { isMac: false };
  assert.deepEqual(keyToAction(key("f", { ctrlKey: true }), win), { type: "focusSearch" });
  assert.deepEqual(keyToAction(key("G", { ctrlKey: true }), win), { type: "focusPage" });
  assert.deepEqual(keyToAction(key("c", { ctrlKey: true }), win), { type: "copy" });
  assert.deepEqual(keyToAction(key("a", { metaKey: true }), mac), { type: "selectAll" });
});

test("zoom and fit keys", () => {
  assert.deepEqual(keyToAction(key("+"), mac), { type: "zoom", factor: ZOOM_STEP });
  assert.deepEqual(keyToAction(key("="), mac), { type: "zoom", factor: ZOOM_STEP });
  assert.deepEqual(keyToAction(key("-"), mac), { type: "zoom", factor: 1 / ZOOM_STEP });
  assert.deepEqual(keyToAction(key("1"), mac), { type: "fit", mode: "width" });
  assert.deepEqual(keyToAction(key("2"), mac), { type: "fit", mode: "page" });
  assert.deepEqual(keyToAction(key("=", { metaKey: true }), mac), { type: "zoom", factor: ZOOM_STEP });
  assert.deepEqual(keyToAction(key("0", { metaKey: true }), mac), { type: "fit", mode: "width" });
});

test("unrelated modified keys are left to Zotero/the browser", () => {
  assert.equal(keyToAction(key("w", { metaKey: true }), mac), null, "Cmd+W must still close the tab");
  assert.equal(keyToAction(key("ArrowRight", { altKey: true }), mac), null);
  assert.equal(keyToAction(key("a"), mac), null);
  assert.deepEqual(keyToAction(key("Escape"), mac), { type: "escape" });
});

test("Alt+Left (and Cmd+[ on a Mac) go back; plain Left still turns the page", () => {
  assert.deepEqual(keyToAction(key("ArrowLeft", { altKey: true }), { isMac: false }), { type: "back" });
  assert.deepEqual(keyToAction(key("[", { metaKey: true }), { isMac: true }), { type: "back" });
  assert.deepEqual(keyToAction(key("ArrowLeft"), { isMac: false }), { type: "prev" });
});

test("N toggles the notes pane, but never with a modifier (Cmd/Ctrl+N is Zotero's New Item)", () => {
  assert.deepEqual(keyToAction(key("n"), mac), { type: "toggleNotes" });
  assert.equal(keyToAction(key("n", { metaKey: true }), mac), null);
  assert.equal(keyToAction(key("n", { ctrlKey: true }), { isMac: false }), null);
});
