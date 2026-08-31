/**
 * Builds the argv array passed to `fast-reader-helper` (see brief §7:
 * "Do NOT construct a shell command by concatenating unescaped strings.
 * Use an appropriate process-spawn API with an argument array.")
 *
 * This never returns a string -- callers must pass the result directly as
 * an array to a spawn API (e.g. Zotero's `Subprocess.call({ arguments })`)
 * so paths with spaces, Unicode, and platform-specific separators are
 * never subject to shell quoting/escaping bugs.
 */

export interface BuildHelperArgsOptions {
  page?: number;
}

export function buildHelperArgs(pdfPath: string, opts?: BuildHelperArgsOptions): string[] {
  if (typeof pdfPath !== "string" || pdfPath.length === 0) {
    throw new TypeError("buildHelperArgs: pdfPath must be a non-empty string");
  }
  const page = opts?.page;
  if (page === undefined || page === null) {
    return [pdfPath];
  }
  if (!Number.isInteger(page) || page < 1) {
    throw new TypeError(`buildHelperArgs: page must be a positive integer, got ${page}`);
  }
  return ["--file", pdfPath, "--page", String(page)];
}
