const { test } = require("node:test");
const assert = require("node:assert/strict");

const { resolveHelperPathPacked } = require("../addon/src/extractHelper.js");
const platformModule = require("../addon/src/platform.js");
const errors = require("../addon/src/errors.js");

function baseOpts(overrides = {}) {
  const existing = new Set();
  const written = new Map();
  let executableCalls = [];
  return {
    opts: {
      platform: "darwin",
      arch: "arm64",
      platformModule,
      errors,
      rootURI: "jar:file:///profile/extensions/fast-reader@zotero-glide.local.xpi!/",
      destDir: "/data/fast-reader-helper/0.1.0",
      pathJoin: (...parts) => parts.join("/"),
      fileExists: async (p) => existing.has(p),
      fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
      writeBytes: async (p, bytes) => {
        written.set(p, bytes);
        existing.add(p);
      },
      setExecutable: async (p) => {
        executableCalls.push(p);
      },
      ...overrides,
    },
    existing,
    written,
    executableCalls,
  };
}

test("resolveHelperPathPacked extracts to the platform-scoped destination when missing", async () => {
  const { opts, written, executableCalls } = baseOpts();
  const path = await resolveHelperPathPacked(opts);
  assert.equal(path, "/data/fast-reader-helper/0.1.0/macos-arm64/fast-reader-helper");
  assert.ok(written.has(path));
  assert.deepEqual(executableCalls, [path]);
});

test("resolveHelperPathPacked fetches from the correct jar-relative URL", async () => {
  let capturedURL = null;
  const { opts } = baseOpts({
    fetchBytes: async (url) => {
      capturedURL = url;
      return new Uint8Array([9]);
    },
  });
  await resolveHelperPathPacked(opts);
  assert.equal(
    capturedURL,
    "jar:file:///profile/extensions/fast-reader@zotero-glide.local.xpi!/bin/macos-arm64/fast-reader-helper"
  );
});

test("resolveHelperPathPacked skips extraction (no fetch/write/chmod) when already extracted", async () => {
  const { opts, existing, executableCalls } = baseOpts();
  existing.add("/data/fast-reader-helper/0.1.0/macos-arm64/fast-reader-helper");
  let fetchCalled = false;
  opts.fetchBytes = async () => {
    fetchCalled = true;
    return new Uint8Array([1]);
  };
  const path = await resolveHelperPathPacked(opts);
  assert.equal(path, "/data/fast-reader-helper/0.1.0/macos-arm64/fast-reader-helper");
  assert.equal(fetchCalled, false);
  assert.deepEqual(executableCalls, []);
});

test("resolveHelperPathPacked throws HelperMissingError when the fetch returns empty bytes", async () => {
  const { opts } = baseOpts({ fetchBytes: async () => new Uint8Array(0) });
  await assert.rejects(() => resolveHelperPathPacked(opts), errors.HelperMissingError);
});

test("resolveHelperPathPacked throws HelperMissingError when the fetch itself fails", async () => {
  const { opts } = baseOpts({
    fetchBytes: async () => {
      throw new Error("network error");
    },
  });
  await assert.rejects(() => resolveHelperPathPacked(opts), errors.HelperMissingError);
});

test("resolveHelperPathPacked throws UnsupportedPlatformError for an unsupported host, before ever fetching", async () => {
  let fetchCalled = false;
  const { opts } = baseOpts({
    platform: "amiga",
    arch: "m68k",
    fetchBytes: async () => {
      fetchCalled = true;
      return new Uint8Array([1]);
    },
  });
  await assert.rejects(() => resolveHelperPathPacked(opts), errors.UnsupportedPlatformError);
  assert.equal(fetchCalled, false);
});

test("resolveHelperPathPacked writes .exe destinations correctly for windows", async () => {
  const { opts } = baseOpts({ platform: "win32", arch: "x64" });
  const path = await resolveHelperPathPacked(opts);
  assert.equal(path, "/data/fast-reader-helper/0.1.0/windows-x64/fast-reader-helper.exe");
});
