// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

import { test } from "node:test";
import assert from "node:assert/strict";
import { annotationToRecord, createSettingsStore, parseSettings, parseTrimDelayMs, readerLocation } from "../src/zoteroAdapters.ts";

test("parseSettings falls back field by field on junk, and clamps the reading size", () => {
  const d = parseSettings(undefined);
  assert.deepEqual(parseSettings("{nope"), d);
  assert.deepEqual(parseSettings("[]"), d);
  const s = parseSettings(JSON.stringify({ theme: "dark", sidebarOpen: true, sidebarTab: "outline", readingFontSize: 99, color: "#aaaaaa" }));
  assert.deepEqual(s, { theme: "dark", sidebarOpen: true, sidebarWidth: 236, sidebarTab: "outline", readingFontSize: 32, color: "#aaaaaa", notesOpen: false, notesWidth: 340 });
  const bad = parseSettings(JSON.stringify({ theme: "neon", sidebarOpen: "yes", sidebarTab: 3, readingFontSize: "big", color: "red" }));
  assert.deepEqual(bad, d);
  assert.equal(parseSettings(JSON.stringify({ readingFontSize: 2 })).readingFontSize, 12);
  assert.equal(parseSettings(JSON.stringify({ sidebarWidth: 9999 })).sidebarWidth, 600);
  assert.equal(parseSettings(JSON.stringify({ sidebarWidth: 10 })).sidebarWidth, 180);
});

test("the settings store merges a patch into what is saved", () => {
  let raw: string | undefined;
  const store = createSettingsStore({ get: () => raw, set: (v) => { raw = v; } });
  store.set({ theme: "sepia" });
  store.set({ sidebarOpen: true });
  assert.equal(store.get().theme, "sepia");
  assert.equal(store.get().sidebarOpen, true);
});

test("parseTrimDelayMs clamps to 0.5s..10min and tolerates strings and junk", () => {
  assert.equal(parseTrimDelayMs(2), 2000);
  assert.equal(parseTrimDelayMs("5"), 5000);
  assert.equal(parseTrimDelayMs(0), 500);
  assert.equal(parseTrimDelayMs(99999), 600000);
  assert.equal(parseTrimDelayMs("soon"), 2000);
  assert.equal(parseTrimDelayMs(undefined, 3000), 3000);
});

test("readerLocation understands the locations Zotero passes when opening a PDF", () => {
  assert.deepEqual(readerLocation({ pageIndex: 4 }), { pageIndex: 4 });
  assert.deepEqual(readerLocation({ annotationID: "ABCD1234" }), { annotationKey: "ABCD1234" });
  assert.deepEqual(readerLocation({ pageLabel: "12" }), { pageIndex: 11 });
  assert.deepEqual(readerLocation({ position: { pageIndex: 2, rects: [] } }), { pageIndex: 2 });
  assert.deepEqual(readerLocation({ pageLabel: "iv" }), {}, "roman labels can't be mapped without the page labels");
  assert.deepEqual(readerLocation(null), {});
  assert.deepEqual(readerLocation({ pageIndex: -1 }), {});
});

test("annotationToRecord keeps highlight/underline/note and skips what this reader can't draw", () => {
  const base = { key: "K1", annotationType: "highlight", annotationColor: "#ff6666", annotationText: "t", annotationComment: "c", annotationPageLabel: "3", annotationSortIndex: "00002|000010|00100", annotationPosition: '{"pageIndex":2,"rects":[[1,2,3,4]]}' };
  assert.deepEqual(annotationToRecord(base), { key: "K1", kind: "highlight", color: "#ff6666", text: "t", comment: "c", pageIndex: 2, pageLabel: "3", sortIndex: "00002|000010|00100", rects: [[1, 2, 3, 4]] });
  assert.equal(annotationToRecord({ ...base, annotationType: "ink" }), null);
  assert.equal(annotationToRecord({ ...base, annotationType: "ink" }), null);
  assert.equal(annotationToRecord({ ...base, annotationPosition: '{"pageIndex":2,"paths":[[1,2]]}' }), null);
  assert.equal(annotationToRecord({ ...base, annotationPosition: "garbage" }), null);
  assert.equal(annotationToRecord({ ...base, annotationColor: undefined })?.color, "#ffd400");
  assert.equal(annotationToRecord({ ...base, annotationPageLabel: undefined })?.pageLabel, "3", "falls back to page index + 1");
});

test("parseSettings keeps the notes pane state and clamps its width", () => {
  const s = parseSettings(JSON.stringify({ notesOpen: true, notesWidth: 400 }));
  assert.equal(s.notesOpen, true);
  assert.equal(s.notesWidth, 400);
  assert.equal(parseSettings(JSON.stringify({ notesWidth: 9999 })).notesWidth, 720);
  assert.equal(parseSettings(JSON.stringify({ notesWidth: 5 })).notesWidth, 260);
  assert.equal(parseSettings(JSON.stringify({ notesOpen: "yes" })).notesOpen, false);
});
