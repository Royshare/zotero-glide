import { test } from "node:test";
import assert from "node:assert/strict";

import { buildHelperArgs } from "../src/buildArgs.ts";

test("buildHelperArgs with no page returns a single-element argv", () => {
  assert.deepEqual(buildHelperArgs("/Users/me/Library/paper.pdf"), [
    "/Users/me/Library/paper.pdf",
  ]);
});

test("buildHelperArgs never merges path and flags into one shell string", () => {
  const args = buildHelperArgs("/Users/me/Library/paper.pdf", { page: 3 });
  assert.deepEqual(args, ["--file", "/Users/me/Library/paper.pdf", "--page", "3"]);
  for (const a of args) {
    assert.equal(typeof a, "string");
  }
});

test("buildHelperArgs preserves paths with spaces as a single argv element", () => {
  const args = buildHelperArgs("/Users/me/My Papers/some paper (final).pdf");
  assert.deepEqual(args, ["/Users/me/My Papers/some paper (final).pdf"]);
  assert.equal(args.length, 1, "a space-containing path must remain one argv element, not be split");
});

test("buildHelperArgs preserves unicode filenames untouched", () => {
  const path = "/Users/me/文献/论文—初稿.pdf";
  assert.deepEqual(buildHelperArgs(path), [path]);
});

test("buildHelperArgs preserves Windows-style paths untouched", () => {
  const path = "C:\\Users\\me\\Zotero\\storage\\ABCD1234\\paper.pdf";
  assert.deepEqual(buildHelperArgs(path), [path]);
});

test("buildHelperArgs rejects a non-string path", () => {
  // @ts-expect-error -- exercising the runtime guard against non-string input
  assert.throws(() => buildHelperArgs(null), TypeError);
  assert.throws(() => buildHelperArgs(""), TypeError);
  // @ts-expect-error -- exercising the runtime guard against non-string input
  assert.throws(() => buildHelperArgs(undefined), TypeError);
});

test("buildHelperArgs rejects a non-positive-integer page", () => {
  assert.throws(() => buildHelperArgs("/a.pdf", { page: 0 }), TypeError);
  assert.throws(() => buildHelperArgs("/a.pdf", { page: -1 }), TypeError);
  assert.throws(() => buildHelperArgs("/a.pdf", { page: 1.5 }), TypeError);
  // @ts-expect-error -- exercising the runtime guard against a non-numeric page
  assert.throws(() => buildHelperArgs("/a.pdf", { page: "3" }), TypeError);
});

test("buildHelperArgs appends dock flags after the bare path when no page is given", () => {
  const args = buildHelperArgs("/a.pdf", { dock: { x: 1200, y: 40, height: 900 } });
  assert.deepEqual(args, ["/a.pdf", "--dock-x", "1200", "--dock-y", "40", "--dock-height", "900"]);
});

test("buildHelperArgs combines --file/--page with dock flags when both are given", () => {
  const args = buildHelperArgs("/a.pdf", { page: 2, dock: { x: 1200, y: 40, height: 900 } });
  assert.deepEqual(args, [
    "--file",
    "/a.pdf",
    "--page",
    "2",
    "--dock-x",
    "1200",
    "--dock-y",
    "40",
    "--dock-height",
    "900",
  ]);
});

test("buildHelperArgs supports a negative dock-x (multi-monitor setups left of the primary display)", () => {
  const args = buildHelperArgs("/a.pdf", { dock: { x: -500, y: 0, height: 800 } });
  assert.deepEqual(args, ["/a.pdf", "--dock-x", "-500", "--dock-y", "0", "--dock-height", "800"]);
});

test("buildHelperArgs rejects non-integer dock values", () => {
  assert.throws(() => buildHelperArgs("/a.pdf", { dock: { x: 1.5, y: 0, height: 800 } }), TypeError);
  // @ts-expect-error -- exercising the runtime guard against a non-numeric dock value
  assert.throws(() => buildHelperArgs("/a.pdf", { dock: { x: "1200", y: 0, height: 800 } }), TypeError);
});
