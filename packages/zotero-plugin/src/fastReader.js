/**
 * Zotero-specific glue: menu registration, real filesystem/process APIs,
 * error dialog. Deliberately thin -- all actual decision logic (PDF
 * detection, platform resolution, argv construction, error typing) lives
 * in the pure, unit-tested modules under src/ that this file wires
 * together. See docs/adr and the research citation in this file's history
 * for the specific Zotero APIs used below:
 *   - Zotero.MenuManager.registerMenu({ target: "main/library/item", ... })
 *     for the item context-menu entry (Zotero 8+; endorsed replacement
 *     for manually injecting into #zotero-itemmenu).
 *   - item.getBestAttachment() / attachment.getFilePathAsync() for
 *     resolving a PDF's on-disk path (not zotero.sqlite directly).
 *   - Subprocess.sys.mjs's Subprocess.call({ command, arguments }) for
 *     spawning the helper with an argv array (not a shell string) --
 *     the same primitive Zotero's own code uses internally
 *     (Zotero.Utilities.Internal.subprocess()).
 *
 * Loaded via `Services.scriptloader.loadSubScript(rootURI + 'src/fastReader.js')`
 * with no second (scope) argument, so its top-level `var`/class/const
 * declarations land directly in bootstrap.js's own global -- the standard
 * Zotero bootstrapped-plugin pattern (see e.g. zotero/make-it-red).
 */

/* global Zotero, Services, ChromeUtils, IOUtils, PathUtils */
/* global FastReaderError, UnsupportedPlatformError, HelperMissingError, AttachmentMissingError, SpawnError, ReaderCrashedError */
/* global resolvePlatformDir, helperFileName, resolveHelperPath, isPdfAttachmentItem, resolvePdfAttachment, getPdfPathForItem, buildHelperArgs, launchFastReader */

// bootstrap.js loadSubScript's errors.js, platform.js, resolveHelper.js,
// pdfAttachment.js, buildArgs.js, and launchFastReader.js (in that
// dependency order) before this file, each with no scope argument -- so
// their top-level declarations (the names in the /* global */ block
// above) are already real bindings in this same global by the time this
// file runs. These small "module" bags exist only to match the plain
// object shape the framework-agnostic modules under src/ expect (the same
// shape Node's `require()` gives the test suite) -- see
// src/launchFastReader.js's `deps` parameter.
var errorsModule = {
  FastReaderError,
  UnsupportedPlatformError,
  HelperMissingError,
  AttachmentMissingError,
  SpawnError,
  ReaderCrashedError,
};
var platformModule = { resolvePlatformDir, helperFileName };
var resolveHelperModule = { resolveHelperPath };
var pdfAttachmentModule = { isPdfAttachmentItem, resolvePdfAttachment, getPdfPathForItem };
var buildArgsModule = { buildHelperArgs };
var launchFastReaderModule = { launchFastReader };

