/**
 * Zotero-specific glue: menu registration, real filesystem/process APIs,
 * error dialog. Deliberately thin -- all actual decision logic (PDF
 * detection, platform resolution, argv construction, error typing) lives
 * in the pure, unit-tested modules under src/ that this file wires
 * together. See docs/adr and the research citations below for the
 * specific Zotero APIs used:
 *   - Zotero.MenuManager.registerMenu({ target: "main/library/item", ... })
 *     for the item context-menu entry (Zotero 8+; endorsed replacement
 *     for manually injecting into #zotero-itemmenu). Its `MenuData` type
 *     (zotero-types) confirms empirically-found behavior: there is no
 *     `label` field, only `l10nID`/`l10nArgs` -- see the onShowing hook
 *     below for why a plain label is set on the DOM element directly.
 *   - item.getBestAttachment() / attachment.getFilePathAsync() for
 *     resolving a PDF's on-disk path (not zotero.sqlite directly).
 *   - Subprocess.sys.mjs's Subprocess.call({ command, arguments }) for
 *     spawning the helper with an argv array (not a shell string) --
 *     the same primitive Zotero's own code uses internally
 *     (Zotero.Utilities.Internal.subprocess()).
 *
 * Exposed as `Zotero.FastReader` (see index.ts) so bootstrap.js's tiny
 * lifecycle wrapper doesn't need to know anything about this file's
 * internals -- see index.ts and addon/bootstrap.js.
 */

import {
  FastReaderError,
  UnsupportedPlatformError,
  HelperMissingError,
  AttachmentMissingError,
  SpawnError,
  ReaderCrashedError,
} from "./errors.ts";
import { resolveHelperPath } from "./resolveHelper.ts";
import { resolveHelperPathPacked } from "./extractHelper.ts";
import { resolvePdfAttachment, type PdfLikeItem } from "./pdfAttachment.ts";
import { launchFastReader } from "./launchFastReader.ts";
import type { DockGeometry } from "./buildArgs.ts";

type LibraryMenuContext = _ZoteroTypes.MenuManager.LibraryMenuContext;

/** Minimal shape of what Subprocess.sys.mjs's Subprocess.call() resolves to -- not covered by zotero-types (a generic Gecko module, not Zotero-specific). */
interface SubprocessHandle {
  pid: number;
  wait(): Promise<{ exitCode: number }>;
}

interface SubprocessModule {
  call(opts: { command: string; arguments: string[] }): Promise<SubprocessHandle>;
}

const MENU_ID = "fast-reader-open";

class FastReaderPlugin {
  id: string | null = null;
  version: string | null = null;
  rootURI: string | null = null;
  menuID: string | false | null = null;
  private subprocessModule: SubprocessModule | null = null;

  init({ id, version, rootURI }: { id: string; version: string; rootURI: string }): void {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
  }

  addToAllWindows(): void {
    this._registerMenu();
  }

  removeFromAllWindows(): void {
    this._unregisterMenu();
  }

  // Present for symmetry with the brief's onMainWindowLoad/Unload hooks;
  // Zotero.MenuManager registers globally (not per-window), so these are
  // no-ops today but kept as the seam bootstrap.js calls into, in case a
  // future Zotero version's MenuManager becomes per-window.
  addToWindow(_window: Window): void {}
  removeFromWindow(_window: Window): void {}

  private _registerMenu(): void {
    if (!Zotero.MenuManager || typeof Zotero.MenuManager.registerMenu !== "function") {
      Zotero.debug("[fast-reader] Zotero.MenuManager unavailable; menu not registered");
      return;
    }
    this.menuID = Zotero.MenuManager.registerMenu({
      menuID: MENU_ID,
      pluginID: this.id!,
      target: "main/library/item",
      menus: [
        {
          menuType: "menuitem",
          // Zotero.MenuManager's item builder (_initMenu) only ever reads
          // l10nID for display text -- a plain `label` field is accepted
          // by registerMenu() (the MenuData type has no `label` at all)
          // but silently never shown, leaving a blank menu entry.
          // Confirmed by reading Zotero's own _initMenu source live.
          // Rather than add a Fluent .ftl file + locale registration for
          // one static string, set the XUL `label` attribute directly on
          // the real menu element -- context.menuElem is exactly that
          // element (see menuManager.js's _updateMenuEvents), and XUL
          // menuitems have always read their display text from `label`
          // regardless of whether Fluent or plain code set it. onShowing
          // runs every time the popup is about to show, so this is safe
          // to redo each time (idempotent, and cheap).
          onShowing: async (_event: Event, context: LibraryMenuContext) => {
            context.menuElem.setAttribute("label", "Open in Fast Reader");
            const item = context.items?.length === 1 ? context.items[0] : null;
            const attachment = await resolvePdfAttachment(item as PdfLikeItem | null);
            context.setVisible(!!attachment);
          },
          onCommand: async (_event: Event, context: LibraryMenuContext) => {
            const item = context.items?.length === 1 ? context.items[0] : null;
            if (!item) return;
            await this.openInFastReader(item as PdfLikeItem);
          },
        },
      ],
    });
  }

