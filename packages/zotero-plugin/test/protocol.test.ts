// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeCommand, LineSplitter, parseEvent } from "../src/protocol.ts";

test("encodeCommand is one JSON object terminated by exactly one newline", () => {
  const s = encodeCommand({ cmd: "text", page: 4 });
  assert.equal(s, '{"cmd":"text","page":4}\n');
  assert.equal(s.split("\n").length, 2);
});

test("encodeCommand keeps a search query with quotes/newlines on a single line", () => {
  const s = encodeCommand({ cmd: "search", query: 'a "b"\nc' });
  assert.equal(s.indexOf("\n"), s.length - 1, "embedded newline must be escaped, not raw");
  assert.deepEqual(JSON.parse(s), { cmd: "search", query: 'a "b"\nc' });
});

test("parseEvent accepts known events and rejects everything else without throwing", () => {
  assert.deepEqual(parseEvent('{"event":"ready","pageCount":3}'), { event: "ready", pageCount: 3 });
  assert.equal(parseEvent('{"event":"error","message":"x"}')?.event, "error");
  assert.equal(parseEvent("not json"), null);
  assert.equal(parseEvent('{"event":"mystery"}'), null);
  assert.equal(parseEvent("42"), null);
  assert.equal(parseEvent("null"), null);
});

test("LineSplitter reassembles lines split across chunks", () => {
  const sp = new LineSplitter();
  assert.deepEqual(sp.push('{"a":'), []);
  assert.deepEqual(sp.push('1}\n{"b"'), ['{"a":1}']);
  assert.deepEqual(sp.push(":2}\n"), ['{"b":2}']);
});

test("LineSplitter handles several lines in one chunk, CRLF, and blank lines", () => {
  const sp = new LineSplitter();
  assert.deepEqual(sp.push("a\r\n\nb\nc"), ["a", "b"]);
  assert.deepEqual(sp.push("\n"), ["c"]);
});
