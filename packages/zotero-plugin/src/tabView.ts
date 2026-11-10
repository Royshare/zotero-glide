/// <reference lib="dom" />
/**
 * DOM for one in-tab reader: toolbar + a natively scrolling canvas that
 * shows the RGBA page frames the helper renders. Deliberately dumb -- all
 * reader state (page, zoom, search hits) lives in the helper; this only
 * paints frames, reports user intent through `ViewCallbacks`, and owns
 * scroll behavior. Not unit-tested (it is DOM glue); verified live in
 * Zotero, see STATUS.md.
 */

import type { FrameEvent } from "./protocol.ts";
import { keyToAction, type ReaderAction } from "./readerKeys.ts";

const XHTML = "http://www.w3.org/1999/xhtml";

/** What to do with the scroll position when the next frame lands. */
export type ScrollIntent = "top" | "bottom" | "keep" | "highlight";

export interface ViewCallbacks {
  onAction(action: ReaderAction): void;
  onGoto(page: number): void;
  /** Enter in the search box. `backwards` = Shift+Enter. */
  onSearchSubmit(query: string, backwards: boolean): void;
  onSearchCleared(): void;
  onViewport(width: number, height: number, dpr: number): void;
}

const CSS = `
.fr-root { display:flex; flex-direction:column; width:100%; height:100%; min-height:0; color-scheme:light dark;
  background:Canvas; color:CanvasText; font:message-box; outline:none; }
.fr-bar { display:flex; align-items:center; gap:6px; padding:4px 8px; flex:none;
  border-bottom:1px solid color-mix(in srgb, CanvasText 18%, transparent); }
.fr-bar button { min-width:28px; padding:2px 6px; }
.fr-bar input { font:inherit; }
.fr-page { width:3.2em; text-align:center; }
.fr-sep { width:1px; align-self:stretch; background:color-mix(in srgb, CanvasText 18%, transparent); margin:2px 4px; }
.fr-grow { flex:1; }
.fr-status { opacity:.7; white-space:nowrap; }
.fr-scroller { position:relative; flex:1; min-height:0; overflow:auto; background:#3b3b3b; scrollbar-gutter:stable; }
.fr-page-box { position:relative; margin:0 auto; background:#fff; box-shadow:0 1px 6px rgba(0,0,0,.5); }
.fr-page-box canvas { display:block; width:100%; height:100%; }
.fr-hl { position:absolute; background:rgba(255,213,0,.45); mix-blend-mode:multiply; pointer-events:none; border-radius:2px; }
.fr-hl.fr-hl-current { background:rgba(255,140,0,.55); }
.fr-msg { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:#ddd;
  text-align:center; padding:2em; white-space:pre-wrap; pointer-events:none; }
`;

export class ReaderView {
  readonly root: HTMLElement;
  private readonly win: Window;
  private readonly doc: Document;
  private readonly cb: ViewCallbacks;
  private readonly isMac: boolean;

  private readonly scroller: HTMLElement;
  private readonly box: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly pageInput: HTMLInputElement;
  private readonly pageTotal: HTMLElement;
  private readonly zoomLabel: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly searchStatus: HTMLElement;
  private readonly message: HTMLElement;

  private scrollIntent: ScrollIntent = "top";
  private resizeObserver: ResizeObserver | null = null;
  private resizeTimer: number | null = null;
  private lastSent = { w: 0, h: 0, dpr: 0 };
  private lastDpr = 1;
  private pageCount = 0;

