// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

/// <reference lib="dom" />
/**
 * The reader's DOM: a Zotero-style toolbar, an optional sidebar (thumbnails / annotations / outline), a
 * continuously scrolling stack of page boxes (each a canvas plus an overlay layer for search hits,
 * selection, annotations and links), popups and menus. Deliberately free of reader logic: it paints what
 * it is told and reports user intent through `ViewEvents`. DOM glue, verified live (STATUS.md) and in a
 * browser harness (scripts/ui-harness).
 */

import { ANNOTATION_COLORS } from "./annotations.ts";
import { createIcon, type IconName } from "./icons.ts";
import type { Layout } from "./layout.ts";
import type { OutlineNode, Rect } from "./protocol.ts";

const XHTML = "http://www.w3.org/1999/xhtml";

export type Tool = "highlight" | "underline" | "note" | null;
export type PageTheme = "light" | "dark" | "sepia";
export type SidebarTab = "thumbnails" | "annotations" | "outline";

export interface OverlayItem {
  kind: "search" | "search-current" | "selection" | "highlight" | "underline" | "note" | "link";
  /** px, relative to the page box (view space) */
  rect: Rect;
  color?: string;
  key?: string;
}

export interface SidebarAnnotation {
  key: string;
  kind: "highlight" | "underline" | "note";
  color: string;
  text: string;
  comment: string;
  pageLabel: string;
  page: number;
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  checked?: boolean;
  disabled?: boolean;
  separator?: boolean;
  run?: () => void;
}

export interface PagePointer {
  type: "down" | "move" | "up" | "dblclick" | "leave";
  clientX: number;
  clientY: number;
  shiftKey: boolean;
  /** 1 single, 2 double, 3 triple click */
  detail: number;
  button: number;
}

export interface ViewEvents {
  scrolled(): void;
  resized(width: number, height: number, dpr: number): void;
  zoomWheel(factor: number, clientX: number, clientY: number): void;
  pointer(e: PagePointer): void;
  key(e: KeyboardEvent): void;
  copy(e: ClipboardEvent): void;
  toggleSidebar(): void;
  prevPage(): void;
  nextPage(): void;
  gotoPage(n: number): void;
  zoomBy(factor: number): void;
  fit(mode: "width" | "page"): void;
  setTool(tool: Tool): void;
  setColor(hex: string): void;
  search(query: string, backwards: boolean): void;
  searchCleared(): void;
  openMenu(anchor: HTMLElement): void;
  sidebarTab(tab: SidebarTab): void;
  sidebarScrolled(): void;
  jumpToPage(page: number): void;
  jumpToAnnotation(key: string): void;
  outlineClick(node: OutlineNode): void;
}

