# ADR 003: the continuous-scroll reader (selection, annotations, and a stateless helper)

Status: Accepted (v0.4)
Builds on: [ADR 001](001-reader-helper-stack.md), [ADR 002](002-in-tab-reader.md). Supersedes ADR 002's
one-page-at-a-time protocol and its "current page only" memory rule (the rest of ADR 002 stands).

## Context

The tab reader showed one page at a time and could not select text, annotate, or follow links -- the gaps that
would stop anyone using it for real reading (see the product assessment: text selection/copy, annotations,
continuous scrolling, position persistence were the P0 items; outline/links/thumbnails, themes, crop, rotate,
reading mode, open-at-location, citation were P1; export, preferences, scan memory were P2).

## Decisions

### 1. The helper is stateless per request; the tab owns layout
The helper used to own the current page, zoom and search state, which can't express a continuous scroll. Now
the tab computes the layout (`layout.ts`), decides which pages are visible, and sends `render {id, page, scale,
rotate, clip}` for exactly those; the helper keeps nothing between requests except the open document. This
also made it *lighter*: with no render cache the helper sits at ~3 MB (was ~24 MB). Protocol: `serve.rs`.
- Of several renders for one page in a batch only the last runs; the rest are reported `skipped`.
- Rotation and crop are applied in pixel space after rendering (`geometry.rs`), so the same math places overlays.
- Frame size is capped (plugin 16M px, helper 40M px): fit-width on a cropped page or a pinch to the zoom limit
  would otherwise ask for hundreds of MB. Above the cap the frame is simply softer.

### 2. Text selection from the helper's geometry
`text {page}` returns lines in reading order, each with its box and the x of every character boundary. A
selection is two `(page, line, char)` positions; highlight rectangles, the copied text and annotation geometry
are all derived from them (`textModel.ts`, unit-tested). Copy joins wrapped lines, re-joins a word hyphenated at a
line end ("inter-" + "national"), and keeps paragraph breaks. Double/triple-click select a word/line;
Cmd/Ctrl+A selects everything. Characters are counted by code point (matches Rust's `char`).

### 3. Annotations live in Zotero, not in the PDF
They are saved with `Zotero.Annotations.saveFromJSON` -- the path Zotero's own reader uses -- so they sync, show in
both readers, and work with notes and citations. The PDF file is never modified (writing into the PDF would change
the file hash of every synced attachment, race with other readers, and not merge across devices).
- The helper reports geometry in *page space* and, per page, a matrix to *PDF space* (what Zotero stores). The
  matrix comes from the page's own `/Rotate` and CropBox (`geometry.rs`).
- Sort index `page(5)|charOffset(6)|top(5)` and the 8 default colors mirror Zotero's reader (`reader.js`).
- Drawn: highlight, underline, note. Image/ink/free-text annotations made in Zotero's reader are left alone.
- **Verified against Zotero's own PDF.js reader**: a highlight saved here lands on exactly the same viewport
  coordinates there (max difference 0.000 px on an unrotated page) and Zotero's reader reads its text. Rotated and
  cropped pages are verified against MuPDF's own text placement (a Rust test), not live in Zotero.
- "Export PDF with annotations" is the one place they are written into a PDF -- into a *copy*, by the helper.

### 4. Other reader features
Outline and links (`outline`, `links`), thumbnails (rendered only while visible), page themes via a CSS filter on
the canvas (no re-render), rotate, crop of uniform white margins (`margins`: the smallest ink margin over sampled
pages, so nothing is ever cut), reading mode (the same text, reflowed), find with highlights, position persistence
per attachment (`positionStore.ts`, a pref, newest 300), per-user settings.
Integration with Zotero: opening at a page or annotation (`zotero://open-pdf` links, note citations) and an opt-in
default opener, both by wrapping `Zotero.Reader.open` (Zotero's own tab restore, which passes `tabID`, is never
redirected); "Copy citation" (QuickCopy); "Create note from annotations" (`EditorInstance`); a Settings pane.

### 5. Memory policy (replaces ADR 002's rules 1-2)
1. Only pages in the visible window (+ ~60% of a screen of lookahead) hold a bitmap; pages that scroll >2 away are
   freed immediately. Thumbnails only while visible.
2. The helper drops the open document every 8 renders: that evicts MuPDF's internal image store, which otherwise
   grows an image-heavy scan to ~270 MB. Measured peak on the scan fixture is now ~33 MB.
3. Background trim, the allocator knobs and idle GC are unchanged (ADR 002).

## Consequences / limits
- Memory now scales with *how many pages are visible*, i.e. with zoom level: a very low zoom shows many pages.
- Text selection is horizontal-text only (vertical CJK text lines are returned but selected as horizontal).
- Not implemented: image/ink/free-text annotation *creation*, annotation drag/resize, annotation tags, OCR.
- `Zotero.Reader.open` wrapping is opt-in and returns an inert stand-in for the reader object; callers that use
  the returned reader beyond `_initPromise` would not work with the default opener on.
- UI is verified live in Zotero by DOM/state and visually only in the browser harness (`scripts/ui-harness`), which
  runs the real code against the real helper; there is no screenshot of the tab inside Zotero itself.
