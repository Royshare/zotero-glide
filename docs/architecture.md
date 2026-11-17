# Architecture

In-tab mode (default):

```
Zotero (unmodified)
 └─ tab "fastreader"  = toolbar + <canvas>          packages/zotero-plugin/src/tabView.ts
      ▲ page frames (raw RGBA files)  │ JSON commands over stdin
      └───────────── fast-reader-helper --serve (headless, one per tab) ─────────┘
```

The helper (one headless process per reader tab):

```
packages/reader-helper/
     ├── src/main.rs       argv + stdio loop (--serve only; there is no window mode)
     ├── src/serve.rs      JSON command protocol, renders the current page to a frame file
     ├── src/engine.rs     DocumentEngine trait + MuPdfDocumentEngine
     └── (MuPDF, statically linked, behind the engine module only)
     (src/session.rs + src/cache.rs: page-cache policy, kept for the benchmark harness only)
```

The original design -- a native `winit` window per PDF, launched from a second
"separate window" menu entry -- was removed in favour of the tab (see
[ADR 002](adr/002-in-tab-reader.md)); a Zotero-hosted window is proposed in
[ADR 006](adr/006-reader-window-host.md).

Closing the Zotero Glide tab ends that one process; Zotero is
unaffected and never blocks on it. Reopening the same PDF starts a
brand-new process with a clean cache -- there's no persistent
in-plugin state to go stale. Full rationale for the specific
Rust/MuPDF stack, and what was ruled out (Electron, Qt,
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
