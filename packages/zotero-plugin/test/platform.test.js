const { test } = require("node:test");
const assert = require("node:assert/strict");

const { resolvePlatformDir, helperFileName } = require("../src/platform.js");
const errors = require("../src/errors.js");

test("resolvePlatformDir maps known platform/arch pairs", () => {
  assert.equal(resolvePlatformDir("darwin", "arm64", errors), "macos-arm64");
  assert.equal(resolvePlatformDir("mac", "aarch64", errors), "macos-arm64");
  assert.equal(resolvePlatformDir("darwin", "x64", errors), "macos-x64");
  assert.equal(resolvePlatformDir("win32", "x64", errors), "windows-x64");
  assert.equal(resolvePlatformDir("win", "x86_64", errors), "windows-x64");
  assert.equal(resolvePlatformDir("linux", "x64", errors), "linux-x64");
});

test("resolvePlatformDir throws UnsupportedPlatformError for unknown combos", () => {
  assert.throws(
    () => resolvePlatformDir("linux", "arm64", errors),
    errors.UnsupportedPlatformError
  );
  assert.throws(
    () => resolvePlatformDir("freebsd", "x64", errors),
    errors.UnsupportedPlatformError
  );
  assert.throws(
    () => resolvePlatformDir("win32", "ia32", errors),
    errors.UnsupportedPlatformError
  );
});

test("UnsupportedPlatformError carries the platform/arch that failed", () => {
  try {
    resolvePlatformDir("linux", "arm64", errors);
    assert.fail("expected throw");
  } catch (e) {
    assert.ok(e instanceof errors.UnsupportedPlatformError);
    assert.equal(e.platform, "linux");
    assert.equal(e.arch, "arm64");
  }
});

test("helperFileName appends .exe only for windows", () => {
  assert.equal(helperFileName("windows-x64"), "fast-reader-helper.exe");
  assert.equal(helperFileName("macos-arm64"), "fast-reader-helper");
  assert.equal(helperFileName("linux-x64"), "fast-reader-helper");
});
