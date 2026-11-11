# ADR 002: the reader as a Zotero tab

Status: Accepted (v0.3); the page model and protocol were superseded by [ADR 003](003-continuous-reader.md) (v0.4)
Builds on: [ADR 001](001-reader-helper-stack.md) (Rust + MuPDF helper)

## Context

Through v0.2 the reader was a separate OS window (optionally positioned next
to Zotero's). The goal: open the PDF as a **tab inside Zotero's own tab bar**,
keeping what makes this project worthwhile -- reading through a small MuPDF
process instead of Zotero's Gecko/PDF.js reader, for lower memory and faster
page turns.

## Options considered

### A. Embed the native window in Zotero's window (reparenting / child window)
The helper keeps its winit window; the plugin tells it to attach to Zotero's
main window and follow the tab area's screen rect.
- Pro: reuses the existing helper unchanged in spirit; native input.
- Con: three different, fragile OS mechanisms (NSWindow child windows on
  macOS, `SetParent` on Windows, XEmbed/X11-only on Linux; Wayland has no
  equivalent). The window floats *over* Zotero rather than living in it: it
  doesn't clip to the tab, ignores tab switching / z-order / full-screen /
  Spaces unless every case is tracked by hand, and is invisible to Zotero's
  theme, shortcuts and accessibility. Highest risk, worst cross-platform story.

### B. MuPDF compiled to WebAssembly, run inside Zotero's tab
- Pro: a true tab, no second process, single codebase for rendering.
- Con: lives in Gecko's process -- the page buffers and WASM heap are
  *Zotero's* memory, which is exactly what the project is trying to keep out
  of Zotero. No OS-level reclamation on close, no process isolation, and a
  new build/licensing pipeline (WASM + AGPL distribution in a plugin).

### C. Helper as a headless render server; the tab is the view  **(chosen)**
The helper runs without a window (`--serve`), owns all reader state, renders
the current page with MuPDF, and hands the pixels to the plugin; the plugin
paints them on a `<canvas>` inside a real `Zotero_Tabs` tab and forwards user
input.
- Pro: a real tab (tab bar, switching, close, shortcuts, theme, full screen
  all just work); one process per tab so closing it returns *all* of its
  memory to the OS; identical on macOS/Windows/Linux (no windowing code at
  all in this mode); the engine, cache and tests are reused as-is.
- Con: pixels cross a process boundary (measured cost below); the view and
  input handling are now JS, so text selection/copy still isn't there (same as
  before -- deferred, not regressed).

### D. Load a helper-served web viewer in a `<browser>` in the tab
Rejected: needs a localhost HTTP server (explicitly ruled out in
[future-ipc.md](../future-ipc.md)) *and* puts a full browsing context in
Zotero's process again.

## Decision: C

```
Zotero main window
 └─ Zotero_Tabs.add({ type: "fastreader" })        one tab per PDF
     └─ ReaderView  (toolbar + scrolling <canvas>)  src/tabView.ts
         ▲ frames            │ commands
         │                   ▼
    ReaderTab ── HelperConnection ── stdin/stdout JSON lines ──┐
    (src/readerTab.ts)  (src/helperConnection.ts)               │
                                                                ▼
                              fast-reader-helper --serve --frame-dir D --file X.pdf
                              (src/serve.rs: ReaderSession, current page only)
```

### Protocol (newline-delimited JSON; authoritative description in `serve.rs`)
- host -> helper: `viewport`, `goto`, `next`, `prev`, `zoom`, `fit`,
  `search`, `search_next`, `clear_search`, `trim`, `resume`, `quit`.
- helper -> host: `ready`, `frame`, `error`.
- A `frame` event points at `D/frame-N.rgba`: the whole page, opaque RGBA8.
  The tab reads it, `putImageData`s it, deletes it. A file (not the stdout
  pipe) because page bitmaps are 10-25 MB at retina size; the pipe carries
  only small JSON. The canvas is the whole page, so scrolling, trackpad
  inertia and scrollbars are the browser's own.
- Commands are **coalesced**: everything queued is applied, then one frame is
  rendered, so a resize or pinch-zoom burst costs one render.
- Search highlights come back as pixel rects in the frame event and are drawn
  as absolutely-positioned divs; the helper never draws UI.
- stdin EOF terminates the helper, so a crashed/killed Zotero cannot leave an
  orphan.

### Memory policy (the point of the exercise)
1. **Current page only** in serve mode (cache radius 0) -- no neighbor
   prefetch. A page render takes ~12 ms, so prefetch buys nothing and costs
   two extra 10-25 MB page buffers.
2. Frames are streamed to disk in 64 KiB chunks (no second page buffer).
3. **Backgrounded tabs shrink.** When another tab is selected, after 2 s the
   tab sends `trim` (helper drops its render cache *and the open document*,
   which also evicts MuPDF's internal image store; it re-opens lazily) and
   sets its own canvas to 0x0. Selecting the tab again re-renders.
4. The plugin launches the helper with an allocator knob -- macOS
   `MallocSpaceEfficient=1`, Linux `MALLOC_MMAP_THRESHOLD_=1048576`. Without
   it the allocator keeps every freed page buffer resident. Found by
   measuring, not assumed -- see STATUS.md and `scripts/benchmark-serve.py`.
5. **Zotero-side garbage is collected when the reader goes idle.** Each
   painted page is a 10-25 MB buffer that Gecko collects lazily: after 30
   page turns Zotero's own process held ~1465 MB and a forced GC took it to
   ~964 MB. The tab forces a GC 1.5 s after the last frame (never mid-turn),
   and after a background trim / close.
6. Closing the tab quits the helper (kill after 1 s) and deletes its frame
   dir. Re-opening a PDF that already has a tab selects that tab.

### Zotero integration notes (verified against Zotero 11 beta's `tabs.js`)
- `Zotero_Tabs.add` accepts any `type` string. **The type must not contain a
  dash** (`parseTabType` splits on `-`), hence `fastreader`.
- Zotero persists every tab's `{type, data}` in its session and on restart
  calls `tabHooks.restoreState[type]` for each; with no hook it destructures
  `undefined` -- a TypeError that **aborts restoring every tab after it,
  including ordinary PDF.js reader tabs** (reproduced on Zotero 10.0.8:
  `tabs.js:611`). Registering a hook from the plugin does *not* fix it (the
  plugin can start after the pane has already restored -- verified). So the
  plugin wraps `Zotero_Tabs.getState()` to never save its own tabs
  (`sessionState.ts`); a reader tab is a live process, not a document.
  Verified: a saved session contains no `fastreader` entry and the library +
  PDF.js reader tabs restore with 0 errors. Known limit: a session already
  containing such a tab (only from a development build) is not repaired.
- Keyboard: the tab handles keys itself (`readerKeys.ts`); only keys it
  actually acts on are stopped, so Cmd/Ctrl+W etc. still reach Zotero.

## Consequences
- The window-based reader remains, as "Open in Fast Reader (separate window)".
- No annotations, no text selection/copy, no position persistence yet (same
  non-goals as v0.1/v0.2). Position persistence is now cheap to add (the
  helper reports `page` on every frame); selection needs text geometry from
  `fz_stext_page`, which the protocol can carry the same way highlights are.
- The helper's `--serve` path was built, tested and benchmarked on Linux
  (Debian glibc 2.36, aarch64, in a container). Zotero-on-Linux and anything on
  Windows are untested; the `--serve` path contains no platform-specific code.
