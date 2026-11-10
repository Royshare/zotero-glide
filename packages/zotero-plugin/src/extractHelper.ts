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
 * Always re-extracts (overwrites any existing file at destPath) rather
 * than skipping when the destination already exists. An earlier version
 * skipped extraction whenever the file existed, keyed only on the
 * plugin's package.json version string -- which broke in exactly the way
 * a real user hit: across many rebuilds during development the version
 * never changed, so an *old* extracted binary (predating a later argv
 * change) kept being reused after every reinstall, silently, with no
 * indication anything was stale, until it failed to understand a new
 * flag and the launch broke in a confusing way. The fetch+write here
 * measures well under a second even for a several-MB binary (confirmed
 * live), so paying that cost on every launch is a small, predictable
 * price for never serving a stale binary again -- simpler and more
 * robust than a cache-invalidation scheme that has to correctly track
 * every reason the binary might have changed.
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
}

/** @throws {UnsupportedPlatformError | HelperMissingError} */
export async function resolveHelperPathPacked(opts: ResolveHelperPathPackedOpts): Promise<string> {
  const { platform, arch, rootURI, destDir, pathJoin, fetchBytes, writeBytes, setExecutable } = opts;

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
  await writeBytes(destPath, bytes);
  await setExecutable(destPath);
  return destPath;
}
