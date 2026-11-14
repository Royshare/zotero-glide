// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

/// <reference lib="dom" />
/**
 * The frame of a split view: two panes inside the reader tab's container with a draggable divider. Pure DOM; the
 * panes' content (two complete readers) is managed by ReaderTab. Design: docs/adr/005-split-view.md.
 */

import type { SplitMode } from "./tabView.ts";

const XHTML = "http://www.w3.org/1999/xhtml";

// The tab's own container becomes the flex box and the main reader stays where it is (moving it would reset its
// scroll position): only a divider and the second pane are added beside it.
const CSS = `
.fr-split{display:flex !important;min-width:0;min-height:0;overflow:hidden}
.fr-split[data-mode=columns]{flex-direction:row !important}
.fr-split[data-mode=rows]{flex-direction:column !important}
.fr-split>.fr-root{flex:1 1 0 !important;width:auto !important;height:auto !important;min-width:0;min-height:0;order:1;flex-grow:var(--fr-split-a,1) !important}
.fr-split>.fr-split-div{order:2}
.fr-split>.fr-split-pane{order:3;flex:1 1 0;flex-grow:var(--fr-split-b,1);position:relative;min-width:0;min-height:0;overflow:hidden}
.fr-split[data-swapped=true]>.fr-root{order:3}
.fr-split[data-swapped=true]>.fr-split-pane{order:1}
.fr-split-pane>.fr-root{width:100%;height:100%}
.fr-split-div{flex:none;background:color-mix(in srgb,CanvasText 18%,transparent);touch-action:none;z-index:3}
.fr-split[data-mode=columns]>.fr-split-div{width:5px;cursor:col-resize}
.fr-split[data-mode=rows]>.fr-split-div{height:5px;cursor:row-resize}
.fr-split-div:hover{background:AccentColor}
`;

export class SplitFrame {
  readonly paneB: HTMLElement;
  private readonly divider: HTMLElement;
  private readonly styleEl: HTMLElement;
  private readonly container: HTMLElement;
  private swapped = false;
  private mode: SplitMode = "columns";

  /** Turns `container` (the tab's content element, holding the main reader) into a two-pane frame. */
  constructor(doc: Document, container: Element, onResize: () => void) {
    const mk = (cls: string) => {
      const e = doc.createElementNS(XHTML, "div") as HTMLElement;
      e.className = cls;
      return e;
    };
    this.container = container as HTMLElement;
    this.styleEl = doc.createElementNS(XHTML, "style") as HTMLElement;
    this.styleEl.textContent = CSS;
    this.divider = mk("fr-split-div");
    this.divider.title = "Drag to resize";
    this.paneB = mk("fr-split-pane");
    this.container.classList.add("fr-split");
    this.container.append(this.styleEl, this.divider, this.paneB);

    this.divider.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.divider.setPointerCapture(e.pointerId);
    });
    this.divider.addEventListener("pointermove", (e) => {
      if (!this.divider.hasPointerCapture(e.pointerId)) return;
      const r = this.container.getBoundingClientRect();
      const cols = this.mode === "columns";
      const frac = (cols ? e.clientX - r.left : e.clientY - r.top) / (cols ? r.width : r.height);
      const a = Math.min(0.8, Math.max(0.2, this.swapped ? 1 - frac : frac));
      this.container.style.setProperty("--fr-split-a", String(a));
      this.container.style.setProperty("--fr-split-b", String(1 - a));
    });
    this.divider.addEventListener("pointerup", () => onResize());
  }

  setMode(mode: SplitMode): void {
    if (mode === "none") return;
    this.mode = mode;
    this.container.dataset.mode = mode;
    this.container.dataset.swapped = String(this.swapped);
  }

  swap(): void {
    this.swapped = !this.swapped;
    this.container.dataset.swapped = String(this.swapped);
  }

  /** Removes the second pane and restores the container. */
  dispose(): void {
    this.container.classList.remove("fr-split");
    for (const k of ["mode", "swapped"]) delete this.container.dataset[k];
    this.container.style.removeProperty("--fr-split-a");
    this.container.style.removeProperty("--fr-split-b");
    this.styleEl.remove();
    this.divider.remove();
    this.paneB.remove();
  }
}
