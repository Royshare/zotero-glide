# Status

## Current milestone

Milestone 5 (profiling) mostly done; Milestone 6 (cleanup/docs) in
progress. See §20 of the original brief for the milestone list.

## Working (verified, not just written)

- **`reader-helper` engine layer** (`packages/reader-helper/src/engine.rs`):
  opens real PDFs via MuPDF, reports page count/size, renders pages to
  RGBA via a bounded per-page display-list cache, extracts text, searches.
  Automated tests (30 total across `engine`/`cache`/`app`/`session`,
  including dedicated navigation/zoom/search coverage in `session.rs`),
  all passing against a real MuPDF build, including a missing-file case, a
  corrupt-file case, page-bounds errors, and a post-close-error case.
  Visually confirmed correct (not just
  dimensionally correct) by rendering the test fixture to PNG and viewing
  it -- text and vector "figure" content both render at the right
  position (see commit history / `/tmp/preview2.png` while this was being
  debugged -- an earlier version had a real content-stream positioning bug
  that this caught).
- **Bounded render cache** (`src/cache.rs`): current page ± 1 by default.
  Unit test simulates reading through a 200-page document one page at a
  time and asserts the cache never exceeds 3 entries.
- **GUI** (`src/app.rs`, winit + softbuffer): builds and **actually runs**
  -- launched for real against the test fixture on this machine, produced
  real debug log output (page open, render, cache hit/miss), and a
  real MuPDF-rendered PNG was inspected to confirm correct rendering
  end-to-end. The pixel-packing/letterboxing blit logic is additionally
  covered by 4 unit tests. **Not verified**: interactive keyboard-driven
  navigation/zoom/search against the live window -- this sandboxed
  environment refuses synthetic keystroke injection (`osascript`/
  Accessibility both return "not allowed to send keystrokes"), and
  screenshot capture of the window is also blocked (no Screen Recording
  permission grantable here). The same navigation/cache logic *is*
  exercised for real, headlessly, by `bench_navigate` -- see
  docs/benchmark-methodology.md for exactly what that does and doesn't
  prove.
- **Benchmarks**: real numbers gathered from the real binaries on real
  (synthetic) fixtures -- see `docs/benchmark-methodology.md`. Found and
  documented a real, non-obvious characteristic: image-heavy PDFs grow
  RSS up to MuPDF's own internal 256MB store cap, separate from and in
  addition to this project's own (correctly bounded) caches.
- **Zotero plugin logic** (`packages/zotero-plugin/src/*.js`): PDF
  attachment detection, platform/binary resolution, argv construction,
  and the full launch orchestration including error categorization are
  all pure, dependency-injected, and unit tested -- 36 tests, all passing,
  via Node's built-in test runner (no extra dependency).
- **`bootstrap.js`/`manifest.json`**: written against APIs and patterns
  confirmed by directly reading Zotero 10's own source
  (`chrome/content/zotero/xpcom/data/item.js`,
  `xpcom/pluginAPI/menuManager.js`, `xpcom/utilities_internal.js`) and the
  official `zotero/make-it-red` sample plugin, not guessed -- see the
  citations inside those files and `docs/adr/001-*.md`.
- **Full dev workflow** (`scripts/setup.sh`): generates fixtures, builds
  the helper, runs both test suites, copies the helper into
  `packages/zotero-plugin/bin/macos-arm64/`, and creates an isolated dev
  Zotero profile -- runs clean end-to-end on this machine right now.

## Not working / not verified

