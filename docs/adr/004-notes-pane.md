# ADR 004: A notes pane beside the reader

Status: implemented (v1 and v1.1); the Zotero-side pieces are verified against Zotero 10.0.8's source, **not yet run
live in Zotero** (see "Verification").

## Decision
A toolbar button (and the **N** key) opens a **right-hand notes pane** in the reader tab. It manages the **child notes
of the PDF's parent item** and edits them with Zotero's own `note-editor` element. A PDF with no parent item has no
notes here (the pane explains how to give it one); standalone notes are out of scope.

Why Zotero's editor and data model, not our own: notes then sync, are searchable in Zotero, take its citation and
annotation inserts, and stay readable by Zotero's own reader and other plugins. It is the same rule as annotations
(ADR 003 section 3): we never invent a storage format.

## UX
- **List** (default view): the parent item's title, then notes newest first (title, preview, relative date), `+` for
  a new note, right-click for Open / Show in library / Move to Trash (the trash is recoverable; nothing is erased).
- **Editor**: Zotero's editor fills the pane; its back arrow returns to the list. The header adds *Insert a link to
  the current page* and *Show in Zotero library*.
- Closing the pane saves and tears down the editor (no hidden iframe in the Zotero process); reopening restores
  the note that was open. Width and open/closed are remembered.
- The left sidebar keeps navigation (thumbnails, annotations, outline, images), so both can be open together.

## Connecting notes and the PDF (v1.1)
- **Add to note** on an annotation card, its popup and context menu: inserts into the open note; with none open it
  asks "New note / one of the item's notes". The bulk "Create note from all annotations" opens the result in the pane.
  Inserting uses `EditorInstance.insertAnnotations`, i.e. exactly Zotero's own formatting and citations.
- **Drag** an annotation card into the open note (`zotero/annotation` payload from `Zotero.Annotations.toJSON`).
- **Insert page link**: a `zotero://open-pdf/.../items/KEY?page=N` link (`notes.ts`, unit-tested).
- **Click an annotation citation** in a note: handled by our `onNavigate`, so it jumps in *this* reader tab.
  Other PDFs fall through to Zotero's own behavior.

## Known limits
- A plain page link is opened by Zotero (`loadURI`), which only lands in Glide when "make Fast Reader the default
  opener" is on; otherwise it opens Zotero's reader. Annotation citations always jump in place.
- Notes are edited in the Zotero process (its editor is a Gecko iframe); the helper process is unaffected.
- Notes need Zotero's `note-editor` custom element; if it is missing the pane offers "Open in Zotero".

## Verification
Unit-tested: `notes.ts` (titles, previews, dates, links), settings, the `N` key. The pane's DOM and flows
(list, editor, add-to-note, new note, link, restore, no-parent) were driven in the browser harness
(`scripts/ui-harness`) with a stand-in editor. Against the real Zotero 10.0.8 source we confirmed `note-editor`
(attach first, then `mode`/`viewMode`/`item`), `getCurrentInstance()`, `_initPromise`, `insertAnnotations`, and the
`openAnnotation` -> `onNavigate` path. **Still to check live**: the element mounting inside our tab, typing saving,
drag and drop from our card into the editor iframe, and dark-mode appearance.
