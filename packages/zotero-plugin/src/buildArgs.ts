// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

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

/**
 * argv for the headless in-tab mode: `--serve --frame-dir DIR --file PDF
 * [--page N]` (see packages/reader-helper/src/main.rs). Like
 * buildHelperArgs, always an array -- never a shell string.
 */
export function buildServeArgs(pdfPath: string, frameDir: string, page?: number): string[] {
  if (typeof pdfPath !== "string" || pdfPath.length === 0) {
    throw new TypeError("buildServeArgs: pdfPath must be a non-empty string");
  }
  if (typeof frameDir !== "string" || frameDir.length === 0) {
    throw new TypeError("buildServeArgs: frameDir must be a non-empty string");
  }
  const args = ["--serve", "--frame-dir", frameDir, "--file", pdfPath];
  if (page !== undefined) {
    if (!Number.isInteger(page) || page < 1) {
      throw new TypeError(`buildServeArgs: page must be a positive integer, got ${page}`);
    }
    args.push("--page", String(page));
  }
  return args;
}

/**
 * Environment for the headless helper. The allocator only reads these at
 * process start, so they must be set by the launcher. Both knobs make the
 * allocator hand large freed buffers (page renders are 10-25 MB) back to the
 * OS instead of keeping them resident. Measured with
 * scripts/benchmark-serve.py:
 *
 * - macOS `MallocSpaceEfficient=1`: steady-state footprint of a text PDF
 *   46 -> 24 MB; `trim` ends at ~3 MB instead of retaining the whole peak
 *   (image-heavy scan: 272 -> 3 MB).
 * - Linux (glibc 2.36, aarch64, in a container) `MALLOC_MMAP_THRESHOLD_=1048576`:
 *   text PDF 71 -> 27 MB while reading, `trim` 8 -> 6 MB; scan `trim`
 *   132 -> 10 MB.
 *
 * No measurable latency cost on either. Windows: not measured, nothing set.
 */
export function helperEnvironment(platform: string): Record<string, string> {
  if (platform === "mac") return { MallocSpaceEfficient: "1" };
  if (platform === "linux") return { MALLOC_MMAP_THRESHOLD_: "1048576" };
  return {};
}
