// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

/**
 * Keyboard -> reader action mapping for the in-tab reader. Pure, so it is unit-tested.
 *
 * The page area scrolls continuously, so the keys that scroll (arrows up/down, Space, PageUp/PageDown,
 * Shift+Space) are deliberately left to the browser (`null`). Left/Right jump a whole page.
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
}

export type ReaderAction =
  | { type: "next" }
  | { type: "prev" }
  | { type: "first" }
  | { type: "last" }
  | { type: "zoom"; factor: number }
  | { type: "fit"; mode: "width" | "page" }
  | { type: "focusSearch" }
  | { type: "focusPage" }
  | { type: "copy" }
  | { type: "selectAll" }
  | { type: "escape" };

export const ZOOM_STEP = 1.15;

/** `null` means "not ours -- let the browser/Zotero handle it". */
export function keyToAction(ev: KeyLike, ctx: KeyContext): ReaderAction | null {
  const primary = ctx.isMac ? ev.metaKey : ev.ctrlKey;
  const k = ev.key;

  if (primary && !ev.altKey) {
    switch (k.toLowerCase()) {
      case "f":
        return { type: "focusSearch" };
      case "g":
        return { type: "focusPage" };
      case "c":
        return { type: "copy" };
      case "a":
        return { type: "selectAll" };
      case "0":
        return { type: "fit", mode: "width" };
      case "+":
      case "=":
        return { type: "zoom", factor: ZOOM_STEP };
      case "-":
        return { type: "zoom", factor: 1 / ZOOM_STEP };
      default:
        return null;
    }
  }
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return null;

  switch (k) {
    case "ArrowRight":
      return { type: "next" };
    case "ArrowLeft":
      return { type: "prev" };
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
