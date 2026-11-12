// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

/**
 * Remembers where you were in each PDF (page, how far into it, zoom, rotation, crop) so reopening a paper
 * returns to the same spot. Stored as one JSON string in a Zotero pref, newest 300 documents kept. Pure:
 * the storage is injected, so this is unit-tested without Zotero.
 */

import type { Rotation } from "./protocol.ts";
import type { ScrollMode, SpreadMode } from "./layout.ts";

export interface SavedPosition {
  page: number;
  /** how far into the page, 0..1 */
  fraction: number;
  zoom: { mode: "width" | "page" } | { mode: "fixed"; scale: number };
  rotation: Rotation;
  insets: [number, number, number, number] | null;
  /** page arrangement; absent in entries saved before it existed */
  scroll?: ScrollMode;
  spread?: SpreadMode;
}

interface Entry extends SavedPosition {
  /** last-saved time, ms; the oldest entries are dropped first */
  t: number;
}

export interface KeyValueStorage {
  get(): string | undefined;
  set(value: string): void;
}

export const MAX_ENTRIES = 300;

export class PositionStore {
  private readonly storage: KeyValueStorage;
  private readonly now: () => number;
  private readonly max: number;

  // Explicit fields rather than parameter properties: Node's type-stripping test runner doesn't support them.
  constructor(storage: KeyValueStorage, now: () => number = Date.now, max = MAX_ENTRIES) {
    this.storage = storage;
    this.now = now;
    this.max = max;
  }

  private read(): Record<string, Entry> {
    try {
      const raw = this.storage.get();
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, Entry>) : {};
    } catch {
      return {}; // a corrupt pref must never stop a PDF from opening
    }
  }

  load(key: string): SavedPosition | null {
    const e = this.read()[key];
    if (!e || typeof e.page !== "number" || !Number.isFinite(e.page) || e.page < 0) return null;
    const { t: _t, ...pos } = e;
    return { ...pos, fraction: Number.isFinite(pos.fraction) ? Math.min(1, Math.max(0, pos.fraction)) : 0 };
  }

  save(key: string, pos: SavedPosition): void {
    const all = this.read();
    all[key] = { ...pos, t: this.now() };
    const keys = Object.keys(all);
    if (keys.length > this.max) {
      keys.sort((a, b) => all[a]!.t - all[b]!.t);
      for (const k of keys.slice(0, keys.length - this.max)) delete all[k];
    }
    this.storage.set(JSON.stringify(all));
  }
}