- **The plugin has not been confirmed to actually load inside a running
  Zotero 10 instance in this session.** Zotero 10.0.1 is installed on this
  machine, and a real attempt was made: an isolated dev profile was
  created, the standard extension-proxy-file mechanism was set up exactly
  as documented (zotero.org/support/dev/zotero_7_for_developers, Zotero
  forums), with `xpinstall.signatures.required=false`,
  `extensions.autoDisableScopes=0`, `extensions.startupScanScopes=15`,
  `extensions.experiments.enabled=true`, and the documented
  `extensions.lastAppBuildId`/`lastAppVersion` prefs.js deletion + restart
  cycle. Across six attempts with a clean profile state each time,
  `extensions.json` in the profile stayed `{"addons":[]}` -- the
  AddonManager never picked up the proxy file. This may be specific to
  this stable/release Zotero build vs. a beta/dev build, or may need the
  community `zotero-plugin-scaffold` tool (which several current Zotero
  plugin READMEs point to for exactly this workflow) rather than the
  manual mechanism. **This is the single most important thing for the
  next person to unblock** -- everything the plugin *does* once loaded is
  unit-tested and grounded in verified API research, but "does Zotero 10
  actually load this manifest.json/bootstrap.js as-is" has not been
  confirmed end-to-end. `scripts/dev-profile.sh` / `run-zotero-dev.sh`
  encode exactly what was tried, so the next attempt starts from a
  documented baseline instead of from scratch.
- **Text selection**: not implemented, per the explicit v0.1 scope
  decision in `docs/adr/001-reader-helper-stack.md` and brief §8 ("if
  robust text selection becomes the dominant complexity, make it the
  first v0.2 feature"). `MuPdfDocumentEngine::extract_text` and the
  `search` plumbing exist and work, so the structured-text foundation a
  real selection feature would need is already there.
- **Continuous scrolling**: not implemented. v0.1 is single-page-at-a-time
  with keyboard/scroll-wheel navigation between pages, per the brief's
  explicit fallback ("start with single-page rendering plus navigation and
  document the limitation" -- §8). This is that documentation.
- **Cross-platform binaries**: only `macos-arm64` has been built. The
  platform-resolution code and directory layout support all four targets
  (`docs/cross-platform.md`), but Windows/Linux/macOS-x64 builds have not
  been produced or tested -- this was developed on a single Apple Silicon
  Mac.
- **No CI** is configured (sketch only, in `docs/cross-platform.md`).
- **No code signing/notarization** -- see `docs/cross-platform.md`; this
  matters before distributing to anyone outside active development.
- **No `LICENSE` file yet** -- see `docs/licensing.md`'s explicit call to
  make this decision deliberately before any public/wider distribution.

## Important decisions

- **Stack**: Rust + `mupdf` crate + `winit` + `softbuffer`, no GPU
  dependency, no on-canvas UI chrome (status shown in the OS window title
  bar instead). Full rationale and alternatives considered in
  `docs/adr/001-reader-helper-stack.md`.
- **MuPDF features trimmed** to PDF-only (`default-features = false,
  features = ["base14-fonts"]`) -- excludes tesseract/HTML/EPUB/XPS/JS,
  which would otherwise bloat build time and binary size for no benefit
  to a PDF reader.
- **`ReaderSession`** (`src/session.rs`) was factored out of `App` mid-way
  through so the exact same render/cache/prefetch/evict code path could be
  driven headlessly by the benchmark harness -- see
  `docs/benchmark-methodology.md` for why that mattered (this sandbox
  can't drive the live GUI's keyboard input).
- **MuPDF's own internal resource store** (`FZ_STORE_DEFAULT`, 256MB, set
  in `mupdf-sys`'s wrapper code) is a real, separate source of memory
  growth from this project's own caches, confirmed by direct benchmark
  measurement, not assumed. Documented rather than papered over.
- **AGPL boundary**: `reader-helper` links MuPDF (AGPL-3.0) statically;
  `zotero-plugin` does not link MuPDF at all (process-spawn boundary
  only). See `docs/licensing.md` -- multiple items there are flagged
  `[LEGAL REVIEW NEEDED]` rather than asserted as legal conclusions, per
  the brief's explicit instruction not to provide unsupported legal
  advice.

## Next concrete step

Get the plugin actually loading in a real Zotero 10 window. Concretely:
try `zotero-plugin-scaffold` (`npx zotero-plugin-scaffold`) against this
existing `packages/zotero-plugin` source instead of the manual proxy-file
mechanism, since it's what current community plugin templates use and may
handle whatever this stable build needs that the manual approach didn't.
Once the menu item is confirmed visible/clickable in a real window, the
remaining Definition-of-Done items (§19: right-click shows "Open in Fast
Reader," selecting it launches the helper on the correct file, closing the
helper leaves Zotero unaffected) become a short, mechanical verification
pass rather than new engineering.
