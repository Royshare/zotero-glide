// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

/**
 * One reader *tab* inside Zotero's own tab bar: a `Zotero_Tabs` tab whose content is a `ReaderView`, fed by
 * a per-tab `fast-reader-helper --serve` process. Closing the tab ends the process and the OS reclaims all of
 * its memory. Design: docs/adr/002-in-tab-reader.md and 003-continuous-reader.md.
 *
 * This is the reader's brain: continuous-scroll layout, asking the helper for exactly the visible pages,
 * text selection and copy, search, annotations (stored in Zotero, not in the PDF), links, outline,
 * thumbnails, zoom/rotate/crop, reading mode, and remembering where you were. The decision logic lives in
 * unit-tested pure modules (layout, textModel, annotations, positionStore, protocol); what is here is the
 * glue between them, the DOM view and Zotero, verified live and in the browser harness.
 */

import {
  buildMarkup, buildNote, hexToRgb, pdfRectsToPage, type AnnotationDraft, type AnnotationKind, type PdfRect, ANNOTATION_COLORS,
} from "./annotations.ts";
import { HelperConnection, type HelperProcess } from "./helperConnection.ts";
import {
  capRenderScale, captureAnchor, DEFAULT_ARRANGEMENT, isScrollMode, isSpreadMode, type Arrangement, type ScrollMode, type SpreadMode, clampScale, clipRect, computeLayout, currentPage, DEFAULT_VIEW, fitScale, pageAtOffset, referencePage, rectToView,
  scrollTopForAnchor, viewSize, viewToPage, visibleRange, type Layout, type ScrollAnchor, type ViewSettings,
} from "./layout.ts";
import type { PositionStore, SavedPosition } from "./positionStore.ts";
import type { FrameEvent, HelperEvent, LinkData, OutlineNode, PageInfo, Rect, Rotation } from "./protocol.ts";
import { keyToAction } from "./readerKeys.ts";
import {
  charOffsetOnPage, codePoints, hitTest, selectionRects, selectionText, wordRange, type PageText, type TextPos,
} from "./textModel.ts";
import { ReaderView, type MenuItem, type OverlayItem, type PagePointer, type PageTheme, type SidebarTab, type Tool } from "./tabView.ts";

/** Custom Zotero tab type. NO dash: Zotero splits tab types on "-" (`parseTabType`). */
export const TAB_TYPE = "fastreader";

/** How long a backgrounded tab keeps its pages before trimming them. */
export const BACKGROUND_TRIM_DELAY_MS = 2000;

/**
 * Every painted page is a 10-25 MB buffer that Gecko collects lazily (measured on Zotero 10.0.8: ~1465 MB in
 * the Zotero process after 30 page turns, ~964 MB after a forced GC). Once the reader has been idle this long,
 * force a collection (and again after a background trim / close). Idle-triggered, never mid-scroll.
 */
export const IDLE_GC_DELAY_MS = 1500;

/**
 * How far past the viewport (as a fraction of its height) pages are requested, and how far a bitmap is kept
 * once it leaves. Each painted page costs ~20 MB of canvas plus a similar compositor texture at retina size,
 * so these are deliberately small: a page scrolling into view is blank for a few ms (a render is ~12-40 ms)
 * rather than the reader holding several full-resolution pages "just in case". Measured: the first version
 * (0.6 screens of lookahead and two pages of slack) held four bitmaps and cost ~170 MB more than one.
 */
const REQUEST_OVERSCAN = 0.15;
const KEEP_OVERSCAN = 0.4;

const THUMB_ID_BASE = 1_000_000_000;
const AREA_ID_BASE = 1_500_000_000;
const THUMB_WIDTH = 120;
const MAX_CACHED_TEXTS = 60;

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

/** An annotation as stored in Zotero (PDF-space rects). */
export interface AnnotationRecord {
  key: string;
  kind: AnnotationKind;
  color: string;
  text: string;
  comment: string;
  pageIndex: number;
  pageLabel: string;
  sortIndex: string;
  rects: PdfRect[];
}

/** Zotero-side annotation operations (implemented in fastReader.ts over Zotero.Annotations). */
export interface AnnotationBackend {
  list(): AnnotationRecord[];
  create(draft: AnnotationDraft, image?: Blob): Promise<string>;
  /** Where Zotero keeps an image annotation's cached picture, if it has one. */
  imagePath(key: string): string | null;
  update(key: string, patch: { color?: string; comment?: string }): Promise<void>;
  remove(key: string): Promise<void>;
  createNote(keys: string[]): Promise<void>;
  /** Calls back when annotations of this attachment change (also from Zotero's own reader). Returns unsubscribe. */
  subscribe(cb: () => void): () => void;
}

/** Everything the reader asks of Zotero/the OS that isn't annotations. */
export interface HostActions {
  copyText(text: string): void;
  /** Puts a PNG on the clipboard as an image. */
  copyImage(png: Uint8Array): void;
  /** Asks where to save, writes the PNG; false if the user cancelled. */
  saveImageAs(png: Uint8Array, defaultName: string): Promise<boolean>;
  /** Asks for a folder (null if cancelled), then `writeImage` puts files in it. */
  chooseFolder(): Promise<string | null>;
  writeImage(folder: string, name: string, png: Uint8Array): Promise<void>;
  openURL(uri: string): void;
  openInZoteroReader(pageIndex: number): void;
  copyCitation(): Promise<void>;
  chooseExportPath(defaultName: string): Promise<string | null>;
  openExternally(): void;
  notify(message: string): void;
}

export interface GlobalSettings {
  theme: PageTheme;
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
  readingFontSize: number;
  color: string;
}

export const DEFAULT_SETTINGS: GlobalSettings = { theme: "auto", sidebarOpen: false, sidebarTab: "thumbnails", readingFontSize: 17, color: ANNOTATION_COLORS[0]!.hex };

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
  requestAnimationFrame(fn: () => void): number;
  /** How long a backgrounded tab waits before trimming (user preference). */
  trimDelayMs?(): number;
  debug(msg: string): void;
  /** Forces a garbage collection in Zotero's process (see IDLE_GC_DELAY_MS). */
  collectGarbage(): void;
  /** Called after the tab is closed (by the user or by us), for bookkeeping. */
  onClosed(tab: ReaderTab): void;

  annotations: AnnotationBackend;
  host: HostActions;
  positions: PositionStore;
  /** "libraryID/ATTACHMENTKEY" */
  positionKey: string;
  settings: { get(): GlobalSettings; set(patch: Partial<GlobalSettings>): void };
  /** Where to open: a 0-indexed page and/or an annotation to reveal. */
  initial?: { pageIndex?: number; annotationKey?: string };
}

type Zoom = { mode: "width" | "page" } | { mode: "fixed"; scale: number };

interface Inflight {
  page: number;
  key: string;
  thumb: boolean;
  /** an area capture: gets the bitmap (or null if it was superseded) instead of painting a page */
  area?: (f: { bytes: Uint8Array; width: number; height: number } | null) => void;
}

interface SearchState {
  query: string;
  /** every hit rectangle, in document order */
  list: Array<{ page: number; rect: Rect }>;
  byPage: Map<number, Rect[]>;
  current: number;
  /** navigate to the first/last hit once results arrive */
  pendingJump: "first" | "last" | null;
}

export class ReaderTab {
  readonly tabID: string;
  readonly pdfPath: string;
  private readonly d: ReaderTabDeps;
  private readonly view: ReaderView;
  private readonly conn: HelperConnection;
  private readonly unsubscribe: () => void;

  // lifecycle
  private active = true;
  private disposed = false;
  private trimTimer: number | null = null;
  private gcTimer: number | null = null;
  private renderTimer: number | null = null;
  private saveTimer: number | null = null;
  private frameRaf: number | null = null;
  private recentOutput: string[] = [];

  // document
  private pages: PageInfo[] = [];
  private viewport: { w: number; h: number; dpr: number } | null = null;
  private started = false;
  private settings: ViewSettings = { ...DEFAULT_VIEW };
  private zoom: Zoom = { mode: "width" };
  private scale = 1; // css px per point
  private arrange: Arrangement = { ...DEFAULT_ARRANGEMENT };
  private layout: Layout = { tops: [], lefts: [], heights: [], widths: [], total: 0, maxWidth: 0 };
  private tool: Tool = null;
  private areaDrag: { page: number; x0: number; y0: number; x1: number; y1: number } | null = null;
  private imageUrls = new Map<string, string>();
  private imageLoading = new Set<string>();
  private pageNow = 0;
  private initialDone = false;

