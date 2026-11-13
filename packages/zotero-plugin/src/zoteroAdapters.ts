// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

/**
 * The reader's connection to Zotero: where annotations live (Zotero's database, via
 * `Zotero.Annotations.saveFromJSON` -- the same path Zotero's own reader uses, so they sync and appear in
 * both readers), settings, and the small pure helpers around them. The parsing helpers are unit-tested; the
 * rest is verified live against a real Zotero (STATUS.md).
 */

import { parsePosition, type AnnotationDraft } from "./annotations.ts";
import type { AnnotationBackend, AnnotationRecord, GlobalSettings, NoteEditorHandle, NotesBackend } from "./readerTab.ts";
import { noteSummary, pageLinkHtml, sortNotes, type NoteItemLike, type NoteSummary } from "./notes.ts";
import { DEFAULT_SETTINGS } from "./readerTab.ts";
import type { KeyValueStorage } from "./positionStore.ts";

// ---------------------------------------------------------------- settings (pure)

const THEMES = ["auto", "light", "dark", "black", "sepia"] as const;
const TABS = ["thumbnails", "annotations", "outline", "images"] as const;

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
    sidebarWidth: typeof v.sidebarWidth === "number" && Number.isFinite(v.sidebarWidth) ? Math.min(600, Math.max(180, v.sidebarWidth)) : d.sidebarWidth,
    sidebarTab: (TABS as readonly unknown[]).includes(v.sidebarTab) ? (v.sidebarTab as GlobalSettings["sidebarTab"]) : d.sidebarTab,
    readingFontSize: typeof v.readingFontSize === "number" && Number.isFinite(v.readingFontSize) ? Math.min(32, Math.max(12, v.readingFontSize)) : d.readingFontSize,
    color: typeof v.color === "string" && /^#[0-9a-f]{6}$/i.test(v.color) ? v.color : d.color,
    notesOpen: typeof v.notesOpen === "boolean" ? v.notesOpen : d.notesOpen,
    notesWidth: typeof v.notesWidth === "number" && Number.isFinite(v.notesWidth) ? Math.min(720, Math.max(260, v.notesWidth)) : d.notesWidth,
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

