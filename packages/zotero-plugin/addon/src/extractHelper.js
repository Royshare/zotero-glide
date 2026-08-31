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
 *
 * Same call shape as resolveHelper.resolveHelperPath (platform/arch/
 * platformModule/errors), plus the extra dependencies extraction needs,
 * so launchFastReader.js's call site is identical regardless of which
 * implementation fastReader.js injects for a given install -- see its
 * `isPacked` branch.
 *
 * @param {Object} opts
 * @param {string} opts.platform
 * @param {string} opts.arch
 * @param {Object} opts.platformModule
 * @param {Object} opts.errors
 * @param {string} opts.rootURI - the plugin's rootURI (jar: or file:), used to build the fetch source URL
 * @param {string} opts.destDir - a real, writable directory to extract into (version-scoped by the caller so upgrades don't reuse a stale binary)
 * @param {(...parts: string[]) => string} opts.pathJoin
 * @param {(path: string) => Promise<boolean>} opts.fileExists
 * @param {(url: string) => Promise<Uint8Array>} opts.fetchBytes
 * @param {(path: string, bytes: Uint8Array) => Promise<void>} opts.writeBytes
 * @param {(path: string) => Promise<void>} opts.setExecutable
 * @returns {Promise<string>} the real, executable path to the helper binary
 */
async function resolveHelperPathPacked(opts) {
  const {
    platform,
    arch,
    platformModule,
    errors,
    rootURI,
    destDir,
    pathJoin,
    fileExists,
    fetchBytes,
    writeBytes,
    setExecutable,
  } = opts;

  const platformDir = platformModule.resolvePlatformDir(platform, arch, errors);
  const fileName = platformModule.helperFileName(platformDir);
  const destPath = pathJoin(destDir, platformDir, fileName);

  if (await fileExists(destPath)) {
    return destPath;
  }

  const sourceURL = `${rootURI}bin/${platformDir}/${fileName}`;
  let bytes;
  try {
    bytes = await fetchBytes(sourceURL);
  } catch (cause) {
    throw new errors.HelperMissingError(sourceURL);
  }
  if (!bytes || bytes.byteLength === 0) {
    throw new errors.HelperMissingError(sourceURL);
  }
  await writeBytes(destPath, bytes);
  await setExecutable(destPath);
  return destPath;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { resolveHelperPathPacked };
}