  private _unregisterMenu(): void {
    if (this.menuID && Zotero.MenuManager && typeof Zotero.MenuManager.unregisterMenu === "function") {
      Zotero.MenuManager.unregisterMenu(this.menuID);
    }
    this.menuID = null;
  }

  private _hostPlatform(): string {
    // Zotero.platform does not exist in current Zotero (confirmed live:
    // undefined) -- Zotero.isMac/isWin/isLinux are the real API. Mapped
    // to the same "mac"/"win"/"linux" strings platform.ts's
    // resolvePlatformDir() already expects and is tested against, so no
    // change needed there.
    if (Zotero.isMac) return "mac";
    if (Zotero.isWin) return "win";
    if (Zotero.isLinux) return "linux";
    return "unknown";
  }

  private async _fileExists(path: string): Promise<boolean> {
    try {
      return await IOUtils.exists(path);
    } catch {
      return false;
    }
  }

  private async _spawn(command: string, args: string[]): Promise<SubprocessHandle> {
    if (!this.subprocessModule) {
      const mod: { Subprocess: SubprocessModule } = {} as { Subprocess: SubprocessModule };
      ChromeUtils.defineESModuleGetters(mod, {
        Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
      });
      this.subprocessModule = mod.Subprocess;
    }
    let proc: SubprocessHandle;
    try {
      proc = await this.subprocessModule.call({ command, arguments: args });
    } catch (cause) {
      throw new SpawnError(command, cause);
    }
    // Best-effort "did it crash immediately" check (brief §12): race the
    // process's exit against a short grace period. If it's already exited
    // with a non-zero code before the reader would plausibly have shown a
    // window, treat that as a launch failure rather than silently
    // succeeding. If the timeout wins, the process is presumed running.
    const immediateExit = await Promise.race([
      proc.wait().then((result) => ({ exited: true as const, result })),
      new Promise<{ exited: false }>((resolve) => setTimeout(() => resolve({ exited: false }), 600)),
    ]);
    if (immediateExit.exited && immediateExit.result.exitCode !== 0) {
      throw new ReaderCrashedError(immediateExit.result.exitCode);
    }
    if (!immediateExit.exited) {
      // Still running past the grace period -- log (not surface) any later exit.
      proc.wait().then((result) => {
        Zotero.debug(`[fast-reader] helper exited with code ${result.exitCode}`);
      });
    }
    return proc;
  }

  async openInFastReader(item: PdfLikeItem): Promise<void> {
    try {
      const isPacked = this.rootURI!.startsWith("jar:");
      // A real "Install Plugin From File" install keeps the .xpi packed
      // (rootURI is jar:file:///.../fast-reader@....xpi!/); the dev
      // workflow (zotero-plugin-scaffold's `serve`) installs it unpacked
      // to a real directory. loadSubScript handles both transparently
      // for *script* loading, which is why only the helper-binary path
      // (which needs a real executable on disk, not a resource inside a
      // zip) needs this branch at all -- see extractHelper.ts.
      const resolveHelper = isPacked
        ? () =>
            resolveHelperPathPacked({
              platform: this._hostPlatform(),
              arch: Zotero.arch,
              rootURI: this.rootURI!,
              destDir: PathUtils.join(Zotero.DataDirectory.dir, "fast-reader-helper-bin", this.version!),
              pathJoin: (...parts: string[]) => PathUtils.join(...parts),
              fileExists: (p: string) => this._fileExists(p),
              fetchBytes: (url: string) => this._fetchBytes(url),
              writeBytes: (p: string, bytes: Uint8Array) => IOUtils.write(p, bytes),
              // IOUtils.setPermissions wants a numeric mode, not a
              // string -- "755" is silently misinterpreted (confirmed
              // live: it does not produce rwxr-xr-x), 0o755 does.
              setExecutable: (p: string) => IOUtils.setPermissions(p, 0o755),
            })
        : () =>
            resolveHelperPath({
              rootDir: this._rootDirFromURI(),
              platform: this._hostPlatform(),
              arch: Zotero.arch,
              pathJoin: (...parts: string[]) => PathUtils.join(...parts),
              fileExists: (p: string) => this._fileExists(p),
            });

      await launchFastReader(item, {
        resolveHelperPath: resolveHelper,
        spawn: (command: string, args: string[]) => this._spawn(command, args),
        dock: this._dockGeometry(),
      });
    } catch (error) {
      this._showLaunchError(error);
    }
  }

