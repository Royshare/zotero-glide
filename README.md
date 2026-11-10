# Zotero Fast Reader (v0.1)

A lightweight MuPDF-based reading companion for Zotero.

## What this is

An experimental Zotero plugin that adds **"Open in Fast Reader"** to a
PDF attachment's context menu. Choosing it opens the PDF as a **tab in
Zotero's own tab bar**, rendered by a separate, native, MuPDF-based helper
process (one per tab) -- a second, minimal reading path alongside Zotero's
own built-in Gecko/PDF.js reader, not a replacement for it. A second menu
entry, **"Open in Fast Reader (separate window)"**, opens the same helper in
its own OS window instead.

See [`docs/adr/002-in-tab-reader.md`](docs/adr/002-in-tab-reader.md) for
how the tab works and the alternatives that were ruled out.

The hypothesis being tested: a PDF reader that is fully process-isolated
from Zotero's Gecko-based reader has substantially lower lifecycle
coupling to it -- opening/closing it doesn't touch Zotero's own reader
tabs or memory, and closing it lets the OS reclaim its resources
independently of whether Zotero itself is still running. See
`docs/benchmark-methodology.md` for what's actually been measured toward
that hypothesis so far, and what hasn't.

## What this is not

- Not a replacement for Zotero's built-in PDF.js reader.
- Not an annotation tool -- no annotation creation, editing, or sync.
  Fast Reader reads; Zotero remains the only place you annotate.
- Not a general-purpose PDF application. No PDF editing, no cloud sync, no
  AI features, no note-taking UI.
- Not a fork or monkey-patch of Zotero's reader internals -- the plugin
  never touches Zotero's existing reader code, and never touches
  `zotero.sqlite` directly.

