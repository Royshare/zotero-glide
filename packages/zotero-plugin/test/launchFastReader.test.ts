// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

import { test } from "node:test";
import assert from "node:assert/strict";

import { launchFastReader, type LaunchFastReaderDeps } from "../src/launchFastReader.ts";
import { AttachmentMissingError, SpawnError } from "../src/errors.ts";
import type { PdfLikeItem } from "../src/pdfAttachment.ts";

function baseDeps(overrides: Partial<LaunchFastReaderDeps> = {}): LaunchFastReaderDeps {
  return {
    resolveHelperPath: async () => "/plugin/bin/macos-arm64/fast-reader-helper",
    spawn: async () => ({ pid: 123 }),
    ...overrides,
  };
}

function pdfItem(path = "/storage/ABCD/paper.pdf"): PdfLikeItem {
  return {
    isPDFAttachment: () => true,
    isRegularItem: () => false,
    getFilePathAsync: async () => path,
  };
}

test("launchFastReader spawns the resolved helper with the resolved PDF path as argv", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const deps = baseDeps({
    spawn: async (command: string, args: string[]) => {
      calls.push({ command, args });
      return { ok: true };
    },
  });
  const result = await launchFastReader(pdfItem("/storage/ABCD/paper.pdf"), deps);
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, "/plugin/bin/macos-arm64/fast-reader-helper");
  assert.deepEqual(calls[0]?.args, ["/storage/ABCD/paper.pdf"]);
});

test("launchFastReader throws AttachmentMissingError when there is no PDF to open", async () => {
  const item: PdfLikeItem = {
    isRegularItem: () => true,
    isPDFAttachment: () => false,
    getBestAttachment: async () => null,
  };
  await assert.rejects(() => launchFastReader(item, baseDeps()), AttachmentMissingError);
});

test("launchFastReader throws whatever resolveHelperPath throws (e.g. HelperMissingError/UnsupportedPlatformError)", async () => {
  class FakeError extends Error {}
  const deps = baseDeps({
    resolveHelperPath: async () => {
      throw new FakeError("helper missing");
    },
  });
  await assert.rejects(() => launchFastReader(pdfItem(), deps), FakeError);
});

test("launchFastReader wraps a spawn-level failure in SpawnError, preserving the cause", async () => {
  const underlying = new Error("ENOENT: no such file");
  const deps = baseDeps({
    spawn: async () => {
      throw underlying;
    },
  });
  await assert.rejects(() => launchFastReader(pdfItem(), deps), (err: unknown) => {
    assert.ok(err instanceof SpawnError);
    assert.equal(err.cause, underlying);
    return true;
  });
});

test("launchFastReader never reaches spawn when the PDF attachment is missing (fails fast)", async () => {
  let spawnCalled = false;
  const item: PdfLikeItem = {
    isRegularItem: () => true,
    isPDFAttachment: () => false,
    getBestAttachment: async () => null,
  };
  const deps = baseDeps({
    spawn: async () => {
      spawnCalled = true;
      return {};
    },
  });
  await assert.rejects(() => launchFastReader(item, deps));
  assert.equal(spawnCalled, false);
});

test("launchFastReader passes a page number through to argv when given", async () => {
  const calls: string[][] = [];
  const deps = baseDeps({
    spawn: async (command: string, args: string[]) => {
      calls.push(args);
      return {};
    },
  });
  await launchFastReader(pdfItem("/x.pdf"), { ...deps, page: 7 });
  assert.deepEqual(calls[0], ["--file", "/x.pdf", "--page", "7"]);
});

test("launchFastReader threads dock geometry through to argv (v0.2 docked-window UX)", async () => {
  const calls: string[][] = [];
  const deps = baseDeps({
    spawn: async (command: string, args: string[]) => {
      calls.push(args);
      return {};
    },
  });
  await launchFastReader(pdfItem("/x.pdf"), {
    ...deps,
    dock: { x: 1200, y: 40, height: 900 },
  });
  assert.deepEqual(calls[0], ["/x.pdf", "--dock-x", "1200", "--dock-y", "40", "--dock-height", "900"]);
});
