// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

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
import { resolvePdfAttachment, tabTitleForItem, type PdfLikeItem } from "./pdfAttachment.ts";
import { launchFastReader } from "./launchFastReader.ts";
import { buildServeArgs, helperEnvironment, type DockGeometry } from "./buildArgs.ts";
import type { HelperProcess } from "./helperConnection.ts";
import { ReaderTab, TAB_TYPE, type HostActions, type ZoteroTabs } from "./readerTab.ts";
import { PositionStore } from "./positionStore.ts";
import { createAnnotationBackend, createSettingsStore, parseTrimDelayMs, readerLocation, type AttachmentApi } from "./zoteroAdapters.ts";
import { withoutTabType, type SessionTab } from "./sessionState.ts";

type LibraryMenuContext = _ZoteroTypes.MenuManager.LibraryMenuContext;

/** Minimal shape of what Subprocess.sys.mjs's Subprocess.call() resolves to -- not covered by zotero-types (a generic Gecko module, not Zotero-specific). */
interface SubprocessHandle extends HelperProcess {
  pid: number;
}

interface SubprocessModule {
  call(opts: {
    command: string;
    arguments: string[];
    stderr?: "ignore" | "stdout" | "pipe";
    environment?: Record<string, string>;
    environmentAppend?: boolean;
  }): Promise<SubprocessHandle>;
}

/** The bit of Zotero's main window this plugin touches for tabs. */
interface TabsWindow {
  Zotero_Tabs?: ZoteroTabs & { getState(): SessionTab[] };
  document: Document;
}

/** The bits of a Zotero attachment item this plugin touches directly. */
interface ZItem {
  id: number;
  parentItemID?: number | false;
}

const MENU_ID = "fast-reader-open";
const MENU_ID_WINDOW = "fast-reader-open-window";
const OBSERVER_ID = "fast-reader-tabs";

class FastReaderPlugin {
  id: string | null = null;
  version: string | null = null;
  rootURI: string | null = null;
  menuID: string | false | null = null;
  windowMenuID: string | false | null = null;
  private subprocessModule: SubprocessModule | null = null;
  private readerTabs = new Set<ReaderTab>();
  private originalGetState: (() => SessionTab[]) | null = null;
  private _originalReaderOpen: ((...a: unknown[]) => Promise<unknown>) | null = null;
  private _bypassReaderPatch = false;
  /** Set while Zotero's viewAttachment resolves a missing file, so the reader it opens is ours. */
  private _openNextInFastReader = false;
  private notifierID: string | null = null;

  init({ id, version, rootURI }: { id: string; version: string; rootURI: string }): void {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
  }

  addToAllWindows(): void {
    this._registerPrefs();
    this._registerMenu();
    this._registerTabSupport(Zotero.getMainWindow() as unknown as TabsWindow | null);
    this._patchReaderOpen();
  }

  removeFromAllWindows(): void {
    this._unregisterMenu();
    this._unpatchReaderOpen();
    this._unregisterTabSupport();
  }

  // Present for symmetry with the brief's onMainWindowLoad/Unload hooks;
  // Zotero.MenuManager registers globally (not per-window), so these are
  // no-ops today but kept as the seam bootstrap.js calls into, in case a
  // future Zotero version's MenuManager becomes per-window.
  // The tab restore hook lives on the window's Zotero_Tabs, so it IS
  // per-window: (re)register it whenever a main window loads.
  addToWindow(window: Window): void {
    this._registerTabSupport(window as unknown as TabsWindow);
  }
  removeFromWindow(_window: Window): void {}

  /** Default values and the pane in Zotero's Settings window (Tools > Settings > Fast Reader). */
  private _registerPrefs(): void {
    try {
      const defaults = Services.prefs.getDefaultBranch("extensions.zotero.");
      defaults.setBoolPref("fastReader.defaultOpener", false);
      defaults.setIntPref("fastReader.trimDelaySeconds", 2);
      const panes = (Zotero as unknown as { PreferencePanes?: { register(o: Record<string, unknown>): Promise<string> } }).PreferencePanes;
      if (panes && this.id && this.rootURI) {
        void panes.register({ pluginID: this.id, src: this.rootURI + "content/preferences.xhtml", label: "Fast Reader" });
      }
    } catch (e) {
      Zotero.debug(`[fast-reader] could not register preferences: ${e}`);
    }
  }

