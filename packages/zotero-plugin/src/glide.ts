// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

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
 * Exposed as `Zotero.Glide` (see index.ts) so bootstrap.js's tiny
 * lifecycle wrapper doesn't need to know anything about this file's
 * internals -- see index.ts and addon/bootstrap.js.
 */

import {
  GlideError,
  UnsupportedPlatformError,
  HelperMissingError,
  AttachmentMissingError,
  SpawnError,
  ReaderCrashedError,
} from "./errors.ts";
import { resolveHelperPath } from "./resolveHelper.ts";
import { resolveHelperPathPacked } from "./extractHelper.ts";
import { resolvePdfAttachment, tabTitleForItem, type PdfLikeItem } from "./pdfAttachment.ts";
import { buildServeArgs, helperEnvironment } from "./buildArgs.ts";
import type { HelperProcess } from "./helperConnection.ts";
import { NO_NOTES, ReaderTab, TAB_TYPE, type GlobalSettings, type HostActions, type PaperChoice, type ReaderTabDeps, type SplitHost, type ZoteroTabs } from "./readerTab.ts";
import { PositionStore } from "./positionStore.ts";
import { createAnnotationBackend, createNotesBackend, createSettingsStore, parseTrimDelayMs, readerLocation, type AttachmentApi } from "./zoteroAdapters.ts";
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

/** A Zotero viewer window with a blank page for a reader, and what a ReaderTab needs in place of `Zotero_Tabs`. */
interface WindowHost {
  chromeWin: Window;
  /** The page's window: its document is where the reader is built. */
  win: TabsWindow;
  tabs: ZoteroTabs;
}

/** The bits of a Zotero attachment item this plugin touches directly. */
interface ZItem {
  id: number;
  parentItemID?: number | false;
}

/** The parts of a library item the split pane's picker reads to describe a paper. */
interface PickerItem extends PdfLikeItem {
  id: number;
  firstCreator?: string;
  getField?: (field: string) => string;
  getBestAttachment?: () => Promise<PdfLikeItem | null | undefined | false>;
}

const MENU_ID = "glide-open";
const TAB_MENU_ID = "glide-tab-actions";
const OBSERVER_ID = "glide-tabs";

class GlidePlugin {
  id: string | null = null;
  version: string | null = null;
  rootURI: string | null = null;
  menuID: string | false | null = null;
  private tabMenuID: string | false | null = null;
  private subprocessModule: SubprocessModule | null = null;
  private readerTabs = new Set<ReaderTab>();
  /** Readers hosted in their own window; they are not Zotero tabs, so tab selection never backgrounds them. */
  private windowTabs = new Set<ReaderTab>();
  private originalGetState: (() => SessionTab[]) | null = null;
  private _originalReaderOpen: ((...a: unknown[]) => Promise<unknown>) | null = null;
  private _bypassReaderPatch = false;
  /** Set while Zotero's viewAttachment resolves a missing file, so the reader it opens is ours. */
  private _openNextInGlide = false;
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

  /** Default values and the pane in Zotero's Settings window (Tools > Settings > Zotero Glide). */
  private _registerPrefs(): void {
    try {
      const defaults = Services.prefs.getDefaultBranch("extensions.zotero.");
      defaults.setBoolPref("glide.defaultOpener", false);
      defaults.setIntPref("glide.trimDelaySeconds", 2);
      const panes = (Zotero as unknown as { PreferencePanes?: { register(o: Record<string, unknown>): Promise<string> } }).PreferencePanes;
      if (panes && this.id && this.rootURI) {
        void panes.register({ pluginID: this.id, src: this.rootURI + "content/preferences.xhtml", label: "Zotero Glide" });
      }
    } catch (e) {
      Zotero.debug(`[glide] could not register preferences: ${e}`);
    }
  }

