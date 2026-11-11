// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

/**
 * The reader's connection to Zotero: where annotations live (Zotero's database, via
 * `Zotero.Annotations.saveFromJSON` -- the same path Zotero's own reader uses, so they sync and appear in
 * both readers), settings, and the small pure helpers around them. The parsing helpers are unit-tested; the
 * rest is verified live against a real Zotero (STATUS.md).
 */

import { parsePosition, type AnnotationDraft } from "./annotations.ts";
import type { AnnotationBackend, AnnotationRecord, GlobalSettings } from "./readerTab.ts";
import { DEFAULT_SETTINGS } from "./readerTab.ts";
import type { KeyValueStorage } from "./positionStore.ts";

// ---------------------------------------------------------------- settings (pure)

const THEMES = ["light", "dark", "sepia"] as const;
const TABS = ["thumbnails", "annotations", "outline"] as const;

/** Reads the settings pref defensively: any bad or missing field falls back to its default. */
export function parseSettings(raw: string | undefined): GlobalSettings {
  let v: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) v = parsed as Record<string, unknown>;
  } catch {
    /* corrupt pref: defaults */
  }
  const d = DEFAULT_SETTINGS;
  return {
    theme: (THEMES as readonly unknown[]).includes(v.theme) ? (v.theme as GlobalSettings["theme"]) : d.theme,
    sidebarOpen: typeof v.sidebarOpen === "boolean" ? v.sidebarOpen : d.sidebarOpen,
    sidebarTab: (TABS as readonly unknown[]).includes(v.sidebarTab) ? (v.sidebarTab as GlobalSettings["sidebarTab"]) : d.sidebarTab,
    readingFontSize: typeof v.readingFontSize === "number" && Number.isFinite(v.readingFontSize) ? Math.min(32, Math.max(12, v.readingFontSize)) : d.readingFontSize,
    color: typeof v.color === "string" && /^#[0-9a-f]{6}$/i.test(v.color) ? v.color : d.color,
  };
}

/** Global settings kept as one JSON string in a pref (injected storage: testable). */
export function createSettingsStore(storage: KeyValueStorage): { get(): GlobalSettings; set(patch: Partial<GlobalSettings>): void } {
  return {
    get: () => parseSettings(storage.get()),
    set: (patch) => storage.set(JSON.stringify({ ...parseSettings(storage.get()), ...patch })),
  };
}

/** Seconds a backgrounded tab waits before trimming; the pref is user-editable so clamp whatever is in it. */
export function parseTrimDelayMs(value: unknown, fallbackMs = 2000): number {
  const s = typeof value === "number" ? value : typeof value === "string" ? parseFloat(value) : NaN;
  if (!Number.isFinite(s)) return fallbackMs;
  return Math.round(Math.min(600, Math.max(0.5, s)) * 1000);
}

// ---------------------------------------------------------------- opening at a location (pure)

/** Zotero's reader `location`: `{pageIndex}`, `{annotationID}` (an annotation *key*), `{pageLabel}`, or `{position}`. */
export function readerLocation(location: unknown): { pageIndex?: number; annotationKey?: string } {
  if (!location || typeof location !== "object") return {};
  const l = location as { pageIndex?: unknown; annotationID?: unknown; pageLabel?: unknown; position?: { pageIndex?: unknown } };
  const out: { pageIndex?: number; annotationKey?: string } = {};
  if (typeof l.annotationID === "string" && l.annotationID) out.annotationKey = l.annotationID;
  if (typeof l.pageIndex === "number" && l.pageIndex >= 0) out.pageIndex = Math.floor(l.pageIndex);
  else if (typeof l.position?.pageIndex === "number" && l.position.pageIndex >= 0) out.pageIndex = Math.floor(l.position.pageIndex);
  else if (typeof l.pageLabel === "string" && /^\d+$/.test(l.pageLabel)) out.pageIndex = Math.max(0, parseInt(l.pageLabel, 10) - 1);
  return out;
}

// ---------------------------------------------------------------- annotations

/** The fields of a Zotero annotation item that this reader reads. */
export interface AnnotationItemLike {
  key: string;
  parentID?: number;
  annotationType: string;
  annotationColor?: string;
  annotationText?: string;
  annotationComment?: string;
  annotationPageLabel?: string;
  annotationSortIndex?: string;
  annotationPosition?: string;
}

