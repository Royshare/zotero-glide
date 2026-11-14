// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

/// <reference lib="dom" />
// Browser side of the UI harness (see server.mjs): the real ReaderTab with Zotero stood in by in-memory fakes.
import { NO_NOTES, ReaderTab, DEFAULT_SETTINGS, type AnnotationRecord, type GlobalSettings, type NotesBackend, type NoteEditorHandle, type ReaderTabDeps } from "../../packages/zotero-plugin/src/readerTab.ts";
import { PositionStore } from "../../packages/zotero-plugin/src/positionStore.ts";
import { buildMarkup, buildNote, type AnnotationDraft } from "../../packages/zotero-plugin/src/annotations.ts";
import { noteSummary, pageLinkHtml } from "../../packages/zotero-plugin/src/notes.ts";
import type { HelperProcess } from "../../packages/zotero-plugin/src/helperConnection.ts";

const params = new URLSearchParams(location.search);
const pdf = params.get("pdf") ?? "";

async function main() {
  const spawnHelper = async (path: string) => {
    const { id, frameDir } = (await (await fetch(`/open?pdf=${encodeURIComponent(path)}`)).json()) as { id: string; frameDir: string };
    return { frameDir, proc: makeProc(id) };
  };
  const makeProc = (id: string): HelperProcess => ({
    stdin: { write: async (d) => void (await fetch(`/stdin?s=${id}`, { method: "POST", body: d })), close: async () => {} },
    stdout: {
      readString: async () => {
        for (;;) {
          const t = await (await fetch(`/stdout?s=${id}`)).text();
          if (t !== "\u0000") return t;
        }
      },
    },
    kill: async () => {},
    wait: () => new Promise(() => {}),
  });
  const { proc, frameDir } = await spawnHelper(pdf);

  // ---- in-memory annotations; the page matrix is applied by the real code, so these are PDF-space like Zotero's
  const records: AnnotationRecord[] = [];
  const listeners = new Set<() => void>();
  let seq = 0;
  const annotations = {
    list: () => records.slice(),
    create: async (d: AnnotationDraft) => {
      const key = `HARN${String(++seq).padStart(4, "0")}`;
      records.push({ key, kind: d.type, color: d.color, text: d.text ?? "", comment: d.comment, pageIndex: d.position.pageIndex, pageLabel: d.pageLabel, sortIndex: d.sortIndex, rects: d.position.rects });
      listeners.forEach((l) => l());
      return key;
    },
    update: async (key: string, patch: { color?: string; comment?: string }) => {
      const r = records.find((x) => x.key === key);
      if (r) Object.assign(r, patch);
      listeners.forEach((l) => l());
    },
    remove: async (key: string) => {
      const i = records.findIndex((x) => x.key === key);
      if (i >= 0) records.splice(i, 1);
      listeners.forEach((l) => l());
    },
    createNote: async () => toast("(harness) would create a Zotero note"),
    dragData: (keys: string[]) => JSON.stringify(keys.map((k) => ({ id: k }))),
    subscribe: (cb: () => void) => (listeners.add(cb), () => listeners.delete(cb)),
  };
  void buildMarkup; void buildNote;

  const toast = (m: string) => {
    const t = document.getElementById("toast")!;
    t.textContent = m;
    t.style.display = "block";
    setTimeout(() => (t.style.display = "none"), 3000);
  };

  // ---- in-memory notes: a contenteditable stands in for Zotero's note-editor (?standalone=1 = a PDF with no parent item)
  const noteStore: Array<{ id: number; html: string; modified: string }> = [
    { id: 1, html: "<h1>Reading notes</h1><p>Main claim is in section 2.</p>", modified: new Date(Date.now() - 3600_000).toISOString().replace("T", " ").slice(0, 19) },
    { id: 2, html: "<p>Questions for the group meeting</p><p>What is the baseline?</p>", modified: "2026-10-01 09:00:00" },
  ];
  const noteListeners = new Set<() => void>();
  const fireNotes = () => noteListeners.forEach((l) => l());
  const standalone = params.get("standalone") === "1";
  const notes: NotesBackend = {
    available: !standalone,
    parentTitle: () => "Attention Is All You Need",
    list: () => noteStore.map((n) => noteSummary({ id: n.id, key: `NOTE${n.id}`.padEnd(8, "X"), dateModified: n.modified, getNote: () => n.html })).sort((a, b) => (a.modified < b.modified ? 1 : -1)),
    create: async () => {
      const id = Math.max(0, ...noteStore.map((n) => n.id)) + 1;
      noteStore.push({ id, html: "", modified: new Date().toISOString().replace("T", " ").slice(0, 19) });
      fireNotes();
      return id;
    },
    createFromAnnotations: async (keys) => {
      const id = Math.max(0, ...noteStore.map((n) => n.id)) + 1;
      noteStore.push({ id, html: keys.map((k) => `<blockquote>${records.find((r) => r.key === k)?.text ?? k}</blockquote>`).join(""), modified: new Date().toISOString().replace("T", " ").slice(0, 19) });
      fireNotes();
      return id;
    },
    trash: async (id) => {
      noteStore.splice(noteStore.findIndex((n) => n.id === id), 1);
      fireNotes();
    },
    has: (id) => noteStore.some((n) => n.id === id),
    showInLibrary: (id) => toast(`(harness) show note ${id} in library`),
    pageLink: (label, page, annotationKey) => pageLinkHtml(label, { groupID: 0, key: "HARNPDF1", page, annotationKey }),
    subscribe: (cb) => (noteListeners.add(cb), () => noteListeners.delete(cb)),
    mountEditor: async (container, id, opts) => {
      const n = noteStore.find((x) => x.id === id)!;
      const ed = document.createElement("div");
      ed.contentEditable = "true";
      ed.style.cssText = "flex:1;padding:10px;overflow:auto;outline:none;min-width:0";
      ed.innerHTML = n.html;
      ed.addEventListener("input", () => { n.html = ed.innerHTML; n.modified = new Date().toISOString().replace("T", " ").slice(0, 19); fireNotes(); });
      container.append(ed);
      void opts;
      const append = async (html: string) => { ed.insertAdjacentHTML("beforeend", html); ed.dispatchEvent(new Event("input")); return true; };
      const handle: NoteEditorHandle = {
        insertAnnotations: (keys) => append(keys.map((k) => `<blockquote>${records.find((r) => r.key === k)?.text ?? k}</blockquote>`).join("")),
        insertHTML: append,
        focus: () => ed.focus(),
        destroy: () => ed.remove(),
      };
      return handle;
    },
  };

  let settings: GlobalSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("fr-harness-settings") ?? "{}") };
  const store: Record<string, string> = {};
  const root = document.getElementById("root")!;

  const deps: ReaderTabDeps = {
    tabs: {
      add: () => ({ id: "harness-tab", container: root }),
      select() {}, close() {}, rename() {}, tabHooks: { restoreState: {} },
    },
    doc: document, isMac: /Mac/.test(navigator.platform), title: pdf.split("/").pop() ?? "PDF", pdfPath: pdf, frameDir, proc,
    readFile: async (p) => new Uint8Array(await (await fetch(`/file?path=${encodeURIComponent(p)}`)).arrayBuffer()),
    removeFile: async (p) => void (await fetch(`/file?path=${encodeURIComponent(p)}`, { method: "DELETE" })),
    removeDir: async () => {},
    setTimeout: (fn, ms) => window.setTimeout(fn, ms), clearTimeout: (i) => window.clearTimeout(i),
    requestAnimationFrame: (fn) => window.requestAnimationFrame(fn),
    debug: (m) => console.log(m), collectGarbage() {}, onClosed() {},
    annotations,
    notes,
    host: {
      copyText: (t) => { console.log("COPY:", t); toast(`Copied ${t.length} characters`); void navigator.clipboard?.writeText(t).catch(() => {}); },
      openURL: (u) => toast(`(harness) open ${u}`),
      openInZoteroReader: (p) => toast(`(harness) open Zotero reader at page ${p + 1}`),
      copyCitation: async () => toast("(harness) citation copied"),
      chooseExportPath: async () => null,
      openExternally: () => toast("(harness) open in system viewer"),
      notify: toast,
      listFonts: () => ["Arial", "Courier New", "Georgia", "Helvetica", "Palatino", "Times New Roman"],
    },
    positions: new PositionStore({ get: () => store.pos, set: (v) => { store.pos = v; } }),
    positionKey: "harness/" + pdf,
    settings: { get: () => settings, set: (p) => { settings = { ...settings, ...p }; localStorage.setItem("fr-harness-settings", JSON.stringify(settings)); } },
  };
  // split view: the second pane is another reader (same paper by default; `?pdf2=` is offered as "another paper")
  const pdf2 = params.get("pdf2");
  deps.split = {
    choices: () => (pdf2 ? [{ label: pdf2.split("/").pop() ?? "Other", target: { kind: "tab", pdfPath: pdf2 }, pdfPath: pdf2 }] : []),
    open: async (container, target, hooks, page) => {
      const path = target.kind === "tab" ? target.pdfPath : pdf;
      const h = await spawnHelper(path);
      const title = path.split("/").pop() ?? "PDF";
      const t = new ReaderTab({
        ...deps,
        ...h,
        tabs: { add: () => ({ id: "harness-pane", container }), select() {}, close() {}, rename() {}, tabHooks: { restoreState: {} } },
        title, pdfPath: path, notes: NO_NOTES,
        positions: new PositionStore({ get: () => undefined, set: () => {} }),
        positionKey: "harness/" + path + "#pane",
        initial: { pageIndex: target.kind === "same" ? page : 0 },
        secondary: hooks, split: undefined,
      });
      return { tab: t, pdfPath: path, title };
    },
  };
  const tab = new ReaderTab(deps);
  (window as unknown as { tab: ReaderTab; records: AnnotationRecord[] }).tab = tab;
  (window as unknown as { records: AnnotationRecord[] }).records = records;
}

if (pdf) void main();
else document.body.textContent = "Add ?pdf=/absolute/path/to/file.pdf";