const CSS = `
.fr-root{--fr-bg:Canvas;--fr-fg:CanvasText;--fr-border:color-mix(in srgb,CanvasText 16%,transparent);--fr-hover:color-mix(in srgb,CanvasText 9%,transparent);
  --fr-active:color-mix(in srgb,AccentColor 22%,transparent);--fr-stage:#e9e9ec;--fr-popup:Canvas;
  display:flex;flex-direction:column;width:100%;height:100%;min-height:0;color-scheme:light dark;background:var(--fr-bg);color:var(--fr-fg);
  font:message-box;font-size:13px;outline:none;position:relative;
  /* The root must never size itself from its content: Zotero's tab-content element grows with it, which
     made the viewport grow with the page width, which grew the fit-width scale -- a runaway to 800% on a
     document whose pages are wider than the window. Containment pins it to the deck's size. */
  contain:size;overflow:hidden}
@media (prefers-color-scheme:dark){.fr-root{--fr-stage:#2b2b2e}}
.fr-bar{display:flex;align-items:center;gap:2px;padding:3px 8px;flex:none;border-bottom:1px solid var(--fr-border);min-height:34px}
.fr-grp{display:flex;align-items:center;gap:2px}
.fr-bar .fr-grow{flex:1}
.fr-btn{display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:26px;padding:0 5px;border:none;border-radius:5px;background:none;color:inherit;font:inherit;cursor:default}
.fr-btn:hover{background:var(--fr-hover)}
.fr-btn[aria-pressed=true]{background:var(--fr-active)}
.fr-btn:disabled{opacity:.35}
.fr-sep{width:1px;align-self:stretch;margin:5px 5px;background:var(--fr-border)}
.fr-page-input{width:3em;text-align:center;font:inherit;border:1px solid var(--fr-border);border-radius:4px;background:var(--fr-bg);color:inherit;height:22px;padding:0 2px}
.fr-label{opacity:.7;white-space:nowrap;padding:0 4px;min-width:3.2em;text-align:center}
.fr-find{display:flex;align-items:center;gap:2px;border:1px solid var(--fr-border);border-radius:5px;padding:0 2px 0 6px;height:24px}
.fr-find input{border:none;background:none;color:inherit;font:inherit;width:11em;outline:none;height:20px}
.fr-find .fr-count{opacity:.65;font-size:11px;white-space:nowrap;padding:0 2px}
.fr-color-dot{width:14px;height:14px;border-radius:50%;border:1px solid color-mix(in srgb,CanvasText 35%,transparent)}
.fr-main{display:flex;flex:1;min-height:0}
.fr-side{width:236px;flex:none;display:none;flex-direction:column;border-inline-end:1px solid var(--fr-border);min-height:0}
.fr-root[data-sidebar=open] .fr-side{display:flex}
.fr-side-tabs{display:flex;gap:2px;padding:4px;border-bottom:1px solid var(--fr-border)}
.fr-side-tabs .fr-btn{flex:1}
.fr-side-body{flex:1;overflow:auto;min-height:0;position:relative}
.fr-thumb{display:flex;flex-direction:column;align-items:center;gap:3px;padding:8px 0 4px;cursor:default}
.fr-thumb canvas{background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35)}
.fr-thumb[data-current=true]{background:var(--fr-active)}
.fr-thumb span{font-size:11px;opacity:.7}
.fr-ann{margin:6px;padding:6px 8px;border-radius:6px;border:1px solid var(--fr-border);border-inline-start:4px solid var(--c);cursor:default}
.fr-ann:hover{background:var(--fr-hover)}
.fr-ann .fr-ann-meta{display:flex;justify-content:space-between;font-size:11px;opacity:.65;margin-bottom:3px}
.fr-ann .fr-ann-text{margin:2px 0}
.fr-ann .fr-ann-comment{margin-top:4px;font-style:italic}
.fr-empty{padding:16px;opacity:.6;text-align:center}
.fr-outline ul{list-style:none;margin:0;padding-inline-start:14px}
.fr-outline>ul{padding-inline-start:6px}
.fr-outline li>div{display:flex;align-items:center;gap:2px;padding:2px 4px;border-radius:4px;cursor:default}
.fr-outline li>div:hover{background:var(--fr-hover)}
.fr-twisty{width:14px;opacity:.7;text-align:center;flex:none}
.fr-scroller{position:relative;flex:1;min-width:0;overflow:auto;background:var(--fr-stage);scrollbar-gutter:stable}
.fr-pages{position:relative;min-width:100%}
.fr-page{position:absolute;background:#fff;box-shadow:0 1px 5px rgba(0,0,0,.4);user-select:none;-moz-user-select:none;cursor:text}
.fr-page canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.fr-ov{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.fr-ov>div{position:absolute;box-sizing:border-box}
.fr-ov .fr-o-search{background:rgba(255,213,0,.45);mix-blend-mode:multiply}
.fr-ov .fr-o-search-current{background:rgba(255,140,0,.6);mix-blend-mode:multiply}
.fr-ov .fr-o-selection{background:rgba(51,118,240,.35)}
.fr-ov .fr-o-highlight{opacity:.4;mix-blend-mode:multiply}
.fr-ov .fr-o-underline{border-bottom:2px solid var(--c);height:0 !important}
.fr-ov .fr-o-note{border-radius:3px 3px 3px 0;box-shadow:0 1px 3px rgba(0,0,0,.4);opacity:.95;border:1px solid rgba(0,0,0,.35)}
.fr-root[data-theme=dark] .fr-ov .fr-o-highlight{mix-blend-mode:screen;opacity:.55}
.fr-root[data-theme=dark] .fr-page canvas{filter:invert(1) hue-rotate(180deg)}
.fr-root[data-theme=dark] .fr-page{background:#111}
.fr-root[data-theme=sepia] .fr-page canvas{filter:sepia(.55) saturate(.9) brightness(.97)}
.fr-root[data-theme=sepia] .fr-page{background:#f4ecd8}
.fr-msg{position:absolute;inset:34px 0 0;display:flex;align-items:center;justify-content:center;text-align:center;padding:2em;white-space:pre-wrap;pointer-events:none;opacity:.8}
.fr-popup{position:absolute;z-index:20;background:var(--fr-popup);color:var(--fr-fg);border:1px solid var(--fr-border);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.28);padding:5px;display:none}
.fr-popup[data-open=true]{display:block}
.fr-colors{display:flex;gap:5px;padding:3px}
.fr-colors button{width:18px;height:18px;border-radius:50%;border:2px solid transparent;padding:0;cursor:default}
.fr-colors button[aria-pressed=true]{border-color:CanvasText}
.fr-popup-row{display:flex;align-items:center;gap:2px}
.fr-popup textarea{display:block;width:240px;height:70px;margin:4px 2px 2px;resize:vertical;font:inherit;border:1px solid var(--fr-border);border-radius:5px;background:var(--fr-bg);color:inherit;padding:4px}
.fr-popup .fr-quote{max-width:260px;max-height:4.2em;overflow:hidden;opacity:.75;padding:2px 4px;font-size:12px}
.fr-menu{min-width:230px;padding:4px 0}
.fr-menu button{display:flex;align-items:center;gap:8px;width:100%;text-align:start;border:none;background:none;color:inherit;font:inherit;padding:5px 12px;cursor:default}
.fr-menu button:hover:not(:disabled){background:var(--fr-hover)}
.fr-menu button:disabled{opacity:.4}
.fr-menu .fr-check{width:14px;flex:none}
.fr-menu hr{border:none;border-top:1px solid var(--fr-border);margin:4px 0}
.fr-reading{position:absolute;inset:0;overflow:auto;background:var(--fr-bg);display:none;z-index:5}
.fr-root[data-reading=true] .fr-reading{display:block}
.fr-reading article{max-width:42em;margin:0 auto;padding:24px 20px 80px;font:var(--fr-reading-size,17px)/1.65 Georgia,serif}
.fr-reading h6{margin:28px 0 8px;font:600 11px sans-serif;letter-spacing:.06em;text-transform:uppercase;opacity:.5}
.fr-reading p{margin:0 0 1em}
`;

