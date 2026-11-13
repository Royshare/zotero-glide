// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

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

import { buildReferenceSet, findPageCitations, parseAuthorYearReferences } from "../src/citations.ts";

const mk = (t: string, x: number, y: number): TextLineData => ({ b: [x, y, 400, 9], t, x: Array.from({ length: [...t].length + 1 }, (_, i) => x + i * 4) });
const page = (...rows: Array<[string, number, number]>) => ({ lines: rows.map(([t, x, y]) => mk(t, x, y)) });
const hits = (text: ReturnType<typeof page>, refs: ReturnType<typeof buildReferenceSet>) => findPageCitations(text, refs).map((m) => m.items.map((i) => i.label));

const AY_REFS = (() => {
  const refs = page(
    ["References", 55, 60],
    ["Brown, T. (2019). A study of flows. Journal of Fluids, 5, 1–10.", 55, 80],
    ["Jones, M. and Smith, J. (2020). Particles in channels. Phys. Rev. Fluids, 4,", 55, 100],
    ["   044301.", 67, 111],
    ["Smith, J., Lee, K., and Park, S. (2021). Another study. Lab Chip, 20, 1–9.", 55, 123],
    ["Smith, J. (2020a). Same year A. Nature, 1, 1.", 55, 145],
    ["Smith, J. (2020b). Same year B. Nature, 2, 2.", 55, 160],
    ["van der Berg, A. (2018). Microfluidics review. Chem. Rev., 118, 1–30.", 55, 175],
    ["Zhang, W. (2015). Another one. Science, 350, 1.", 55, 190],
  );
  return buildReferenceSet([{ page: 9, text: refs }], { page: 9, line: 0 });
})();

test("author-year reference lists are parsed (hanging indents, particles, a/b suffixes)", () => {
  assert.equal(AY_REFS.mode, "ay");
  const names = AY_REFS.ay.map((e) => `${e.surname} ${e.year}`);
  assert.deepEqual(names, ["brown 2019", "jones 2020", "smith 2021", "smith 2020a", "smith 2020b", "van der berg 2018", "zhang 2015"]);
  assert.ok(AY_REFS.ay[1]!.text.includes("044301"), "the wrapped line belongs to the entry");
});

test("author-year citations: parenthetical, et al., two authors, several in one, narrative, wrapped over a line", () => {
  assert.deepEqual(hits(page(["as shown before (Brown, 2019) and others", 50, 10]), AY_REFS), [["Brown 2019"]]);
  assert.deepEqual(hits(page(["found in (Jones and Smith, 2020)", 50, 10]), AY_REFS), [["Jones 2020"]]);
  assert.deepEqual(hits(page(["(Smith et al., 2021; Zhang 2015)", 50, 10]), AY_REFS), [["Smith 2021", "Zhang 2015"]]);
  assert.deepEqual(hits(page(["Smith et al. (2020a) showed that", 50, 10]), AY_REFS), [["Smith 2020a"]]);
  assert.deepEqual(hits(page(["see (e.g., Brown 2019, p. 4)", 50, 10]), AY_REFS), [["Brown 2019"]]);
  assert.deepEqual(hits(page(["see van der Berg (2018) for details", 50, 10]), AY_REFS), [["van der Berg 2018"]]);
  const wrapped = findPageCitations(page(["flows are common (Brown,", 50, 10], ["2019) in practice", 50, 22]), AY_REFS);
  assert.equal(wrapped.length, 1);
  assert.equal(wrapped[0]!.rects.length, 2, "one rectangle per line");
});

test("author-year: a year without the exact entry, or an unknown author, is not a citation", () => {
  assert.deepEqual(hits(page(["(Nobody, 2019) and (Brown, 2001) and in 2019 (see above)", 50, 10]), AY_REFS), []);
  assert.deepEqual(hits(page(["Smith 2020 without brackets", 50, 10]), AY_REFS), []);
});

