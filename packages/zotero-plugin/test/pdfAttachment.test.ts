import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isPdfAttachmentItem,
  resolvePdfAttachment,
  getPdfPathForItem,
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

test("getPdfPathForItem: resolves the attachment's file path for a regular item", async () => {
  const path = await getPdfPathForItem(regularItemWithPdf("/x/y.pdf"));
  assert.equal(path, "/x/y.pdf");
});

test("getPdfPathForItem: resolves directly when given the PDF attachment itself", async () => {
  const path = await getPdfPathForItem(pdfAttachment("/x/y.pdf"));
  assert.equal(path, "/x/y.pdf");
});

test("getPdfPathForItem: null when the attachment file is missing on disk", async () => {
  const attachment: PdfLikeItem = {
    isPDFAttachment: () => true,
    isRegularItem: () => false,
    getFilePathAsync: async () => false, // Zotero's real API returns `false` for a missing file
  };
  assert.equal(await getPdfPathForItem(attachment), null);
});

test("getPdfPathForItem: null when there is no PDF attachment to resolve", async () => {
  assert.equal(await getPdfPathForItem(regularItemWithoutAttachment()), null);
});
