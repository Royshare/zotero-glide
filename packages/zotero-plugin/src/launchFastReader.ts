/**
 * Orchestrates "Open in Fast Reader": resolve the PDF path, resolve the
 * platform helper binary, build argv, spawn. `resolveHelperPath` and
 * `spawn` are injected (real I/O, faked in tests, and -- for
 * `resolveHelperPath` -- genuinely different per install type, see
 * fastReader.ts's isPacked branch); `getPdfPathForItem`/`buildHelperArgs`
 * are imported directly since they're pure functions with no Zotero
 * dependency of their own. This whole flow, including spawn failure, is
 * testable without Zotero or a real filesystem (brief §15: "argument
 * construction, missing executable handling" must be tested; §12: launch
 * errors must be categorized).
 */

import { AttachmentMissingError, SpawnError } from "./errors.ts";
import { getPdfPathForItem, type PdfLikeItem } from "./pdfAttachment.ts";
import { buildHelperArgs, type DockGeometry } from "./buildArgs.ts";

export interface LaunchFastReaderDeps {
  /** Resolves (and, for a packed install, extracts) the helper binary's real path. */
  resolveHelperPath: () => Promise<string>;
  spawn: (command: string, args: string[]) => Promise<unknown>;
  page?: number;
  /** v0.2: position the reader window next to Zotero's own -- see buildArgs.ts's DockGeometry. */
  dock?: DockGeometry;
}

export async function launchFastReader(
  item: PdfLikeItem | null | undefined,
  deps: LaunchFastReaderDeps
): Promise<unknown> {
  const { resolveHelperPath, spawn, page, dock } = deps;

  const pdfPath = await getPdfPathForItem(item);
  if (!pdfPath) {
    const key = item?.key ?? "(unknown item)";
    throw new AttachmentMissingError(key);
  }

  const helperPath = await resolveHelperPath();
  const args = buildHelperArgs(pdfPath, { page, dock });

  try {
    return await spawn(helperPath, args);
  } catch (cause) {
    throw new SpawnError(helperPath, cause);
  }
}
