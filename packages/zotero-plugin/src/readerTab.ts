/**
 * One reader *tab* inside Zotero's own tab bar: a `Zotero_Tabs` tab whose
 * content is a `ReaderView` (canvas) fed by a per-tab
 * `fast-reader-helper --serve` process. Closing the tab ends the process,
 * and the OS reclaims all of its memory -- same isolation story as the
 * standalone window, minus the separate window. See
 * docs/adr/002-in-tab-reader.md.
 *
 * Glue between Zotero_Tabs, the DOM view, and HelperConnection; the
 * decision logic it calls (protocol, keys, connection) is unit-tested, the
 * glue itself is verified live (STATUS.md).
 */

import { HelperConnection, type HelperProcess } from "./helperConnection.ts";
import type { FrameEvent, HelperEvent } from "./protocol.ts";
import type { ReaderAction } from "./readerKeys.ts";
import { ReaderView, type ScrollIntent } from "./tabView.ts";

/** Custom Zotero tab type. NO dash: Zotero splits tab types on "-" (`parseTabType`). */
export const TAB_TYPE = "fastreader";

/** How long a backgrounded tab keeps its page cache before trimming it. */
export const BACKGROUND_TRIM_DELAY_MS = 2000;

/**
 * Every painted page is a 10-25 MB buffer (read from the helper's frame
 * file, then copied into the canvas). Gecko collects them lazily: measured
 * on Zotero 10.0.8 after 30 page turns the Zotero process held ~1465 MB and
 * a forced GC took it to ~964 MB. So once the reader has been idle for this
 * long, force a collection (and again after a background trim / close).
 * Idle-triggered, so it never lands in the middle of a page turn.
 */
export const IDLE_GC_DELAY_MS = 1500;

/** The slice of Zotero's `Zotero_Tabs` (chrome/content/zotero/tabs.js) this plugin uses. */
export interface ZoteroTabs {
  add(opts: {
    id?: string;
    type: string;
    title?: string;
    data?: Record<string, unknown>;
    select?: boolean;
    onClose?: () => void;
  }): { id: string; container: Element };
  select(id: string): void;
  close(ids: string | string[]): void;
  rename(id: string, title: string): void;
  tabHooks: { restoreState: Record<string, (tab: unknown, index: number) => Promise<{ itemID: number | null }>> };
}

export interface ReaderTabDeps {
  tabs: ZoteroTabs;
  doc: Document;
  isMac: boolean;
  title: string;
  pdfPath: string;
  frameDir: string;
  /** Already-spawned helper in `--serve` mode. */
  proc: HelperProcess;
  readFile(path: string): Promise<Uint8Array>;
  removeFile(path: string): Promise<void>;
  removeDir(path: string): Promise<void>;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  debug(msg: string): void;
  /** Forces a garbage collection in Zotero's process (see IDLE_GC_DELAY_MS). */
  collectGarbage(): void;
  /** Called after the tab is closed (by the user or by us), for bookkeeping. */
  onClosed(tab: ReaderTab): void;
}

export class ReaderTab {
  readonly tabID: string;
  readonly pdfPath: string;
  private readonly d: ReaderTabDeps;
  private readonly view: ReaderView;
  private readonly conn: HelperConnection;
  private lastFrame: FrameEvent | null = null;
  private lastQuery = "";
  private pendingFrame: FrameEvent | null = null;
  private drawing = false;
  private trimTimer: number | null = null;
  private gcTimer: number | null = null;
  private active = true;
  private disposed = false;
  private recentOutput: string[] = [];

  constructor(deps: ReaderTabDeps) {
    this.d = deps;
    this.pdfPath = deps.pdfPath;

    const { id, container } = deps.tabs.add({
      type: TAB_TYPE,
      title: deps.title,
      data: { icon: "attachmentPDF" },
      select: true,
      onClose: () => this.dispose(),
    });
    this.tabID = id;

    this.view = new ReaderView(
      deps.doc,
      container,
      {
        onAction: (a) => this.onAction(a),
        onGoto: (n) => this.go({ cmd: "goto", page: n }, "top"),
        onSearchSubmit: (q, back) => this.onSearch(q, back),
        onSearchCleared: () => {
          this.lastQuery = "";
          void this.conn.send({ cmd: "clear_search" });
        },
        onViewport: (width, height, dpr) => void this.conn.send({ cmd: "viewport", width, height, dpr }),
      },
      deps.isMac
    );

    this.conn = new HelperConnection(deps.proc, {
      onEvent: (ev) => this.onEvent(ev),
      onOutput: (line) => {
        this.recentOutput.push(line);
        if (this.recentOutput.length > 5) this.recentOutput.shift();
        deps.debug(`[fast-reader] helper: ${line}`);
      },
      onExit: (code, requested) => this.onExit(code, requested),
    });
    this.conn.start();
    this.view.focus();
  }

  select(): void {
    this.d.tabs.select(this.tabID);
  }

  /** Programmatic close (plugin shutdown). The tab's own `onClose` does the cleanup. */
  close(): void {
    if (!this.disposed) this.d.tabs.close(this.tabID);
  }