var FastReader = {
  id: null,
  version: null,
  rootURI: null,
  menuID: null,

  init({ id, version, rootURI }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
  },

  addToAllWindows() {
    this._registerMenu();
  },

  removeFromAllWindows() {
    this._unregisterMenu();
  },

  // Present for symmetry with the brief's onMainWindowLoad/Unload hooks;
  // Zotero.MenuManager registers globally (not per-window), so these are
  // no-ops today but kept as the seam bootstrap.js calls into, in case a
  // future Zotero version's MenuManager becomes per-window.
  addToWindow(_window) {},
  removeFromWindow(_window) {},

  _registerMenu() {
    if (!Zotero.MenuManager || typeof Zotero.MenuManager.registerMenu !== "function") {
      Zotero.debug("[fast-reader] Zotero.MenuManager unavailable; menu not registered");
      return;
    }
    this.menuID = Zotero.MenuManager.registerMenu({
      menuID: "fast-reader-open",
      pluginID: this.id,
      target: "main/library/item",
      menus: [
        {
          menuType: "menuitem",
          label: "Open in Fast Reader",
          onShowing: async (_event, context) => {
            const item = FastReader._getSelectedItem();
            const attachment = await pdfAttachmentModule.resolvePdfAttachment(item);
            context.setVisible(!!attachment);
          },
          onCommand: async () => {
            const item = FastReader._getSelectedItem();
            if (!item) return;
            await FastReader.openInFastReader(item);
          },
        },
      ],
    });
  },

  _unregisterMenu() {
    if (this.menuID && Zotero.MenuManager && typeof Zotero.MenuManager.unregisterMenu === "function") {
      Zotero.MenuManager.unregisterMenu(this.menuID);
    }
    this.menuID = null;
  },

  _getSelectedItem() {
    const items = Zotero.getActiveZoteroPane().getSelectedItems();
    return items && items.length === 1 ? items[0] : null;
  },

  async _fileExists(path) {
    try {
      return await IOUtils.exists(path);
    } catch (e) {
      return false;
    }
  },

  async _spawn(command, args) {
    ChromeUtils.defineESModuleGetters(this, {
      Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
    });
    let proc;
    try {
      proc = await this.Subprocess.call({ command, arguments: args });
    } catch (cause) {
      throw new errorsModule.SpawnError(command, cause);
    }
    // Best-effort "did it crash immediately" check (brief §12): race the
    // process's exit against a short grace period. If it's already exited
    // with a non-zero code before the reader would plausibly have shown a
    // window, treat that as a launch failure rather than silently
    // succeeding. If the timeout wins, the process is presumed running.
    const immediateExit = await Promise.race([
      proc.wait().then((result) => ({ exited: true, result })),
      new Promise((resolve) => setTimeout(() => resolve({ exited: false }), 600)),
    ]);
    if (immediateExit.exited && immediateExit.result.exitCode !== 0) {
      throw new errorsModule.ReaderCrashedError(immediateExit.result.exitCode);
    }
    if (!immediateExit.exited) {
      // Still running past the grace period -- log (not surface) any later exit.
      proc.wait().then((result) => {
        Zotero.debug(`[fast-reader] helper exited with code ${result.exitCode}`);
      });
    }
    return proc;
  },

  async openInFastReader(item) {
    try {
      await launchFastReaderModule.launchFastReader(item, {
        errors: errorsModule,
        platform: platformModule,
        resolveHelper: resolveHelperModule,
        pdfAttachment: pdfAttachmentModule,
        buildArgs: buildArgsModule,
        rootDir: this._rootDirFromURI(),
        hostPlatform: Zotero.platform,
        hostArch: Zotero.arch,
        pathJoin: (...parts) => PathUtils.join(...parts),
        fileExists: (p) => this._fileExists(p),
        spawn: (command, args) => this._spawn(command, args),
      });
    } catch (error) {
      this._showLaunchError(error);
    }
  },

  _rootDirFromURI() {
    // rootURI is a `file://` or `jar:file://...!/` URI depending on
    // packed vs. unpacked install; PathUtils works from a plain OS path,
    // so unwrap it via a real nsIFile per Zotero's own conventions.
    return Zotero.File.pathToFile(this.rootURI).path;
  },

  _showLaunchError(error) {
    Zotero.debug(`[fast-reader] launch failed: ${error && error.stack ? error.stack : error}`);
    const summary = FastReader._summarizeError(error);
    const win = Zotero.getMainWindow();
    const buttonFlags =
      Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_OK +
      Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_IS_STRING;
    const pressed = Services.prompt.confirmEx(
      win,
      "Fast Reader could not be started",
      summary,
      buttonFlags,
      null,
      "Show Details",
      null,
      null,
      {}
    );
    if (pressed === 1) {
      Services.prompt.alert(win, "Fast Reader — Details", String(error && error.stack ? error.stack : error));
    }
  },

  _summarizeError(error) {
    if (error instanceof errorsModule.HelperMissingError) {
      return "The Fast Reader helper program is missing from this plugin's installation.";
    }
    if (error instanceof errorsModule.AttachmentMissingError) {
      return "The PDF attachment's file could not be found on disk.";
    }
    if (error instanceof errorsModule.UnsupportedPlatformError) {
      return `Fast Reader does not support this platform (${error.platform}/${error.arch}).`;
    }
    if (error instanceof errorsModule.SpawnError) {
      return "The Fast Reader process failed to launch.";
    }
    if (error instanceof errorsModule.ReaderCrashedError) {
      return `Fast Reader started but exited immediately (code ${error.exitCode}).`;
    }
    return "An unexpected error occurred while starting Fast Reader.";
  },
};
