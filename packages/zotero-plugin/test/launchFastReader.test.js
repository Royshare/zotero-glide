const { test } = require("node:test");
const assert = require("node:assert/strict");

const { launchFastReader } = require("../src/launchFastReader.js");
const errors = require("../src/errors.js");
const platform = require("../src/platform.js");
const resolveHelper = require("../src/resolveHelper.js");
const pdfAttachment = require("../src/pdfAttachment.js");
const buildArgs = require("../src/buildArgs.js");

function baseDeps(overrides = {}) {
  return {
    errors,
    platform,
    resolveHelper,
    pdfAttachment,
    buildArgs,
    rootDir: "/plugin",
    hostPlatform: "darwin",
    hostArch: "arm64",
    pathJoin: (...parts) => parts.join("/"),
    fileExists: async () => true,
    spawn: async () => ({ pid: 123 }),
    ...overrides,
  };
}

function pdfItem(path = "/storage/ABCD/paper.pdf") {
  return {
    isPDFAttachment: () => true,
    isRegularItem: () => false,
    getFilePathAsync: async () => path,
  };
}

test("launchFastReader spawns the resolved helper with the resolved PDF path as argv", async () => {
  let captured = null;
  const deps = baseDeps({
    spawn: async (command, args) => {
      captured = { command, args };
      return { ok: true };
    },
  });
  const result = await launchFastReader(pdfItem("/storage/ABCD/paper.pdf"), deps);
  assert.deepEqual(result, { ok: true });
  assert.equal(captured.command, "/plugin/bin/macos-arm64/fast-reader-helper");
  assert.deepEqual(captured.args, ["/storage/ABCD/paper.pdf"]);
});

test("launchFastReader throws AttachmentMissingError when there is no PDF to open", async () => {
  const item = { isRegularItem: () => true, isPDFAttachment: () => false, getBestAttachment: async () => null };
  await assert.rejects(() => launchFastReader(item, baseDeps()), errors.AttachmentMissingError);
});

test("launchFastReader throws HelperMissingError when the binary isn't installed", async () => {
  const deps = baseDeps({ fileExists: async () => false });
  await assert.rejects(() => launchFastReader(pdfItem(), deps), errors.HelperMissingError);
});

test("launchFastReader throws UnsupportedPlatformError on an unsupported host", async () => {
  const deps = baseDeps({ hostPlatform: "amiga", hostArch: "m68k" });
  await assert.rejects(() => launchFastReader(pdfItem(), deps), errors.UnsupportedPlatformError);
});

test("launchFastReader wraps a spawn-level failure in SpawnError, preserving the cause", async () => {
  const underlying = new Error("ENOENT: no such file");
  const deps = baseDeps({
    spawn: async () => {
      throw underlying;
    },
  });
  await assert.rejects(() => launchFastReader(pdfItem(), deps), (err) => {
    assert.ok(err instanceof errors.SpawnError);
    assert.equal(err.cause, underlying);
    return true;
  });
});

test("launchFastReader never reaches spawn when the PDF attachment is missing (fails fast)", async () => {
  let spawnCalled = false;
  const item = { isRegularItem: () => true, isPDFAttachment: () => false, getBestAttachment: async () => null };
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
  let captured = null;
  const deps = baseDeps({
    spawn: async (command, args) => {
      captured = args;
      return {};
    },
  });
  await launchFastReader(pdfItem("/x.pdf"), { ...deps, page: 7 });
  assert.deepEqual(captured, ["--file", "/x.pdf", "--page", "7"]);
});
