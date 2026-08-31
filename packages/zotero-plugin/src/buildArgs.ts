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

/**
 * "Docked" window placement next to Zotero's own window (v0.2 --
 * process isolation is kept; only the window's on-screen position/size
 * change to look integrated. See docs/adr and STATUS.md for why this
 * stays a separate process rather than a literal embedded tab).
 * `x`/`y` are the *target* position for the Fast Reader window itself
 * (fastReader.ts computes this from Zotero's own window geometry, e.g.
 * its right edge), not Zotero's own position.
 */
export interface DockGeometry {
  x: number;
  y: number;
  height: number;
}

export interface BuildHelperArgsOptions {
  page?: number;
  dock?: DockGeometry;
}

export function buildHelperArgs(pdfPath: string, opts?: BuildHelperArgsOptions): string[] {
  if (typeof pdfPath !== "string" || pdfPath.length === 0) {
    throw new TypeError("buildHelperArgs: pdfPath must be a non-empty string");
  }
  const page = opts?.page;
  const dock = opts?.dock;

  const args: string[] = [];
  if (page === undefined || page === null) {
    if (!dock) {
      return [pdfPath];
    }
    args.push(pdfPath);
  } else {
    if (!Number.isInteger(page) || page < 1) {
      throw new TypeError(`buildHelperArgs: page must be a positive integer, got ${page}`);
    }
    args.push("--file", pdfPath, "--page", String(page));
  }

  if (dock) {
    const entries: Array<[string, number]> = [
      ["--dock-x", dock.x],
      ["--dock-y", dock.y],
      ["--dock-height", dock.height],
    ];
    for (const [flag, value] of entries) {
      if (!Number.isInteger(value)) {
        throw new TypeError(`buildHelperArgs: ${flag} must be an integer, got ${value}`);
      }
      args.push(flag, String(value));
    }
  }

  return args;
}
