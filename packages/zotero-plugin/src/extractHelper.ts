/**
 * Resolves the platform helper binary to a real, executable path on disk,
 * extracting it first if necessary.
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
 */

import { HelperMissingError } from "./errors.ts";
import { resolvePlatformDir, helperFileName } from "./platform.ts";

export interface ResolveHelperPathPackedOpts {
  platform: string;
  arch: string;
  /** The plugin's rootURI (jar: or file:), used to build the fetch source URL. */
  rootURI: string;
  /** A real, writable directory to extract into (version-scoped by the caller so upgrades don't reuse a stale binary). */
  destDir: string;
  pathJoin: (...parts: string[]) => string;
  fileExists: (path: string) => Promise<boolean>;
  fetchBytes: (url: string) => Promise<Uint8Array>;
  /** Real Zotero usage is `IOUtils.write`, which resolves with the byte count -- the value is unused here. */
  writeBytes: (path: string, bytes: Uint8Array) => Promise<unknown>;
  setExecutable: (path: string) => Promise<void>;
}

/** @throws {UnsupportedPlatformError | HelperMissingError} */
export async function resolveHelperPathPacked(opts: ResolveHelperPathPackedOpts): Promise<string> {
  const { platform, arch, rootURI, destDir, pathJoin, fileExists, fetchBytes, writeBytes, setExecutable } =
    opts;

  const platformDir = resolvePlatformDir(platform, arch);
  const fileName = helperFileName(platformDir);
  const destPath = pathJoin(destDir, platformDir, fileName);

  if (await fileExists(destPath)) {
    return destPath;
  }

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
