/**
 * Resolves the absolute path to the platform-appropriate
 * `fast-reader-helper` executable, given the plugin's own root directory.
 * No Zotero/Node filesystem calls here -- `pathJoin` and `fileExists` are
 * injected so this is fully testable with fakes (brief §15: "missing
 * executable handling" must be tested).
 *
 * @param {Object} opts
 * @param {string} opts.rootDir - plugin install directory (contains `bin/`)
 * @param {string} opts.platform - e.g. Zotero.platform or process.platform
 * @param {string} opts.arch - e.g. Zotero.arch or process.arch
 * @param {(...parts: string[]) => string} opts.pathJoin
 * @param {(path: string) => (boolean|Promise<boolean>)} opts.fileExists - may be sync or async (real Zotero uses async IOUtils.exists)
 * @param {{resolvePlatformDir: Function, helperFileName: Function}} opts.platformModule
 * @param {Object} opts.errors - the errors module (dependency-injected, see src/errors.js)
 * @returns {Promise<string>} absolute path to the helper executable
 * @throws {UnsupportedPlatformError|HelperMissingError}
 */
async function resolveHelperPath(opts) {
  const { rootDir, platform, arch, pathJoin, fileExists, platformModule, errors } = opts;

  const platformDir = platformModule.resolvePlatformDir(platform, arch, errors);
  const fileName = platformModule.helperFileName(platformDir);
  const helperPath = pathJoin(rootDir, "bin", platformDir, fileName);

  const exists = await fileExists(helperPath);
  if (!exists) {
    throw new errors.HelperMissingError(helperPath);
  }
  return helperPath;
}

const exportsObj = { resolveHelperPath };

if (typeof module !== "undefined" && module.exports) {
  module.exports = exportsObj;
}
