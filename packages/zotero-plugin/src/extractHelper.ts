// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

/**
 * Extracts the platform helper binary to a real, executable path on disk.
 *
 * A real "Install Plugin From File" install keeps the .xpi as a packed
 * zip -- Zotero runs the plugin's JS directly out of it via `jar:` URIs
 * (Services.scriptloader.loadSubScript handles that transparently, which
 * is why the rest of this plugin's code never needed to know) -- but
 * `Subprocess.call()` cannot execute a binary that lives inside a zip.
 * A packed install must copy `bin/<platform>/<binary>` out to a writable
 * location before it can be spawned. (Confirmed live against a real
 * install: `rootURI` is `jar:file:///.../fast-reader@....xpi!/` in that
 * case, not a plain `file://` directory -- see STATUS.md.)
 *
 * Never trusts a file merely because it exists (an earlier version skipped
 * extraction whenever the destination existed, keyed only on the plugin's
 * version string -- across many rebuilds the version never changed, so an
 * *old* binary kept being reused after every reinstall and broke in a
 * confusing way). It compares the packed bytes with what is on disk instead.
 *
 * And it never overwrites the binary in place. Doing so is fatal on macOS:
 * once a binary has been run, rewriting the same file makes the kernel
 * reject the next launch from it, so the *second* reader tab opened in a
 * session died immediately with SIGKILL ("stopped unexpectedly (exit code
 * -9)"). Reproduced and fixed: if the bytes already match, nothing is
 * written; otherwise the new binary is written to a temp file next to it
 * and renamed over the old one (a new file, so helpers still running from
 * the old one are unaffected and new launches are clean).
 */

import { HelperMissingError } from "./errors.ts";
import { resolvePlatformDir, helperFileName } from "./platform.ts";

export interface ResolveHelperPathPackedOpts {
  platform: string;
  arch: string;
  /** The plugin's rootURI (jar: or file:), used to build the fetch source URL. */
  rootURI: string;
  /** A real, writable directory to extract into. */
  destDir: string;
  pathJoin: (...parts: string[]) => string;
  fetchBytes: (url: string) => Promise<Uint8Array>;
  writeBytes: (path: string, bytes: Uint8Array) => Promise<unknown>;
  setExecutable: (path: string) => Promise<void>;
  /** The current bytes at `path`, or null if there is no such file. */
  readExisting: (path: string) => Promise<Uint8Array | null>;
  /** Atomically renames `from` over `to` (replacing it). */
  moveFile: (from: string, to: string) => Promise<unknown>;
  removeFile?: (path: string) => Promise<unknown>;
  /** Unique suffix for the temp file; injectable for tests. */
  tempSuffix?: () => string;
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** @throws {UnsupportedPlatformError | HelperMissingError} */
export async function resolveHelperPathPacked(opts: ResolveHelperPathPackedOpts): Promise<string> {
  const { platform, arch, rootURI, destDir, pathJoin, fetchBytes, writeBytes, setExecutable, readExisting, moveFile, removeFile } = opts;

  const platformDir = resolvePlatformDir(platform, arch);
  const fileName = helperFileName(platformDir);
  const destPath = pathJoin(destDir, platformDir, fileName);
  const sourceURL = `${rootURI}bin/${platformDir}/${fileName}`;

  let bytes: Uint8Array;
  try {
    bytes = await fetchBytes(sourceURL);
  } catch {
    throw new HelperMissingError(sourceURL);
  }
  if (!bytes || bytes.byteLength === 0) {
    throw new HelperMissingError(sourceURL);
  }

  const existing = await readExisting(destPath).catch(() => null);
  if (existing && sameBytes(existing, bytes)) {
    return destPath; // already the right binary: touch nothing
  }

  const suffix = opts.tempSuffix ? opts.tempSuffix() : Math.random().toString(36).slice(2);
  const tmpPath = `${destPath}.${suffix}.tmp`;
  try {
    await writeBytes(tmpPath, bytes);
    await setExecutable(tmpPath);
    await moveFile(tmpPath, destPath);
  } catch (e) {
    await removeFile?.(tmpPath)?.catch?.(() => {});
    throw e;
  }
  return destPath;
}
