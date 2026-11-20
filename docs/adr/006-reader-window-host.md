# ADR 006: opening the reader in its own Zotero window

Status: **Partly implemented, not yet verified in a real Zotero.** The tab menu's "Open in New Window" builds the reader
in a Zotero `basicViewer` window, in place of its `<browser>` (`_createWindowHost` in `glide.ts`) and falls back to Zotero's own
reader window if that fails. Not done: split view in the window, a library-menu entry, trimming when minimised, and the
spike checklist below (notably the note editor in that window).
Builds on: [ADR 002](002-in-tab-reader.md) (the reader is a Zotero tab), [ADR 005](005-split-view.md) (split view)

## Context

Until now there were two ways to open a PDF: "Open in Zotero Glide" (a tab) and "Open in Zotero Glide (separate
window)", the v0.1 native window (`winit` + `softbuffer`, `app.rs`). The window had no selection, annotations, notes
pane, themes, split view, outline or reading mode: those all live in the JS reader (`tabView.ts`, `readerTab.ts`).
Keeping it meant a second reader to maintain, per-OS windowing code, two menu entries and a confusing choice.

**Done:** the native window mode was removed (`app.rs`, `--dock-*`, `launchGlide.ts`, `winit`, `softbuffer`).
`glide-helper` is `--serve`-only.

What users actually wanted from "a separate window" is mostly *a second monitor* or *the paper next to something
else*. Split view and tabs cover the second; the first is a real gap. Zotero's own reader offers "Move to New
Window", so users expect it.

## Proposal: a plugin-owned Zotero window that hosts the same reader

Mount the existing `ReaderView`/`ReaderTab` in a window instead of a `Zotero_Tabs` tab, so a window has the full
feature set for free. Zotero's own "Move to New Window" only works for its built-in tab types, so the plugin has to
open its own window.

### Coupling to the main window that must be abstracted (`ReaderHost`)

| Where | Today | Needed |
|---|---|---|
| tab lifecycle | `win.Zotero_Tabs.add/close/select`, `getState` wrapper (`glide.ts`, `readerTab.ts`, `sessionState.ts`) | host interface: `mount(container)`, `setTitle`, `close`, `onVisibilityChange` |
| hidden-tab trimming | tab deselect -> canvas 0x0, `trim` | window minimised / unfocused for N seconds |
| notes pane | `createNotesBackend(..., win.document, ...)` | the *window's* document; check Zotero's note-editor iframe loads in a secondary window |
| file pickers | `Zotero.getMainWindow().browsingContext` | the host window's `browsingContext` |
| split view | `splitView.ts` flexes the tab container | works on any container; verify |
| keyboard | `readerKeys.ts` on the tab | same, on the window; Cmd/Ctrl+W must close the window |
| session restore | tabs deliberately never saved | windows are never restored either (no change) |

### Opening the window (to verify)

A `chrome://` (or plugin `rootURI`) XHTML page `reader.xhtml` opened with `Services.ww.openWindow` /
`win.openDialog`, with a small bootstrap script that builds the `ReaderTab` with a `WindowHost`. Needs a plugin chrome
registration (`aomStartup.registerChrome` or a `chrome.manifest`), which the plugin does not have today.

### Entry points
A second context-menu entry "Open in Zotero Glide (new window)" and a ⋯-menu action "Move to new window" in the tab
(close the tab, open the window at the same page; the helper process can be handed over rather than restarted).

## Spike checklist (answer before building)

1. Can the plugin open its own window with Zotero's theme, fonts and shortcut handling (macOS / Windows / Linux)?
2. Does Zotero's note editor work in that window, and do "Add to note" and drag still reach it?
3. Does closing the *main* window leave an orphaned reader window and helper? (It must close, and end the helper.)
4. Window lifetime vs. helper lifetime: stdin EOF on close, same as a tab.
5. Memory: a hidden/minimised window must trim like a background tab.

## Decision

Do the spike only if users ask for a second-screen mode; until then split view and "Open in Zotero's own reader"
are the answer (documented in README and usage.md). Cost estimate if built: a `ReaderHost` interface plus two
implementations (~a few hundred lines), the window document, chrome registration and live verification. This has
**not** been run in a real Zotero yet.