  /**
   * Called as tab selection changes. A backgrounded reader trims its page
   * cache and drops its canvas bitmap after a short delay, so an idle tab
   * costs ~nothing but the open document; showing it again re-renders.
   */
  setActive(active: boolean): void {
    if (this.disposed || active === this.active) return;
    this.active = active;
    if (this.trimTimer !== null) {
      this.d.clearTimeout(this.trimTimer);
      this.trimTimer = null;
    }
    if (active) {
      void this.conn.send({ cmd: "resume" });
      this.view.focus();
      this.view.sendViewport();
    } else {
      this.trimTimer = this.d.setTimeout(() => {
        this.trimTimer = null;
        void this.conn.send({ cmd: "trim" });
        this.view.releaseBitmap();
        this.scheduleGc();
      }, BACKGROUND_TRIM_DELAY_MS);
    }
  }

  /** (Re)starts the idle timer; the collection runs only after IDLE_GC_DELAY_MS without a new frame. */
  private scheduleGc(): void {
    if (this.gcTimer !== null) this.d.clearTimeout(this.gcTimer);
    this.gcTimer = this.d.setTimeout(() => {
      this.gcTimer = null;
      this.d.collectGarbage();
    }, IDLE_GC_DELAY_MS);
  }

  private go(cmd: Parameters<HelperConnection["send"]>[0], scroll: ScrollIntent): void {
    this.view.setScrollIntent(scroll);
    void this.conn.send(cmd);
  }

  private onAction(a: ReaderAction): void {
    switch (a.type) {
      case "next":
        return this.go({ cmd: "next" }, "top");
      case "prev":
        return this.go({ cmd: "prev" }, a.scroll);
      case "first":
        return this.go({ cmd: "goto", page: 1 }, "top");
      case "last":
        return this.go({ cmd: "goto", page: this.lastFrame?.pageCount ?? 1 }, "top");
      case "zoom":
        return this.go({ cmd: "zoom", factor: a.factor }, "keep");
      case "fit":
        return this.go({ cmd: "fit", mode: a.mode }, "keep");
      case "focusSearch":
        return this.view.focusSearch();
      case "focusPage":
        return this.view.focusPage();
      case "escape":
        if (this.lastQuery) {
          this.lastQuery = "";
          void this.conn.send({ cmd: "clear_search" });
        }
        return;
    }
  }

  private onSearch(query: string, backwards: boolean): void {
    if (query !== this.lastQuery) {
      this.lastQuery = query;
      this.go({ cmd: "search", query }, "highlight");
    } else {
      this.go({ cmd: "search_next", query, backwards }, "highlight");
    }
  }

  private onEvent(ev: HelperEvent): void {
    if (this.disposed) return;
    switch (ev.event) {
      case "ready":
        this.view.setMessage(null);
        // The view's ResizeObserver sends the first viewport; if it already
        // did before `ready` it is queued in the pipe, which is fine. If the
        // tab has been measurable all along, make sure a viewport goes out.
        this.view.sendViewport();
        return;
      case "frame":
        return void this.onFrame(ev);
      case "error":
        this.d.debug(`[fast-reader] helper error: ${ev.message}`);
        return;
    }
  }

  /** Reads and paints frames, always skipping straight to the newest one. */
  private async onFrame(ev: FrameEvent): Promise<void> {
    this.pendingFrame = ev;
    if (this.drawing) return;
    this.drawing = true;
    try {
      while (this.pendingFrame && !this.disposed) {
        const f = this.pendingFrame;
        this.pendingFrame = null;
        let bytes: Uint8Array;
        try {
          bytes = await this.d.readFile(f.path);
        } catch {
          continue; // superseded: the helper already deleted this file
        }
        void this.d.removeFile(f.path).catch(() => {});
        if (this.pendingFrame || this.disposed) continue; // stale, a newer frame is waiting
        if (!this.active) continue; // arrived after the tab was backgrounded; don't re-grow the bitmap
        this.lastFrame = f;
        this.view.showFrame(f, bytes);
        this.scheduleGc();
      }
    } finally {
      this.drawing = false;
    }
  }

  private onExit(code: number, requested: boolean): void {
    if (requested || this.disposed) return;
    const detail = this.recentOutput.length ? `\n\n${this.recentOutput.join("\n")}` : "";
    this.view.setMessage(`The Fast Reader process stopped unexpectedly (exit code ${code}).\nClose this tab and reopen the PDF.${detail}`);
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.trimTimer !== null) this.d.clearTimeout(this.trimTimer);
    if (this.gcTimer !== null) this.d.clearTimeout(this.gcTimer);
    void this.conn
      .close()
      .catch(() => {})
      .then(() => this.d.removeDir(this.d.frameDir))
      .catch(() => {});
    this.view.dispose();
    this.d.onClosed(this);
    this.d.setTimeout(() => this.d.collectGarbage(), IDLE_GC_DELAY_MS); // free the closed tab's canvas/buffers
  }
}
