// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveHelperPathPacked, type ResolveHelperPathPackedOpts } from "../src/extractHelper.ts";
import { HelperMissingError, UnsupportedPlatformError } from "../src/errors.ts";

/** A tiny in-memory filesystem so the extraction's write/rename behavior can be asserted exactly. */
function baseOpts(overrides: Partial<ResolveHelperPathPackedOpts> = {}, initialFiles: Record<string, Uint8Array> = {}) {
  const files = new Map<string, Uint8Array>(Object.entries(initialFiles));
  const writes: string[] = []; // every path written to directly
  const moves: Array<[string, string]> = [];
  const executableCalls: string[] = [];
  let n = 0;
  const opts: ResolveHelperPathPackedOpts = {
    platform: "darwin",
    arch: "arm64",
    rootURI: "jar:file:///profile/extensions/fast-reader@zotero-glide.local.xpi!/",
    destDir: "/data/fast-reader-helper-bin/0.1.0",
    pathJoin: (...parts) => parts.join("/"),
    fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
    writeBytes: async (p, bytes) => {
      writes.push(p);
      files.set(p, bytes);
    },
    setExecutable: async (p) => {
      assert.ok(files.has(p), "chmod only a file that exists");
      executableCalls.push(p);
    },
    readExisting: async (p) => files.get(p) ?? null,
    moveFile: async (from, to) => {
      moves.push([from, to]);
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    removeFile: async (p) => void files.delete(p),
    tempSuffix: () => `t${++n}`,
    ...overrides,
  };
  return { opts, files, writes, moves, executableCalls };
}

const DEST = "/data/fast-reader-helper-bin/0.1.0/macos-arm64/fast-reader-helper";

test("resolveHelperPathPacked extracts to the platform-scoped destination", async () => {
  const { opts, files, executableCalls } = baseOpts();
  const path = await resolveHelperPathPacked(opts);
  assert.equal(path, DEST);
  assert.deepEqual(Array.from(files.get(path) ?? []), [1, 2, 3, 4]);
  assert.equal(executableCalls.length, 1);
});

test("resolveHelperPathPacked fetches from the correct jar-relative URL", async () => {
  let capturedURL: string | null = null;
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

test("an identical binary already on disk is reused and NOTHING is written (the second-tab SIGKILL fix)", async () => {
  // Regression: every open used to rewrite the helper in place. On macOS, rewriting a binary that has been run
  // makes the next launch from it die with SIGKILL, so the second reader tab opened in a session showed
  // "stopped unexpectedly (exit code -9)". Reproduced live on Zotero 10.0.8.
  const { opts, writes, moves, executableCalls } = baseOpts({ fetchBytes: async () => new Uint8Array([9, 9, 9]) }, { [DEST]: new Uint8Array([9, 9, 9]) });
  const path = await resolveHelperPathPacked(opts);
  assert.equal(path, DEST);
  assert.deepEqual(writes, []);
  assert.deepEqual(moves, []);
  assert.deepEqual(executableCalls, []);
});

test("opening several tabs in a row never writes the destination: the second and third are reuses", async () => {
  const { opts, writes } = baseOpts({ fetchBytes: async () => new Uint8Array([7, 7]) });
  for (let i = 0; i < 4; i++) await resolveHelperPathPacked(opts);
  assert.equal(writes.length, 1, "only the first open writes (to a temp file); the rest find it identical");
  assert.ok(writes[0]!.endsWith(".tmp"));
});

test("a stale binary is replaced by writing a temp file and renaming it over the old one, never in place", async () => {
  // Regression for the older bug: a binary from a previous build must not be reused after a reinstall.
  const { opts, files, writes, moves, executableCalls } = baseOpts({ fetchBytes: async () => new Uint8Array([2, 2]) }, { [DEST]: new Uint8Array([1, 1]) });
  const path = await resolveHelperPathPacked(opts);
  assert.deepEqual(Array.from(files.get(path)!), [2, 2], "new bytes are in place");
  assert.ok(!writes.includes(DEST), "the destination itself is never written to");
  assert.deepEqual(moves, [[`${DEST}.t1.tmp`, DEST]]);
  assert.deepEqual(executableCalls, [`${DEST}.t1.tmp`], "made executable before the rename, so there is no window with a non-executable binary");
  assert.ok(![...files.keys()].some((k) => k.endsWith(".tmp")), "no temp file left behind");
});

test("a binary of the same length but different content is still replaced", async () => {
  const { opts, files } = baseOpts({ fetchBytes: async () => new Uint8Array([1, 2, 4]) }, { [DEST]: new Uint8Array([1, 2, 3]) });
  await resolveHelperPathPacked(opts);
  assert.deepEqual(Array.from(files.get(DEST)!), [1, 2, 4]);
});

test("a failure while replacing cleans up the temp file and leaves the old binary intact", async () => {
  const { opts, files } = baseOpts(
    { fetchBytes: async () => new Uint8Array([2]), moveFile: async () => { throw new Error("disk full"); } },
    { [DEST]: new Uint8Array([1]) }
  );
  await assert.rejects(() => resolveHelperPathPacked(opts), /disk full/);
  assert.deepEqual(Array.from(files.get(DEST)!), [1], "the working binary is untouched");
  assert.ok(![...files.keys()].some((k) => k.endsWith(".tmp")));
});

test("an unreadable existing file is treated as absent, not as an error", async () => {
  const { opts, files } = baseOpts({ readExisting: async () => { throw new Error("EACCES"); } });
  await resolveHelperPathPacked(opts);
  assert.ok(files.has(DEST));
});

test("resolveHelperPathPacked throws HelperMissingError when the fetch returns empty bytes", async () => {
  const { opts } = baseOpts({ fetchBytes: async () => new Uint8Array(0) });
  await assert.rejects(() => resolveHelperPathPacked(opts), HelperMissingError);
});

test("resolveHelperPathPacked throws HelperMissingError when the fetch itself fails", async () => {
  const { opts } = baseOpts({
    fetchBytes: async () => {
      throw new Error("network error");
    },
  });
  await assert.rejects(() => resolveHelperPathPacked(opts), HelperMissingError);
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
  await assert.rejects(() => resolveHelperPathPacked(opts), UnsupportedPlatformError);
  assert.equal(fetchCalled, false);
});

test("resolveHelperPathPacked writes .exe destinations correctly for windows", async () => {
  const { opts } = baseOpts({ platform: "win32", arch: "x64" });
  const path = await resolveHelperPathPacked(opts);
  assert.equal(path, "/data/fast-reader-helper-bin/0.1.0/windows-x64/fast-reader-helper.exe");
});
