/**
 * Maps a platform/arch pair to the `bin/<dir>/` name used in
 * docs/cross-platform.md's binary layout. Pure function, no Zotero/Node
 * dependency -- takes plain strings so it's callable identically from
 * Zotero (`Zotero.platform`/`Zotero.arch`) and from Node
 * (`process.platform`/`process.arch`) via a small adapter at the call
 * site, and directly from tests.
 */

/** @throws {UnsupportedPlatformError} */
function resolvePlatformDir(platform, arch, errors) {
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

  throw new errors.UnsupportedPlatformError(platform, arch);
}

function helperFileName(platformDir) {
  return platformDir.startsWith("windows-") ? "fast-reader-helper.exe" : "fast-reader-helper";
}

const exportsObj = { resolvePlatformDir, helperFileName };

if (typeof module !== "undefined" && module.exports) {
  module.exports = exportsObj;
}