  constructor(doc: Document, container: Element, cb: ViewCallbacks, isMac: boolean) {
    this.doc = doc;
    this.win = doc.defaultView as Window;
    this.cb = cb;
    this.isMac = isMac;

    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
      const e = doc.createElementNS(XHTML, tag) as HTMLElementTagNameMap[K];
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const button = (label: string, title: string, onClick: () => void) => {
      const b = el("button", undefined, label);
      b.title = title;
      b.addEventListener("click", () => {
        onClick();
        this.focus();
      });
      return b;
    };

    this.root = el("div", "fr-root");
    this.root.tabIndex = -1;
    this.root.append(el("style", undefined, CSS));

    const bar = el("div", "fr-bar");
    this.pageInput = el("input", "fr-page");
    this.pageInput.type = "text";
    this.pageInput.title = "Page number (Enter to go)";
    this.pageInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        const n = parseInt(this.pageInput.value, 10);
        if (n >= 1) this.cb.onGoto(n);
        this.focus();
      } else if (e.key === "Escape") {
        this.focus();
      }
    });
    this.pageTotal = el("span", "fr-status", "/ –");
    this.zoomLabel = el("span", "fr-status", "");
    this.searchInput = el("input");
    this.searchInput.type = "search";
    this.searchInput.placeholder = "Search";
    this.searchInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        const q = this.searchInput.value;
        if (q.trim()) this.cb.onSearchSubmit(q, e.shiftKey);
      } else if (e.key === "Escape") {
        this.searchInput.value = "";
        this.searchStatus.textContent = "";
        this.cb.onSearchCleared();
        this.focus();
      }
    });
    this.searchStatus = el("span", "fr-status");

    bar.append(
      button("‹", "Previous page (←)", () => cb.onAction({ type: "prev", scroll: "top" })),
      this.pageInput,
      this.pageTotal,
      button("›", "Next page (→)", () => cb.onAction({ type: "next" })),
      el("span", "fr-sep"),
      button("−", "Zoom out (-)", () => cb.onAction({ type: "zoom", factor: 1 / 1.15 })),
      this.zoomLabel,
      button("+", "Zoom in (+)", () => cb.onAction({ type: "zoom", factor: 1.15 })),
      button("Fit width", "Fit width (1)", () => cb.onAction({ type: "fit", mode: "width" })),
      button("Fit page", "Fit page (2)", () => cb.onAction({ type: "fit", mode: "page" })),
      el("span", "fr-grow"),
      this.searchInput,
      this.searchStatus
    );

    this.scroller = el("div", "fr-scroller");
    this.box = el("div", "fr-page-box");
    this.canvas = el("canvas");
    this.box.append(this.canvas);
    this.message = el("div", "fr-msg", "Opening…");
    this.scroller.append(this.box, this.message);
    this.root.append(bar, this.scroller);
    container.append(this.root);

    this.root.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.scroller.addEventListener("mousedown", () => this.focus());
    // Trackpad pinch (reported as ctrl+wheel) and Ctrl/Cmd+wheel zoom the page.
    this.scroller.addEventListener(
      "wheel",
      (e) => {
        if (!(e.ctrlKey || (this.isMac && e.metaKey))) return;
        e.preventDefault();
        this.cb.onAction({ type: "zoom", factor: Math.exp(-e.deltaY * 0.01) });
      },
      { passive: false }
    );

    const RO = (this.win as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver;
    this.resizeObserver = new RO(() => this.scheduleViewport());
    this.resizeObserver.observe(this.scroller);
  }

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

  setScrollIntent(intent: ScrollIntent): void {
    this.scrollIntent = intent;
  }

  /** Shown over the page area: startup text, errors, "process ended". `null` hides it. */
  setMessage(text: string | null): void {
    this.message.textContent = text ?? "";
    this.message.style.display = text ? "flex" : "none";
  }

  /** Current viewport in *physical* pixels, or null while hidden/zero-sized. */
  measure(): { width: number; height: number; dpr: number } | null {
    const dpr = this.win.devicePixelRatio || 1;
    const w = Math.floor(this.scroller.clientWidth * dpr);
    const h = Math.floor(this.scroller.clientHeight * dpr);
    if (w < 2 || h < 2) return null;
    return { width: w, height: h, dpr };
  }

  /** Sends the viewport now if it changed since the last send. */
  sendViewport(): void {
    const m = this.measure();
    if (!m) return;
    if (m.width === this.lastSent.w && m.height === this.lastSent.h && m.dpr === this.lastSent.dpr) return;
    this.lastSent = { w: m.width, h: m.height, dpr: m.dpr };
    this.lastDpr = m.dpr;
    this.cb.onViewport(m.width, m.height, m.dpr);
  }

  private scheduleViewport(): void {
    if (this.lastSent.w === 0) {
      this.sendViewport(); // first measurement: no debounce, the user is waiting
      return;
    }
    if (this.resizeTimer !== null) this.win.clearTimeout(this.resizeTimer);
    this.resizeTimer = this.win.setTimeout(() => {
      this.resizeTimer = null;
      this.sendViewport();
    }, 120);
  }

  private onKeyDown(e: KeyboardEvent): void {
    const s = this.scroller;
    const atTop = s.scrollTop <= 1;
    const atBottom = s.scrollTop + s.clientHeight >= s.scrollHeight - 1;
    const action = keyToAction(e, { isMac: this.isMac, atTop, atBottom });
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    this.cb.onAction(action);
  }

  /** Paints a frame. `rgba` is the helper's raw page: `width*height*4` bytes. */
  showFrame(ev: FrameEvent, rgba: Uint8Array): void {
    const win = this.win as unknown as { ImageData: typeof ImageData };
    const s = this.scroller;
    const oldH = this.box.offsetHeight;
    const oldW = this.box.offsetWidth;
    const centerY = s.scrollTop + s.clientHeight / 2;
    const centerX = s.scrollLeft + s.clientWidth / 2;

    this.canvas.width = ev.width;
    this.canvas.height = ev.height;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const clamped = new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, ev.width * ev.height * 4);
    ctx.putImageData(new win.ImageData(clamped, ev.width, ev.height), 0, 0);

    const dpr = this.lastDpr;
    this.box.style.width = `${ev.width / dpr}px`;
    this.box.style.height = `${ev.height / dpr}px`;

    // Highlights
    for (const old of Array.from(this.box.querySelectorAll(".fr-hl"))) old.remove();
    ev.highlights.forEach(([x, y, w, h], i) => {
      const d = this.doc.createElementNS(XHTML, "div") as HTMLElement;
      d.className = i === 0 ? "fr-hl fr-hl-current" : "fr-hl";
      d.style.left = `${x / dpr}px`;
      d.style.top = `${y / dpr}px`;
      d.style.width = `${w / dpr}px`;
      d.style.height = `${h / dpr}px`;
      this.box.append(d);
    });

    // Scroll position
    const intent = this.scrollIntent;
    this.scrollIntent = "keep";
    if (intent === "top") s.scrollTop = 0;
    else if (intent === "bottom") s.scrollTop = s.scrollHeight;
    else if (intent === "highlight" && ev.highlights[0]) {
      const [x, y, w, h] = ev.highlights[0];
      s.scrollTop = Math.max(0, (y + h / 2) / dpr - s.clientHeight / 2);
      s.scrollLeft = Math.max(0, (x + w / 2) / dpr - s.clientWidth / 2);
    } else if (intent === "keep" && oldH > 0 && oldW > 0) {
      // Zoom/fit: keep the same spot of the page under the middle of the view.
      s.scrollTop = Math.max(0, (centerY * this.box.offsetHeight) / oldH - s.clientHeight / 2);
      s.scrollLeft = Math.max(0, (centerX * this.box.offsetWidth) / oldW - s.clientWidth / 2);
    } else if (intent === "highlight") s.scrollTop = 0;

    // Status
    this.pageCount = ev.pageCount;
    if (this.doc.activeElement !== this.pageInput) this.pageInput.value = String(ev.page);
    this.pageTotal.textContent = `/ ${ev.pageCount}`;
    this.zoomLabel.textContent = `${ev.zoomPct}%`;
    this.searchStatus.textContent =
      ev.search.total > 0 ? `${ev.search.index + 1}/${ev.search.pages} pages · ${ev.search.total} hits` : "";
    this.setMessage(null);
  }

  get totalPages(): number {
    return this.pageCount;
  }

  /** Frees the Gecko-side bitmap while the tab is in the background. */
  releaseBitmap(): void {
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.lastSent = { w: 0, h: 0, dpr: 0 };
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    if (this.resizeTimer !== null) this.win.clearTimeout(this.resizeTimer);
    this.releaseBitmap();
    this.root.remove();
  }
}
