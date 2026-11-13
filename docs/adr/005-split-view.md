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
- The pane's header chip (a menu) switches what it shows: this paper, any other paper open in a Glide tab,
  or the paper selected in the Zotero library. It also swaps the panes and closes the split.
- Side by side or top/bottom; the divider is draggable (20-80 %).
- The second pane never writes the saved reading position, has no notes pane, and keeps its sidebar state to
  itself. Theme and annotation colors are shared; annotations of the shown paper appear in both panes.
- Cost: one more helper process (~25 MB while reading, ~3 MB trimmed) while split is on.

Not done: remembering the split across restarts; synchronized scrolling; picking a library paper other than
the current selection; a notes pane in the second pane.
