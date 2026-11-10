/**
 * Keyboard -> reader action mapping for the in-tab reader. Pure, so the
 * behavior (especially "Space at the bottom of a page flips to the next
 * page, otherwise it just scrolls") is unit-tested. Mirrors the keys the
 * standalone window already supports (README "Keyboard"), plus scrolling
 * semantics that only make sense inside a scrollable tab.
 */

export interface KeyLike {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export interface KeyContext {
  isMac: boolean;
  /** Scroller is at (or within a pixel of) its top / bottom edge. */
  atTop: boolean;
  atBottom: boolean;
}

export type ReaderAction =
  | { type: "next" }
  | { type: "prev"; scroll: "top" | "bottom" }
  | { type: "first" }
  | { type: "last" }
  | { type: "zoom"; factor: number }
  | { type: "fit"; mode: "width" | "page" }
  | { type: "focusSearch" }
  | { type: "focusPage" }
  | { type: "escape" };

export const ZOOM_STEP = 1.15;

/** `null` means "not ours -- let the browser/Zotero handle it" (e.g. plain arrow-down scrolls natively). */
export function keyToAction(ev: KeyLike, ctx: KeyContext): ReaderAction | null {
  const primary = ctx.isMac ? ev.metaKey : ev.ctrlKey;
  const k = ev.key;

  if (primary && !ev.altKey) {
    if (k.toLowerCase() === "f") return { type: "focusSearch" };
    if (k.toLowerCase() === "g") return { type: "focusPage" };
    if (k === "+" || k === "=") return { type: "zoom", factor: ZOOM_STEP };
    if (k === "-") return { type: "zoom", factor: 1 / ZOOM_STEP };
    if (k === "0") return { type: "fit", mode: "width" };
    return null;
  }
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return null;

  switch (k) {
    case "ArrowRight":
      return { type: "next" };
    case "ArrowLeft":
      return { type: "prev", scroll: "top" };
    case "PageDown":
      return ctx.atBottom ? { type: "next" } : null;
    case "PageUp":
      return ctx.atTop ? { type: "prev", scroll: "bottom" } : null;
    case " ":
      if (ev.shiftKey) return ctx.atTop ? { type: "prev", scroll: "bottom" } : null;
      return ctx.atBottom ? { type: "next" } : null;
    case "Home":
      return { type: "first" };
    case "End":
      return { type: "last" };
    case "+":
    case "=":
      return { type: "zoom", factor: ZOOM_STEP };
    case "-":
      return { type: "zoom", factor: 1 / ZOOM_STEP };
    case "1":
      return { type: "fit", mode: "width" };
    case "2":
      return { type: "fit", mode: "page" };
    case "Escape":
      return { type: "escape" };
    default:
      return null;
  }
}