export class ReaderView {
  readonly root: HTMLElement;
  readonly scroller: HTMLElement;
  readonly pagesEl: HTMLElement;
  private readonly doc: Document;
  private readonly win: Window;
  private readonly ev: ViewEvents;
  private readonly isMac: boolean;

  private readonly pageInput: HTMLInputElement;
  private readonly pageTotal: HTMLElement;
  private readonly zoomLabel: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly searchCount: HTMLElement;
  private readonly colorDot: HTMLElement;
  private readonly toolButtons = new Map<string, HTMLButtonElement>();
  private readonly sideBody: HTMLElement;
  private readonly sideTabs = new Map<SidebarTab, HTMLButtonElement>();
  private readonly popup: HTMLElement;
  private readonly message: HTMLElement;
  private readonly reading: HTMLElement;
  private readonly readingArticle: HTMLElement;

  private pageEls: HTMLElement[] = [];
  private canvases: HTMLCanvasElement[] = [];
  private overlays: HTMLElement[] = [];
  private sideTab: SidebarTab = "thumbnails";
  private thumbEls: HTMLElement[] = [];
  private thumbCanvases: HTMLCanvasElement[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private resizeTimer: number | null = null;
  private lastSent = { w: 0, h: 0, dpr: 0 };
  private dpr = 1;

  constructor(doc: Document, container: Element, ev: ViewEvents, isMac: boolean) {
    this.doc = doc;
    this.win = doc.defaultView as Window;
    this.ev = ev;
    this.isMac = isMac;

    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string, parent?: Element) => {
      const e = doc.createElementNS(XHTML, tag) as HTMLElementTagNameMap[K];
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      parent?.append(e);
      return e;
    };
    const btn = (icon: IconName, title: string, onClick: () => void, parent: Element, text?: string) => {
      const b = el("button", "fr-btn", undefined, parent);
      b.title = title;
      b.setAttribute("aria-label", title);
      b.append(createIcon(doc, icon, 16));
      if (text) b.append(doc.createTextNode(text));
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
      });
      return b;
    };

    this.root = el("div", "fr-root");
    this.root.tabIndex = -1;
    el("style", undefined, CSS, this.root);

    // ---- toolbar (mirrors Zotero's reader: sidebar/navigation/zoom left, tools centre, find + view right)
    const bar = el("div", "fr-bar", undefined, this.root);
    const left = el("div", "fr-grp", undefined, bar);
    btn("panel-left", "Toggle sidebar", () => ev.toggleSidebar(), left);
    el("span", "fr-sep", undefined, left);
    btn("chevron-left", "Previous page", () => ev.prevPage(), left);
    this.pageInput = el("input", "fr-page-input", undefined, left);
    this.pageInput.type = "text";
    this.pageInput.title = "Page number (Enter to go)";
    this.pageInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        const n = parseInt(this.pageInput.value, 10);
        if (n >= 1) ev.gotoPage(n);
        this.focus();
      } else if (e.key === "Escape") this.focus();
    });
    this.pageTotal = el("span", "fr-label", "/ –", left);
    btn("chevron-right", "Next page", () => ev.nextPage(), left);
    el("span", "fr-sep", undefined, left);
    btn("minus", "Zoom out", () => ev.zoomBy(1 / 1.15), left);
    this.zoomLabel = el("span", "fr-label", "", left);
    btn("plus", "Zoom in", () => ev.zoomBy(1.15), left);
    btn("move-horizontal", "Fit width", () => ev.fit("width"), left);
    btn("maximize", "Fit page", () => ev.fit("page"), left);

    el("span", "fr-grow", undefined, bar);
    const mid = el("div", "fr-grp", undefined, bar);
    const tool = (id: "highlight" | "underline" | "note", icon: IconName, title: string) => {
      const b = btn(icon, title, () => ev.setTool(b.getAttribute("aria-pressed") === "true" ? null : id), mid);
      b.setAttribute("aria-pressed", "false");
      this.toolButtons.set(id, b);
    };
    tool("highlight", "highlighter", "Highlight text");
    tool("underline", "underline", "Underline text");
    tool("note", "sticky-note", "Add note");
    const colorBtn = el("button", "fr-btn", undefined, mid);
    colorBtn.title = "Annotation color";
    this.colorDot = el("span", "fr-color-dot", undefined, colorBtn);
    colorBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showColorPopup(colorBtn);
    });
    el("span", "fr-grow", undefined, bar);

    const right = el("div", "fr-grp", undefined, bar);
    const find = el("div", "fr-find", undefined, right);
    find.append(createIcon(doc, "search", 14));
    this.searchInput = el("input", undefined, undefined, find);
    this.searchInput.type = "text";
    this.searchInput.placeholder = "Find in document";
    this.searchInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        if (this.searchInput.value.trim()) ev.search(this.searchInput.value, e.shiftKey);
      } else if (e.key === "Escape") {
        this.searchInput.value = "";
        this.searchCount.textContent = "";
        ev.searchCleared();
        this.focus();
      }
    });
    this.searchCount = el("span", "fr-count", "", find);
    btn("chevron-up", "Previous match", () => this.searchInput.value.trim() && ev.search(this.searchInput.value, true), find);
    btn("chevron-down", "Next match", () => this.searchInput.value.trim() && ev.search(this.searchInput.value, false), find);
    const more = btn("more", "View and more", () => ev.openMenu(more), right);

    // ---- sidebar + pages
    const main = el("div", "fr-main", undefined, this.root);
    const side = el("div", "fr-side", undefined, main);
    const tabs = el("div", "fr-side-tabs", undefined, side);
    const sideTab = (id: SidebarTab, icon: IconName, title: string) => {
      const b = btn(icon, title, () => ev.sidebarTab(id), tabs);
      this.sideTabs.set(id, b);
    };
    sideTab("thumbnails", "layout-grid", "Thumbnails");
    sideTab("annotations", "message-square", "Annotations");
    sideTab("outline", "list", "Outline");
    this.sideBody = el("div", "fr-side-body", undefined, side);
    this.sideBody.addEventListener("scroll", () => ev.sidebarScrolled());

    this.scroller = el("div", "fr-scroller", undefined, main);
    this.pagesEl = el("div", "fr-pages", undefined, this.scroller);
    this.reading = el("div", "fr-reading", undefined, this.scroller);
    this.readingArticle = el("article", undefined, undefined, this.reading);

    this.popup = el("div", "fr-popup", undefined, this.root);
    this.message = el("div", "fr-msg", "Opening…", this.root);

    // ---- events
    this.root.addEventListener("keydown", (e) => ev.key(e));
    this.root.addEventListener("copy", (e) => ev.copy(e));
    this.scroller.addEventListener("scroll", () => ev.scrolled(), { passive: true });
    this.scroller.addEventListener(
      "wheel",
      (e) => {
        if (!(e.ctrlKey || (this.isMac && e.metaKey))) return;
        e.preventDefault(); // trackpad pinch arrives as ctrl+wheel
        ev.zoomWheel(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
      },
      { passive: false }
    );
    const pointer = (type: PagePointer["type"]) => (e: MouseEvent) =>
      ev.pointer({ type, clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey, detail: e.detail, button: e.button });
    this.pagesEl.addEventListener("mousedown", (e) => {
      this.focus();
      this.hidePopups();
      if (e.button === 0) pointer("down")(e);
    });
    this.pagesEl.addEventListener("mousemove", pointer("move"));
    this.pagesEl.addEventListener("mouseleave", pointer("leave"));
    this.pagesEl.addEventListener("dblclick", pointer("dblclick"));
    this.win.addEventListener("mouseup", pointer("up"));
    this.root.addEventListener("mousedown", (e) => {
      if (!(e.target as Element).closest?.(".fr-popup")) this.hidePopups();
    });

    const RO = (this.win as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver;
    this.resizeObserver = new RO(() => this.scheduleViewport());
    this.resizeObserver.observe(this.scroller);

    container.append(this.root);
    this.setColor(ANNOTATION_COLORS[0]!.hex);
  }

  // -------------------------------------------------------------- basics
  focus(): void {
    this.root.focus();
  }
  focusSearch(): void {
    this.searchInput.focus();
    this.searchInput.select();
  }
  focusPage(): void {
    this.pageInput.focus();
    this.pageInput.select();
  }
  setMessage(text: string | null): void {
    this.message.textContent = text ?? "";
    this.message.style.display = text ? "flex" : "none";
  }
  setTheme(theme: PageTheme): void {
    this.root.dataset.theme = theme;
  }
  setPageInfo(page: number, total: number): void {
    if (this.doc.activeElement !== this.pageInput) this.pageInput.value = String(page);
    this.pageTotal.textContent = `/ ${total}`;
  }
  setZoomLabel(pct: number): void {
    this.zoomLabel.textContent = `${Math.round(pct)}%`;
  }
  setTool(tool: Tool): void {
    for (const [id, b] of this.toolButtons) b.setAttribute("aria-pressed", String(id === tool));
    this.scroller.style.cursor = tool === "note" ? "crosshair" : "";
  }
  setColor(hex: string): void {
    this.colorDot.style.background = hex;
  }
  setSearchStatus(text: string): void {
    this.searchCount.textContent = text;
  }
  get searchQuery(): string {
    return this.searchInput.value;
  }
  setSidebarOpen(open: boolean): void {
    this.root.dataset.sidebar = open ? "open" : "closed";
  }
  get sidebarOpen(): boolean {
    return this.root.dataset.sidebar === "open";
  }
  get viewport(): { width: number; height: number; left: number; top: number } {
    const r = this.scroller.getBoundingClientRect();
    return { width: this.scroller.clientWidth, height: this.scroller.clientHeight, left: r.left, top: r.top };
  }
  get devicePixelRatio(): number {
    return this.dpr;
  }

  measure(): { width: number; height: number; dpr: number } | null {
    const dpr = this.win.devicePixelRatio || 1;
    const w = this.scroller.clientWidth;
    const h = this.scroller.clientHeight;
    return w < 2 || h < 2 ? null : { width: w, height: h, dpr };
  }

  /** Reports the viewport if it changed since the last report. */
  sendViewport(): void {
    const m = this.measure();
    if (!m) return;
    if (m.width === this.lastSent.w && m.height === this.lastSent.h && m.dpr === this.lastSent.dpr) return;
    this.lastSent = { w: m.width, h: m.height, dpr: m.dpr };
    this.dpr = m.dpr;
    this.ev.resized(m.width, m.height, m.dpr);
  }

  private scheduleViewport(): void {
    if (this.lastSent.w === 0) return void this.sendViewport();
    if (this.resizeTimer !== null) this.win.clearTimeout(this.resizeTimer);
    this.resizeTimer = this.win.setTimeout(() => {
      this.resizeTimer = null;
      this.sendViewport();
    }, 100);
  }

  // -------------------------------------------------------------- pages
  /** (Re)creates `count` empty page boxes. */
  buildPages(count: number): void {
    this.pagesEl.replaceChildren();
    this.pageEls = [];
    this.canvases = [];
    this.overlays = [];
    for (let i = 0; i < count; i++) {
      const page = this.doc.createElementNS(XHTML, "div") as HTMLElement;
      page.className = "fr-page";
      page.dataset.page = String(i);
      const canvas = this.doc.createElementNS(XHTML, "canvas") as HTMLCanvasElement;
      canvas.width = canvas.height = 0;
      const ov = this.doc.createElementNS(XHTML, "div") as HTMLElement;
      ov.className = "fr-ov";
      page.append(canvas, ov);
      this.pagesEl.append(page);
      this.pageEls.push(page);
      this.canvases.push(canvas);
      this.overlays.push(ov);
    }
  }

  /** Positions every page box from a layout (px). Rows of pages are centred horizontally. */
  applyLayout(layout: Layout): void {
    const width = Math.max(this.scroller.clientWidth, layout.maxWidth + 16);
    this.pagesEl.style.width = `${width}px`;
    this.pagesEl.style.height = `${layout.total}px`;
    for (let i = 0; i < this.pageEls.length; i++) {
      const s = this.pageEls[i]!.style;
      s.top = `${layout.tops[i]}px`;
      s.left = `${(width - layout.maxWidth) / 2 + layout.lefts[i]!}px`;
      s.width = `${layout.widths[i]}px`;
      s.height = `${layout.heights[i]}px`;
    }
  }

  pageElement(i: number): HTMLElement | undefined {
    return this.pageEls[i];
  }
  /** Index of the page box under a client point, or null. */
  pageAtPoint(clientX: number, clientY: number): number | null {
    const el = this.doc.elementFromPoint(clientX, clientY)?.closest?.(".fr-page") as HTMLElement | null | undefined;
    return el ? Number(el.dataset.page) : null;
  }

  drawFrame(page: number, rgba: Uint8Array, width: number, height: number): void {
    const canvas = this.canvases[page];
    if (!canvas) return;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const ImageDataCtor = (this.win as unknown as { ImageData: typeof ImageData }).ImageData;
    ctx.putImageData(new ImageDataCtor(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, width * height * 4), width, height), 0, 0);
  }

  /** Frees a page's bitmap (it scrolled far away). The box and its overlays stay. */
  clearPage(page: number): void {
    const c = this.canvases[page];
    if (c) c.width = c.height = 0;
  }
  /** Frees every bitmap (tab backgrounded). */
  clearAllPages(): void {
    for (const c of this.canvases) c.width = c.height = 0;
  }
  hasBitmap(page: number): boolean {
    return (this.canvases[page]?.width ?? 0) > 0;
  }

  setOverlay(page: number, items: OverlayItem[]): void {
    const ov = this.overlays[page];
    if (!ov) return;
    ov.replaceChildren();
    for (const it of items) {
      const d = this.doc.createElementNS(XHTML, "div") as HTMLElement;
      d.className = `fr-o-${it.kind}`;
      const [x, y, w, h] = it.rect;
      d.style.left = `${x}px`;
      d.style.top = `${y}px`;
      d.style.width = `${w}px`;
      d.style.height = `${h}px`;
      if (it.color) {
        d.style.setProperty("--c", it.color);
        if (it.kind === "highlight" || it.kind === "note") d.style.background = it.color;
      }
      if (it.key) d.dataset.key = it.key;
      if (it.kind === "underline") {
        d.style.top = `${y + h - 1}px`;
      }
      ov.append(d);
    }
  }

  setCursor(cursor: string): void {
    this.pagesEl.style.cursor = cursor;
  }

  scrollBy(dy: number): void {
    this.scroller.scrollTop += dy;
  }

  // -------------------------------------------------------------- popups & menus
  private placePopup(x: number, y: number): void {
    const r = this.root.getBoundingClientRect();
    this.popup.style.left = "0px";
    this.popup.style.top = "0px";
    this.popup.dataset.open = "true";
    const pw = this.popup.offsetWidth;
    const ph = this.popup.offsetHeight;
    const left = Math.min(Math.max(4, x - r.left), r.width - pw - 4);
    const top = y - r.top + ph + 12 > r.height ? Math.max(4, y - r.top - ph - 8) : y - r.top + 10;
    this.popup.style.left = `${left}px`;
    this.popup.style.top = `${top}px`;
  }

  hidePopups(): void {
    this.popup.dataset.open = "false";
    this.popup.replaceChildren();
    this.popup.classList.remove("fr-menu");
  }

  get popupOpen(): boolean {
    return this.popup.dataset.open === "true";
  }

  private colorRow(active: string, onPick: (hex: string) => void): HTMLElement {
    const row = this.doc.createElementNS(XHTML, "div") as HTMLElement;
    row.className = "fr-colors";
    for (const c of ANNOTATION_COLORS) {
      const b = this.doc.createElementNS(XHTML, "button") as HTMLButtonElement;
      b.title = c.name;
      b.style.background = c.hex;
      b.setAttribute("aria-pressed", String(c.hex.toLowerCase() === active.toLowerCase()));
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        onPick(c.hex);
      });
      row.append(b);
    }
    return row;
  }

  private iconButton(icon: IconName, title: string, onClick: () => void): HTMLButtonElement {
    const b = this.doc.createElementNS(XHTML, "button") as HTMLButtonElement;
    b.className = "fr-btn";
    b.title = title;
    b.append(createIcon(this.doc, icon, 16));
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  showColorPopup(anchor: HTMLElement): void {
    this.hidePopups();
    this.popup.append(this.colorRow(this.colorDot.style.background ? rgbToHex(this.colorDot.style.background) : "", (hex) => {
      this.ev.setColor(hex);
      this.hidePopups();
    }));
    const r = anchor.getBoundingClientRect();
    this.placePopup(r.left, r.bottom);
  }

  /** The popup that follows a text selection: colors, highlight, underline, copy. */
  showSelectionPopup(x: number, y: number, active: string, a: { color(hex: string): void; highlight(): void; underline(): void; copy(): void; note(): void }): void {
    this.hidePopups();
    this.popup.append(this.colorRow(active, a.color));
    const row = this.doc.createElementNS(XHTML, "div") as HTMLElement;
    row.className = "fr-popup-row";
    row.append(
      this.iconButton("highlighter", "Highlight", a.highlight),
      this.iconButton("underline", "Underline", a.underline),
      this.iconButton("message-square", "Add note to selection", a.note),
      this.iconButton("copy", "Copy", a.copy)
    );
    this.popup.append(row);
    this.placePopup(x, y);
  }

  /** The popup for an existing annotation: quote, color, comment, delete. */
  showAnnotationPopup(x: number, y: number, a: { color: string; text: string; comment: string; kind: string }, h: { color(hex: string): void; comment(text: string): void; remove(): void; toNote(): void }): void {
    this.hidePopups();
    if (a.text) {
      const q = this.doc.createElementNS(XHTML, "div") as HTMLElement;
      q.className = "fr-quote";
      q.textContent = a.text;
      this.popup.append(q);
    }
    this.popup.append(this.colorRow(a.color, h.color));
    const ta = this.doc.createElementNS(XHTML, "textarea") as HTMLTextAreaElement;
    ta.placeholder = a.kind === "note" ? "Note text" : "Add comment";
    ta.value = a.comment;
    ta.addEventListener("keydown", (e) => e.stopPropagation());
    ta.addEventListener("blur", () => {
      if (ta.value !== a.comment) h.comment(ta.value);
    });
    this.popup.append(ta);
    const row = this.doc.createElementNS(XHTML, "div") as HTMLElement;
    row.className = "fr-popup-row";
    row.append(this.iconButton("file-text", "Create Zotero note from this annotation", h.toNote), this.iconButton("trash", "Delete annotation", h.remove));
    this.popup.append(row);
    this.placePopup(x, y);
    ta.focus();
  }

  showMenu(anchor: HTMLElement, items: MenuItem[]): void {
    this.hidePopups();
    this.popup.classList.add("fr-menu");
    for (const it of items) {
      if (it.separator) {
        this.popup.append(this.doc.createElementNS(XHTML, "hr"));
        continue;
      }
      const b = this.doc.createElementNS(XHTML, "button") as HTMLButtonElement;
      const check = this.doc.createElementNS(XHTML, "span") as HTMLElement;
      check.className = "fr-check";
      if (it.checked) check.append(createIcon(this.doc, "check", 14));
      b.append(check);
      if (it.icon) b.append(createIcon(this.doc, it.icon, 15));
      b.append(this.doc.createTextNode(it.label));
      b.disabled = !!it.disabled;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this.hidePopups();
        it.run?.();
      });
      this.popup.append(b);
    }
    const r = anchor.getBoundingClientRect();
    this.placePopup(r.right - 240, r.bottom);
  }

  // -------------------------------------------------------------- sidebar
  setSidebarTab(tab: SidebarTab): void {
    this.sideTab = tab;
    for (const [id, b] of this.sideTabs) b.setAttribute("aria-pressed", String(id === tab));
  }
  get sidebarTabNow(): SidebarTab {
    return this.sideTab;
  }
  get sidebarRect(): { top: number; height: number; scrollTop: number } {
    return { top: this.sideBody.getBoundingClientRect().top, height: this.sideBody.clientHeight, scrollTop: this.sideBody.scrollTop };
  }

  /** Builds thumbnail placeholders (`aspect` = height/width of each page). */
  buildThumbs(aspects: number[], width: number): void {
    this.sideBody.replaceChildren();
    this.thumbEls = [];
    this.thumbCanvases = [];
    aspects.forEach((aspect, i) => {
      const t = this.doc.createElementNS(XHTML, "div") as HTMLElement;
      t.className = "fr-thumb";
      t.dataset.page = String(i);
      const c = this.doc.createElementNS(XHTML, "canvas") as HTMLCanvasElement;
      c.width = c.height = 0; // a new canvas defaults to 300x150: don't allocate until a thumbnail is drawn
      c.style.width = `${width}px`;
      c.style.height = `${Math.round(width * aspect)}px`;
      const label = this.doc.createElementNS(XHTML, "span") as HTMLElement;
      label.textContent = String(i + 1);
      t.append(c, label);
      t.addEventListener("click", () => this.ev.jumpToPage(i));
      this.sideBody.append(t);
      this.thumbEls.push(t);
      this.thumbCanvases.push(c);
    });
  }
  /** Thumbnails whose boxes intersect the sidebar viewport. */
  visibleThumbs(): number[] {
    const top = this.sideBody.scrollTop;
    const bottom = top + this.sideBody.clientHeight;
    const out: number[] = [];
    this.thumbEls.forEach((t, i) => {
      if (t.offsetTop + t.offsetHeight >= top - 80 && t.offsetTop <= bottom + 80) out.push(i);
    });
    return out;
  }
  drawThumb(page: number, rgba: Uint8Array, width: number, height: number): void {
    const c = this.thumbCanvases[page];
    if (!c) return;
    c.width = width;
    c.height = height;
    const ImageDataCtor = (this.win as unknown as { ImageData: typeof ImageData }).ImageData;
    c.getContext("2d")?.putImageData(new ImageDataCtor(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, width * height * 4), width, height), 0, 0);
  }
  hasThumb(page: number): boolean {
    return (this.thumbCanvases[page]?.width ?? 0) > 0;
  }
  markCurrentThumb(page: number): void {
    this.thumbEls.forEach((t, i) => (t.dataset.current = String(i === page)));
    const t = this.thumbEls[page];
    if (t && this.sideTab === "thumbnails") {
      const top = this.sideBody.scrollTop;
      if (t.offsetTop < top || t.offsetTop + t.offsetHeight > top + this.sideBody.clientHeight) this.sideBody.scrollTop = t.offsetTop - 40;
    }
  }
  clearThumbs(): void {
    for (const c of this.thumbCanvases) c.width = c.height = 0;
  }

  renderAnnotations(list: SidebarAnnotation[]): void {
    this.sideBody.replaceChildren();
    this.thumbEls = [];
    if (!list.length) {
      const e = this.doc.createElementNS(XHTML, "div") as HTMLElement;
      e.className = "fr-empty";
      e.textContent = "No annotations. Select text and choose a color, or use a tool in the toolbar.";
      this.sideBody.append(e);
      return;
    }
    for (const a of list) {
      const card = this.doc.createElementNS(XHTML, "div") as HTMLElement;
      card.className = "fr-ann";
      card.style.setProperty("--c", a.color);
      const meta = this.doc.createElementNS(XHTML, "div") as HTMLElement;
      meta.className = "fr-ann-meta";
      meta.textContent = `${a.kind[0]!.toUpperCase()}${a.kind.slice(1)} · page ${a.pageLabel || a.page + 1}`;
      card.append(meta);
      if (a.text) {
        const t = this.doc.createElementNS(XHTML, "div") as HTMLElement;
        t.className = "fr-ann-text";
        t.textContent = a.text;
        card.append(t);
      }
      if (a.comment) {
        const c = this.doc.createElementNS(XHTML, "div") as HTMLElement;
        c.className = "fr-ann-comment";
        c.textContent = a.comment;
        card.append(c);
      }
      card.addEventListener("click", () => this.ev.jumpToAnnotation(a.key));
      this.sideBody.append(card);
    }
  }

  renderOutline(items: OutlineNode[]): void {
    this.sideBody.replaceChildren();
    this.thumbEls = [];
    if (!items.length) {
      const e = this.doc.createElementNS(XHTML, "div") as HTMLElement;
      e.className = "fr-empty";
      e.textContent = "This document has no outline.";
      this.sideBody.append(e);
      return;
    }
    const build = (nodes: OutlineNode[], depth: number): HTMLElement => {
      const ul = this.doc.createElementNS(XHTML, "ul") as HTMLElement;
      for (const n of nodes) {
        const li = this.doc.createElementNS(XHTML, "li") as HTMLElement;
        const row = this.doc.createElementNS(XHTML, "div") as HTMLElement;
        const tw = this.doc.createElementNS(XHTML, "span") as HTMLElement;
        tw.className = "fr-twisty";
        row.append(tw, this.doc.createTextNode(n.t || "(untitled)"));
        li.append(row);
        let kids: HTMLElement | null = null;
        if (n.c.length) {
          kids = build(n.c, depth + 1);
          const open = depth < 1;
          kids.style.display = open ? "" : "none";
          tw.textContent = open ? "▾" : "▸";
          tw.addEventListener("click", (e) => {
            e.stopPropagation();
            const hidden = kids!.style.display === "none";
            kids!.style.display = hidden ? "" : "none";
            tw.textContent = hidden ? "▾" : "▸";
          });
          li.append(kids);
        }
        row.addEventListener("click", () => this.ev.outlineClick(n));
        ul.append(li);
      }
      return ul;
    };
    const wrap = this.doc.createElementNS(XHTML, "div") as HTMLElement;
    wrap.className = "fr-outline";
    wrap.append(build(items, 0));
    this.sideBody.append(wrap);
  }

  // -------------------------------------------------------------- reading mode
  setReadingMode(on: boolean): void {
    this.root.dataset.reading = String(on);
  }
  get readingMode(): boolean {
    return this.root.dataset.reading === "true";
  }
  setReadingFontSize(px: number): void {
    this.root.style.setProperty("--fr-reading-size", `${px}px`);
  }
  /** Replaces the reading view's content: one heading + paragraphs per page. */
  renderReading(sections: Array<{ page: number; paragraphs: string[] | null }>): void {
    this.readingArticle.replaceChildren();
    for (const s of sections) {
      const h = this.doc.createElementNS(XHTML, "h6") as HTMLElement;
      h.textContent = `Page ${s.page + 1}`;
      h.dataset.page = String(s.page);
      this.readingArticle.append(h);
      if (s.paragraphs === null) {
        const p = this.doc.createElementNS(XHTML, "p") as HTMLElement;
        p.dataset.pending = String(s.page);
        p.textContent = "…";
        this.readingArticle.append(p);
      } else {
        for (const para of s.paragraphs) {
          const p = this.doc.createElementNS(XHTML, "p") as HTMLElement;
          p.textContent = para;
          this.readingArticle.append(p);
        }
      }
    }
  }
  get readingScroller(): HTMLElement {
    return this.reading;
  }
  /** Page headings currently within (or near) the reading viewport. */
  readingVisiblePages(): number[] {
    const top = this.reading.scrollTop - 400;
    const bottom = this.reading.scrollTop + this.reading.clientHeight + 400;
    const out: number[] = [];
    for (const h of Array.from(this.readingArticle.querySelectorAll("h6")) as HTMLElement[]) {
      if (h.offsetTop >= top && h.offsetTop <= bottom) out.push(Number(h.dataset.page));
    }
    return out;
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    if (this.resizeTimer !== null) this.win.clearTimeout(this.resizeTimer);
    this.clearAllPages();
    this.clearThumbs();
    this.root.remove();
  }
}

function rgbToHex(css: string): string {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css);
  if (!m) return css;
  return "#" + [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, "0")).join("");
}
