# ADR 005: split view and the view-options panel

## View options
One toolbar button ("View options") opens a panel: Reading Mode, Scrolling (vertical / wrapped), Spreads
(none / odd / even), Split View, and Themes (Auto, Original, Snow, Sepia, Dark, Black, plus user-made custom
themes: a page color and a text color, kept in `customThemes` in the settings pref). These entries are no
longer in the "more" (…) menu. Dark, Snow and custom themes recolor the bitmap per pixel (`darken()` with a
palette); Sepia and Black stay CSS filters.

## Split view
Goal: compare two places in one paper, or two papers, without leaving the tab.

Decision: the second pane is a complete `ReaderTab` of its own, mounted beside the main reader in the same
Zotero tab (`splitView.ts` turns the tab container into a flex box; the main reader is not moved, so its scroll
position survives). Each pane therefore has its own helper process, scroll, zoom, search, sidebar and tools.

- Turning split on opens the **same paper at the current page** (the common case: compare p.3 with p.12).
- The second pane has a header row of its own above its toolbar: the full paper title is a button ("Change
  paper") that opens a picker, plus Swap panes and Close buttons. The picker has a search box over the library
  (title, author, year; only papers that have a PDF) and, before anything is typed, lists this paper, the papers
  open in other Glide tabs and the paper selected in the Zotero library. Up/Down/Enter/Escape work from the box.
- Side by side or top/bottom; the divider is draggable (20-80 %).
- The second pane never writes the saved reading position, has no notes pane, and keeps its sidebar state to
  itself. Theme and annotation colors are shared; annotations of the shown paper appear in both panes.
- Cost: one more helper process (~25 MB while reading, ~3 MB trimmed) while split is on.

Not done: remembering the split across restarts; synchronized scrolling; a notes pane in the second pane.

## Reading-mode font
The reading (reflow) view uses a font the user picks in the view-options panel ("Reading font"). No font files
are bundled, so there is nothing to license: the choice is a generic family (Serif, Sans-serif, Monospace) or
the name of a font already installed on the user's computer. The installed names come from Gecko's
`nsIFontEnumerator` and fill a drop-down list (each name shown in its own font); if listing fails only the three generic families are offered. The name is validated
(no quotes, semicolons, braces...) before it reaches a CSS value, and falls back to Georgia/serif if the font
is missing. Stored as `readingFont` in the settings pref.
