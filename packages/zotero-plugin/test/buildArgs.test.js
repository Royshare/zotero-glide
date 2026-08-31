const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildHelperArgs } = require("../addon/src/buildArgs.js");

test("buildHelperArgs with no page returns a single-element argv", () => {
  assert.deepEqual(buildHelperArgs("/Users/me/Library/paper.pdf"), [
    "/Users/me/Library/paper.pdf",
  ]);
});

test("buildHelperArgs never merges path and flags into one shell string", () => {
  const args = buildHelperArgs("/Users/me/Library/paper.pdf", { page: 3 });
  assert.deepEqual(args, ["--file", "/Users/me/Library/paper.pdf", "--page", "3"]);
  // every element must be its own argv entry -- no embedded spaces standing in for argv separators
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
  assert.throws(() => buildHelperArgs(null), TypeError);
  assert.throws(() => buildHelperArgs(""), TypeError);
  assert.throws(() => buildHelperArgs(undefined), TypeError);
});

test("buildHelperArgs rejects a non-positive-integer page", () => {
  assert.throws(() => buildHelperArgs("/a.pdf", { page: 0 }), TypeError);
  assert.throws(() => buildHelperArgs("/a.pdf", { page: -1 }), TypeError);
  assert.throws(() => buildHelperArgs("/a.pdf", { page: 1.5 }), TypeError);
  assert.throws(() => buildHelperArgs("/a.pdf", { page: "3" }), TypeError);
});
