/**
 * Orchestrates "Open in Fast Reader": resolve the PDF path, resolve the
 * platform helper binary, build argv, spawn. Every collaborator is passed
 * in via `deps` rather than looked up globally, so this whole flow --
 * including spawn failure -- is testable without Zotero or a real
 * filesystem (brief §15: "argument construction, missing executable
 * handling" must be tested; §12: launch errors must be categorized).
 *
 * @param {Object} item - the selected Zotero item (regular item or attachment)
 * @param {Object} deps
 * @param {Object} deps.errors - src/errors.js exports
 * @param {Object} deps.platform - src/platform.js exports
 * @param {Object} deps.resolveHelper - src/resolveHelper.js exports
 * @param {Object} deps.pdfAttachment - src/pdfAttachment.js exports
 * @param {Object} deps.buildArgs - src/buildArgs.js exports
 * @param {string} deps.rootDir
 * @param {string} deps.hostPlatform - Zotero.platform / process.platform
 * @param {string} deps.hostArch - Zotero.arch / process.arch
 * @param {(...parts: string[]) => string} deps.pathJoin
 * @param {(path: string) => boolean} deps.fileExists
 * @param {(command: string, args: string[]) => Promise<any>} deps.spawn
 * @param {number} [deps.page]
 * @returns {Promise<any>} whatever `spawn` resolves to
 */
async function launchFastReader(item, deps) {
  const {
    errors,
    platform,
    resolveHelper,
    pdfAttachment,
    buildArgs,
    rootDir,
    hostPlatform,
    hostArch,
    pathJoin,
    fileExists,
    spawn,
    page,
  } = deps;

  const pdfPath = await pdfAttachment.getPdfPathForItem(item);
  if (!pdfPath) {
    const key = item && item.key ? item.key : "(unknown item)";
    throw new errors.AttachmentMissingError(key);
  }

  const helperPath = await resolveHelper.resolveHelperPath({
    rootDir,
    platform: hostPlatform,
    arch: hostArch,
    pathJoin,
    fileExists,
    platformModule: platform,
    errors,
  });

  const args = buildArgs.buildHelperArgs(pdfPath, page ? { page } : undefined);

  try {
    return await spawn(helperPath, args);
  } catch (cause) {
    throw new errors.SpawnError(helperPath, cause);
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { launchFastReader };
}
