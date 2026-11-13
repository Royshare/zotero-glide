# Architecture

In-tab mode (default):

```
Zotero (unmodified)
 └─ tab "fastreader"  = toolbar + <canvas>          packages/zotero-plugin/src/tabView.ts
      ▲ page frames (raw RGBA files)  │ JSON commands over stdin
      └───────────── fast-reader-helper --serve (headless, one per tab) ─────────┘
```

Separate-window mode (the original design):

```
Zotero (unmodified)
     │
     │  right-click a PDF attachment -> "Open in Zotero Glide (separate window)"
     ▼
packages/zotero-plugin/addon/       (thin: menu + process spawn only)
     │  Subprocess.call({ command, arguments: [pdfPath] })
     │  argv array, never a shell string (brief §7)
     ▼
packages/reader-helper/            (standalone native process, per PDF)
     │
     ├── src/app.rs        window, input, blit-to-surface (winit + softbuffer)
     ├── src/session.rs    navigation/zoom/search + render/cache/prefetch/evict
     ├── src/cache.rs      bounded render cache (current page ± 1)
     ├── src/engine.rs     DocumentEngine trait + MuPdfDocumentEngine
     └── (MuPDF, statically linked, behind the engine module only)
```

Closing the Zotero Glide tab (or window) ends that one process; Zotero is
unaffected and never blocks on it. Reopening the same PDF starts a
brand-new process with a clean cache -- there's no persistent
in-plugin state to go stale. Full rationale for the specific
Rust/winit/softbuffer/MuPDF stack, and what was ruled out (Electron, Qt,
a bundled browser engine), is in
[`docs/adr/001-reader-helper-stack.md`](adr/001-reader-helper-stack.md).

## Why process isolation

Zotero's own reader runs inside Zotero's Gecko-based UI process --
Firefox's rendering/JS engine, with PDF.js on top. That's a large, capable
stack, well-suited to what Zotero's reader actually needs to do
(annotate, sync, integrate tightly with the library). Zotero Glide exists
to test the other end of the tradeoff: a single-purpose native process
whose only job is "show this one PDF," decoupled enough that its memory
and CPU footprint is entirely its own, reclaimed by the OS the moment its
window closes, regardless of what Zotero itself is doing at the time.

**This is a hypothesis, not a settled claim.** MuPDF is not *always*
faster or lighter than PDF.js/Gecko for every workload -- see
`benchmark-methodology.md` for actual measured numbers (including a
real, documented case -- image-heavy PDFs -- where MuPDF's own internal
resource cache adds meaningfully more memory than this project's own
render cache does) rather than an assumed conclusion.