  // rendering
  private nextId = 1;
  private inflight = new Map<number, Inflight>();
  private rendered = new Map<number, string>(); // page -> render key it was drawn at
  private pendingFrame = new Map<number, FrameEvent>();
  private drawing = false;
  private thumbRendered = new Set<number>();

  // text, links, search, selection, annotations
  private texts = new Map<number, PageText>();
  private textPending = new Set<number>();
  private textWaiters: Array<() => void> = [];
  private links = new Map<number, LinkData[]>();
  private linksPending = new Set<number>();
  private search: SearchState | null = null;
  private selection: { anchor: TextPos; focus: TextPos } | null = null;
  private drag: { page: number; moved: boolean; startX: number; startY: number; wordMode: boolean } | null = null;
  private annotations: AnnotationRecord[] = [];
  private annotationRects = new Map<string, Rect[]>(); // key -> page-space rects
  private outline: OutlineNode[] | null = null;
  private readingTexts = new Set<number>();
  private readingTimer: number | null = null;

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
        scrolled: () => this.onScrolled(),
        resized: (w, h, dpr) => this.onResized(w, h, dpr),
        zoomWheel: (f, _x, y) => this.zoomBy(f, y - this.view.viewport.top),
        pointer: (e) => this.onPointer(e),
        key: (e) => this.onKey(e),
        copy: (e) => this.onCopyEvent(e),
        toggleSidebar: () => this.setSidebar(!this.view.sidebarOpen),
        prevPage: () => this.goToPage(this.pageNow - 1),
        nextPage: () => this.goToPage(this.pageNow + 1),
        gotoPage: (n) => this.goToPage(n - 1),
        zoomBy: (f) => this.zoomBy(f),
        fit: (m) => this.setZoom({ mode: m }),
        setTool: (t) => this.setTool(t),
        setColor: (hex) => this.setColor(hex),
        search: (q, back) => this.doSearch(q, back),
        searchCleared: () => this.clearSearch(),
        openMenu: (anchor) => this.openMenu(anchor),
        sidebarTab: (t) => this.setSidebarTab(t),
        sidebarScrolled: () => this.onSidebarScrolled(),
        jumpToPage: (p) => this.goToPage(p),
        jumpToAnnotation: (k) => this.revealAnnotation(k),
        themeChanged: () => {
          this.resetRendered();
          this.requestVisible();
        },
        commentAnnotation: (k, text) => void this.d.annotations.update(k, { comment: text }),
        annotationMenu: (k, x, y) => this.showAnnotationMenu(k, x, y),
        outlineClick: (n) => this.onOutlineClick(n),
      },
      deps.isMac
    );
    const s = deps.settings.get();
    this.view.setTheme(s.theme);
    this.view.setColor(s.color);
    this.view.setReadingFontSize(s.readingFontSize);
    this.view.setSidebarOpen(s.sidebarOpen);
    this.view.setSidebarTab(s.sidebarTab);
    this.view.setMessage("Opening…");

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
    this.unsubscribe = deps.annotations.subscribe(() => this.refreshAnnotations());
    this.view.focus();
  }

  // ======================================================================= tab API
  select(): void {
    this.d.tabs.select(this.tabID);
  }

  /** Programmatic close (plugin shutdown). The tab's own `onClose` does the cleanup. */
  close(): void {
    if (!this.disposed) this.d.tabs.close(this.tabID);
  }

  /** Brings the tab to front and moves to a page and/or annotation (Zotero asked to open it there). */
  reveal(loc: { pageIndex?: number; annotationKey?: string }): void {
    this.select();
    if (loc.annotationKey) this.revealAnnotation(loc.annotationKey);
    else if (loc.pageIndex !== undefined) this.goToPage(loc.pageIndex);
  }

  /**
   * A backgrounded reader trims its page memory after a short delay, so an idle tab costs ~nothing but the
   * open document; showing it again re-renders what is visible.
   */
  setActive(active: boolean): void {
    if (this.disposed || active === this.active) return;
    this.active = active;
    if (this.trimTimer !== null) {
      this.d.clearTimeout(this.trimTimer);
      this.trimTimer = null;
    }
    if (active) {
      this.view.focus();
      this.view.sendViewport();
      this.requestVisible();
    } else {
      this.trimTimer = this.d.setTimeout(() => {
        this.trimTimer = null;
        void this.conn.send({ cmd: "trim" });
        this.view.clearAllPages();
        this.view.clearThumbs();
        this.rendered.clear();
        this.inflight.clear();
        this.pendingFrame.clear();
        this.thumbRendered.clear();
        this.scheduleGc();
      }, this.d.trimDelayMs?.() ?? BACKGROUND_TRIM_DELAY_MS);
    }
  }

  // ======================================================================= helper events
  private onEvent(ev: HelperEvent): void {
    if (this.disposed) return;
    switch (ev.event) {
      case "ready":
        this.pages = ev.pages;
        this.maybeStart();
        return;
      case "frame":
        return void this.onFrame(ev);
      case "skipped":
        this.inflight.get(ev.id)?.area?.(null);
        this.inflight.delete(ev.id);
        return;
      case "text":
        this.onText(ev.page, { lines: ev.lines });
        return;
      case "search":
        this.onSearchResult(ev.query, ev.hits);
        return;
      case "outline":
        this.outline = ev.items;
        if (this.view.sidebarTabNow === "outline") this.view.renderOutline(ev.items);
        return;
      case "links":
        this.links.set(ev.page, ev.links);
        this.linksPending.delete(ev.page);
        return;
      case "margins":
        if (ev.insets) this.settings = { ...this.settings, insets: ev.insets };
        else this.d.host.notify("This document has no margins to crop.");
        this.relayout();
        return;
      case "exported":
        this.d.host.notify(`Exported ${ev.count} annotation${ev.count === 1 ? "" : "s"} to ${ev.path}`);
        return;
      case "error":
        this.d.debug(`[fast-reader] helper error${ev.cmd ? ` (${ev.cmd})` : ""}: ${ev.message}`);
        return;
    }
  }

  private onExit(code: number, requested: boolean): void {
    if (requested || this.disposed) return;
    const detail = this.recentOutput.length ? `\n\n${this.recentOutput.join("\n")}` : "";
    this.view.setMessage(`The Fast Reader process stopped unexpectedly (exit code ${code}).\nClose this tab and reopen the PDF.${detail}`);
  }

  // ======================================================================= start-up and layout
  private onResized(w: number, h: number, dpr: number): void {
    this.viewport = { w, h, dpr };
    if (!this.started) return this.maybeStart();
    if (this.zoom.mode !== "fixed" || this.arrange.scroll === "wrapped") this.relayout();
    else this.view.applyLayout(this.layout);
    this.scheduleRender(60);
  }

  private maybeStart(): void {
    if (this.started || !this.pages.length || !this.viewport) return;
    this.started = true;
    this.view.setMessage(null);
    const saved = this.d.positions.load(this.d.positionKey);
    if (saved) {
      this.settings = { rotation: saved.rotation, insets: saved.insets };
      this.arrange = { scroll: isScrollMode(saved.scroll) ? saved.scroll : "vertical", spread: isSpreadMode(saved.spread) ? saved.spread : "none" };
      this.zoom = saved.zoom.mode === "fixed" ? { mode: "fixed", scale: saved.zoom.scale } : { mode: saved.zoom.mode };
    }
    this.view.buildPages(this.pages.length);
    this.relayout();
    const start = this.d.initial?.pageIndex !== undefined ? { page: this.d.initial.pageIndex, fraction: 0 } : saved ? { page: saved.page, fraction: saved.fraction } : null;
    if (start) this.scrollToPage(start.page, start.fraction);
    this.initialDone = true;
    this.refreshAnnotations();
    if (this.d.initial?.annotationKey) this.revealAnnotation(this.d.initial.annotationKey);
    if (this.view.sidebarOpen) this.setSidebarTab(this.view.sidebarTabNow);
    this.view.focus();
    this.requestVisible();
  }

  private computeScale(): number {
    const vp = this.viewport;
    if (!vp || !this.pages.length) return 1;
    if (this.zoom.mode === "fixed") return clampScale(this.zoom.scale);
    // Fit against a fixed reference page, never the current one (see referencePage: a scale that depends on
    // the current page diverges on documents that mix page sizes). The scrollbar gutter is reserved
    // (scrollbar-gutter: stable), so clientWidth is the usable width.
    const page = this.pages[referencePage(this.pages, this.settings)]!;
    return clampScale(fitScale(this.zoom.mode, page, this.settings, vp.w, vp.h, 24, this.arrange.spread === "none" ? 1 : 2));
  }

  /** Recomputes scale and layout, keeping the part of the document under the viewport centre in place. */
  private relayout(): void {
    if (!this.pages.length) return;
    const vh = this.view.viewport.height;
    const anchor: ScrollAnchor | null = this.layout.tops.length ? captureAnchor(this.layout, this.view.scroller.scrollTop, vh / 2) : null;
    this.scale = this.computeScale();
    this.layout = this.computeLayoutNow();
    this.view.applyLayout(this.layout);
    if (anchor && this.initialDone) this.view.scroller.scrollTop = scrollTopForAnchor(this.layout, anchor);
    this.view.setZoomLabel(this.scale * 100);
    this.refreshAllOverlays();
    this.onScrolled(true);
    this.scheduleRender(this.rendered.size ? 90 : 0);
  }

  private computeLayoutNow(): Layout {
    return computeLayout(this.pages, this.settings, this.scale, 8, 8, this.arrange, this.viewport?.w ?? Infinity);
  }

  setArrangement(next: Partial<Arrangement>): void {
    const arrange = { ...this.arrange, ...next };
    if (arrange.scroll === this.arrange.scroll && arrange.spread === this.arrange.spread) return;
    const page = this.pageNow;
    // "fit width" in wrapped mode would be one page per row; start from a zoom that shows several
    if (arrange.scroll === "wrapped" && this.arrange.scroll !== "wrapped" && this.zoom.mode !== "fixed") {
      this.zoom = { mode: "fixed", scale: clampScale(this.scale * 0.5) };
    }
    this.arrange = arrange;
    this.relayout();
    this.scrollToPage(page);
    this.requestVisible();
    this.schedulePositionSave();
  }

  private scrollToPage(page: number, fraction = 0): void {
    const p = Math.min(Math.max(page, 0), this.pages.length - 1);
    this.view.scroller.scrollTop = Math.max(0, this.layout.tops[p]! + fraction * this.layout.heights[p]! - 8);
    this.onScrolled();
  }

  /** First page of the row after (dir 1) or before (dir -1) the current one; rows hold several pages in spreads. */
  private stepRow(dir: 1 | -1): number {
    const tops = this.layout.tops;
    const cur = this.pageNow;
    if (!tops.length) return cur + dir;
    if (dir === 1) {
      let p = cur;
      while (p < tops.length && tops[p] === tops[cur]) p++;
      return p;
    }
    let p = cur - 1;
    while (p > 0 && tops[p - 1] === tops[p]) p--;
    return Math.max(p, 0);
  }

  goToPage(page: number): void {
    if (!this.pages.length) return;
    this.scrollToPage(page);
    this.requestVisible();
  }

  // ======================================================================= zoom / view settings
  setZoom(z: Zoom): void {
    this.zoom = z;
    this.relayout();
    this.schedulePositionSave();
  }

  zoomBy(factor: number, anchorOffset?: number): void {
    const cur = this.scale;
    const next = clampScale(cur * factor);
    if (next === cur) return;
    this.zoom = { mode: "fixed", scale: next };
    const vh = this.view.viewport.height;
    // keep the point under the pointer (or the viewport centre) fixed
    const prev = this.layout.tops.length ? captureAnchor(this.layout, this.view.scroller.scrollTop, anchorOffset ?? vh / 2) : null;
    this.scale = next;
    this.layout = this.computeLayoutNow();
    this.view.applyLayout(this.layout);
    if (prev) this.view.scroller.scrollTop = scrollTopForAnchor(this.layout, prev);
    this.view.setZoomLabel(this.scale * 100);
    this.refreshAllOverlays();
    this.onScrolled(true);
    this.scheduleRender(120); // pinch/wheel bursts: render once they settle; the stretched bitmaps cover the gap
    this.schedulePositionSave();
  }

  private rotate(delta: 90 | -90): void {
    const rotation = (((this.settings.rotation + delta) % 360) + 360) % 360 as Rotation;
    this.settings = { ...this.settings, rotation };
    this.resetRendered();
    this.relayout();
    this.schedulePositionSave();
  }

  private toggleCrop(): void {
    if (this.settings.insets) {
      this.settings = { ...this.settings, insets: null };
      this.resetRendered();
      this.relayout();
      this.schedulePositionSave();
    } else {
      void this.conn.send({ cmd: "margins" });
    }
  }

  /** Orientation/crop changed: every bitmap is the wrong shape; drop them rather than stretch them. */
  private resetRendered(): void {
    this.view.clearAllPages();
    this.view.clearThumbs();
    this.rendered.clear();
    this.inflight.clear();
    this.pendingFrame.clear();
    this.thumbRendered.clear();
    if (this.view.sidebarOpen && this.view.sidebarTabNow === "thumbnails") this.buildThumbnails();
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.view.setTool(tool);
  }

  private setColor(hex: string): void {
    this.d.settings.set({ color: hex });
    this.view.setColor(hex);
  }

  private setTheme(theme: PageTheme): void {
    this.d.settings.set({ theme });
    this.view.setTheme(theme);
  }

  // ======================================================================= scrolling and rendering
  private onScrolled(force = false): void {
    if (this.frameRaf !== null && !force) return;
    const run = () => {
      this.frameRaf = null;
      if (this.disposed || !this.started) return;
      const vh = this.view.viewport.height;
      const cur = currentPage(this.layout, this.view.scroller.scrollTop, vh);
      if (cur !== this.pageNow) {
        this.pageNow = cur;
        this.view.markCurrentThumb(cur);
      }
      this.view.setPageInfo(this.pageNow + 1, this.pages.length);
      this.requestVisible();
      this.schedulePositionSave();
      this.scheduleGc();
    };
    if (force) run();
    else this.frameRaf = this.d.requestAnimationFrame(run);
  }

  /** Pixels per point to render a page at: the screen resolution, capped so one frame stays a sane size. */
  private renderScaleFor(page: number): number {
    const s = viewSize(this.pages[page]!, this.settings);
    return capRenderScale(s.w, s.h, this.scale * (this.viewport?.dpr ?? 1));
  }

  /** Identifies what a drawn bitmap shows; a bitmap with another key is stale. (The cap makes it per page.) */
  private currentKey(page = 0): string {
    const ins = this.settings.insets ? this.settings.insets.map((v) => v.toFixed(1)).join(",") : "-";
    return `${this.renderScaleFor(page).toFixed(3)}|${this.settings.rotation}|${ins}`;
  }

  private scheduleRender(ms: number): void {
    if (this.renderTimer !== null) this.d.clearTimeout(this.renderTimer);
    if (ms <= 0) return this.requestVisible();
    this.renderTimer = this.d.setTimeout(() => {
      this.renderTimer = null;
      this.requestVisible();
    }, ms);
  }

  /** Asks the helper for the visible pages (and one screen of lookahead), frees pages that scrolled away. */
  private requestVisible(): void {
    if (this.disposed || !this.started || !this.active) return;
    const vh = this.view.viewport.height;
    const top = this.view.scroller.scrollTop;
    const [first, last] = visibleRange(this.layout, top, vh, vh * REQUEST_OVERSCAN);
    const [vFirst, vLast] = visibleRange(this.layout, top, vh, 0);
    const [keepFirst, keepLast] = visibleRange(this.layout, top, vh, vh * KEEP_OVERSCAN);
    const wanted: number[] = [];
    for (let p = first; p <= last; p++) wanted.push(p);
    wanted.sort((a, b) => Math.abs(a - this.pageNow) - Math.abs(b - this.pageNow));
    const inflightPages = new Map<number, string>();
    for (const f of this.inflight.values()) if (!f.thumb) inflightPages.set(f.page, f.key);
    for (const p of wanted) {
      const key = this.currentKey(p);
      if (this.rendered.get(p) === key || inflightPages.get(p) === key) continue;
      const info = this.pages[p]!;
      const id = this.nextId++;
      this.inflight.set(id, { page: p, key, thumb: false });
      const clip = this.settings.insets ? clipRect(info, this.settings) : null;
      void this.conn.send({ cmd: "render", id, page: p, scale: this.renderScaleFor(p), rotate: this.settings.rotation, clip });
    }
    // free what has left the viewport by more than a small margin
    for (const p of [...this.rendered.keys()]) {
      if (p < keepFirst || p > keepLast) {
        this.view.clearPage(p);
        this.rendered.delete(p);
      }
    }
    for (let p = vFirst; p <= vLast; p++) {
      this.ensureText(p);
      this.ensureLinks(p);
    }
    this.pruneTexts(vFirst, vLast);
    this.refreshOverlaysFor(vFirst, vLast);
    if (this.view.readingMode) this.requestReadingText();
  }

  /** Reads and paints frames, always skipping straight to the newest per page. */
  private async onFrame(ev: FrameEvent): Promise<void> {
    this.pendingFrame.set(ev.id, ev);
    if (this.drawing) return;
    this.drawing = true;
    try {
      while (this.pendingFrame.size && !this.disposed) {
        const [id, f] = this.pendingFrame.entries().next().value as [number, FrameEvent];
        this.pendingFrame.delete(id);
        const meta = this.inflight.get(id);
        this.inflight.delete(id);
        let bytes: Uint8Array | null = null;
        if (meta) {
          try {
            bytes = await this.d.readFile(f.path);
          } catch {
            bytes = null; // superseded: the helper already deleted this file
          }
        }
        void this.d.removeFile(f.path).catch(() => {});
        if (meta?.area) {
          meta.area(bytes ? { bytes, width: f.width, height: f.height } : null);
          continue;
        }
        if (!bytes || !meta || this.disposed || !this.active) continue;
        if (meta.thumb) {
          this.view.drawThumb(meta.page, bytes, f.width, f.height);
          this.thumbRendered.add(meta.page);
        } else if (meta.key === this.currentKey(meta.page)) {
          this.imagesAtDraw.set(meta.page, this.images.has(meta.page));
          this.view.drawFrame(meta.page, bytes, f.width, f.height, this.imageRectsPx(meta.page, f.width));
          this.rendered.set(meta.page, meta.key);
          this.refreshOverlaysFor(meta.page, meta.page);
        }
        this.scheduleGc();
      }
    } finally {
      this.drawing = false;
    }
  }

  // ======================================================================= text, links
  private ensureText(page: number): void {
    if (this.texts.has(page) || this.textPending.has(page)) return;
    this.textPending.add(page);
    void this.conn.send({ cmd: "text", page });
  }

  private ensureLinks(page: number): void {
    if (this.links.has(page) || this.linksPending.has(page)) return;
    this.linksPending.add(page);
    void this.conn.send({ cmd: "links", page });
  }

  private onText(page: number, text: PageText): void {
    this.texts.set(page, text);
    this.textPending.delete(page);
    const waiters = this.textWaiters.splice(0);
    waiters.forEach((w) => w());
    if (this.view.readingMode) this.scheduleReadingRender();
  }

  /** Resolves once every page's text is loaded (requesting those that aren't). Gives up after 4 s. */
  private loadTexts(pages: number[]): Promise<void> {
    const missing = pages.filter((p) => !this.texts.has(p));
    if (!missing.length) return Promise.resolve();
    missing.forEach((p) => this.ensureText(p));
    return new Promise((resolve) => {
      const timer = this.d.setTimeout(resolve, 4000);
      const check = () => {
        if (pages.every((p) => this.texts.has(p))) {
          this.d.clearTimeout(timer);
          resolve();
        } else this.textWaiters.push(check);
      };
      this.textWaiters.push(check);
    });
  }

  /** Keeps the text cache bounded: far-away pages go, except pages with the selection. */
  private pruneTexts(first: number, last: number): void {
    if (this.texts.size <= MAX_CACHED_TEXTS) return;
    const keep = new Set<number>();
    if (this.selection) for (let p = this.selection.anchor.page; p <= this.selection.focus.page; p++) keep.add(p);
    const sorted = [...this.texts.keys()].sort((a, b) => Math.abs(b - first) - Math.abs(a - first));
    for (const p of sorted) {
      if (this.texts.size <= MAX_CACHED_TEXTS) break;
      if (p >= first - 4 && p <= last + 4) continue;
      if (!keep.has(p) && !this.readingTexts.has(p)) this.texts.delete(p);
    }
  }

  // ======================================================================= overlays
  private pxRect(page: number, r: Rect): Rect {
    const v = rectToView(this.pages[page]!, this.settings, r);
    return [v[0] * this.scale, v[1] * this.scale, v[2] * this.scale, v[3] * this.scale];
  }

  private overlaysFor(page: number): OverlayItem[] {
    const items: OverlayItem[] = [];
    for (const a of this.annotations) {
      if (a.pageIndex !== page) continue;
      const rects = this.annotationRects.get(a.key) ?? [];
      if (a.kind === "note") {
        if (rects[0]) items.push({ kind: "note", rect: this.pxRect(page, rects[0]), color: a.color, key: a.key });
      } else for (const r of rects) items.push({ kind: a.kind, rect: this.pxRect(page, r), color: a.color, key: a.key });
    }
    const hits = this.search?.byPage.get(page);
    if (hits) {
      const cur = this.search!.list[this.search!.current];
      hits.forEach((r) => items.push({ kind: cur && cur.page === page && cur.rect === r ? "search-current" : "search", rect: this.pxRect(page, r) }));
    }
    if (this.selection) {
      const rects = selectionRects(this.texts, this.selection.anchor, this.selection.focus).get(page);
      rects?.forEach((r) => items.push({ kind: "selection", rect: this.pxRect(page, r) }));
    }
    return items;
  }

  private refreshOverlaysFor(first: number, last: number): void {
    for (let p = first; p <= last; p++) if (this.pages[p]) this.view.setOverlay(p, this.overlaysFor(p));
  }

  private refreshAllOverlays(): void {
    if (!this.layout.tops.length) return;
    const vh = this.view.viewport.height;
    const [a, b] = visibleRange(this.layout, this.view.scroller.scrollTop, vh, vh);
    this.refreshOverlaysFor(a, b);
  }

  // ======================================================================= pointer: selection, links, annotations
  private pageUnder(clientX: number, clientY: number): number {
    const p = this.view.pageAtPoint(clientX, clientY) ?? this.view.pageAtPoint(this.view.viewport.left + 10, clientY);
    if (p !== null) return p;
    return pageAtOffset(this.layout, this.view.scroller.scrollTop + clientY - this.view.viewport.top);
  }

  private clientToPage(page: number, clientX: number, clientY: number): { x: number; y: number } | null {
    const el = this.view.pageElement(page);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const [x, y] = viewToPage(this.pages[page]!, this.settings, (clientX - r.left) / this.scale, (clientY - r.top) / this.scale);
    return { x, y };
  }

  private linkAt(page: number, x: number, y: number): LinkData | null {
    return this.links.get(page)?.find((l) => x >= l.r[0] && x <= l.r[0] + l.r[2] && y >= l.r[1] && y <= l.r[1] + l.r[3]) ?? null;
  }

  private annotationAt(page: number, x: number, y: number): AnnotationRecord | null {
    for (let i = this.annotations.length - 1; i >= 0; i--) {
      const a = this.annotations[i]!;
      if (a.pageIndex !== page) continue;
      const rects = this.annotationRects.get(a.key) ?? [];
      if (rects.some((r) => x >= r[0] - 2 && x <= r[0] + r[2] + 2 && y >= r[1] - 2 && y <= r[1] + r[3] + 2)) return a;
    }
    return null;
  }

  private onPointer(e: PagePointer): void {
    if (!this.started) return;
    if (e.type === "leave") return this.view.setCursor("");
    const page = this.pageUnder(e.clientX, e.clientY);
    const pt = this.clientToPage(page, e.clientX, e.clientY);

    if (this.areaDrag) {
      if (e.type === "move" || e.type === "up") {
        const d = this.areaDrag;
        const info = this.pages[d.page]!;
        const q = this.clientToPage(d.page, e.clientX, e.clientY);
        if (q) {
          d.x1 = Math.min(info.w, Math.max(0, q.x));
          d.y1 = Math.min(info.h, Math.max(0, q.y));
        }
        if (e.type === "move") return this.refreshOverlaysFor(d.page, d.page);
        this.areaDrag = null;
        this.refreshOverlaysFor(d.page, d.page);
        void this.createImageFromArea(d.page, [Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0)]);
      }
      return;
    }

    if (e.type === "move" && !this.drag) {
      if (!pt) return;
      const over = this.linkAt(page, pt.x, pt.y) || this.annotationAt(page, pt.x, pt.y);
      this.view.setCursor(over ? "pointer" : this.tool === "note" ? "crosshair" : "");
      return;
    }

    if (e.type === "down") {
      if (!pt) return;
      if (this.tool === "note") return void this.createNoteAt(page, pt.x, pt.y);
      if (this.tool === "image") {
        this.clearSelection();
        this.areaDrag = { page, x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
        return;
      }
      const text = this.texts.get(page);
      const hit = text ? hitTest(text, page, pt.x, pt.y, { maxDistance: 6 }) : null;
      this.drag = { page, moved: false, startX: e.clientX, startY: e.clientY, wordMode: false };
      if (e.detail >= 2 && text && hit) {
        const line = text.lines[hit.line]!;
        const [c0, c1] = e.detail >= 3 ? [0, codePoints(line.t).length] : wordRange(line, hit.ch);
        this.selection = { anchor: { ...hit, ch: c0 }, focus: { ...hit, ch: c1 } };
        this.drag.wordMode = true;
        this.refreshSelectionOverlays();
      } else if (hit) {
        this.selection = { anchor: hit, focus: hit };
        this.refreshSelectionOverlays();
      } else {
        this.clearSelection();
      }
      return;
    }

    if (e.type === "move" && this.drag) {
      if (Math.abs(e.clientX - this.drag.startX) + Math.abs(e.clientY - this.drag.startY) > 3) this.drag.moved = true;
      this.autoScroll(e.clientY);
      if (!this.drag.moved || !this.selection || this.drag.wordMode) return;
      const text = this.texts.get(page);
      if (!text) return void this.ensureText(page);
      const p = pt ?? { x: 0, y: 0 };
      const hit = hitTest(text, page, p.x, p.y);
      if (hit) {
        this.selection = { anchor: this.selection.anchor, focus: hit };
        this.refreshSelectionOverlays();
      }
      return;
    }

    if (e.type === "up" && this.drag) {
      const d = this.drag;
      this.drag = null;
      if (!d.moved && !d.wordMode) {
        // a click: annotation, then link, otherwise just clears the selection
        if (pt) {
          const ann = this.annotationAt(page, pt.x, pt.y);
          if (ann) return this.showAnnotationPopup(ann, e.clientX, e.clientY);
          const link = this.linkAt(page, pt.x, pt.y);
          if (link) return this.followLink(link);
        }
        return this.clearSelection();
      }
      this.onSelectionFinished(e.clientX, e.clientY);
    }
  }

  private autoScrollTimer: number | null = null;
  private autoScroll(clientY: number): void {
    const vp = this.view.viewport;
    const edge = 28;
    const dy = clientY < vp.top + edge ? -(vp.top + edge - clientY) : clientY > vp.top + vp.height - edge ? clientY - (vp.top + vp.height - edge) : 0;
    if (dy) this.view.scrollBy(Math.max(-40, Math.min(40, dy)));
    void this.autoScrollTimer;
  }

  private followLink(link: LinkData): void {
    if (link.p !== null) this.goToPage(link.p);
    else if (link.u) this.d.host.openURL(link.u);
  }

  private refreshSelectionOverlays(): void {
    const vh = this.view.viewport.height;
    const [a, b] = visibleRange(this.layout, this.view.scroller.scrollTop, vh, vh);
    this.refreshOverlaysFor(a, b);
  }

  clearSelection(): void {
    if (!this.selection) return this.view.hidePopups();
    this.selection = null;
    this.view.hidePopups();
    this.refreshSelectionOverlays();
  }

  private selectionIsEmpty(): boolean {
    const s = this.selection;
    return !s || (s.anchor.page === s.focus.page && s.anchor.line === s.focus.line && s.anchor.ch === s.focus.ch);
  }

  private onSelectionFinished(clientX: number, clientY: number): void {
    if (this.selectionIsEmpty()) return this.clearSelection();
    if (this.tool === "highlight" || this.tool === "underline") return void this.createMarkupFromSelection(this.tool);
    const color = this.d.settings.get().color;
    this.view.showSelectionPopup(clientX, clientY, color, {
      color: (hex) => this.setColor(hex),
      highlight: () => void this.createMarkupFromSelection("highlight"),
      underline: () => void this.createMarkupFromSelection("underline"),
      copy: () => void this.copySelection(),
      note: () => void this.createMarkupFromSelection("highlight", true),
    });
  }

  private selectAll(): void {
    const last = this.pages.length - 1;
    void this.loadTexts([...Array(this.pages.length).keys()]).then(() => {
      const lastText = this.texts.get(last);
      if (!lastText?.lines.length) return;
      const ln = lastText.lines.length - 1;
      this.selection = { anchor: { page: 0, line: 0, ch: 0 }, focus: { page: last, line: ln, ch: codePoints(lastText.lines[ln]!.t).length } };
      this.refreshSelectionOverlays();
    });
  }

  // ======================================================================= copy
  private async currentSelectionText(): Promise<string> {
    const s = this.selection;
    if (!s || this.selectionIsEmpty()) return "";
    const lo = Math.min(s.anchor.page, s.focus.page);
    const hi = Math.max(s.anchor.page, s.focus.page);
    await this.loadTexts(Array.from({ length: hi - lo + 1 }, (_, i) => lo + i));
    return selectionText(this.texts, s.anchor, s.focus);
  }

  async copySelection(): Promise<void> {
    const text = await this.currentSelectionText();
    if (text) this.d.host.copyText(text);
    this.view.hidePopups();
  }

  private onCopyEvent(e: ClipboardEvent): void {
    if (this.selectionIsEmpty()) return;
    // the sync path: pages in range are normally loaded already (they were visible while selecting)
    const s = this.selection!;
    const text = selectionText(this.texts, s.anchor, s.focus);
    if (!text) return;
    e.preventDefault();
    e.clipboardData?.setData("text/plain", text);
  }

  // ======================================================================= annotations
  private refreshAnnotations(): void {
    if (this.disposed) return;
    this.annotations = [...this.d.annotations.list()].sort((a, b) => a.sortIndex.localeCompare(b.sortIndex));
    this.annotationRects.clear();
    for (const a of this.annotations) {
      const info = this.pages[a.pageIndex];
      if (info) this.annotationRects.set(a.key, pdfRectsToPage(a.rects, info.m));
    }
    if (this.view.sidebarOpen && this.view.sidebarTabNow === "annotations") this.renderAnnotationList();
    this.refreshAllOverlays();
  }

  private renderAnnotationList(): void {
    this.view.renderAnnotations(this.annotations.map((a) => ({ key: a.key, kind: a.kind, color: a.color, text: a.text, comment: a.comment, pageLabel: a.pageLabel, page: a.pageIndex })));
  }

  private async createMarkupFromSelection(kind: "highlight" | "underline", focusComment = false): Promise<void> {
    const s = this.selection;
    if (!s || this.selectionIsEmpty()) return;
    const color = this.d.settings.get().color;
    const lo = Math.min(s.anchor.page, s.focus.page);
    const hi = Math.max(s.anchor.page, s.focus.page);
    await this.loadTexts(Array.from({ length: hi - lo + 1 }, (_, i) => lo + i));
    const rectsByPage = selectionRects(this.texts, s.anchor, s.focus);
    const [start, end] = s.anchor.page < s.focus.page || (s.anchor.page === s.focus.page && (s.anchor.line < s.focus.line || (s.anchor.line === s.focus.line && s.anchor.ch <= s.focus.ch))) ? [s.anchor, s.focus] : [s.focus, s.anchor];
    let firstKey: string | null = null;
    for (const [page, rects] of rectsByPage) {
      const text = this.texts.get(page)!;
      const from: TextPos = page === start.page ? start : { page, line: 0, ch: 0 };
      const lastLine = text.lines.length - 1;
      const to: TextPos = page === end.page ? end : { page, line: lastLine, ch: codePoints(text.lines[lastLine]?.t ?? "").length };
      const draft = buildMarkup({
        kind, text: selectionText(this.texts, from, to), color, pageIndex: page, pageLabel: String(page + 1),
        pageRects: rects, charOffset: charOffsetOnPage(text, from), page: this.pages[page]!,
      });
      try {
        const key = await this.d.annotations.create(draft);
        firstKey ??= key;
      } catch (e) {
        this.d.debug(`[fast-reader] could not save annotation: ${e}`);
        this.d.host.notify("Could not save the annotation.");
      }
    }
    this.clearSelection();
    if (focusComment && firstKey) this.revealAnnotation(firstKey, true);
  }

  private async createNoteAt(page: number, x: number, y: number): Promise<void> {
    const draft = buildNote({ comment: "", color: this.d.settings.get().color, pageIndex: page, pageLabel: String(page + 1), x, y, page: this.pages[page]! });
    try {
      const key = await this.d.annotations.create(draft);
      this.setTool(null);
      this.revealAnnotation(key, true);
    } catch (e) {
      this.d.debug(`[fast-reader] could not save note: ${e}`);
      this.d.host.notify("Could not save the note.");
    }
  }

  /** The bitmap of a page-space rectangle, upright, at `scale` pixels per point (null if it could not be rendered). */
  private renderArea(page: number, rect: Rect, scale: number): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
    return new Promise((resolve) => {
      const id = AREA_ID_BASE + this.nextId++;
      this.inflight.set(id, { page, key: "area", thumb: false, area: resolve });
      void this.conn.send({ cmd: "render", id, page, scale, rotate: 0, clip: rect });
      this.d.setTimeout(() => resolve(null), 8000);
    });
  }

  // ---- the Images sidebar tab: every picture in the document, like Zotero's own reader
  private figures: Array<{ page: number; rect: Rect }> | null = null;
  private figuresToken = 0;
  private figureUrls: string[] = [];
  private figureUrlAt = new Map<number, string>();
  /** Frees the pictures of the Images tab (they are re-rendered when it is opened again). */
  private dropFigureImages(): void {
    this.figuresToken++;
    this.figureUrlAt.clear();
    for (const u of this.figureUrls.splice(0)) this.view.revokeUrl(u);
  }

  private showFigures(): void {
    const token = ++this.figuresToken;
    if (this.figures) return this.paintFigures(token);
    this.view.renderFigures([], () => {});
    for (let p = 0; p < this.pages.length; p++) if (!this.images.has(p) && !this.imagesPending.has(p)) {
      this.imagesPending.add(p);
      void this.conn.send({ cmd: "images", page: p });
    }
    this.buildFiguresIfReady();
  }

  private buildFiguresIfReady(): void {
    if (this.figures || this.view.sidebarTabNow !== "images" || !this.pages.length) return;
    if (this.pages.some((_, p) => !this.images.has(p))) return;
    const out: Array<{ page: number; rect: Rect }> = [];
    this.pages.forEach((info, page) => {
      // pieces of one figure often come as several images: merge the ones that touch
      const rects = (this.images.get(page) ?? []).filter((r) => r[2] >= 30 && r[3] >= 30).map((r) => [...r] as Rect);
      const touch = (a: Rect, b: Rect) => a[0] <= b[0] + b[2] + 6 && b[0] <= a[0] + a[2] + 6 && a[1] <= b[1] + b[3] + 6 && b[1] <= a[1] + a[3] + 6;
      for (let again = true; again; ) {
        again = false;
        for (let i = 0; i < rects.length && !again; i++) {
          for (let j = i + 1; j < rects.length; j++) {
            if (!touch(rects[i]!, rects[j]!)) continue;
            const a = rects[i]!, b = rects[j]!;
            const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]);
            rects[i] = [x0, y0, Math.max(a[0] + a[2], b[0] + b[2]) - x0, Math.max(a[1] + a[3], b[1] + b[3]) - y0];
            rects.splice(j, 1);
            again = true;
            break;
          }
        }
      }
      for (const r of rects) {
        const x0 = Math.max(0, r[0]), y0 = Math.max(0, r[1]);
        const x1 = Math.min(info.w, r[0] + r[2]), y1 = Math.min(info.h, r[1] + r[3]);
        const rect: Rect = [x0, y0, x1 - x0, y1 - y0];
        if (rect[2] < 30 || rect[3] < 30) continue;
        if (rect[2] * rect[3] > info.w * info.h * 0.9) continue; // a scanned page, not a figure
        out.push({ page, rect });
      }
    });
    this.figures = out;
    this.paintFigures(++this.figuresToken);
  }

  private copyImageFromUrl(url: string | undefined): void {
    if (!url) return this.d.host.notify("The image is not loaded yet.");
    void this.view.urlBytes(url).then((png) => {
      this.d.host.copyImage(png);
      this.d.host.notify("Image copied.");
    }).catch(() => this.d.host.notify("Could not copy the image."));
  }

  private saveImageFromUrl(url: string | undefined, name: string): void {
    if (!url) return this.d.host.notify("The image is not loaded yet.");
    void this.view.urlBytes(url).then((png) => this.d.host.saveImageAs(png, name)).then((saved) => saved && this.d.host.notify("Image saved.")).catch(() => this.d.host.notify("Could not save the image."));
  }

  /** A figure's PNG at a resolution good enough to keep (the sidebar copy is only 560 px wide). */
  private async figurePng(f: { page: number; rect: Rect }): Promise<Uint8Array | null> {
    const frame = await this.renderArea(f.page, f.rect, Math.min(5, Math.max(1, 2400 / f.rect[2])));
    const blob = frame ? await this.view.encodePng(frame.bytes, frame.width, frame.height) : null;
    if (!blob) return null;
    const url = this.view.blobUrl(blob);
    try {
      return await this.view.urlBytes(url);
    } finally {
      this.view.revokeUrl(url);
    }
  }

  private figureName(i: number): string {
    const f = this.figures![i]!;
    const nth = this.figures!.slice(0, i).filter((g) => g.page === f.page).length + 1;
    return `figure-p${f.page + 1}-${nth}.png`;
  }

  private async saveFigure(i: number): Promise<void> {
    const f = this.figures?.[i];
    if (!f) return;
    const png = await this.figurePng(f);
    if (!png) return this.d.host.notify("Could not render the image.");
    if (await this.d.host.saveImageAs(png, this.figureName(i))) this.d.host.notify("Image saved.");
  }

  /** Saves every picture of the document into a folder the user picks. */
  private async saveAllFigures(): Promise<void> {
    const figs = this.figures;
    if (!figs?.length) return this.d.host.notify("No images in this document.");
    const folder = await this.d.host.chooseFolder();
    if (!folder) return;
    this.d.host.notify(`Saving ${figs.length} images…`);
    let saved = 0;
    for (let i = 0; i < figs.length && !this.disposed; i++) {
      const png = await this.figurePng(figs[i]!);
      if (!png) continue;
      try {
        await this.d.host.writeImage(folder, this.figureName(i), png);
        saved++;
      } catch (e) {
        this.d.debug(`[fast-reader] could not write image: ${e}`);
      }
    }
    this.d.host.notify(saved === figs.length ? `Saved ${saved} images.` : `Saved ${saved} of ${figs.length} images.`);
  }

  private showFigureMenu(i: number, page: number, x: number, y: number): void {
    this.view.showMenuAt(x, y, [
      { label: "Copy image", icon: "copy", disabled: !this.figureUrlAt.has(i), run: () => this.copyImageFromUrl(this.figureUrlAt.get(i)) },
      { label: "Save image as…", icon: "download", run: () => void this.saveFigure(i) },
      { label: "Save all images…", icon: "download", run: () => void this.saveAllFigures() },
      { label: `Go to page ${page + 1}`, icon: "book-open", run: () => this.goToPage(page) },
    ]);
  }

  private paintFigures(token: number): void {
    const figs = this.figures;
    if (!figs) return;
    this.figureUrlAt.clear();
    for (const u of this.figureUrls.splice(0)) this.view.revokeUrl(u);
    this.view.renderFigures(figs.map((f) => ({ page: f.page, aspect: f.rect[3] / f.rect[2] })), (i) => this.goToPage(figs[i]!.page), (i, x, y) => this.showFigureMenu(i, figs[i]!.page, x, y), () => void this.saveAllFigures());
    void (async () => {
      for (let i = 0; i < figs.length; i++) {
        if (token !== this.figuresToken || this.disposed || this.view.sidebarTabNow !== "images") return;
        const f = figs[i]!;
        const frame = await this.renderArea(f.page, f.rect, Math.min(4, Math.max(0.5, 560 / f.rect[2])));
        if (!frame || token !== this.figuresToken) continue;
        const blob = await this.view.encodePng(frame.bytes, frame.width, frame.height);
        if (blob) {
          const url = this.view.blobUrl(blob);
          this.figureUrls.push(url);
          this.figureUrlAt.set(i, url);
          this.view.setFigureImage(i, url);
        }
      }
    })();
  }

  /** Renders the chosen page area as a PNG and stores it as an image annotation. */
  private async createImageFromArea(page: number, rect: Rect): Promise<void> {
    if (rect[2] < 6 || rect[3] < 6) return;
    const frame = await this.renderArea(page, rect, Math.min(4, Math.max(2, 900 / Math.max(rect[2], rect[3]))));
    if (!frame || this.disposed) return this.d.host.notify("Could not capture the area.");
    const blob = await this.view.encodePng(frame.bytes, frame.width, frame.height);
    if (!blob) return this.d.host.notify("Could not capture the area.");
    const draft = buildImage({ color: this.d.settings.get().color, pageIndex: page, pageLabel: String(page + 1), pageRect: rect, page: this.pages[page]! });
    try {
      const key = await this.d.annotations.create(draft, blob);
      this.imageUrls.set(key, this.view.blobUrl(blob));
      this.renderAnnotationList();
    } catch (e) {
      this.d.debug(`[fast-reader] could not save image annotation: ${e}`);
      this.d.host.notify("Could not save the image annotation.");
    }
  }

  /** Loads the cached picture of image annotations that the sidebar is about to show. */
  private loadAnnotationImages(): void {
    for (const a of this.annotations) {
      if (a.kind !== "image" || this.imageUrls.has(a.key) || this.imageLoading.has(a.key)) continue;
      const path = this.d.annotations.imagePath(a.key);
      if (!path) continue;
      this.imageLoading.add(a.key);
      void this.d
        .readFile(path)
        .then((bytes) => {
          this.imageUrls.set(a.key, this.view.blobUrl(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "image/png" })));
          if (!this.disposed) this.renderAnnotationList();
        })
        .catch(() => {})
        .finally(() => this.imageLoading.delete(a.key));
    }
  }

  private showAnnotationPopup(a: AnnotationRecord, clientX: number, clientY: number): void {
    this.view.showAnnotationPopup(clientX, clientY, a, {
      color: (hex) => void this.d.annotations.update(a.key, { color: hex }),
      comment: (text) => void this.d.annotations.update(a.key, { comment: text }),
      remove: () => {
        this.view.hidePopups();
        void this.d.annotations.remove(a.key);
      },
      toNote: () => {
        this.view.hidePopups();
        void this.d.annotations.createNote([a.key]);
      },
    });
  }

  /** Right-click menu for an annotation (sidebar card or on the page). */
  private showAnnotationMenu(key: string, x: number, y: number): void {
    const a = this.annotations.find((k) => k.key === key);
    if (!a) return;
    if (a.external) {
      return this.view.showMenuAt(x, y, [
        { label: "Go to annotation", icon: "book-open", run: () => this.revealAnnotation(key) },
        { label: "Copy text", icon: "copy", disabled: !(a.text || a.comment), run: () => this.d.host.copyText(a.text || a.comment) },
        { separator: true, label: "" },
        { label: "Stored in the PDF file (read-only)", disabled: true },
      ]);
    }
    const items: MenuItem[] = [
      { label: "Go to annotation", icon: "book-open", run: () => this.revealAnnotation(key) },
      { label: "Edit comment", icon: "message-square", run: () => this.revealAnnotation(key, true) },
      ...(a.kind === "image"
        ? [
            { label: "Copy image", icon: "copy" as const, disabled: !this.imageUrls.has(key), run: () => this.copyImageFromUrl(this.imageUrls.get(key)) },
            { label: "Save image as…", icon: "download" as const, disabled: !this.imageUrls.has(key), run: () => this.saveImageFromUrl(this.imageUrls.get(key), `annotation-p${a.pageIndex + 1}.png`) },
          ]
        : []),
      { separator: true, label: "" },
      ...ANNOTATION_COLORS.map((c): MenuItem => ({ label: c.name, swatch: c.hex, checked: c.hex.toLowerCase() === a.color.toLowerCase(), run: () => void this.d.annotations.update(key, { color: c.hex }) })),
      { separator: true, label: "" },
      { label: "Copy text", icon: "copy", disabled: !a.text || a.kind === "image", run: () => this.d.host.copyText(a.text) },
      { label: "Create Zotero note", icon: "file-text", run: () => void this.d.annotations.createNote([key]) },
      { separator: true, label: "" },
      { label: "Delete annotation", icon: "trash", run: () => void this.d.annotations.remove(key) },
    ];
    this.view.showMenuAt(x, y, items);
  }

  /** Scrolls an annotation into view and optionally opens its editor. */
  revealAnnotation(key: string, edit = false): void {
    const a = this.annotations.find((x) => x.key === key) ?? this.d.annotations.list().find((x) => x.key === key);
    if (!a || !this.pages[a.pageIndex]) return;
    const rect = (this.annotationRects.get(a.key) ?? pdfRectsToPage(a.rects, this.pages[a.pageIndex]!.m))[0];
    if (!rect) return this.goToPage(a.pageIndex);
    const v = this.pxRect(a.pageIndex, rect);
    this.view.scroller.scrollTop = Math.max(0, this.layout.tops[a.pageIndex]! + v[1] - this.view.viewport.height / 3);
    this.onScrolled(true);
    if (edit) {
      this.d.setTimeout(() => {
        const el = this.view.pageElement(a.pageIndex);
        if (!el) return;
        const r = el.getBoundingClientRect();
        this.showAnnotationPopup(a, r.left + v[0], r.top + v[1] + v[3]);
      }, 60);
    }
  }

  // ======================================================================= search
  private doSearch(query: string, backwards: boolean): void {
    if (this.search && this.search.query === query && this.search.list.length) {
      const n = this.search.list.length;
      this.search.current = (this.search.current + (backwards ? n - 1 : 1)) % n;
      return this.showSearchHit();
    }
    this.search = { query, list: [], byPage: new Map(), current: 0, pendingJump: backwards ? "last" : "first" };
    void this.conn.send({ cmd: "search", query });
  }

  private onSearchResult(query: string, hits: Array<{ page: number; rects: Rect[] }>): void {
    if (!this.search || this.search.query !== query) return;
    const list: SearchState["list"] = [];
    const byPage = new Map<number, Rect[]>();
    for (const h of hits) {
      byPage.set(h.page, h.rects);
      h.rects.forEach((rect) => list.push({ page: h.page, rect }));
    }
    this.search.list = list;
    this.search.byPage = byPage;
    this.search.current = this.search.pendingJump === "last" ? Math.max(0, list.length - 1) : 0;
    this.search.pendingJump = null;
    if (!list.length) {
      this.view.setSearchStatus("No matches");
      return this.refreshAllOverlays();
    }
    this.showSearchHit();
  }

  private showSearchHit(): void {
    const s = this.search;
    if (!s?.list.length) return;
    const hit = s.list[s.current]!;
    this.view.setSearchStatus(`${s.current + 1} / ${s.list.length}${hit ? "" : ""}`);
    const v = this.pxRect(hit.page, hit.rect);
    this.view.scroller.scrollTop = Math.max(0, this.layout.tops[hit.page]! + v[1] - this.view.viewport.height / 3);
    this.onScrolled(true);
    this.refreshAllOverlays();
  }

  private clearSearch(): void {
    const pages = this.search ? [...this.search.byPage.keys()] : [];
    this.search = null;
    this.view.setSearchStatus("");
    for (const p of pages) this.refreshOverlaysFor(p, p); // including pages that are scrolled out of view
    this.refreshAllOverlays();
  }

  // ======================================================================= sidebar
  private setSidebar(open: boolean): void {
    this.view.setSidebarOpen(open);
    this.d.settings.set({ sidebarOpen: open });
    if (open) this.setSidebarTab(this.view.sidebarTabNow);
    this.view.sendViewport();
    this.d.setTimeout(() => this.relayout(), 30);
  }

  private setSidebarTab(tab: SidebarTab): void {
    this.view.setSidebarTab(tab);
    if (tab !== "images") this.dropFigureImages();
    this.d.settings.set({ sidebarTab: tab });
    if (tab === "thumbnails") this.buildThumbnails();
    else if (tab === "annotations") this.renderAnnotationList();
    else if (tab === "images") this.showFigures();
    else {
      if (this.outline) this.view.renderOutline(this.outline);
      else void this.conn.send({ cmd: "outline" });
    }
  }

  private buildThumbnails(): void {
    if (!this.pages.length) return;
    this.thumbRendered.clear();
    this.view.buildThumbs(this.pages.map((p) => { const s = viewSize(p, this.settings); return s.h / s.w; }), THUMB_WIDTH);
    this.view.markCurrentThumb(this.pageNow);
    this.requestThumbnails();
  }

  private requestThumbnails(): void {
    if (!this.view.sidebarOpen || this.view.sidebarTabNow !== "thumbnails" || !this.active) return;
    const dpr = this.viewport?.dpr ?? 1;
    for (const p of this.view.visibleThumbs()) {
      if (this.thumbRendered.has(p) || [...this.inflight.values()].some((f) => f.thumb && f.page === p)) continue;
      const info = this.pages[p]!;
      const id = THUMB_ID_BASE + this.nextId++;
      this.inflight.set(id, { page: p, key: "thumb", thumb: true });
      const w = viewSize(info, this.settings).w;
      void this.conn.send({ cmd: "render", id, page: p, scale: (THUMB_WIDTH / w) * dpr, rotate: this.settings.rotation, clip: this.settings.insets ? clipRect(info, this.settings) : null });
    }
  }

  private onSidebarScrolled(): void {
    this.requestThumbnails();
  }

  private onOutlineClick(n: OutlineNode): void {
    if (n.p !== null) this.goToPage(n.p);
    else if (n.u) this.d.host.openURL(n.u);
  }

  // ======================================================================= reading mode
  private setReadingMode(on: boolean): void {
    this.view.setReadingMode(on);
    if (!on) return;
    this.renderReadingNow();
    this.view.readingScroller.onscroll = () => this.requestReadingText();
    this.requestReadingText();
    // start where the user is
    const h = this.view.readingScroller.querySelector(`h6[data-page="${this.pageNow}"]`) as HTMLElement | null;
    if (h) this.view.readingScroller.scrollTop = h.offsetTop - 12;
  }

  private requestReadingText(): void {
    for (const p of this.view.readingVisiblePages()) {
      if (!this.texts.has(p)) {
        this.ensureText(p);
      } else this.readingTexts.add(p);
    }
  }

  private scheduleReadingRender(): void {
    if (this.readingTimer !== null) return;
    this.readingTimer = this.d.setTimeout(() => {
      this.readingTimer = null;
      this.renderReadingNow();
    }, 80);
  }

  private renderReadingNow(): void {
    const scroller = this.view.readingScroller;
    const keepTop = scroller.scrollTop;
    this.view.renderReading(this.pages.map((_, page) => ({ page, paragraphs: this.paragraphsFor(page) })));
    scroller.scrollTop = keepTop;
  }

  private paragraphsFor(page: number): string[] | null {
    const t = this.texts.get(page);
    if (!t) return null;
    if (!t.lines.length) return [];
    this.readingTexts.add(page);
    const last = t.lines.length - 1;
    return selectionText(this.texts, { page, line: 0, ch: 0 }, { page, line: last, ch: codePoints(t.lines[last]!.t).length }).split("\n").filter((s) => s.trim());
  }

  // ======================================================================= menu and actions
  private openMenu(anchor: HTMLElement): void {
    const s = this.d.settings.get();
    const items: MenuItem[] = [
      { label: "Rotate right", icon: "rotate-cw", run: () => this.rotate(90) },
      { label: "Rotate left", icon: "rotate-ccw", run: () => this.rotate(-90) },
      { label: "Crop white margins", icon: "crop", checked: !!this.settings.insets, run: () => this.toggleCrop() },
      { separator: true, label: "" },
      { label: "Vertical scrolling", checked: this.arrange.scroll === "vertical", run: () => this.setArrangement({ scroll: "vertical" }) },
      { label: "Wrapped scrolling (several pages per row)", checked: this.arrange.scroll === "wrapped", run: () => this.setArrangement({ scroll: "wrapped" }) },
      { separator: true, label: "" },
      { label: "No spreads (single pages)", checked: this.arrange.spread === "none", run: () => this.setArrangement({ spread: "none" }) },
      { label: "Odd spreads (1-2, 3-4, …)", checked: this.arrange.spread === "odd", run: () => this.setArrangement({ spread: "odd" }) },
      { label: "Even spreads (1, 2-3, 4-5, …)", checked: this.arrange.spread === "even", run: () => this.setArrangement({ spread: "even" }) },
      { separator: true, label: "" },
      { label: "Match Zotero (auto)", icon: "sun", checked: s.theme === "auto", run: () => this.setTheme("auto") },
      { label: "Light pages", icon: "sun", checked: s.theme === "light", run: () => this.setTheme("light") },
      { label: "Dark pages", icon: "moon", checked: s.theme === "dark", run: () => this.setTheme("dark") },
      { label: "Black pages (inverted)", icon: "moon", checked: s.theme === "black", run: () => this.setTheme("black") },
      { label: "Sepia pages", icon: "book-open", checked: s.theme === "sepia", run: () => this.setTheme("sepia") },
      { label: "Reading mode (reflowed text)", icon: "file-text", checked: this.view.readingMode, run: () => this.setReadingMode(!this.view.readingMode) },
      { separator: true, label: "" },
      { label: "Select all text", run: () => this.selectAll() },
      { label: "Copy citation", icon: "quote", run: () => void this.d.host.copyCitation() },
      { label: "Create Zotero note from all annotations", icon: "file-text", disabled: !this.annotations.length, run: () => void this.d.annotations.createNote(this.annotations.map((a) => a.key)) },
      { separator: true, label: "" },
      { label: "Export PDF with annotations…", icon: "download", run: () => void this.exportAnnotated() },
      { label: "Open in system viewer (print)", icon: "printer", run: () => this.d.host.openExternally() },
      { label: "Open in Zotero’s own reader at this page", icon: "external-link", run: () => this.d.host.openInZoteroReader(this.pageNow) },
    ];
    this.view.showMenu(anchor, items);
  }

  private async exportAnnotated(): Promise<void> {
    const out = await this.d.host.chooseExportPath(`${this.d.title.replace(/[\\/:*?"<>|]/g, "_")} (annotated).pdf`);
    if (!out) return;
    const annotations = this.annotations
      .map((a) => {
        const rects = this.annotationRects.get(a.key) ?? [];
        return { page: a.pageIndex, kind: a.kind, rects, color: hexToRgb(a.color), contents: a.kind === "note" ? a.comment : a.comment };
      })
      .filter((a) => a.rects.length);
    void this.conn.send({ cmd: "export", path: out, annotations });
  }

  // ======================================================================= keyboard
  private onKey(e: KeyboardEvent): void {
    const action = keyToAction(e, { isMac: this.d.isMac });
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    switch (action.type) {
      case "next":
        return this.goToPage(this.stepRow(1));
      case "prev":
        return this.goToPage(this.stepRow(-1));
      case "first":
        return this.goToPage(0);
      case "last":
        return this.goToPage(this.pages.length - 1);
      case "zoom":
        return this.zoomBy(action.factor);
      case "fit":
        return this.setZoom({ mode: action.mode });
      case "focusSearch":
        return this.view.focusSearch();
      case "focusPage":
        return this.view.focusPage();
      case "copy":
        return void this.copySelection();
      case "selectAll":
        return this.selectAll();
      case "escape":
        if (this.view.readingMode) return this.setReadingMode(false);
        this.clearSelection();
        this.setTool(null);
        return;
    }
  }

  // ======================================================================= persistence, GC, teardown
  private currentPosition(): SavedPosition {
    const p = Math.min(this.pageNow, Math.max(0, this.pages.length - 1));
    const h = this.layout.heights[p] || 1;
    const fraction = Math.min(1, Math.max(0, (this.view.scroller.scrollTop + 8 - (this.layout.tops[p] ?? 0)) / h));
    return { page: p, fraction, zoom: this.zoom.mode === "fixed" ? { mode: "fixed", scale: this.zoom.scale } : { mode: this.zoom.mode }, rotation: this.settings.rotation, insets: this.settings.insets, scroll: this.arrange.scroll, spread: this.arrange.spread };
  }

  private schedulePositionSave(): void {
    if (!this.started || this.disposed) return;
    if (this.saveTimer !== null) this.d.clearTimeout(this.saveTimer);
    this.saveTimer = this.d.setTimeout(() => {
      this.saveTimer = null;
      this.savePositionNow();
    }, 1200);
  }

  private savePositionNow(): void {
    if (!this.started || !this.pages.length) return;
    try {
      this.d.positions.save(this.d.positionKey, this.currentPosition());
    } catch (e) {
      this.d.debug(`[fast-reader] could not save position: ${e}`);
    }
  }

  /** (Re)starts the idle timer; the collection runs only after IDLE_GC_DELAY_MS without new activity. */
  private scheduleGc(): void {
    if (this.gcTimer !== null) this.d.clearTimeout(this.gcTimer);
    this.gcTimer = this.d.setTimeout(() => {
      this.gcTimer = null;
      this.d.collectGarbage();
    }, IDLE_GC_DELAY_MS);
  }

  private dispose(): void {
    if (this.disposed) return;
    this.savePositionNow();
    this.disposed = true;
    for (const t of [this.trimTimer, this.gcTimer, this.renderTimer, this.saveTimer, this.readingTimer]) if (t !== null) this.d.clearTimeout(t);
    this.unsubscribe();
    void this.conn
      .close()
      .catch(() => {})
      .then(() => this.d.removeDir(this.d.frameDir))
      .catch(() => {});
    this.view.dispose();
    this.d.onClosed(this);
    this.d.setTimeout(() => this.d.collectGarbage(), IDLE_GC_DELAY_MS); // free the closed tab's canvases/buffers
  }
}
