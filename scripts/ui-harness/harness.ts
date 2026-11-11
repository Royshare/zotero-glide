// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

/// <reference lib="dom" />
// Browser side of the UI harness (see server.mjs): the real ReaderTab with Zotero stood in by in-memory fakes.
import { ReaderTab, DEFAULT_SETTINGS, type AnnotationRecord, type GlobalSettings, type ReaderTabDeps } from "../../packages/zotero-plugin/src/readerTab.ts";
import { PositionStore } from "../../packages/zotero-plugin/src/positionStore.ts";
import { buildMarkup, buildNote, type AnnotationDraft } from "../../packages/zotero-plugin/src/annotations.ts";
import type { HelperProcess } from "../../packages/zotero-plugin/src/helperConnection.ts";

const params = new URLSearchParams(location.search);
const pdf = params.get("pdf") ?? "";

async function main() {
  const { id, frameDir } = (await (await fetch(`/open?pdf=${encodeURIComponent(pdf)}`)).json()) as { id: string; frameDir: string };

  const proc: HelperProcess = {
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
  };

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
    subscribe: (cb: () => void) => (listeners.add(cb), () => listeners.delete(cb)),
  };
  void buildMarkup; void buildNote;

  const toast = (m: string) => {
    const t = document.getElementById("toast")!;
    t.textContent = m;
    t.style.display = "block";
    setTimeout(() => (t.style.display = "none"), 3000);
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
    host: {
      copyText: (t) => { console.log("COPY:", t); toast(`Copied ${t.length} characters`); void navigator.clipboard?.writeText(t).catch(() => {}); },
      openURL: (u) => toast(`(harness) open ${u}`),
      openInZoteroReader: (p) => toast(`(harness) open Zotero reader at page ${p + 1}`),
      copyCitation: async () => toast("(harness) citation copied"),
      chooseExportPath: async () => null,
      openExternally: () => toast("(harness) open in system viewer"),
      notify: toast,
    },
    positions: new PositionStore({ get: () => store.pos, set: (v) => { store.pos = v; } }),
    positionKey: "harness/" + pdf,
    settings: { get: () => settings, set: (p) => { settings = { ...settings, ...p }; localStorage.setItem("fr-harness-settings", JSON.stringify(settings)); } },
  };
  const tab = new ReaderTab(deps);
  (window as unknown as { tab: ReaderTab; records: AnnotationRecord[] }).tab = tab;
  (window as unknown as { records: AnnotationRecord[] }).records = records;
}

if (pdf) void main();
else document.body.textContent = "Add ?pdf=/absolute/path/to/file.pdf";