  /**
   * v0.2 "docked" placement (see docs/adr and STATUS.md: a real, still
   * fully isolated process, just positioned to *look* integrated rather
   * than a literal embedded tab). Targets the space immediately to the
   * right of Zotero's own window, matching its height. Best-effort --
   * returns undefined (falling back to reader-helper's normal centered
   * default) rather than throwing if Zotero's window geometry isn't
   * available for any reason; this is a cosmetic feature, not something
   * that should ever block opening the reader.
   */
  private _dockGeometry(): DockGeometry | undefined {
    try {
      const win = Zotero.getMainWindow();
      if (!win) return undefined;
      return {
        x: win.screenX + win.outerWidth,
        y: win.screenY,
        height: win.outerHeight,
      };
    } catch {
      return undefined;
    }
  }

  private _rootDirFromURI(): string {
    // Only valid for an unpacked (plain file://) install -- see the
    // isPacked branch in openInFastReader above.
    return Zotero.File.pathToFile(this.rootURI!).path;
  }

  private async _fetchBytes(url: string): Promise<Uint8Array> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`failed to fetch ${url}: HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  private _showLaunchError(error: unknown): void {
    const stack = error instanceof Error ? error.stack : String(error);
    Zotero.debug(`[fast-reader] launch failed: ${stack}`);
    const summary = this._summarizeError(error);
    // Services.prompt's nsIPrompt-derived signature wants
    // mozIDOMWindowProxy; Zotero.getMainWindow()'s real return value
    // works fine as the window argument at runtime (this is standard
    // Zotero/Firefox privileged code), but zotero-types' MainWindow
    // (extends DOM Window) and Gecko's mozIDOMWindowProxy don't overlap
    // structurally -- a platform-typing gap, not a real type mismatch.
    const win = Zotero.getMainWindow() as unknown as mozIDOMWindowProxy;
    const buttonFlags =
      Services.prompt.BUTTON_POS_0! * Services.prompt.BUTTON_TITLE_OK! +
      Services.prompt.BUTTON_POS_1! * Services.prompt.BUTTON_TITLE_IS_STRING!;
    const pressed = Services.prompt.confirmEx(
      win,
      "Fast Reader could not be started",
      summary,
      buttonFlags,
      "",
      "Show Details",
      "",
      "",
      { value: false }
    );
    if (pressed === 1) {
      Services.prompt.alert(win, "Fast Reader — Details", stack ?? String(error));
    }
  }

  private _summarizeError(error: unknown): string {
    if (error instanceof HelperMissingError) {
      return "The Fast Reader helper program is missing from this plugin's installation.";
    }
    if (error instanceof AttachmentMissingError) {
      return "The PDF attachment's file could not be found on disk.";
    }
    if (error instanceof UnsupportedPlatformError) {
      return `Fast Reader does not support this platform (${error.platform}/${error.arch}).`;
    }
    if (error instanceof SpawnError) {
      return "The Fast Reader process failed to launch.";
    }
    if (error instanceof ReaderCrashedError) {
      return `Fast Reader started but exited immediately (code ${error.exitCode}).`;
    }
    if (error instanceof FastReaderError) {
      return error.message;
    }
    return "An unexpected error occurred while starting Fast Reader.";
  }
}

export const FastReader = new FastReaderPlugin();