const NUM_REFS = (() => {
  const refs = page(["REFERENCES", 55, 50], ["[1] A. One, J. Fluid Mech., 2001.", 55, 70], ["[2] B. Two, Phys. Rev., 2002.", 55, 82], ["[3] C. Three, Nature, 2003.", 55, 94], ["[4] D. Four, Science, 2004.", 55, 106], ["[5] E. Five, Lab Chip, 2005.", 55, 118]);
  return buildReferenceSet([{ page: 5, text: refs }], findReferenceStart([{ page: 5, text: refs }])!);
})();

test("numeric styles: [1], [1,2], [1–3], Ref. 3, Refs. 2 and 4, (1), and not equation numbers", () => {
  assert.equal(NUM_REFS.mode, "num");
  assert.deepEqual(hits(page(["as known [1] and [2, 4–5] too", 50, 10]), NUM_REFS), [["1"], ["2", "4", "5"]]);
  assert.deepEqual(hits(page(["see Ref. 3 and Refs. 2 and 4", 50, 10]), NUM_REFS), [["3"], ["2", "4"]]);
  assert.deepEqual(hits(page(["previous work (1,2) and (3)", 50, 10]), NUM_REFS), [["1", "2"], ["3"]]);
  assert.deepEqual(hits(page(["from Eq. (3) and Fig. (2) with x = (1) done", 50, 10]), NUM_REFS), [], "equation and figure numbers are not citations");
  assert.deepEqual(hits(page(["unknown [99] marker", 50, 10]), NUM_REFS), []);
});

test("numbered lists in other forms: '1.', '(1)', 'REFERENCES AND NOTES', '6. References'", () => {
  for (const [head, fmt] of [["References and Notes", (n: number) => `${n}. Author, J. Chem., 20${n}0.`], ["6. References", (n: number) => `(${n}) Author, J. Chem., 20${n}0.`], ["Bibliography", (n: number) => `${n} Author, J. Chem., 20${n}0.`]] as const) {
    const refs = page([head, 55, 50], ...[1, 2, 3, 4].map((n, i) => [fmt(n), 55, 70 + i * 12] as [string, number, number]));
    const start = findReferenceStart([{ page: 3, text: refs }]);
    assert.ok(start, head);
    assert.equal(buildReferenceSet([{ page: 3, text: refs }], start!).numbered.size, 4, head);
  }
});

test("vancouver-style unnumbered author lists parse too", () => {
  const refs = page(["Smith AB, Jones C. A title here. Nature. 2019;5:1-9.", 55, 70], ["Lee K, Park S. Another title. Cell. 2018;3:10-20.", 55, 82], ["Brown T. Third. Lab Chip. 2017;2:1-3.", 55, 94], ["Zhang W. Fourth. Science. 2016;1:1-2.", 55, 106], ["Wang L. Fifth. PNAS. 2015;1:3-4.", 55, 118]);
  const ay = parseAuthorYearReferences([{ page: 1, text: refs }], { page: 0, line: -1 });
  assert.deepEqual(ay.map((e) => `${e.surname} ${e.year}`), ["smith 2019", "lee 2018", "brown 2017", "zhang 2016", "wang 2015"]);
});

import { findNumberedRunStart } from "../src/citations.ts";

test("AIP lists (number glued to the first author) and APS lists (no heading at all)", () => {
  const aip = page(["References", 55, 50], ["1P. G. Saffman and G. Taylor, “The penetration,” Proc. R. Soc. 1958.", 44, 70], ["2G. Rousseaux, A. De Wit, J. Chromatogr. 2007.", 44, 82], ["3A. Kopp, H. Class, Int. J. Greenhouse 2009.", 44, 94]);
  assert.equal(buildReferenceSet([{ page: 1, text: aip }], findReferenceStart([{ page: 1, text: aip }])!).numbered.size, 3);
  const aps = page(["ACKNOWLEDGMENTS", 55, 40], ...[1, 2, 3, 4, 5, 6].map((n, i) => [`[${n}] Author ${n}, Phys. Rev. E 8${n}, 0${n}0000 (2019).`, 55, 60 + i * 12] as [string, number, number]));
  assert.equal(findReferenceStart([{ page: 4, text: aps }]), null);
  const start = findNumberedRunStart([{ page: 4, text: aps }]);
  assert.ok(start);
  assert.equal(buildReferenceSet([{ page: 4, text: aps }], start!).numbered.size, 6);
});

