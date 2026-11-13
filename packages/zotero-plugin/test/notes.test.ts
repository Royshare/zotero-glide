// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

import { test } from "node:test";
import assert from "node:assert/strict";
import { noteLines, noteSummary, openPdfUrl, pageLinkHtml, parseOpenPdfUrl, parseZoteroDate, relativeDate, sortNotes, UNTITLED_NOTE } from "../src/notes.ts";

const item = (html: string, over: Partial<{ id: number; key: string; dateModified: string; title: string }> = {}) => ({
  id: over.id ?? 1,
  key: over.key ?? "AAAAAAAA",
  dateModified: over.dateModified ?? "2026-11-13 10:00:00",
  getNote: () => html,
  ...(over.title !== undefined ? { getNoteTitle: () => over.title! } : {}),
});

test("noteLines turns block ends into lines and decodes entities", () => {
  assert.deepEqual(noteLines("<h1>Title &amp; more</h1><p>First<br/>second&nbsp;line</p><ul><li>a</li><li>b</li></ul>"), ["Title & more", "First", "second line", "a", "b"]);
  assert.deepEqual(noteLines("<p>&#65;&#x42; &unknown; &#0;</p>"), ["AB &unknown; &#0;"]);
  assert.deepEqual(noteLines(""), []);
});

test("noteSummary: title from Zotero when given, else the first line; preview is the next line", () => {
  assert.deepEqual(noteSummary(item("<h1>Ideas</h1><p>Try the thing</p>")), { id: 1, key: "AAAAAAAA", title: "Ideas", preview: "Try the thing", modified: "2026-11-13 10:00:00" });
  const given = noteSummary(item("<p>Body one</p><p>Body two</p>", { title: "Chosen" }));
  assert.equal(given.title, "Chosen");
  assert.equal(given.preview, "Body one");
  assert.equal(noteSummary(item("")).title, UNTITLED_NOTE);
  assert.equal(noteSummary(item("<p>Only line</p>")).preview, "");
  assert.equal(noteSummary(item(`<p>${"x".repeat(500)}</p><p>${"y".repeat(500)}</p>`)).preview.length, 140);
});

test("sortNotes puts the newest first and is stable on ties", () => {
  const a = noteSummary(item("<p>a</p>", { id: 1, dateModified: "2026-01-01 00:00:00" }));
  const b = noteSummary(item("<p>b</p>", { id: 2, dateModified: "2026-03-01 00:00:00" }));
  const c = noteSummary(item("<p>c</p>", { id: 3, dateModified: "2026-03-01 00:00:00" }));
  assert.deepEqual(sortNotes([a, b, c]).map((n) => n.id), [2, 3, 1]);
});

test("parseZoteroDate reads Zotero's UTC format and rejects junk", () => {
  assert.equal(parseZoteroDate("2026-11-13 10:20:30")?.toISOString(), "2026-11-13T10:20:30.000Z");
  assert.equal(parseZoteroDate("yesterday"), null);
  assert.equal(parseZoteroDate("2026-13-45 99:99:99"), null);
});

test("relativeDate reads naturally", () => {
  const now = new Date(2026, 10, 13, 15, 0, 0); // local time
  const at = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);
  assert.equal(relativeDate(at(new Date(now.getTime() - 20_000)), now), "Just now");
  assert.equal(relativeDate(at(new Date(now.getTime() - 5 * 60_000)), now), "5 min ago");
  assert.equal(relativeDate(at(new Date(now.getTime() - 2 * 3_600_000)), now), "2 h ago");
  assert.equal(relativeDate(at(new Date(2026, 10, 12, 8, 0, 0)), now), "Yesterday");
  assert.equal(relativeDate(at(new Date(2026, 9, 3, 12, 0, 0)), now), "Oct 3");
  assert.equal(relativeDate(at(new Date(2024, 0, 20, 12, 0, 0)), now), "Jan 20, 2024");
  assert.equal(relativeDate("nonsense", now), "");
});

test("open-pdf links: user library, group library, with an annotation, and back again", () => {
  assert.equal(openPdfUrl({ groupID: 0, key: "ABCD2345", page: "12" }), "zotero://open-pdf/library/items/ABCD2345?page=12");
  assert.equal(openPdfUrl({ groupID: 77, key: "ABCD2345", page: "iv", annotationKey: "ZZZZ9999" }), "zotero://open-pdf/groups/77/items/ABCD2345?page=iv&annotation=ZZZZ9999");
  assert.deepEqual(parseOpenPdfUrl("zotero://open-pdf/library/items/ABCD2345?page=12"), { groupID: 0, key: "ABCD2345", page: "12" });
  assert.deepEqual(parseOpenPdfUrl("zotero://open-pdf/groups/77/items/ABCD2345?page=3&annotation=ZZZZ9999"), { groupID: 77, key: "ABCD2345", page: "3", annotationKey: "ZZZZ9999" });
  assert.equal(parseOpenPdfUrl("zotero://select/library/items/ABCD2345"), null);
  assert.equal(parseOpenPdfUrl("zotero://open-pdf/library/items/ABCD2345"), null); // no page
  assert.equal(parseOpenPdfUrl("https://example.com"), null);
});

test("pageLinkHtml escapes the label and the url", () => {
  assert.equal(
    pageLinkHtml('A <b> & "c"', { groupID: 0, key: "ABCD2345", page: "5" }),
    '<p><a href="zotero://open-pdf/library/items/ABCD2345?page=5">A &lt;b&gt; &amp; &quot;c&quot;</a></p>'
  );
});
