// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

/**
 * Resolves the absolute path to the platform-appropriate
 * `glide-helper` executable, given the plugin's own root directory.
 * No Zotero/Node filesystem calls here -- `pathJoin` and `fileExists` are
 * injected so this is fully testable with fakes (brief §15: "missing
 * executable handling" must be tested). This one *is* genuine dependency
 * injection (real I/O, faked in tests), unlike the old `platformModule`/
 * `errors` module-bag parameters removed elsewhere in this migration --
 * those existed only to route around loadSubScript scoping, not for
 * testability.
 */

import { HelperMissingError } from "./errors.ts";
import { resolvePlatformDir, helperFileName } from "./platform.ts";

export interface ResolveHelperOpts {
  /** Plugin install directory (contains `bin/`). */
  rootDir: string;
  /** e.g. the value from glide.ts's `hostPlatform()`, or process.platform in tests. */
  platform: string;
  /** e.g. Zotero.arch, or process.arch in tests. */
  arch: string;
  pathJoin: (...parts: string[]) => string;
  /** May be sync or async -- real Zotero uses async IOUtils.exists. */
  fileExists: (path: string) => boolean | Promise<boolean>;
}

/** @throws {UnsupportedPlatformError | HelperMissingError} */
export async function resolveHelperPath(opts: ResolveHelperOpts): Promise<string> {
  const { rootDir, platform, arch, pathJoin, fileExists } = opts;

  const platformDir = resolvePlatformDir(platform, arch);
  const fileName = helperFileName(platformDir);
  const helperPath = pathJoin(rootDir, "bin", platformDir, fileName);

  const exists = await fileExists(helperPath);
  if (!exists) {
    throw new HelperMissingError(helperPath);
  }
  return helperPath;
}
