# Zotero Fast Reader

<img src="packages/zotero-plugin/addon/content/icons/zotero-glide.svg" alt="Zotero Glide icon: an open book with a red-tinted right page" width="96" height="96">

A lightweight, MuPDF-based PDF reader that opens as a tab inside Zotero.

> **Status: early (v0.1), experimental.** Developed and tested mostly on macOS (Apple Silicon).
> Windows and Linux builds are produced by CI but have had little hands-on testing inside Zotero.
> Expect rough edges, and please [report them](https://github.com/Royshare/zotero-glide/issues/new/choose).

## What it does

Adds **Open in Fast Reader** to a PDF attachment's context menu. The PDF opens as a tab in Zotero's
own tab bar, rendered by a separate native MuPDF process (one per tab). It sits alongside Zotero's
built-in PDF.js reader and does not replace or modify it. **Open in Fast Reader (separate window)**
opens the same renderer in its own OS window.

- Continuous scrolling, zoom, fit width / fit page, rotate, crop margins, light / dark / sepia themes
- Text selection and copy, find with highlights, clickable links, outline and thumbnails
- Highlight, underline and note annotations, stored in **Zotero** (they sync and show up in Zotero's
  own reader; the PDF file is never modified)
- A notes pane that edits the item's child notes with Zotero's own note editor
- Copy citation, export a PDF copy with annotations embedded, reading mode with reflowed text
- Remembers your place in each PDF; background tabs free their memory

## Install

1. Download `zotero-fast-reader-<version>.xpi` from the
   [latest release](https://github.com/Royshare/zotero-glide/releases/latest). Right-click the link and save it; don't open it in a browser.
2. In Zotero: **Tools → Plugins** → gear icon → **Install Plugin From File...** → pick the `.xpi`.
3. Right-click a PDF attachment → **Open in Fast Reader**.

Requires Zotero 7 or newer. The `.xpi` bundles the helper for macOS (Apple Silicon and Intel),
Windows x64 and Linux x64.

**Unsigned binaries.** The helper is not yet code-signed or notarized. macOS Gatekeeper or Windows
SmartScreen may warn the first time it runs. Verify the download against `SHA256SUMS` on the release
page. Signing is tracked in [`docs/cross-platform.md`](docs/cross-platform.md).

Settings are under **Zotero ▸ Settings ▸ Fast Reader**: open PDFs here by default, and how long a
background tab waits before freeing its memory.

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
- Not accessible to screen readers yet (see [ADR 001](docs/adr/001-reader-helper-stack.md)).

## Why process isolation

Zotero's reader runs inside its Gecko UI process. Fast Reader tests the other end of the tradeoff: a
single-purpose native process whose memory and CPU are entirely its own and are reclaimed by the OS
when the tab closes. **This is a hypothesis, not a settled claim**: MuPDF is not always lighter than
PDF.js. Measured numbers, including a case where MuPDF's own cache uses more memory, are in
[`docs/benchmark-methodology.md`](docs/benchmark-methodology.md).

## Architecture

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
     │  right-click a PDF attachment -> "Open in Fast Reader (separate window)"
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

Closing the Fast Reader tab (or window) ends that one process; Zotero is
unaffected and never blocks on it. Reopening the same PDF starts a
brand-new process with a clean cache -- there's no persistent
in-plugin state to go stale. Full rationale for the specific
Rust/winit/softbuffer/MuPDF stack, and what was ruled out (Electron, Qt,
a bundled browser engine), is in
[`docs/adr/001-reader-helper-stack.md`](docs/adr/001-reader-helper-stack.md).

## Why process isolation

Zotero's own reader runs inside Zotero's Gecko-based UI process --
Firefox's rendering/JS engine, with PDF.js on top. That's a large, capable
stack, well-suited to what Zotero's reader actually needs to do
(annotate, sync, integrate tightly with the library). Fast Reader exists
to test the other end of the tradeoff: a single-purpose native process
whose only job is "show this one PDF," decoupled enough that its memory
and CPU footprint is entirely its own, reclaimed by the OS the moment its
window closes, regardless of what Zotero itself is doing at the time.

**This is a hypothesis, not a settled claim.** MuPDF is not *always*
faster or lighter than PDF.js/Gecko for every workload -- see
`docs/benchmark-methodology.md` for actual measured numbers (including a
real, documented case -- image-heavy PDFs -- where MuPDF's own internal
resource cache adds meaningfully more memory than this project's own
render cache does) rather than an assumed conclusion.

## Building from source

Requires Rust (stable), a C compiler + `make` (MuPDF is built from vendored source), Node.js 24+, and
Python 3 (with Pillow for the image fixtures: `pip install pillow`). On Windows see
[`docs/cross-platform.md`](docs/cross-platform.md).

```bash
scripts/setup.sh                      # fixtures, build helper, run both test suites
```

Build an installable `.xpi` for your own OS/architecture:

```bash
cd packages/zotero-plugin
npm ci
npm run build                         # -> .scaffold/build/zotero-fast-reader.xpi
```

`npm run build` rebuilds the native helper first, then bundles the plugin and type-checks. A local
build contains only your host's helper binary; release builds contain all platforms.

Develop against a live, isolated Zotero profile (hot reload on save):

```bash
cd packages/zotero-plugin
cp .env.example .env                  # set the Zotero binary and an isolated profile / data dir
npm start
```

Never point the dev profile at your real Zotero data.

Run the helper standalone, without Zotero:

```bash
FAST_READER_DEBUG=1 ./packages/reader-helper/target/release/fast-reader-helper path/to/some.pdf
```

| npm command | what it does |
|---|---|
| `npm start` | launch Zotero with the plugin loaded, hot-reload on save |
| `npm run build` | build helper, bundle plugin into the `.xpi`, type-check |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | plugin unit tests (Node's built-in runner) |

Tests: `(cd packages/reader-helper && cargo test)` and `(cd packages/zotero-plugin && npm test)`.
Benchmarks: see [`docs/benchmark-methodology.md`](docs/benchmark-methodology.md).

## Releasing

Maintainers: from `packages/zotero-plugin`, on an up-to-date `main`, run `npm run release`. It prompts for the
version, bumps `package.json` and `addon/manifest.json`, commits, tags `vX.Y.Z` and pushes. The pushed tag triggers the
[release workflow](.github/workflows/release.yml), which builds the helper on four platforms, assembles one
`.xpi`, and publishes it with the AGPL corresponding-source archive, `SHA256SUMS` and `update.json`
(Zotero's auto-update manifest).

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Security issues: [`SECURITY.md`](SECURITY.md).
Project history and verification notes: [`STATUS.md`](STATUS.md).

## License

AGPL-3.0-or-later (see `LICENSE`). The helper statically links MuPDF, which is
AGPL-3.0-or-later, so the whole project is too. Third-party components:
`THIRD_PARTY_NOTICES.md`. Where the source for a distributed build is, and how
the obligations are met: [`docs/licensing.md`](docs/licensing.md). The `.xpi`
carries `legal/LICENSE`, `legal/THIRD_PARTY_NOTICES.md` and `legal/SOURCE.md`;
`fast-reader-helper --license` prints the notice from the binary. Every release also publishes a
complete-corresponding-source archive.

This software is based in part on the work of the Independent JPEG Group (libjpeg, inside MuPDF).

## Known limitations

- Windows and Linux have not had full manual testing inside Zotero; CI builds and tests the helper on
  both. macOS is the primary platform.
- Not yet: image / ink / free-text annotations, editing annotations by dragging, OCR.
- No code signing or notarization yet.