/** Highlight, underline, note and image are drawn; ink/text annotations from Zotero's own reader are left alone. */
export function annotationToRecord(item: AnnotationItemLike): AnnotationRecord | null {
  if (item.annotationType !== "highlight" && item.annotationType !== "underline" && item.annotationType !== "note" && item.annotationType !== "image") return null;
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
  Annotations: {
    saveFromJSON(att: unknown, json: Record<string, unknown>): Promise<unknown>;
    saveCacheImage?(item: unknown, blob: Blob): Promise<unknown>;
    getCacheImagePath?(item: { libraryID: number; key: string }): string;
    toJSON?(item: unknown): Record<string, unknown>;
  };
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
    async create(draft: AnnotationDraft, image?: Blob) {
      const key = Z.DataObjectUtilities.generateKey();
      const saved = await Z.Annotations.saveFromJSON(att, { key, isExternal: false, ...draft });
      if (image && saved && Z.Annotations.saveCacheImage) await Z.Annotations.saveCacheImage(saved, image);
      return key;
    },
    imagePath(key) {
      return Z.Annotations.getCacheImagePath?.({ libraryID: att.libraryID, key }) ?? null;
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
    dragData(keys) {
      const items = keys.map((k) => Z.Items.getByLibraryAndKey(att.libraryID, k)).filter((i): i is ZoteroItemApi => !!i);
      if (!items.length || !Z.Annotations.toJSON) return null;
      // what Zotero's own reader puts on the drag clipboard for the note editor's drop handler
      return JSON.stringify(items.map((i) => ({ ...Z.Annotations.toJSON!(i), attachmentItemID: att.id })));
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


// ---------------------------------------------------------------- notes

/** The note-editor element (Zotero's chrome/content/zotero/elements/noteEditor.js) and its editor instance. */
interface NoteEditorInstance {
  _initPromise?: Promise<unknown>;
  onNavigate?: (uri: string, loc?: { position?: { pageIndex?: number } }) => unknown;
  insertAnnotations?(items: unknown[]): Promise<void>;
  _ensureNoteCreated?(): Promise<void>;
  _postMessage?(m: Record<string, unknown>): void;
}
interface NoteEditorElement extends HTMLElement {
  mode: string;
  viewMode: string;
  returnHandler: (() => void) | undefined;
  item: unknown;
  _editorInstance?: NoteEditorInstance | null;
  getCurrentInstance?(): NoteEditorInstance | null;
  saveSync?(): void;
  focus(): void;
}

interface ZoteroNoteItem extends NoteItemLike {
  deleted: boolean;
  parentID?: number | false;
  isNote?(): boolean;
  saveTx(): Promise<unknown>;
}

interface ZoteroNotesApi {
  Items: { get(id: number): unknown; getByLibraryAndKey(libraryID: number, key: string): unknown };
  Item: new (type: string) => { libraryID: number; parentID: number; id: number; setNote(html: string): void; saveTx(): Promise<unknown> };
  Libraries?: { get(id: number): { groupID?: number } | undefined };
  URI: { getURIItem(uri: string): Promise<{ id: number } | false | null> };
  EditorInstance?: ZoteroAnnotationApi["EditorInstance"];
  Notifier: ZoteroAnnotationApi["Notifier"];
  getActiveZoteroPane?(): { selectItem(id: number): Promise<unknown>; viewPDF?(id: number, loc: unknown): unknown } | undefined;
}

export interface NotesAttachmentApi {
  id: number;
  libraryID: number;
  key: string;
  parentID?: number | false;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Notes of the open PDF = child notes of its parent item, edited with Zotero's own `note-editor`, so they
 * sync, are searchable in Zotero, and take its citations and annotation inserts. A standalone PDF (no parent)
 * has no notes here.
 */
export function createNotesBackend(Z: ZoteroNotesApi, att: NotesAttachmentApi, doc: Document, notify: (m: string) => void): NotesBackend {
  let observerSeq = 0;
  const parent = (): { id: number; getNotes(): number[]; getDisplayTitle?(): string } | null =>
    att.parentID ? ((Z.Items.get(att.parentID) as { id: number; getNotes(): number[]; getDisplayTitle?(): string } | undefined) ?? null) : null;
  const annotationItems = (keys: string[]) => keys.map((k) => Z.Items.getByLibraryAndKey(att.libraryID, k)).filter((i): i is object => !!i);

  return {
    available: !!att.parentID,
    parentTitle: () => parent()?.getDisplayTitle?.() ?? "",
    list() {
      const p = parent();
      if (!p) return [];
      const out: NoteSummary[] = [];
      for (const id of p.getNotes()) {
        const item = Z.Items.get(id) as ZoteroNoteItem | undefined;
        if (item && !item.deleted) out.push(noteSummary(item));
      }
      return sortNotes(out);
    },
    async create() {
      const p = parent();
      if (!p) return null;
      const note = new Z.Item("note");
      note.libraryID = att.libraryID;
      note.parentID = p.id;
      note.setNote("");
      await note.saveTx();
      return note.id;
    },
    async createFromAnnotations(keys) {
      const p = parent();
      const items = annotationItems(keys);
      if (!p || !items.length || !Z.EditorInstance) return null;
      const note = await Z.EditorInstance.createNoteFromAnnotations(items, { parentID: p.id });
      return note?.id ?? null;
    },
    async trash(id) {
      const note = Z.Items.get(id) as ZoteroNoteItem | undefined;
      if (!note) return;
      note.deleted = true;
      await note.saveTx();
    },
    has(id) {
      const n = Z.Items.get(id) as ZoteroNoteItem | undefined;
      return !!n && !n.deleted && n.parentID === att.parentID;
    },
    showInLibrary(id) {
      void Z.getActiveZoteroPane?.()?.selectItem(id);
    },
    async mountEditor(container, id, opts) {
      const note = Z.Items.get(id);
      const win = doc.defaultView as (Window & { customElements: CustomElementRegistry }) | null;
      const create = (doc as unknown as { createXULElement?(tag: string): Element }).createXULElement;
      if (!note || !create || !win?.customElements.get("note-editor")) return null;
      const ed = create.call(doc, "note-editor") as NoteEditorElement;
      ed.style.cssText = "display:flex;flex:1;min-height:0;min-width:0;width:100%;height:100%";
      let gone = false;
      const destroy = () => {
        if (gone) return;
        gone = true;
        try {
          ed.saveSync?.(); // flush an edit still waiting for its debounce
        } catch {
          /* the editor may already be torn down */
        }
        ed.remove();
      };
      // like Zotero's own note window: attach first (the element builds its content on connect), then configure
      container.append(ed);
      ed.mode = "edit";
      ed.viewMode = "library";
      ed.returnHandler = opts.onReturn;
      ed.item = note;
      let tries = 0;
      while (!gone && !ed._editorInstance && tries++ < 200) await sleep(25);
      const inst = ed.getCurrentInstance?.() ?? ed._editorInstance;
      if (gone || !inst) {
        destroy();
        return null;
      }
      await inst._initPromise;
      inst.onNavigate = async (uri, loc) => {
        try {
          const target = await Z.URI.getURIItem(uri);
          if (!target) return;
          if (target.id === att.id) opts.onOpenAnnotation(loc?.position?.pageIndex ?? 0);
          else Z.getActiveZoteroPane?.()?.viewPDF?.(target.id, loc); // another PDF: Zotero's own behavior
        } catch (e) {
          notify(`Could not open the citation: ${e}`);
        }
      };
      const post = async (html: string): Promise<boolean> => {
        if (gone || !inst._postMessage) return false;
        await inst._ensureNoteCreated?.();
        inst._postMessage({ action: "insertHTML", pos: null, html });
        return true;
      };
      const handle: NoteEditorHandle = {
        async insertAnnotations(keys) {
          const items = annotationItems(keys);
          if (gone || !items.length || !inst.insertAnnotations) return false;
          await inst.insertAnnotations(items);
          return true;
        },
        insertHTML: post,
        focus: () => void ed.focus(),
        destroy,
      };
      return handle;
    },
    pageLink(label, page, annotationKey) {
      const lib = Z.Libraries?.get(att.libraryID);
      return pageLinkHtml(label, { groupID: lib?.groupID ?? 0, key: att.key, page, annotationKey });
    },
    subscribe(cb) {
      const id = `fast-reader-notes-${att.id}-${++observerSeq}`;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const fire = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(cb, 60);
      };
      const reg = Z.Notifier.registerObserver(
        {
          notify(event, _type, ids) {
            // a trashed or erased note no longer names its parent, so those events always refresh
            if (event === "delete" || event === "trash" || event === "restore") return fire();
            const p = att.parentID;
            for (const raw of ids) {
              const item = typeof raw === "number" ? (Z.Items.get(raw) as { parentID?: number | false; isNote?(): boolean } | undefined) : undefined;
              if (item?.isNote?.() && item.parentID === p) return fire();
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
