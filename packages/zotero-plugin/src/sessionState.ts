// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

/**
 * Keeps the plugin's tabs out of Zotero's saved session.
 *
 * Zotero persists every tab as `{type, title, data, selected}` and, at the
 * next start, calls `Zotero_Tabs.tabHooks.restoreState[type]` for each. For a
 * type with no hook it falls back to `async () => {}` and then destructures
 * the `undefined` result -- a TypeError that aborts restoring *every* tab
 * after it, including the user's ordinary PDF.js reader tabs (found live on
 * Zotero 10.0.8: "TypeError: undefined has no properties" at tabs.js:611).
 * A hook registered by the plugin is not a fix (the plugin can start after
 * the pane has already restored). A reader tab is a live helper process, not
 * a document, so there is nothing to restore: simply never save it.
 *
 * Pure -- no Zotero APIs -- so it is unit-tested.
 */

export interface SessionTab {
  type: string;
  selected?: boolean;
}

/**
 * Returns `tabs` without any tab of `type`. If that removed the selected
 * tab, selection falls back to the first remaining tab (the library) rather
 * than leaving nothing selected.
 */
export function withoutTabType<T extends SessionTab>(tabs: T[], type: string): T[] {
  const kept = tabs.filter((t) => t.type !== type);
  if (kept.length === tabs.length) return tabs;
  if (kept.length > 0 && !kept.some((t) => t.selected)) {
    kept[0] = { ...kept[0]!, selected: true };
  }
  return kept;
}