test("stray numbered table rows do not turn an author-year list into a numeric one", () => {
  const refs = page(["References", 55, 40], ["1 2 3 table row", 55, 52], ["2 4 5 table row", 55, 62], ["3 6 7 table row", 55, 72], ...[["Adams, A. (2001). T1. J, 1, 1.", 55, 90], ["Baker, B. (2002). T2. J, 2, 2.", 55, 102], ["Clark, C. (2003). T3. J, 3, 3.", 55, 114], ["Davis, D. (2004). T4. J, 4, 4.", 55, 126], ["Evans, E. (2005). T5. J, 5, 5.", 55, 138], ["Frank, F. (2006). T6. J, 6, 6.", 55, 150], ["Green, G. (2007). T7. J, 7, 7.", 55, 162], ["Hall, H. (2008). T8. J, 8, 8.", 55, 174]] as Array<[string, number, number]>);
  const set = buildReferenceSet([{ page: 1, text: refs }], { page: 1, line: 0 });
  assert.equal(set.mode, "ay");
});

import { findCrossRefs, indexCaptions, captionRegion, equationLines } from "../src/crossrefs.ts";

test("equation numbers are not citations, but in-text (1) is", () => {
  const refs = [line("References", {}, 700)].concat(Array.from({ length: 6 }, (_, i) => line(`${i + 1} Author ${i}, Journal, 20${10 + i}.`, {}, 710 + i * 10)));
  const set = buildReferenceSet([{ page: 0, text: { lines: refs } }], { page: 0, line: 0 });
  const eq = line("E = mc2                                                  (2)", {}, 100);
  const alone = line("(3)", {}, 130);
  const prose = line("as shown previously (1) in the text", {}, 160);
  const text = { lines: [eq, alone, prose] };
  const found = findPageCitations(text, set);
  assert.deepEqual(found.map((c) => c.items.map((i) => i.label)), [["1"]]);
  assert.deepEqual(equationLines({ lines: [eq, alone] }, 3), [1]);
});

test("figure and table references, captions and preview regions", () => {
  const text = {
    lines: [
      line("As seen in Fig. 3a and Table 2, and Eq. (5) too, it works well enough here.", {}, 50),
      { ...line("axis label", {}, 200), b: [50, 200, 40, 9] as [number, number, number, number] },
      { ...line("Fig. 3. The result of the experiment on many cells in parallel.", {}, 400), b: [50, 400, 500, 9] as [number, number, number, number] },
    ],
  };
  const refs = findCrossRefs(text);
  assert.deepEqual(refs.map((r) => [r.kind, r.n, r.sub]), [["fig", 3, "a"], ["table", 2, ""], ["eq", 5, ""]]);
  const caps = indexCaptions([{ page: 0, text }]);
  assert.equal(caps.get("fig3")?.line, 2);
  const r = captionRegion(text, 2, 612, 792, "fig");
  assert.ok(r[1] < 200 && r[1] + r[3] >= 409);
});

test("a bare (5) in a sentence is an equation reference; the equation's own number is not", () => {
  const text = { lines: [line("Substituting into (5) and Eqs. (3) and (4) we get f(2) = 1.", {}, 50), line("E = mc2                                                  (5)", {}, 100)] };
  const refs = findCrossRefs(text).filter((r) => r.kind === "eq");
  assert.deepEqual(refs.map((r) => [r.n, !!r.bare]), [[3, false], [5, true], [4, true]]);
});
