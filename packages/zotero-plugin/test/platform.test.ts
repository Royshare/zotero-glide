// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolvePlatformDir, helperFileName } from "../src/platform.ts";
import { UnsupportedPlatformError } from "../src/errors.ts";

test("resolvePlatformDir maps known platform/arch pairs", () => {
  assert.equal(resolvePlatformDir("darwin", "arm64"), "macos-arm64");
  assert.equal(resolvePlatformDir("mac", "aarch64"), "macos-arm64");
  assert.equal(resolvePlatformDir("darwin", "x64"), "macos-x64");
  assert.equal(resolvePlatformDir("win32", "x64"), "windows-x64");
  assert.equal(resolvePlatformDir("win", "x86_64"), "windows-x64");
  assert.equal(resolvePlatformDir("linux", "x64"), "linux-x64");
});

test("resolvePlatformDir throws UnsupportedPlatformError for unknown combos", () => {
  assert.throws(() => resolvePlatformDir("linux", "arm64"), UnsupportedPlatformError);
  assert.throws(() => resolvePlatformDir("freebsd", "x64"), UnsupportedPlatformError);
  assert.throws(() => resolvePlatformDir("win32", "ia32"), UnsupportedPlatformError);
});

test("UnsupportedPlatformError carries the platform/arch that failed", () => {
  try {
    resolvePlatformDir("linux", "arm64");
    assert.fail("expected throw");
  } catch (e) {
    if (!(e instanceof UnsupportedPlatformError)) throw e;
    assert.equal(e.platform, "linux");
    assert.equal(e.arch, "arm64");
  }
});

test("helperFileName appends .exe only for windows", () => {
  assert.equal(helperFileName("windows-x64"), "fast-reader-helper.exe");
  assert.equal(helperFileName("macos-arm64"), "fast-reader-helper");
  assert.equal(helperFileName("linux-x64"), "fast-reader-helper");
});