See §2 of the original project brief (or `docs/adr/001-*.md`'s framing)
for the full non-goals list this was built against.

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

## Build

Requires: Rust (stable, 2024 edition support), a C compiler + `make`
(for MuPDF's vendored build), Node.js (for the plugin's test suite and
fixture generation), and Python 3 with Pillow (for fixture generation --
`pip install pillow` if you don't already have it; text-only fixtures work
without it).

```bash
scripts/setup.sh
```

This generates PDF fixtures, builds `reader-helper` in release mode, runs
its test suite, copies the built binary into
`packages/zotero-plugin/addon/bin/<platform>/`, and runs the plugin's test
suite. See individual scripts under `scripts/` to run any one step alone
(`build-helper.sh`, `benchmark-reader.sh`).

## Run

Standalone (no Zotero involved -- this is how `reader-helper` was
developed and tested):

```bash
FAST_READER_DEBUG=1 ./packages/reader-helper/target/release/fast-reader-helper path/to/some.pdf
```

Keyboard (standalone window): `PageDown`/`Right`/`Space` next page,
`PageUp`/`Left` previous, `+`/`-` zoom, `1` fit width, `2` fit page,
`Ctrl/Cmd+F` search (`Enter` next hit, `Shift+Enter` previous),
`Ctrl/Cmd+G` go to page, `Esc` close search/goto or quit.

Keyboard (tab): `←`/`→` previous/next page; `Space`/`PageDown` scroll the
page and flip to the next page once at the bottom (`Shift+Space`/`PageUp`
likewise upward); `Home`/`End` first/last page; `+`/`-` or pinch /
`Ctrl/Cmd`+wheel zoom; `1` fit width, `2` fit page; `Ctrl/Cmd+F` search
(`Enter` next hit, `Shift+Enter` previous, `Esc` clear); `Ctrl/Cmd+G` go to
page. The toolbar has the same controls.

Headless (what the tab drives -- JSON lines on stdin, frames written to
files; protocol in `packages/reader-helper/src/serve.rs`):

```bash
fast-reader-helper --serve --frame-dir /tmp/frames --file some.pdf
```

Inside Zotero -- confirmed working via `zotero-plugin-scaffold`, which
installs the plugin as a temporary add-on over the Firefox Remote
Debugging Protocol and hot-reloads on save (see STATUS.md's "Zotero dev
loading" section for how this was verified and why it replaced an earlier
proxy-file attempt that didn't work in this environment):

```bash
cd packages/zotero-plugin
npm install
cp .env.example .env   # set ZOTERO_PLUGIN_ZOTERO_BIN_PATH and an
                        # isolated ZOTERO_PLUGIN_PROFILE_PATH/DATA_DIR
npm start
```

### Installing a built `.xpi` directly

For trying the plugin in your own Zotero install (rather than the
scaffold-managed dev instance above), build an installable `.xpi`:

```bash
cd packages/zotero-plugin
npm install
npm run build                    # -> .scaffold/build/zotero-fast-reader.xpi
```

`npm run build` rebuilds the native helper itself first (a `prebuild`
script runs `scripts/build-helper.sh` automatically -- no separate manual
step, and no risk of packaging a stale helper binary from an earlier
build; see STATUS.md for a real bug that came from exactly that before
this was wired up). `npm start` does the same via `prestart`.

Then in Zotero: **Tools → Plugins** (or **Extensions**, depending on
version) → gear icon → **Install Plugin From File...** → select the
`.xpi`. The built `.xpi` only bundles the helper binary for the host you
built it on (`scripts/build-helper.sh` populates only the current host's
platform under `addon/bin/` -- see `docs/cross-platform.md`), so build it
on the same OS/architecture you intend to install it on until
cross-platform binaries are produced.

| npm command | what it does |
|---|---|
| `npm start` | `zotero-plugin serve` -- launch Zotero with the plugin loaded live, hot-reload on save (see above) |
| `npm run build` | rebuilds the native helper (`prebuild`), then `zotero-plugin build && tsc --noEmit` -- bundles `src/` into `.scaffold/build/zotero-fast-reader.xpi` and type-checks |
| `npm run typecheck` | `tsc --noEmit` alone |
| `npm test` | run the 75 pure-logic unit tests -- Node's built-in test runner, running the `.ts` sources directly (Node v26's native type-stripping, no ts-node/jest/babel) |
| `npm run release` | `zotero-plugin release` -- publish a GitHub release with the built xpi; needs a real git remote + `GITHUB_TOKEN`, not configured for this repo yet |

The plugin's source (`packages/zotero-plugin/src/*.ts`) is real
TypeScript, bundled into one file by esbuild; `addon/` holds only static
files (`manifest.json`, `bootstrap.js`, `bin/`). See STATUS.md's "v0.2"
section for why bundling replaced the earlier multi-file
`loadSubScript` chain.

## Tests executed

```bash
(cd packages/reader-helper && cargo test)   # 60 tests: engine, cache, blit pixel math,
                                             #   session navigation/zoom/search, argv parsing,
                                             #   serve-mode protocol + frames
(cd packages/zotero-plugin && node --test)  # 75 tests: PDF detection, platform
                                             #   resolution, argv construction, wire protocol,
                                             #   keymap, helper connection (spawn/read/close),
                                             #   missing-executable/spawn-failure handling
```

Both currently pass in full; see STATUS.md for exactly what is and isn't
additionally verified by hand (e.g., real MuPDF rendering was visually
confirmed by inspecting a rendered PNG, not just asserted by a test; the
same is true of the docked-window positioning -- confirmed via real argv
inspection, not by looking at the window).

## Benchmarks

```bash
bash scripts/benchmark-reader.sh release     # standalone window
python3 scripts/benchmark-serve.py           # in-tab (--serve) mode: footprint + page-turn latency
scripts/test-linux-docker.sh                 # helper tests + that benchmark on real Linux, in a container
# scripts/pdfjs-compare/: head-to-head memory vs Zotero's PDF.js reader (needs an isolated Zotero profile; see its compare.py)
```

Full methodology, the actual numbers observed, and an honest account of
two measurement compromises (this sandbox can't inject synthetic
keystrokes into the live GUI; macOS `ps` RSS overstates memory vs.
`footprint`'s `phys_footprint`) are in
[`docs/benchmark-methodology.md`](docs/benchmark-methodology.md). Headline
result: this project's own render/display-list caches provably plateau
under navigation (bounded at 3 entries, confirmed both by a unit test
walking a simulated 200-page read and by a real headless benchmark run);
MuPDF's own separate internal resource store does not plateau as tightly
for image-heavy documents, and that's documented rather than hidden.

## Remaining v0.2 work

- A person actually using the tab (real keys, trackpad pinch, tab
  switching) and a head-to-head memory comparison against Zotero's PDF.js
  reader on real papers -- STATUS.md's "v0.3" lists what was verified
  mechanically and what wasn't.
- Remember last page/zoom per PDF (cheap now: the helper reports `page` on
  every frame).
- Robust text selection + copy (deliberately deferred, not attempted as a
  half-measure -- see `docs/adr/001-*.md`).
- Continuous scrolling (v0.1 is single-page + navigation by design).
- Position/zoom persistence and the Zotero↔Fast Reader signaling that
  would need -- designed but not implemented, see
  [`docs/future-ipc.md`](docs/future-ipc.md).
- Windows and Linux builds (only macOS-arm64 has been built and run).
- Code signing/notarization for real distribution (see
  `docs/cross-platform.md`).
- A `LICENSE` file and the licensing decisions in
  [`docs/licensing.md`](docs/licensing.md) that need to precede any
  distribution beyond active development.

## Known platform limitations

- Developed and tested only on macOS (Apple Silicon). The engine, cache,
  and windowing code have no macOS-specific APIs (`winit`/`softbuffer`
  cover Windows/macOS/Linux uniformly, and MuPDF's build system already
  supports all three), but Windows/Linux builds have not been produced or
  run -- see `docs/cross-platform.md` for the intended build matrix.
- Accessibility (screen readers) is not supported in v0.1's raw
  `winit`-based UI -- documented as an accepted trade-off in
  `docs/adr/001-*.md`, with `AccessKit` identified as the path if this
  becomes a requirement later.