/** Highlight, underline and note are drawn; image/ink/text annotations from Zotero's own reader are left alone. */
export function annotationToRecord(item: AnnotationItemLike): AnnotationRecord | null {
  if (item.annotationType !== "highlight" && item.annotationType !== "underline" && item.annotationType !== "note") return null;
  const pos = parsePosition(item.annotationPosition ?? "");
  if (!pos) return null;
  return {
    key: item.key,
    kind: item.annotationType,
    color: item.annotationColor || "#ffd400",
    text: item.annotationText ?? "",
    comment: item.annotationComment ?? "",
    pageIndex: pos.pageIndex,
    pageLabel: item.annotationPageLabel ?? String(pos.pageIndex + 1),
    sortIndex: item.annotationSortIndex ?? "",
    rects: pos.rects,
  };
}

interface ZoteroAnnotationApi {
  Annotations: { saveFromJSON(att: unknown, json: Record<string, unknown>): Promise<unknown> };
  DataObjectUtilities: { generateKey(): string };
  Items: { getByLibraryAndKey(libraryID: number, key: string): ZoteroItemApi | false | null; get(id: number): ZoteroItemApi | undefined };
  Notifier: {
    registerObserver(o: { notify(event: string, type: string, ids: Array<number | string>, extra: unknown): void }, types: string[], id: string): string;
    unregisterObserver(id: string): void;
  };
  EditorInstance?: { createNoteFromAnnotations(items: unknown[], opts: { parentID?: number }): Promise<{ id: number } | undefined> };
  getActiveZoteroPane?(): { selectItem(id: number): Promise<unknown> } | undefined;
}

interface ZoteroItemApi extends AnnotationItemLike {
  id: number;
  isAnnotation(): boolean;
  saveTx(): Promise<unknown>;
  eraseTx(): Promise<unknown>;
}

export interface AttachmentApi {
  id: number;
  libraryID: number;
  key: string;
  parentID?: number | false;
  getAnnotations(): AnnotationItemLike[];
}

/** Annotation storage in Zotero itself, so they sync, show in Zotero's reader and note/citation features. */
export function createAnnotationBackend(Z: ZoteroAnnotationApi, att: AttachmentApi, notify: (m: string) => void): AnnotationBackend {
  let observerSeq = 0;
  return {
    list() {
      return att.getAnnotations().map(annotationToRecord).filter((r): r is AnnotationRecord => !!r);
    },
    async create(draft: AnnotationDraft) {
      const key = Z.DataObjectUtilities.generateKey();
      await Z.Annotations.saveFromJSON(att, { key, isExternal: false, ...draft });
      return key;
    },
    async update(key, patch) {
      const item = Z.Items.getByLibraryAndKey(att.libraryID, key);
      if (!item) return;
      if (patch.color !== undefined) item.annotationColor = patch.color;
      if (patch.comment !== undefined) item.annotationComment = patch.comment;
      await item.saveTx();
    },
    async remove(key) {
      const item = Z.Items.getByLibraryAndKey(att.libraryID, key);
      if (item) await item.eraseTx();
    },
    async createNote(keys) {
      const items = keys.map((k) => Z.Items.getByLibraryAndKey(att.libraryID, k)).filter((i): i is ZoteroItemApi => !!i);
      if (!items.length || !Z.EditorInstance) return notify("Could not create a note.");
      const note = await Z.EditorInstance.createNoteFromAnnotations(items, { parentID: att.parentID || undefined });
      if (note) {
        notify("Note created from annotations.");
        void Z.getActiveZoteroPane?.()?.selectItem(note.id);
      }
    },
    subscribe(cb) {
      const id = `fast-reader-annotations-${att.id}-${++observerSeq}`;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const fire = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(cb, 40); // a batch of changes -> one refresh
      };
      const reg = Z.Notifier.registerObserver(
        {
          notify(event, _type, ids) {
            if (event === "delete" || event === "trash") return fire();
            for (const raw of ids) {
              const item = typeof raw === "number" ? Z.Items.get(raw) : undefined;
              if (item?.isAnnotation() && item.parentID === att.id) return fire();
            }
          },
        },
        ["item"],
        id
      );
      return () => {
        if (timer) clearTimeout(timer);
        Z.Notifier.unregisterObserver(reg);
      };
    },
  };
}
