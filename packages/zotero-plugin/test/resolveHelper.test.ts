// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveHelperPath } from "../src/resolveHelper.ts";
import { HelperMissingError, UnsupportedPlatformError } from "../src/errors.ts";

const fakePathJoin = (...parts: string[]) => parts.join("/");

test("resolveHelperPath returns the platform-specific path when the file exists", async () => {
  const path = await resolveHelperPath({
    rootDir: "/plugin",
    platform: "darwin",
    arch: "arm64",
    pathJoin: fakePathJoin,
    fileExists: async (p) => p === "/plugin/bin/macos-arm64/fast-reader-helper",
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
      }),
    HelperMissingError
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
    });
    assert.fail("expected throw");
  } catch (e) {
    if (!(e instanceof HelperMissingError)) throw e;
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
      }),
    UnsupportedPlatformError
  );
  assert.equal(fileExistsCalled, false);
});