  private _registerMenu(): void {
    if (!Zotero.MenuManager || typeof Zotero.MenuManager.registerMenu !== "function") {
      Zotero.debug("[glide] Zotero.MenuManager unavailable; menu not registered");
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
    // One entry: the reader is always a tab in Zotero's own tab bar. (There used to be a second,
    // "separate window" entry that launched the helper's own native window; it is gone -- see
    // docs/adr/006-reader-window-host.md for the plan for a real Zotero-hosted window.)
    this.menuID = Zotero.MenuManager.registerMenu({
      menuID: MENU_ID,
      pluginID: this.id!,
      target: "main/library/item",
      menus: [entry("Open in Zotero Glide", (i) => this.openInTab(i))],
    });

    // Context actions for a Glide reader tab. `main/tab` is Zotero's supported tab popup target.
    // The menu context supplies tabID/type; the attachment is held alongside the live ReaderTab.
    this.tabMenuID = Zotero.MenuManager.registerMenu({
      menuID: TAB_MENU_ID,
      pluginID: this.id!,
      target: "main/tab",
      menus: [
        {
          menuType: "menuitem",
          onShowing: (_event: Event, context: { menuElem: Element; tabType?: string; tabID?: string; setVisible(visible: boolean): void }) => {
            context.menuElem.setAttribute("label", "Open in New Window");
            context.setVisible(context.tabType === TAB_TYPE && !!context.tabID && !![...this.readerTabs].find((t) => t.tabID === context.tabID));
          },
          onCommand: async (_event: Event, context: { tabID?: string }) => {
            const tab = [...this.readerTabs].find((t) => t.tabID === context.tabID);
            const attachment = tab && this._papers.get(tab)?.attachment;
            if (!tab || !attachment) return;
            // Move the paper to its own Glide window (the tab closes once it is up).
            const item = Zotero.Items.get(attachment.id) as unknown as PdfLikeItem;
            if (await this.openInWindow(item, {}, tab)) return;
            // The window could not be created: use Zotero's own reader window instead. allowDuplicate is required:
            // our tab carries the same itemID, so without it Zotero finds that tab, selects it and returns.
            await Zotero.Reader.open(attachment.id, undefined, { openInWindow: true, allowDuplicate: true });
          },
        },
      ],
    });
  }

  private _unregisterMenu(): void {
    if (this.menuID && Zotero.MenuManager && typeof Zotero.MenuManager.unregisterMenu === "function") {
      Zotero.MenuManager.unregisterMenu(this.menuID);
    }
    if (this.tabMenuID && Zotero.MenuManager && typeof Zotero.MenuManager.unregisterMenu === "function") {
      Zotero.MenuManager.unregisterMenu(this.tabMenuID);
    }
    this.menuID = null;
    this.tabMenuID = null;
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

  /**
   * Resolves (and, for a packed install, extracts) the helper binary.
   */
  private _resolveHelper(): Promise<string> {
      const isPacked = this.rootURI!.startsWith("jar:");
    // A real "Install Plugin From File" install keeps the .xpi packed
    // (rootURI is jar:file:///.../glide@....xpi!/); the dev
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
            destDir: PathUtils.join(Zotero.DataDirectory.dir, "glide-helper-bin", this.version!),
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

  /**
   * Opens the PDF as a tab in Zotero's own tab bar (the default action).
   * Spawns a per-tab headless helper (`--serve`); closing the tab ends it.
   * Re-opening a PDF that already has a reader tab just selects that tab.
   */
  async openInTab(item: PdfLikeItem, loc: { pageIndex?: number; annotationKey?: string } = {}): Promise<void> {
    await this._open(item, loc, "tab");
  }

  /**
   * Opens the PDF in its own Glide window (the full reader, hosted in a Zotero viewer window instead of a tab).
   * `replace` is a Glide tab being moved: it is closed once the window is up. Resolves false only when the window
   * could not be created, so the caller can fall back to Zotero's own reader window.
   */
  async openInWindow(item: PdfLikeItem, loc: { pageIndex?: number; annotationKey?: string } = {}, replace?: ReaderTab): Promise<boolean> {
    return this._open(item, loc, "window", replace);
  }

  private async _open(item: PdfLikeItem, loc: { pageIndex?: number; annotationKey?: string }, target: "tab" | "window", replace?: ReaderTab): Promise<boolean> {
    let proc: SubprocessHandle | null = null;
    let frameDir: string | null = null;
    let host: WindowHost | null = null;
    try {
      const win = Zotero.getMainWindow() as unknown as TabsWindow | null;
      const tabs = win?.Zotero_Tabs;
      if (!win || !tabs) {
        throw new GlideError("Zotero's tab bar is not available in this window.");
      }
      const attachment = await resolvePdfAttachment(item);
      const pdfPath = attachment && typeof attachment.getFilePathAsync === "function" ? await attachment.getFilePathAsync() : null;
      if (!attachment) {
        throw new AttachmentMissingError(item?.key ?? "(unknown item)");
      }
      if (!pdfPath) {
        // The item is a PDF attachment but its file isn't on disk (e.g. a synced file that hasn't been downloaded
        // yet). Zotero's own flow knows what to do -- download it, or offer to locate it -- so use that instead of a
        // dead-end error; once the file exists it opens here (see _openNextInGlide).
        await this._viewMissingAttachment((attachment as unknown as ZItem).id);
        return true;
      }

      for (const open of [...this.readerTabs, ...this.windowTabs]) {
        if (open !== replace && open.pdfPath === pdfPath) {
          open.reveal(loc);
          return true;
        }
      }

      const title = tabTitleForItem(attachment, pdfPath);
      // Start the helper (it opens the PDF) while the window is still loading: the two are independent, and
      // doing them one after the other is what made a new window slow to show the paper.
      const spawning = this._spawnServe(pdfPath);
      if (target === "window") {
        spawning.catch(() => {}); // handled below; this only stops an unhandled-rejection warning while we wait
        try {
          host = await this._createWindowHost(title);
        } catch (e) {
          Zotero.debug(`[glide] could not open a reader window: ${e}`);
          this._notify(`Couldn't open a Glide window (${e instanceof Error ? e.message : String(e)}); using Zotero's reader instead.`);
          const orphan = await spawning.catch(() => null);
          if (orphan) {
            try {
              await orphan.proc.kill(0);
            } catch {
              /* already gone */
            }
            IOUtils.remove(orphan.frameDir, { recursive: true, ignoreAbsent: true }).catch(() => {});
          }
          return false;
        }
      }

      const spawned = await spawning;
      proc = spawned.proc;
      frameDir = spawned.frameDir;
      // the new reader reads the saved position when it starts, so the one being replaced must have written it
      replace?.flushPosition();

      const tab = new ReaderTab({
        ...this._readerDeps(host?.win ?? win, host?.tabs ?? tabs, attachment as unknown as ZItem, pdfPath, spawned.proc, spawned.frameDir),
        title,
        initial: loc,
        // split view flexes a tab's container; a window has no second pane for now
        split: host ? undefined : this._splitHost(win),
        onClosed: (closed) => {
          this.readerTabs.delete(closed);
          this.windowTabs.delete(closed);
          this._papers.delete(closed);
        },
      });
      if (host) {
        this.windowTabs.add(tab);
      } else {
        this.readerTabs.add(tab);
        this._papers.set(tab, { attachment: attachment as unknown as ZItem, title });
      }
      if (replace) replace.close();
      return true;
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
      try {
        host?.chromeWin.close();
      } catch {
        /* already gone */
      }
      this._showLaunchError(error);
      return true;
    }
  }

  /**
   * A Zotero viewer window (the one `Zotero.openInViewer` uses: Zotero's theme, an Edit/Window menu, Cmd/Ctrl+W)
   * with a blank page the reader is built into, plus the tab-API stand-in a ReaderTab needs. Throws if it does
   * not come up, and the caller then falls back to Zotero's own reader window.
   */
  private async _createWindowHost(title: string): Promise<WindowHost> {
    // Not Zotero.openInViewer: it refuses a second window for a URI it already shows, and one blank page per
    // reader is exactly what is wanted here. The argument shape is basicViewer.js's own.
    const arg: { uri: string; options: Record<string, unknown>; wrappedJSObject?: unknown } = { uri: "about:blank", options: {} };
    arg.wrappedJSObject = arg;
    const chromeWin = Services.ww.openWindow(
      null as never,
      "chrome://zotero/content/standalone/basicViewer.xhtml",
      null as never,
      "chrome,dialog=yes,resizable,centerscreen,menubar,scrollbars",
      arg as never
    ) as unknown as Window;
    try {
      const doc = await new Promise<Document>((resolve, reject) => {
        const started = Date.now();
        chromeWin.addEventListener(
          "load",
          () => {
            // basicViewer.js creates and loads its <browser> in a load handler of its own, so wait a tick
            setTimeout(() => {
              const browser = chromeWin.document.documentElement.getElementsByTagName("browser")[0] as unknown as
                | { contentDocument: Document | null; currentURI?: { spec: string }; webProgress?: { isLoadingDocument: boolean } }
                | undefined;
              if (!browser) return reject(new Error("the reader window has no browser"));
              // The browser holds an initial about:blank that is replaced when basicViewer's own load of about:blank
              // finishes; a reader built into the initial one is thrown away (an empty "about:blank" window). A
              // `pageshow` listener (as Zotero.openInViewer's onLoad uses) never fired for this blank page, so
              // poll instead: take the document once nothing is loading and the same one has stayed put.
              let last: Document | null = null;
              let stable = 0;
              const poll = () => {
                if (chromeWin.closed) return reject(new Error("the reader window was closed while loading"));
                const d = browser.contentDocument;
                const settled = !!d?.body && d.readyState === "complete" && browser.currentURI?.spec === "about:blank" && !browser.webProgress?.isLoadingDocument;
                stable = settled && d === last ? stable + 1 : 0;
                last = settled ? d : null;
                if (stable >= 3 && d) return resolve(d);
                if (Date.now() - started > 10000) return reject(new Error("the reader window did not load"));
                setTimeout(poll, 50);
              };
              poll();
            });
          },
          { once: true }
        );
      });
      const setTitle = (t: string) => {
        doc.title = t;
        chromeWin.document.title = t;
      };
      setTitle(title);
      doc.documentElement.style.cssText = "color-scheme:light dark;background:Canvas;height:100%";
      doc.body.style.cssText = "margin:0;height:100%;overflow:hidden";
      const root = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
      root.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column";
      doc.body.append(root);
      const tabs: ZoteroTabs = {
        add: ({ title: t, onClose }) => {
          if (t) setTitle(t);
          chromeWin.addEventListener("unload", () => onClose?.(), { once: true });
          return { id: `glide-window-${Zotero.Utilities.randomString(6)}`, container: root };
        },
        select: () => chromeWin.focus(),
        close: () => chromeWin.close(),
        rename: (_id, t) => setTitle(t),
        tabHooks: { restoreState: {} },
      };
      return { chromeWin, win: doc.defaultView as unknown as TabsWindow, tabs };
    } catch (e) {
      try {
        chromeWin.close();
      } catch {
        /* already gone */
      }
      throw e;
    }
  }

  /** Starts a per-tab headless helper for a PDF. On failure nothing is left running. */
  private async _spawnServe(pdfPath: string): Promise<{ proc: SubprocessHandle; frameDir: string }> {
    const helperPath = await this._resolveHelper();
    const frameDir = PathUtils.join(PathUtils.tempDir, `zotero-glide-${Zotero.Utilities.randomString(10)}`);
    try {
      const proc = await this._subprocess().call({
        command: helperPath,
        arguments: buildServeArgs(pdfPath, frameDir),
        // helper's own error text (e.g. "failed to open document") arrives
        // on stdout as non-JSON lines and is shown if the tab dies early
        stderr: "stdout",
        // allocator tuning that keeps an idle/backgrounded tab small -- see buildArgs.ts
        environment: helperEnvironment(this._hostPlatform()),
        environmentAppend: true,
      });
      return { proc, frameDir };
    } catch (cause) {
      IOUtils.remove(frameDir, { recursive: true, ignoreAbsent: true }).catch(() => {});
      throw new SpawnError(helperPath, cause);
    }
  }

  /** Everything a ReaderTab needs for one PDF except its title, where it opens and its split/pane hooks. */
  private _readerDeps(win: TabsWindow, tabs: ZoteroTabs, attachment: ZItem, pdfPath: string, proc: SubprocessHandle, frameDir: string): Omit<ReaderTabDeps, "title" | "onClosed"> {
    return {
      tabs,
      doc: win.document,
      isMac: !!Zotero.isMac,
      itemID: attachment.id,
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
      trimDelayMs: () => parseTrimDelayMs(Zotero.Prefs.get("glide.trimDelaySeconds")),
      collectGarbage: () => {
        try {
          (win as unknown as { windowUtils: { garbageCollect(): void } }).windowUtils.garbageCollect();
        } catch (e) {
          Zotero.debug(`[glide] garbageCollect failed: ${e}`);
        }
      },
      annotations: createAnnotationBackend(Zotero as never, attachment as unknown as AttachmentApi, (m) => this._notify(m)),
      notes: createNotesBackend(Zotero as never, attachment as unknown as AttachmentApi, win.document, (m) => this._notify(m)),
      host: this._hostActions(attachment, pdfPath),
      positions: new PositionStore({
        get: () => (Zotero.Prefs.get("glide.positions") as string | undefined) || undefined,
        set: (v) => Zotero.Prefs.set("glide.positions", v),
      }),
      positionKey: `${(attachment as unknown as AttachmentApi).libraryID}/${(attachment as unknown as AttachmentApi).key}`,
      settings: createSettingsStore({
        get: () => (Zotero.Prefs.get("glide.settings") as string | undefined) || undefined,
        set: (v) => Zotero.Prefs.set("glide.settings", v),
      }),
    };
  }

  /** The papers open in Glide tabs, for the split view's paper picker. */
  private _papers = new Map<ReaderTab, { attachment: ZItem; title: string }>();

  /** Opens readers inside the second pane of a split view. */
  private _splitHost(win: TabsWindow): SplitHost {
    /** "Smith, 2021" under the title of a library paper. */
    const describe = (item: PickerItem, target: PaperChoice["target"]): PaperChoice => {
      const owner = item.parentItem ? (item.parentItem as PickerItem) : item;
      const year = /\b(\d{4})\b/.exec(owner.getField?.("date") ?? "")?.[1];
      const label = (owner.getDisplayTitle?.() || item.getDisplayTitle?.() || "Untitled").replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
      const sub = [owner.firstCreator, year].filter(Boolean).join(", ");
      return { label, sub: sub || undefined, target };
    };
    return {
      selected: async () => {
        const pane = Zotero.getActiveZoteroPane() as unknown as { getSelectedItems(): PickerItem[] } | undefined;
        const picked = pane?.getSelectedItems()?.[0];
        if (!picked || !(await resolvePdfAttachment(picked))) return null;
        return describe(picked, { kind: "selected" });
      },
      search: async (query) => {
        const pane = Zotero.getActiveZoteroPane() as unknown as { getSelectedLibraryID?(): number } | undefined;
        const search = new Zotero.Search({ libraryID: pane?.getSelectedLibraryID?.() ?? Zotero.Libraries.userLibraryID });
        search.addCondition("quicksearch-titleCreatorYear", "contains", query);
        const ids = await search.search();
        const items = (await Zotero.Items.getAsync(ids.slice(0, 60))) as unknown as PickerItem[];
        // keep only papers that really have a PDF; resolve in parallel but show at most a screenful
        const found = await Promise.all(items.map(async (it) => ((await resolvePdfAttachment(it)) ? describe(it, { kind: "item", itemID: it.id }) : null)));
        const seen = new Set<number>();
        const out: PaperChoice[] = [];
        for (const c of found) {
          if (!c || c.target.kind !== "item" || seen.has(c.target.itemID)) continue;
          seen.add(c.target.itemID);
          out.push(c);
          if (out.length >= 15) break;
        }
        return out;
      },
      choices: (self) => {
        const out: ReturnType<SplitHost["choices"]> = [];
        for (const [tab, { title }] of this._papers) if (tab !== self) out.push({ label: title, target: { kind: "tab", pdfPath: tab.pdfPath }, pdfPath: tab.pdfPath });
        return out;
      },
      open: async (container, target, hooks, page) => {
        let proc: SubprocessHandle | null = null;
        try {
          let attachment: ZItem | null = null;
          let pdfPath: string | null = null;
          if (target.kind === "same") {
            const owner = [...this.readerTabs].find((t) => t.container.contains(container));
            attachment = owner ? (this._papers.get(owner)?.attachment ?? null) : null;
          } else if (target.kind === "item") {
            const picked = (await Zotero.Items.getAsync(target.itemID)) as unknown as PdfLikeItem | false;
            attachment = picked ? ((await resolvePdfAttachment(picked)) as unknown as ZItem | null) : null;
            if (!attachment) {
              this._notify("That paper has no PDF to open.");
              return null;
            }
          } else if (target.kind === "tab") {
            const owner = [...this.readerTabs].find((t) => t.pdfPath === target.pdfPath);
            attachment = owner ? (this._papers.get(owner)?.attachment ?? null) : null;
          } else {
            const pane = Zotero.getActiveZoteroPane() as unknown as { getSelectedItems(): PdfLikeItem[] } | undefined;
            const picked = pane?.getSelectedItems()?.[0];
            attachment = picked ? ((await resolvePdfAttachment(picked)) as unknown as ZItem | null) : null;
            if (!attachment) {
              this._notify("Select an item with a PDF in the Zotero library first.");
              return null;
            }
          }
          if (!attachment) return null;
          pdfPath = (await (attachment as unknown as { getFilePathAsync(): Promise<string | false> }).getFilePathAsync()) || null;
          if (!pdfPath) {
            this._notify("That PDF's file is not available on this computer.");
            return null;
          }
          const spawned = await this._spawnServe(pdfPath);
          proc = spawned.proc;
          const base = this._readerDeps(win, undefined as never, attachment as unknown as ZItem, pdfPath, spawned.proc, spawned.frameDir);
          const shim: ZoteroTabs = {
            add: () => ({ id: `glide-pane-${Zotero.Utilities.randomString(6)}`, container }),
            select: () => {},
            close: () => hooks.close(),
            rename: () => {},
            tabHooks: { restoreState: {} },
          };
          // the pane keeps its UI choices (sidebar, tool...) to itself; theme and colors stay shared
          const shared = base.settings;
          let local: Partial<GlobalSettings> = { sidebarOpen: false, notesOpen: false };
          const title = tabTitleForItem(attachment as never, pdfPath);
          const tab = new ReaderTab({
            ...base,
            tabs: shim,
            title,
            notes: NO_NOTES,
            positions: new PositionStore({ get: () => undefined, set: () => {} }),
            settings: {
              get: () => ({ ...shared.get(), ...local }),
              set: (patch) => {
                const { sidebarOpen, sidebarWidth, sidebarTab, notesOpen, notesWidth, ...rest } = patch;
                local = { ...local, ...(sidebarOpen !== undefined && { sidebarOpen }), ...(sidebarTab !== undefined && { sidebarTab }), ...(sidebarWidth !== undefined && { sidebarWidth }), ...(notesOpen !== undefined && { notesOpen }), ...(notesWidth !== undefined && { notesWidth }) };
                if (Object.keys(rest).length) shared.set(rest);
              },
            },
            initial: { pageIndex: target.kind === "same" ? page : 0 },
            secondary: hooks,
            onClosed: () => {},
          });
          return { tab, pdfPath, title };
        } catch (error) {
          if (proc) void Promise.resolve(proc.kill(0)).catch(() => {});
          this._showLaunchError(error);
          return null;
        }
      },
    };
  }

  /**
   * Hands a PDF whose file is missing to Zotero's viewAttachment (download from sync / locate dialog), and makes the
   * reader that Zotero then opens be this one even if the default-opener preference is off.
   */
  private async _viewMissingAttachment(attachmentID: number): Promise<void> {
    const pane = Zotero.getActiveZoteroPane() as unknown as { viewAttachment(id: number): Promise<unknown> } | undefined;
    if (!pane) throw new AttachmentMissingError(String(attachmentID));
    this._openNextInGlide = true;
    try {
      await pane.viewAttachment(attachmentID);
    } finally {
      this._openNextInGlide = false;
    }
  }

  /** A short, non-blocking message in Zotero's own progress-window style. */
  private _notify(message: string): void {
    try {
      const pw = new Zotero.ProgressWindow({ closeOnClick: true });
      pw.changeHeadline("Zotero Glide");
      pw.addDescription(message);
      pw.show();
      pw.startCloseTimer(4500);
    } catch (e) {
      Zotero.debug(`[glide] notify failed: ${e}`);
    }
  }

  /** What the reader asks of Zotero and the OS besides annotations. */
  private _hostActions(att: ZItem, pdfPath: string): HostActions {
    return {
      copyText: (text) => Zotero.Utilities.Internal.copyTextToClipboard(text),
      copyImage: (png) => {
        // the same route Zotero's own reader uses for "Copy Image": decode, then put it on the clipboard as a native image
        const C = Components as unknown as { classes: Record<string, { getService(i: unknown): any; createInstance(i: unknown): any }>; interfaces: Record<string, unknown> };
        const imgTools = C.classes["@mozilla.org/image/tools;1"]!.getService(C.interfaces.imgITools);
        const transferable = C.classes["@mozilla.org/widget/transferable;1"]!.createInstance(C.interfaces.nsITransferable);
        const clipboard = C.classes["@mozilla.org/widget/clipboard;1"]!.getService(C.interfaces.nsIClipboard);
        const img = imgTools.decodeImageFromArrayBuffer(png.slice().buffer, "image/png");
        transferable.init(null);
        transferable.addDataFlavor("application/x-moz-nativeimage");
        transferable.setTransferData("application/x-moz-nativeimage", img);
        clipboard.setData(transferable, null, (C.interfaces.nsIClipboard as { kGlobalClipboard: number }).kGlobalClipboard);
      },
      openURL: (uri) => Zotero.launchURL(uri),
      openInZoteroReader: (pageIndex) => {
        this._bypassReaderPatch = true;
        Promise.resolve(Zotero.Reader.open(att.id, { pageIndex }, { allowDuplicate: true }))
          .catch((e: unknown) => Zotero.debug(`[glide] open in Zotero reader failed: ${e}`))
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
      saveImageAs: async (png, defaultName) => {
        const fp = (Components.classes as unknown as Record<string, { createInstance(iid: unknown): any }>)["@mozilla.org/filepicker;1"]!.createInstance(Components.interfaces.nsIFilePicker);
        fp.init((Zotero.getMainWindow() as unknown as { browsingContext: unknown }).browsingContext, "Save image as", fp.modeSave);
        fp.defaultString = defaultName;
        fp.appendFilter("PNG", "*.png");
        const rv: number = await new Promise((resolve) => fp.open(resolve));
        if (rv !== fp.returnOK && rv !== fp.returnReplace) return false;
        let path: string = fp.file.path;
        if (!/\.png$/i.test(path)) path += ".png";
        await IOUtils.write(path, png);
        return true;
      },
      chooseFolder: async () => {
        const fp = (Components.classes as unknown as Record<string, { createInstance(iid: unknown): any }>)["@mozilla.org/filepicker;1"]!.createInstance(Components.interfaces.nsIFilePicker);
        fp.init((Zotero.getMainWindow() as unknown as { browsingContext: unknown }).browsingContext, "Save all images to", fp.modeGetFolder);
        const rv: number = await new Promise((resolve) => fp.open(resolve));
        return rv === fp.returnOK ? (fp.file?.path ?? null) : null;
      },
      writeImage: async (folder, name, png) => {
        const path = (PathUtils as unknown as { join(...p: string[]): string }).join(folder, name);
        await IOUtils.write(path, png);
      },
      openExternally: () => Zotero.launchFile(pdfPath),
      listFonts: () => {
        try {
          const C = Components as unknown as { classes: Record<string, { getService(i: unknown): { EnumerateAllFonts(): string[] } }>; interfaces: Record<string, unknown> };
          const names = C.classes["@mozilla.org/gfx/fontenumerator;1"]!.getService(C.interfaces.nsIFontEnumerator).EnumerateAllFonts();
          return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
        } catch (e) {
          Zotero.debug(`[glide] listing fonts failed: ${e}`);
          return [];
        }
      },
      notify: (m) => this._notify(m),
    };
  }

  /**
   * Optional: make "Zotero Glide" what Zotero opens for PDFs (double-click, `zotero://open-pdf` links, note
   * citations) by wrapping `Zotero.Reader.open` while the pref `glide.defaultOpener` is on. Zotero's own
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
        if (!this._bypassReaderPatch && (this._openNextInGlide || Zotero.Prefs.get("glide.defaultOpener")) && !options?.tabID && !options?.openInWindow) {
          const item = Zotero.Items.get(itemID as number) as unknown as PdfLikeItem | undefined;
          if (item && typeof item.isPDFAttachment === "function" && item.isPDFAttachment()) {
            await this.openInTab(item, readerLocation(location));
            // callers may touch the returned reader; hand back an inert stand-in
            return { _initPromise: Promise.resolve(), _isReaderInitialized: true, tabID: null, navigate() {} };
          }
        }
      } catch (e) {
        Zotero.debug(`[glide] default-opener failed, falling back to Zotero's reader: ${e}`);
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
   * Known limit: a session file already containing a `glide` tab (only
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
    // The tab carries data.itemID (for Zotero's tab menu), so Zotero calls rename(id) with no title whenever that
    // item is modified (reading position, annotations...). With no getTitle hook for our type the title became
    // undefined and the tab went blank; keep the title we set.
    if (tabs?.tabHooks) {
      tabs.tabHooks.getTitle ??= {};
      tabs.tabHooks.getTitle[TAB_TYPE] = (tab) => tab.title ?? "";
    }
    if (!this.notifierID && Zotero.Notifier?.registerObserver) {
      // Selecting another tab backgrounds our reader tabs (frees their memory).
      this.notifierID = Zotero.Notifier.registerObserver(
        {
          notify: async (event: string, type: string, ids: Array<string | number>) => {
            if (type !== "tab" || event !== "select") return;
            // Zotero's live selection is the truth: notifications are delivered asynchronously (and may be
            // batched), so a stale "another tab was selected" must not trim the tab that is on screen.
            const selected = (Zotero.getMainWindow() as unknown as TabsWindow | null)?.Zotero_Tabs?.selectedID;
            for (const tab of this.readerTabs) tab.setActive(selected !== undefined ? tab.tabID === selected : ids.includes(tab.tabID));
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
    if (tabs?.tabHooks?.getTitle) delete tabs.tabHooks.getTitle[TAB_TYPE];
    if (tabs && this.originalGetState) tabs.getState = this.originalGetState;
    this.originalGetState = null;
    if (this.notifierID) {
      Zotero.Notifier.unregisterObserver(this.notifierID);
      this.notifierID = null;
    }
    for (const tab of Array.from(this.readerTabs)) tab.close();
    this.readerTabs.clear();
    for (const tab of Array.from(this.windowTabs)) tab.close();
    this.windowTabs.clear();
  }

  private _rootDirFromURI(): string {
    // Only valid for an unpacked (plain file://) install -- see the
    // isPacked branch in _resolveHelper above.
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
    Zotero.debug(`[glide] launch failed: ${stack}`);
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
      "Zotero Glide could not be started",
      summary,
      buttonFlags,
      "",
      "Show Details",
      "",
      "",
      { value: false }
    );
    if (pressed === 1) {
      Services.prompt.alert(win, "Zotero Glide — Details", stack ?? String(error));
    }
  }

  private _summarizeError(error: unknown): string {
    if (error instanceof HelperMissingError) {
      return "The Zotero Glide helper program is missing from this plugin's installation.";
    }
    if (error instanceof AttachmentMissingError) {
      return "The PDF attachment's file could not be found on disk.";
    }
    if (error instanceof UnsupportedPlatformError) {
      return `Zotero Glide does not support this platform (${error.platform}/${error.arch}).`;
    }
    if (error instanceof SpawnError) {
      return "The Zotero Glide process failed to launch.";
    }
    if (error instanceof ReaderCrashedError) {
      return `Zotero Glide started but exited immediately (code ${error.exitCode}).`;
    }
    if (error instanceof GlideError) {
      return error.message;
    }
    return "An unexpected error occurred while starting Zotero Glide.";
  }
}

export const Glide = new GlidePlugin();
