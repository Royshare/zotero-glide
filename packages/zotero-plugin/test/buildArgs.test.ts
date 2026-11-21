// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildServeArgs, helperEnvironment } from "../src/buildArgs.ts";

test("buildServeArgs builds a headless argv array and keeps awkward paths as single elements", () => {
  assert.deepEqual(buildServeArgs("/Users/me/My Papers/a (1).pdf", "/tmp/fr 1"), [
    "--serve", "--frame-dir", "/tmp/fr 1", "--file", "/Users/me/My Papers/a (1).pdf",
  ]);
  assert.deepEqual(buildServeArgs("/a.pdf", "/t", 7).slice(-2), ["--page", "7"]);
});

test("buildServeArgs validates its inputs", () => {
  assert.throws(() => buildServeArgs("", "/t"), TypeError);
  assert.throws(() => buildServeArgs("/a.pdf", ""), TypeError);
  assert.throws(() => buildServeArgs("/a.pdf", "/t", 0), TypeError);
});

test("helperEnvironment sets the measured allocator knob per platform, and nothing on Windows", () => {
  assert.deepEqual(helperEnvironment("mac"), { MallocSpaceEfficient: "1" });
  assert.deepEqual(helperEnvironment("linux"), { MALLOC_MMAP_THRESHOLD_: "1048576" });
  assert.deepEqual(helperEnvironment("win"), {});
  assert.deepEqual(helperEnvironment("unknown"), {});
});
