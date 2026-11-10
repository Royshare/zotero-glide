// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

/**
 * Maps a platform/arch pair to the `bin/<dir>/` name used in
 * docs/cross-platform.md's binary layout. Pure function, no Zotero
 * dependency -- takes plain strings so it's callable identically from
 * Zotero (`Zotero.isMac`/`isWin`/`isLinux` + `Zotero.arch`, mapped by
 * fastReader.ts's `hostPlatform()`) and from Node (`process.platform`/
 * `process.arch`) via a small adapter at the call site, and directly
 * from tests.
 */

import { UnsupportedPlatformError } from "./errors.ts";

export type PlatformDir = "macos-arm64" | "macos-x64" | "windows-x64" | "linux-x64";

export function resolvePlatformDir(platform: string, arch: string): PlatformDir {
  const p = String(platform || "").toLowerCase();
  const a = String(arch || "").toLowerCase();

  const isMac = p === "mac" || p === "darwin" || p === "macos";
  const isWin = p === "win" || p === "win32" || p === "windows";
  const isLinux = p === "linux";

  const isArm64 = a === "aarch64" || a === "arm64";
  const isX64 = a === "x86_64" || a === "x64" || a === "amd64";

  if (isMac && isArm64) return "macos-arm64";
  if (isMac && isX64) return "macos-x64";
  if (isWin && isX64) return "windows-x64";
  if (isLinux && isX64) return "linux-x64";

  throw new UnsupportedPlatformError(platform, arch);
}

export function helperFileName(platformDir: PlatformDir): string {
  return platformDir.startsWith("windows-") ? "fast-reader-helper.exe" : "fast-reader-helper";
}
