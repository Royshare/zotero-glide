import { test } from "node:test";
import assert from "node:assert/strict";
import { citationsInLine, findReferenceStart, parseNumberList, parseReferences } from "../src/citations.ts";
import type { TextLineData } from "../src/protocol.ts";

const line = (t: string, extra: Partial<TextLineData> = {}, y = 10): TextLineData => ({ b: [50, y, 200, 9], t, x: Array.from({ length: [...t].length + 1 }, (_, i) => 50 + i * 4), ...extra });

test("number lists expand ranges and reject non-citations", () => {
  assert.deepEqual(parseNumberList("7"), [7]);
  assert.deepEqual(parseNumberList("7,10,11"), [7, 10, 11]);
  assert.deepEqual(parseNumberList("7–9"), [7, 8, 9]);
  assert.deepEqual(parseNumberList("1-3, 5"), [1, 2, 3, 5]);
  assert.equal(parseNumberList("2024"), null);
  assert.equal(parseNumberList("9-7"), null);
});

test("superscript runs and bracketed numbers are citations", () => {
  const l = line("cells such as yeast7–9 and [3, 5] ok", { s: [[19, 22]] });
  const c = citationsInLine(l, 4);
  assert.deepEqual(c.map((x) => x.nums), [[7, 8, 9], [3, 5]]);
  assert.equal(c[0]!.line, 4);
  assert.equal(c[1]!.from, [..."cells such as yeast7–9 and "].length);
});

test("reference entries are split by their running numbers", () => {
  const pages = [
    { page: 3, text: { lines: [line("References", {}, 100), line("1 A. Author, Lab Chip, 2024, 24,", {}, 120), line("1867–1874.", {}, 130), line("2 B. Writer, Nature, 2005, 2,", {}, 140), line("5 stray number inside the title", {}, 150), line("3 C. Third, Cell, 2001.", {}, 160)] } },
  ];
  const start = findReferenceStart(pages)!;
  assert.deepEqual(start, { page: 3, line: 0 });
  const refs = parseReferences(pages, start);
  assert.equal(refs.size, 3);
  assert.equal(refs.get(1)!.text, "A. Author, Lab Chip, 2024, 24, 1867–1874.");
  assert.ok(refs.get(2)!.text.includes("stray number"), "a number out of sequence continues the entry");
  assert.equal(refs.get(3)!.y, 160);
});

import { looksLikeCitationLabel, referenceAt, textInRect } from "../src/citations.ts";

test("link labels that look like citations", () => {
  for (const s of ["[15]", "15", "7–9", "[3, 5]", "Smith et al., 2010", "(2010)", "Wagner 2010a"]) assert.ok(looksLikeCitationLabel(s), s);
  for (const s of ["Figure 3", "Section 2", "Table 2010", "", "see the discussion in the next section"]) assert.ok(!looksLikeCitationLabel(s), s);
});

test("the reference at a destination runs to the next entry (numbered and hanging-indent styles)", () => {
  const L = (t: string, x: number, y: number): TextLineData => ({ b: [x, y, 300, 8], t, x: Array.from({ length: [...t].length + 1 }, (_, i) => x + i * 4) });
  const numbered = { lines: [L("[8] H. A. Barne, Shear-thickening", 59, 311), L("in suspensions, J. Rheol.", 59, 322), L("[9] N. J. Wagner and J. F. Brady,", 59, 334), L("Shear thickening in colloidal", 59, 345), L("dispersions, Phys. Today 2009.", 59, 356), L("[10] E. Brown, 2010.", 55, 368)] };
  assert.equal(referenceAt(numbered, 334), "[9] N. J. Wagner and J. F. Brady, Shear thickening in colloidal dispersions, Phys. Today 2009.");
  const hanging = { lines: [L("Smith, A. (2010). A title that wraps", 55, 100), L("onto a second line. J. Fluid Mech.", 67, 111), L("Jones, B. (2012). Another.", 55, 123)] };
  assert.equal(referenceAt(hanging, 100), "Smith, A. (2010). A title that wraps onto a second line. J. Fluid Mech.");
  assert.equal(referenceAt({ lines: [] }, 50), null);
});

test("text under a link rectangle", () => {
  const l: TextLineData = { b: [50, 10, 100, 9], t: "see [15] here", x: Array.from({ length: 14 }, (_, i) => 50 + i * 4) };
  assert.equal(textInRect({ lines: [l] }, [50 + 4 * 4, 10, 4 * 4, 9]), "[15]");
});

import { numberedEntryY, singleNumber } from "../src/citations.ts";

test("numbered entries are found by their own number, whatever the link's coordinates say", () => {
  const L = (t: string, y: number): TextLineData => ({ b: [55, y, 300, 8], t, x: [55] });
  const page = { lines: [L("[9] N. J. Wagner", 334), L("[15] F. Boyer, O. Pouliquen", 460), L("16 plain numbering", 483)] };
  assert.equal(numberedEntryY(page, 15), 460);
  assert.equal(numberedEntryY(page, 16), 483);
  assert.equal(numberedEntryY(page, 1), null);
  assert.equal(singleNumber("[15]"), 15);
  assert.equal(singleNumber("7–9"), null);
});
