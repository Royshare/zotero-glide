const { test } = require("node:test");
const assert = require("node:assert/strict");

const { resolveHelperPath } = require("../src/resolveHelper.js");
const platformModule = require("../src/platform.js");
const errors = require("../src/errors.js");

const fakePathJoin = (...parts) => parts.join("/");

test("resolveHelperPath returns the platform-specific path when the file exists", async () => {
  const path = await resolveHelperPath({
    rootDir: "/plugin",
    platform: "darwin",
    arch: "arm64",
    pathJoin: fakePathJoin,
    fileExists: async (p) => p === "/plugin/bin/macos-arm64/fast-reader-helper",
    platformModule,
    errors,
  });
  assert.equal(path, "/plugin/bin/macos-arm64/fast-reader-helper");
});

test("resolveHelperPath works with a synchronous fileExists too", async () => {
  const path = await resolveHelperPath({
    rootDir: "/plugin",
    platform: "win32",
    arch: "x64",
    pathJoin: fakePathJoin,
    fileExists: (p) => p.endsWith(".exe"),
    platformModule,
    errors,
  });
  assert.equal(path, "/plugin/bin/windows-x64/fast-reader-helper.exe");
});

test("resolveHelperPath throws HelperMissingError when the binary is absent", async () => {
  await assert.rejects(
    () =>
      resolveHelperPath({
        rootDir: "/plugin",
        platform: "darwin",
        arch: "arm64",
        pathJoin: fakePathJoin,
        fileExists: async () => false,
        platformModule,
        errors,
      }),
    errors.HelperMissingError
  );
});

test("HelperMissingError names the exact path that was checked", async () => {
  try {
    await resolveHelperPath({
      rootDir: "/plugin",
      platform: "linux",
      arch: "x64",
      pathJoin: fakePathJoin,
      fileExists: async () => false,
      platformModule,
      errors,
    });
    assert.fail("expected throw");
  } catch (e) {
    assert.ok(e instanceof errors.HelperMissingError);
    assert.equal(e.expectedPath, "/plugin/bin/linux-x64/fast-reader-helper");
  }
});

test("resolveHelperPath throws UnsupportedPlatformError before ever checking the filesystem", async () => {
  let fileExistsCalled = false;
  await assert.rejects(
    () =>
      resolveHelperPath({
        rootDir: "/plugin",
        platform: "amiga",
        arch: "m68k",
        pathJoin: fakePathJoin,
        fileExists: async () => {
          fileExistsCalled = true;
          return true;
        },
        platformModule,
        errors,
      }),
    errors.UnsupportedPlatformError
  );
  assert.equal(fileExistsCalled, false);
});
