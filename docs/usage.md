# Usage

## Keyboard (tab)

`←`/`→` previous/next page; arrows, `Space`, `PageUp/Down` scroll; `Home`/`End` first/last page;
`+`/`-`, pinch or `Ctrl/Cmd`+wheel zoom; `1` fit width, `2` fit page; `Ctrl/Cmd+F` find (`Enter` next,
`Shift+Enter` previous); `Ctrl/Cmd+G` go to page; `Ctrl/Cmd+C` copy selection; `Ctrl/Cmd+A` select all
text; `Esc` clears the selection / tool / reading mode.

## What it is not

- Not a replacement for Zotero's built-in reader, and not a fork or monkey-patch of it. The plugin never
  touches `zotero.sqlite` directly.
- Not a general PDF application: no PDF editing, no cloud sync, no AI features, no annotation or note
  format of its own.
- Not accessible to screen readers yet (see [ADR 001](adr/001-reader-helper-stack.md)).

## Known limitations

- Windows and Linux have not had full manual testing inside Zotero; CI builds and tests the helper on
  both. macOS is the primary platform.
- Not yet: image / ink / free-text annotations, editing annotations by dragging, OCR.
- No code signing or notarization yet.
