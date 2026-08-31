/**
 * PDF attachment detection and path resolution, using only the Zotero
 * item API surface confirmed during research (see docs/adr and
 * fastReader.ts's citation comment): `item.isRegularItem()`,
 * `item.isPDFAttachment()`, `item.getBestAttachment()`,
 * `attachment.getFilePathAsync()`. No direct zotero.sqlite access (brief
 * §3/§20 non-goal).
 *
 * Every function here takes `PdfLikeItem`, a narrow structural interface
 * (not the real, much larger `Zotero.Item` type) capturing only the
 * methods actually used, so tests can pass plain object fakes -- see
 * test/pdfAttachment.test.ts. A real `Zotero.Item` satisfies this
 * structurally with no cast needed.
 */

export interface PdfLikeItem {
  key?: string;
  isPDFAttachment?: () => boolean;
  isFileAttachment?: () => boolean;
  attachmentContentType?: string;
  isRegularItem?: () => boolean;
  getBestAttachment?: () => Promise<PdfLikeItem | null | undefined | false>;
  getFilePathAsync?: () => Promise<string | false>;
}

/**
 * True if `item` is itself a PDF file attachment (not a regular
 * bibliographic item, and not a non-PDF attachment like a snapshot or
 * linked URL).
 */
export function isPdfAttachmentItem(item: PdfLikeItem | null | undefined): boolean {
  if (!item) return false;
  if (typeof item.isPDFAttachment === "function") {
    return !!item.isPDFAttachment();
  }
  // Fallback for fakes/older API surfaces that don't expose isPDFAttachment().
  const isFileAttachment =
    typeof item.isFileAttachment === "function" ? item.isFileAttachment() : false;
  return isFileAttachment && item.attachmentContentType === "application/pdf";
}

/**
 * Given whatever the user right-clicked (a regular item, or an attachment
 * directly), returns the PDF attachment item to open in Fast Reader, or
 * `null` if there isn't one. Mirrors the brief §12 "only show/enable it
 * when appropriate" requirement -- this is also what the context-menu
 * `onShowing` visibility check calls.
 */
export async function resolvePdfAttachment(
  item: PdfLikeItem | null | undefined
): Promise<PdfLikeItem | null> {
  if (!item) return null;
  if (isPdfAttachmentItem(item)) return item;
  if (typeof item.isRegularItem === "function" && item.isRegularItem()) {
    if (typeof item.getBestAttachment !== "function") return null;
    const best = await item.getBestAttachment();
    return best && isPdfAttachmentItem(best) ? best : null;
  }
  return null;
}

/**
 * Resolves the on-disk path for the PDF attachment relevant to `item`
 * (regular item or attachment), or `null` if there is none / the file is
 * missing on disk. Uses `getFilePathAsync()` specifically, not the
 * cache-only sync `getFilePath()` (see fastReader.ts's research citation).
 */
export async function getPdfPathForItem(item: PdfLikeItem | null | undefined): Promise<string | null> {
  const attachment = await resolvePdfAttachment(item);
  if (!attachment || typeof attachment.getFilePathAsync !== "function") {
    return null;
  }
  const path = await attachment.getFilePathAsync();
  return path || null;
}
