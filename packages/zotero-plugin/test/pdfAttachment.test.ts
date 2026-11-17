// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isPdfAttachmentItem,
  resolvePdfAttachment,
  type PdfLikeItem,
} from "../src/pdfAttachment.ts";

function pdfAttachment(path = "/storage/ABCD1234/paper.pdf"): PdfLikeItem {
  return {
    isPDFAttachment: () => true,
    isRegularItem: () => false,
    getFilePathAsync: async () => path,
  };
}

function snapshotAttachment(): PdfLikeItem {
  return {
    isPDFAttachment: () => false,
    isFileAttachment: () => true,
    attachmentContentType: "text/html",
    isRegularItem: () => false,
  };
}

function regularItemWithPdf(path = "/storage/ABCD1234/paper.pdf"): PdfLikeItem {
  const attachment = pdfAttachment(path);
  return {
    isRegularItem: () => true,
    isPDFAttachment: () => false,
    getBestAttachment: async () => attachment,
  };
}

function regularItemWithoutAttachment(): PdfLikeItem {
  return {
    isRegularItem: () => true,
    isPDFAttachment: () => false,
    getBestAttachment: async () => null,
  };
}

function regularItemWithNonPdfAttachment(): PdfLikeItem {
  return {
    isRegularItem: () => true,
    isPDFAttachment: () => false,
    getBestAttachment: async () => snapshotAttachment(),
  };
}

test("isPdfAttachmentItem: true for a PDF attachment", () => {
  assert.equal(isPdfAttachmentItem(pdfAttachment()), true);
});

test("isPdfAttachmentItem: false for a non-PDF attachment", () => {
  assert.equal(isPdfAttachmentItem(snapshotAttachment()), false);
});

test("isPdfAttachmentItem: false for null/undefined", () => {
  assert.equal(isPdfAttachmentItem(null), false);
  assert.equal(isPdfAttachmentItem(undefined), false);
});

test("isPdfAttachmentItem: falls back correctly when isPDFAttachment() is absent", () => {
  const legacyLikeItem: PdfLikeItem = {
    isFileAttachment: () => true,
    attachmentContentType: "application/pdf",
  };
  assert.equal(isPdfAttachmentItem(legacyLikeItem), true);
});

test("resolvePdfAttachment: returns the item itself when it is already a PDF attachment", async () => {
  const item = pdfAttachment();
  assert.equal(await resolvePdfAttachment(item), item);
});

test("resolvePdfAttachment: resolves a regular item's best PDF attachment", async () => {
  const item = regularItemWithPdf();
  const attachment = await resolvePdfAttachment(item);
  assert.ok(attachment);
  assert.equal(isPdfAttachmentItem(attachment), true);
});

test("resolvePdfAttachment: null when the regular item has no attachment at all", async () => {
  assert.equal(await resolvePdfAttachment(regularItemWithoutAttachment()), null);
});

test("resolvePdfAttachment: null when the best attachment is not a PDF (e.g. a web snapshot)", async () => {
  assert.equal(await resolvePdfAttachment(regularItemWithNonPdfAttachment()), null);
});

test("resolvePdfAttachment: null for null item (menu shown with nothing selected)", async () => {
  assert.equal(await resolvePdfAttachment(null), null);
});

import { tabTitleForItem } from "../src/pdfAttachment.ts";

test("tabTitleForItem prefers the parent title, then own title, then filename, then path basename", () => {
  assert.equal(tabTitleForItem({ parentItem: { getDisplayTitle: () => "Parent Paper" }, getDisplayTitle: () => "PDF" }, "/x/a.pdf"), "Parent Paper");
  assert.equal(tabTitleForItem({ getDisplayTitle: () => "Own Title" }, "/x/a.pdf"), "Own Title");
  assert.equal(tabTitleForItem({ attachmentFilename: "file.pdf" }, "/x/a.pdf"), "file.pdf");
  assert.equal(tabTitleForItem({}, "/x/y/a.pdf"), "a.pdf");
  assert.equal(tabTitleForItem(null, "C:\\docs\\b.pdf"), "b.pdf");
});

test("tabTitleForItem strips control characters (they break Zotero's tab DOM)", () => {
  assert.equal(tabTitleForItem({ getDisplayTitle: () => "A\u0001B\n" }, "/x.pdf"), "AB");
});
