// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

/**
 * Pure helpers for the reader's notes pane: summarising a child note for the list, relative dates, and
 * `zotero://open-pdf` links (what a note stores to point back at a place in the PDF). The notes themselves
 * are ordinary Zotero child notes edited with Zotero's own note editor; nothing here defines a note format.
 */

/** What the notes list shows for one note. */
export interface NoteSummary {
  id: number;
  key: string;
  title: string;
  /** the text after the title line, one line's worth */
  preview: string;
  /** Zotero's `dateModified`: UTC, "YYYY-MM-DD HH:MM:SS" */
  modified: string;
}

/** The fields of a Zotero note item the list reads. */
export interface NoteItemLike {
  id: number;
  key: string;
  dateModified: string;
  getNote(): string;
  getNoteTitle?(): string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Note HTML -> text lines (block ends become line breaks), entities decoded, whitespace collapsed per line. */
export function noteLines(html: string): string[] {
  return html
    .replace(/<\s*(br|\/p|\/div|\/h[1-6]|\/li|\/blockquote|\/pre|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export const UNTITLED_NOTE = "Untitled note";

export function noteSummary(item: NoteItemLike): NoteSummary {
  const lines = noteLines(item.getNote() ?? "");
  const given = item.getNoteTitle?.().trim();
  const title = given || lines[0] || UNTITLED_NOTE;
  // the preview skips the title line when the title came from it
  const rest = given || !lines.length ? lines : lines.slice(1);
  const preview = rest.find((l) => l !== title) ?? "";
  return { id: item.id, key: item.key, title, preview: preview.slice(0, 140), modified: item.dateModified };
}

/** Newest first; ties keep their order. */
export function sortNotes(list: NoteSummary[]): NoteSummary[] {
  return list.map((n, i) => ({ n, i })).sort((a, b) => (a.n.modified < b.n.modified ? 1 : a.n.modified > b.n.modified ? -1 : a.i - b.i)).map((x) => x.n);
}

/** Zotero's UTC "YYYY-MM-DD HH:MM:SS" -> a Date (null if it isn't one). */
export function parseZoteroDate(s: string): Date | null {
  const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)/.exec(s);
  if (!m) return null;
  const [y, mo, day, h, mi, sec] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const d = new Date(Date.UTC(y, mo - 1, day, h, mi, sec));
  // Date.UTC rolls an impossible date over (month 13 -> next year), so check it round-trips
  return d.getUTCFullYear() === y && d.getUTCMonth() === mo - 1 && d.getUTCDate() === day && h < 24 && mi < 60 && sec < 60 ? d : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Just now", "5 min ago", "3 h ago", "Yesterday", "Nov 3", "Nov 3, 2024" -- in the viewer's local time. */
export function relativeDate(modified: string, now: Date = new Date()): string {
  const d = parseZoteroDate(modified);
  if (!d) return "";
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days <= 0) return `${Math.floor(diff / 3_600_000)} h ago`;
  if (days === 1) return "Yesterday";
  const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

// ---------------------------------------------------------------- links back into the PDF

export interface PdfLinkTarget {
  /** 0 for the user library, else the group's id */
  groupID: number;
  /** the attachment's key */
  key: string;
  /** the page label shown to the reader (1-based) */
  page: string;
  /** an annotation's key, to land on it */
  annotationKey?: string;
}

/** `zotero://open-pdf/library/items/KEY?page=12` (or `/groups/ID/items/KEY`), Zotero's own link format. */
export function openPdfUrl(t: PdfLinkTarget): string {
  const base = t.groupID ? `zotero://open-pdf/groups/${t.groupID}/items/${t.key}` : `zotero://open-pdf/library/items/${t.key}`;
  const q = [`page=${encodeURIComponent(t.page)}`];
  if (t.annotationKey) q.push(`annotation=${encodeURIComponent(t.annotationKey)}`);
  return `${base}?${q.join("&")}`;
}

/** The inverse, for recognising our own links; null for anything else. */
export function parseOpenPdfUrl(url: string): PdfLinkTarget | null {
  const m = /^zotero:\/\/open-pdf\/(?:library|groups\/(\d+))\/items\/([A-Z0-9]{8})(?:\?(.*))?$/.exec(url);
  if (!m) return null;
  const params = new URLSearchParams(m[3] ?? "");
  const page = params.get("page");
  if (!page) return null;
  const out: PdfLinkTarget = { groupID: m[1] ? parseInt(m[1], 10) : 0, key: m[2]!, page };
  const a = params.get("annotation");
  if (a) out.annotationKey = a;
  return out;
}

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A paragraph holding a link to a page of the PDF, ready for the note editor's insertHTML. */
export function pageLinkHtml(label: string, target: PdfLinkTarget): string {
  return `<p><a href="${escapeHtml(openPdfUrl(target))}">${escapeHtml(label)}</a></p>`;
}