  private _registerMenu(): void {
    if (!Zotero.MenuManager || typeof Zotero.MenuManager.registerMenu !== "function") {
      Zotero.debug("[fast-reader] Zotero.MenuManager unavailable; menu not registered");
      return;
    }
    const entry = (label: string, open: (item: PdfLikeItem) => Promise<void>) => ({
      menuType: "menuitem" as const,
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
        context.menuElem.setAttribute("label", label);
        const item = context.items?.length === 1 ? context.items[0] : null;
        const attachment = await resolvePdfAttachment(item as PdfLikeItem | null);
        context.setVisible(!!attachment);
      },
      onCommand: async (_event: Event, context: LibraryMenuContext) => {
        const item = context.items?.length === 1 ? context.items[0] : null;
        if (!item) return;
        await open(item as PdfLikeItem);
      },
    });
    // Primary: a tab in Zotero's own tab bar. Secondary: the original
    // standalone window (kept: it has the lowest possible coupling to Zotero).
    this.menuID = Zotero.MenuManager.registerMenu({
      menuID: MENU_ID,
      pluginID: this.id!,
      target: "main/library/item",
      menus: [entry("Open in Fast Reader", (i) => this.openInTab(i))],
    });
    this.windowMenuID = Zotero.MenuManager.registerMenu({
      menuID: MENU_ID_WINDOW,
      pluginID: this.id!,
      target: "main/library/item",
      menus: [entry("Open in Fast Reader (separate window)", (i) => this.openInFastReader(i))],
    });
  }

  private _unregisterMenu(): void {
    if (this.menuID && Zotero.MenuManager && typeof Zotero.MenuManager.unregisterMenu === "function") {
      Zotero.MenuManager.unregisterMenu(this.menuID);
    }
    if (this.windowMenuID && Zotero.MenuManager && typeof Zotero.MenuManager.unregisterMenu === "function") {
      Zotero.MenuManager.unregisterMenu(this.windowMenuID);
    }
    this.menuID = null;
    this.windowMenuID = null;
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

  /**
   * Resolves (and, for a packed install, extracts) the helper binary.
   */
  private _resolveHelper(): Promise<string> {
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
            fetchBytes: (url: string) => this._fetchBytes(url),
            writeBytes: (p: string, bytes: Uint8Array) => IOUtils.write(p, bytes),
            // never write over a binary that may be running (macOS then kills the next launch) -- see extractHelper.ts
            readExisting: async (p: string) => ((await IOUtils.exists(p)) ? await IOUtils.read(p) : null),
            moveFile: (from: string, to: string) => IOUtils.move(from, to),
            removeFile: (p: string) => IOUtils.remove(p, { ignoreAbsent: true }),
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

    return resolveHelper();
  }

  async openInFastReader(item: PdfLikeItem): Promise<void> {
    try {
      await launchFastReader(item, {
        resolveHelperPath: () => this._resolveHelper(),
        spawn: (command: string, args: string[]) => this._spawn(command, args),
        dock: this._dockGeometry(),
      });
    } catch (error) {
      this._showLaunchError(error);
    }
  }

  /**
   * Opens the PDF as a tab in Zotero's own tab bar (the default action).
   * Spawns a per-tab headless helper (`--serve`); closing the tab ends it.
   * Re-opening a PDF that already has a reader tab just selects that tab.
   */
  async openInTab(item: PdfLikeItem, loc: { pageIndex?: number; annotationKey?: string } = {}): Promise<void> {
    let proc: SubprocessHandle | null = null;
    let frameDir: string | null = null;
    try {
      const win = Zotero.getMainWindow() as unknown as TabsWindow | null;
      const tabs = win?.Zotero_Tabs;
      if (!win || !tabs) {
        throw new FastReaderError("Zotero's tab bar is not available in this window.");
      }
      const attachment = await resolvePdfAttachment(item);
      const pdfPath = attachment && typeof attachment.getFilePathAsync === "function" ? await attachment.getFilePathAsync() : null;
      if (!attachment) {
        throw new AttachmentMissingError(item?.key ?? "(unknown item)");
      }
      if (!pdfPath) {
        // The item is a PDF attachment but its file isn't on disk (e.g. a synced file that hasn't been downloaded
        // yet). Zotero's own flow knows what to do -- download it, or offer to locate it -- so use that instead of a
        // dead-end error; once the file exists it opens here (see _openNextInFastReader).
        await this._viewMissingAttachment((attachment as unknown as ZItem).id);
        return;
      }

      for (const open of this.readerTabs) {
        if (open.pdfPath === pdfPath) {
          open.reveal(loc);
          return;
        }
      }

      const helperPath = await this._resolveHelper();
      frameDir = PathUtils.join(PathUtils.tempDir, `zotero-fast-reader-${Zotero.Utilities.randomString(10)}`);
      try {
        proc = await this._subprocess().call({
          command: helperPath,
          arguments: buildServeArgs(pdfPath, frameDir),
          // helper's own error text (e.g. "failed to open document") arrives
          // on stdout as non-JSON lines and is shown if the tab dies early
          stderr: "stdout",
          // allocator tuning that keeps an idle/backgrounded tab small -- see buildArgs.ts
          environment: helperEnvironment(this._hostPlatform()),
          environmentAppend: true,
        });
      } catch (cause) {
        throw new SpawnError(helperPath, cause);
      }

      const tab = new ReaderTab({
        tabs,
        doc: win.document,
        isMac: !!Zotero.isMac,
        title: tabTitleForItem(attachment, pdfPath),
        pdfPath,
        frameDir,
        proc,
        readFile: (path) => IOUtils.read(path),
        removeFile: (path) => IOUtils.remove(path, { ignoreAbsent: true }),
        removeDir: (path) => IOUtils.remove(path, { recursive: true, ignoreAbsent: true }),
        setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
        clearTimeout: (id) => clearTimeout(id as never),
        debug: (msg) => Zotero.debug(msg),
        requestAnimationFrame: (fn) => (win as unknown as { requestAnimationFrame(f: () => void): number }).requestAnimationFrame(fn),
        trimDelayMs: () => parseTrimDelayMs(Zotero.Prefs.get("fastReader.trimDelaySeconds")),
        collectGarbage: () => {
          try {
            (win as unknown as { windowUtils: { garbageCollect(): void } }).windowUtils.garbageCollect();
          } catch (e) {
            Zotero.debug(`[fast-reader] garbageCollect failed: ${e}`);
          }
        },
        annotations: createAnnotationBackend(Zotero as never, attachment as unknown as AttachmentApi, (m) => this._notify(m)),
        host: this._hostActions(attachment as unknown as ZItem, pdfPath),
        positions: new PositionStore({
          get: () => (Zotero.Prefs.get("fastReader.positions") as string | undefined) || undefined,
          set: (v) => Zotero.Prefs.set("fastReader.positions", v),
        }),
        positionKey: `${(attachment as unknown as AttachmentApi).libraryID}/${(attachment as unknown as AttachmentApi).key}`,
        settings: createSettingsStore({
          get: () => (Zotero.Prefs.get("fastReader.settings") as string | undefined) || undefined,
          set: (v) => Zotero.Prefs.set("fastReader.settings", v),
        }),
        initial: loc,
        onClosed: (closed) => {
          this.readerTabs.delete(closed);
        },
      });
      this.readerTabs.add(tab);
    } catch (error) {
      if (proc) {
        try {
          await proc.kill(0);
        } catch {
          /* already gone */
        }
      }
      if (frameDir) {
        IOUtils.remove(frameDir, { recursive: true, ignoreAbsent: true }).catch(() => {});
      }
      this._showLaunchError(error);
    }
  }

  /**
   * Hands a PDF whose file is missing to Zotero's viewAttachment (download from sync / locate dialog), and makes the
   * reader that Zotero then opens be this one even if the default-opener preference is off.
   */
  private async _viewMissingAttachment(attachmentID: number): Promise<void> {
    const pane = Zotero.getActiveZoteroPane() as unknown as { viewAttachment(id: number): Promise<unknown> } | undefined;
    if (!pane) throw new AttachmentMissingError(String(attachmentID));
    this._openNextInFastReader = true;
    try {
      await pane.viewAttachment(attachmentID);
    } finally {
      this._openNextInFastReader = false;
    }
  }

  /** A short, non-blocking message in Zotero's own progress-window style. */
  private _notify(message: string): void {
    try {
      const pw = new Zotero.ProgressWindow({ closeOnClick: true });
      pw.changeHeadline("Fast Reader");
      pw.addDescription(message);
      pw.show();
      pw.startCloseTimer(4500);
    } catch (e) {
      Zotero.debug(`[fast-reader] notify failed: ${e}`);
    }
  }

  /** What the reader asks of Zotero and the OS besides annotations. */
  private _hostActions(att: ZItem, pdfPath: string): HostActions {
    return {
      copyText: (text) => Zotero.Utilities.Internal.copyTextToClipboard(text),
      openURL: (uri) => Zotero.launchURL(uri),
      openInZoteroReader: (pageIndex) => {
        this._bypassReaderPatch = true;
        Promise.resolve(Zotero.Reader.open(att.id, { pageIndex }, { allowDuplicate: true }))
          .catch((e: unknown) => Zotero.debug(`[fast-reader] open in Zotero reader failed: ${e}`))
          .finally(() => (this._bypassReaderPatch = false));
      },
      copyCitation: async () => {
        const parent = att.parentItemID ? Zotero.Items.get(att.parentItemID) : att;
        const format = Zotero.Prefs.get("export.quickCopy.setting");
        const content = await (Zotero as unknown as { QuickCopy: { getContentFromItems(items: unknown[], format: unknown): { text: string } } }).QuickCopy.getContentFromItems([parent], format);
        if (content?.text) {
          Zotero.Utilities.Internal.copyTextToClipboard(content.text);
          this._notify("Citation copied.");
        }
      },
      chooseExportPath: async (defaultName) => {
        // nsIFilePicker is outside zotero-types' coverage; this is the standard Gecko usage
        const fp = (Components.classes as unknown as Record<string, { createInstance(iid: unknown): any }>)["@mozilla.org/filepicker;1"]!.createInstance(Components.interfaces.nsIFilePicker);
        fp.init((Zotero.getMainWindow() as unknown as { browsingContext: unknown }).browsingContext, "Export PDF with annotations", fp.modeSave);
        fp.defaultString = defaultName;
        fp.appendFilter("PDF", "*.pdf");
        const rv: number = await new Promise((resolve) => fp.open(resolve));
        return rv === fp.returnOK || rv === fp.returnReplace ? (fp.file?.path ?? null) : null;
      },
      openExternally: () => Zotero.launchFile(pdfPath),
      notify: (m) => this._notify(m),
    };
  }

  /**
   * Optional: make "Fast Reader" what Zotero opens for PDFs (double-click, `zotero://open-pdf` links, note
   * citations) by wrapping `Zotero.Reader.open` while the pref `fastReader.defaultOpener` is on. Zotero's own
   * tab-restore calls (they pass `tabID`) and "open in window" always go to Zotero's reader, as does
   * "Open in Zotero's own reader" in our menu.
   */
  private _patchReaderOpen(): void {
    const R = Zotero.Reader as unknown as { open: (...a: unknown[]) => Promise<unknown> } | undefined;
    if (!R || this._originalReaderOpen) return;
    const original = R.open.bind(R);
    this._originalReaderOpen = original;
    R.open = async (...args: unknown[]) => {
      const [itemID, location, options] = args as [unknown, unknown, { tabID?: string; openInWindow?: boolean } | undefined];
      try {
        if (!this._bypassReaderPatch && (this._openNextInFastReader || Zotero.Prefs.get("fastReader.defaultOpener")) && !options?.tabID && !options?.openInWindow) {
          const item = Zotero.Items.get(itemID as number) as unknown as PdfLikeItem | undefined;
          if (item && typeof item.isPDFAttachment === "function" && item.isPDFAttachment()) {
            await this.openInTab(item, readerLocation(location));
            // callers may touch the returned reader; hand back an inert stand-in
            return { _initPromise: Promise.resolve(), _isReaderInitialized: true, tabID: null, navigate() {} };
          }
        }
      } catch (e) {
        Zotero.debug(`[fast-reader] default-opener failed, falling back to Zotero's reader: ${e}`);
      }
      return original(...args);
    };
  }

  private _unpatchReaderOpen(): void {
    const R = Zotero.Reader as unknown as { open: unknown } | undefined;
    if (R && this._originalReaderOpen) R.open = this._originalReaderOpen;
    this._originalReaderOpen = null;
  }

  private _subprocess(): SubprocessModule {
    if (!this.subprocessModule) {
      const mod: { Subprocess: SubprocessModule } = {} as { Subprocess: SubprocessModule };
      ChromeUtils.defineESModuleGetters(mod, {
        Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
      });
      this.subprocessModule = mod.Subprocess;
    }
    return this.subprocessModule;
  }

  /**
   * Keeps reader tabs out of Zotero's saved session. Zotero persists every
   * tab and on the next start calls `tabHooks.restoreState[type]` for each;
   * with no hook for our type it destructures `undefined` and *aborts
   * restoring all tabs* -- including ordinary PDF.js reader tabs (found
   * live on Zotero 10.0.8: TypeError at tabs.js:611). A hook registered by
   * the plugin is not a fix: the plugin can start after the pane has
   * already restored (verified: the error still occurred with the hook
   * present). So `getState()` is wrapped to never save our tabs -- a reader
   * tab is a live helper process, not a document; there is nothing to
   * restore -- and the no-op hook stays only as a last resort. See
   * sessionState.ts.
   *
   * Known limit: a session file already containing a `fastreader` tab (only
   * possible from a development build of this feature) is not repaired by
   * the plugin; delete the tab entry from the profile's session.json.
   */
  private _registerTabSupport(win: TabsWindow | null | undefined): void {
    const tabs = win?.Zotero_Tabs;
    if (tabs && !this.originalGetState) {
      const original = tabs.getState.bind(tabs);
      this.originalGetState = original;
      tabs.getState = () => withoutTabType(original(), TAB_TYPE);
    }
    if (tabs?.tabHooks?.restoreState) {
      tabs.tabHooks.restoreState[TAB_TYPE] = async () => ({ itemID: null });
    }
    if (!this.notifierID && Zotero.Notifier?.registerObserver) {
      // Selecting another tab backgrounds our reader tabs (frees their memory).
      this.notifierID = Zotero.Notifier.registerObserver(
        {
          notify: async (event: string, type: string, ids: Array<string | number>) => {
            if (type !== "tab" || event !== "select") return;
            for (const tab of this.readerTabs) tab.setActive(ids.includes(tab.tabID));
          },
        },
        ["tab"],
        OBSERVER_ID
      );
    }
  }

  private _unregisterTabSupport(): void {
    const tabs = (Zotero.getMainWindow() as unknown as TabsWindow | null)?.Zotero_Tabs;
    if (tabs?.tabHooks?.restoreState) delete tabs.tabHooks.restoreState[TAB_TYPE];
    if (tabs && this.originalGetState) tabs.getState = this.originalGetState;
    this.originalGetState = null;
    if (this.notifierID) {
      Zotero.Notifier.unregisterObserver(this.notifierID);
      this.notifierID = null;
    }
    for (const tab of Array.from(this.readerTabs)) tab.close();
    this.readerTabs.clear();
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
    //
    // Zotero.File.pathToFile() takes a filesystem *path*; on Zotero 11 it
    // throws "Unexpected path value 'file:///...'" when handed the
    // file:// rootURI (found live). The file protocol handler is the
    // Gecko-standard URL -> nsIFile conversion and works on every version.
    const handler = Services.io.getProtocolHandler("file") as unknown as {
      QueryInterface(iid: unknown): { getFileFromURLSpec(spec: string): { path: string } };
    };
    return handler.QueryInterface(Ci.nsIFileProtocolHandler).getFileFromURLSpec(this.rootURI!).path;
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
