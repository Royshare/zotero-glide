# Status

## Current milestone

Milestone 6 (cleanup/docs) — the last open item from Milestone 3 (plugin
loading inside real Zotero, previously unconfirmed) is now confirmed. See
§20 of the original brief for the milestone list.

## Working (verified, not just written)

- **The plugin genuinely loads and registers its menu inside a real,
  running Zotero.** Confirmed against `/Applications/Zotero 2.app`
  (Zotero beta, v9.0, `org.zotero.zotero-beta`) using
  `zotero-plugin-scaffold`'s `serve` command (`packages/zotero-plugin`:
  `npm start`), which installs the addon via the Firefox Remote Debugging
  Protocol's `installTemporaryAddon` (the same mechanism as
  `about:debugging → Load Temporary Add-on`) rather than the classic
  proxy-file trick. Verified two independent ways, live, against the
  running process (not by reading logs):
  - `listAddons` over RDP shows `fast-reader@zotero-glide.local` /
    "Zotero Fast Reader" installed, active, no warnings.
  - After a real (file-watcher-triggered, i.e. genuine
    `shutdown()`→`startup()`) addon reload, evaluating JS in the live
    process shows `Zotero.MenuManager`'s internal registry contains
    exactly the expected entry: target `main/library/item`, label "Open
    in Fast Reader", both `onShowing` and `onCommand` present as real
    functions.
  - See `packages/zotero-plugin/.env.example` and the "Zotero dev
    loading" section below for how to reproduce this.
- **A real bug was found and fixed in the process**: `bootstrap.js` loads
  `src/errors.js`, `platform.js`, `resolveHelper.js`, `pdfAttachment.js`,
  `buildArgs.js`, `launchFastReader.js`, `fastReader.js` via successive
  `Services.scriptloader.loadSubScript(url)` calls (no scope argument,
  so each lands in the caller's own global — see `addon/src/errors.js`'s
  comment). Every one of those files ended with an identical `const
  exportsObj = {...}` for the Node/CommonJS export path. Loaded into
  Zotero's actual bootstrap scope, the *second* such file threw
  `SyntaxError: redeclaration of const exportsObj`, silently aborting the
  rest of `startup()` — so `FastReader.addToAllWindows()` (and the menu
  registration) never ran, while the addon still showed as "active" at
  the AddonManager level (no visible top-level error in the places this
  was checked first). Found by loading the exact same file chain, live,
  in the running process's own console via RDP, one file at a time, and
  watching for exactly where it broke. Fixed by inlining
  `module.exports = {...}` directly instead of going through a shared
  top-level `const` (all five affected files). All 36 Node tests still
  pass after the fix (they never exercised this cross-file loading path,
  which is exactly why it wasn't caught by tests — see "Important
  decisions" below).
- **Installable `.xpi` builds via `npm run build`** (`zotero-plugin build`):
  produces `.scaffold/build/zotero-fast-reader.xpi`, verified to contain
  the correct `manifest.json`, `bootstrap.js`, all `src/*.js` modules, and
  the `bin/macos-arm64/fast-reader-helper` binary with its executable bit
  preserved in the zip (`zipinfo -l` confirmed `-rwxr-xr-x`). One fix was
  needed here too: scaffold's default manifest management injects an
  `update_url` derived from `package.json`'s `repository` field, which is
  a local-dev placeholder, not a real update feed — shipping that in a
  distributable manifest would look like a real (but broken) link, so
  `build.makeManifest.enable: false` in `zotero-plugin.config.mts` now
  keeps the hand-authored `addon/manifest.json` untouched by the build.
- **`reader-helper` engine layer** (`packages/reader-helper/src/engine.rs`):
  opens real PDFs via MuPDF, reports page count/size, renders pages to
  RGBA via a bounded per-page display-list cache, extracts text, searches.
  30 automated tests across `engine`/`cache`/`app`/`session`, all passing
  against a real MuPDF build, including a missing-file case, a corrupt-file
  case, page-bounds errors, and a post-close-error case. Visually confirmed
  correct (not just dimensionally correct) by rendering the test fixture
  to PNG and viewing it — an earlier version had a real content-stream
  positioning bug that this caught.
- **Bounded render cache** (`src/cache.rs`): current page ± 1 by default.
  Unit test simulates reading through a 200-page document one page at a
  time and asserts the cache never exceeds 3 entries.
- **GUI** (`src/app.rs`, winit + softbuffer): builds and runs for real —
  launched against the test fixture, produced real debug log output,
  confirmed correct rendering via a real MuPDF-rendered PNG. **Still not
  verified**: interactive keyboard-driven navigation against the *live
  window* — this sandbox refuses synthetic keystroke injection and
  screenshot capture. `bench_navigate` exercises the same
  navigation/cache code path headlessly instead — see
  `docs/benchmark-methodology.md`.
- **Benchmarks**: real numbers from real binaries on real (synthetic)
  fixtures — see `docs/benchmark-methodology.md`, including the
  documented MuPDF-internal-store finding for image-heavy PDFs.
- **Zotero plugin logic** (`addon/src/*.js`): PDF attachment detection,
  platform/binary resolution, argv construction, and launch orchestration
  including error categorization — 36 tests, all passing, via Node's
  built-in test runner.
- **`bootstrap.js`/`manifest.json`**: written against APIs confirmed by
  directly reading Zotero's own source and the official
  `zotero/make-it-red` sample plugin — see citations inside those files
  and `docs/adr/001-*.md`. Now also confirmed correct empirically (above).

## Zotero dev loading (the mechanism that actually works)

```bash
cd packages/zotero-plugin
npm install
cp .env.example .env   # then set ZOTERO_PLUGIN_ZOTERO_BIN_PATH to your
                        # Zotero binary and ZOTERO_PLUGIN_PROFILE_PATH /
                        # ZOTERO_PLUGIN_DATA_DIR to isolated dev locations
npm start               # zotero-plugin serve
```

This launches Zotero with `-start-debugger-server`, connects over RDP, and
calls `installTemporaryAddon` on `addon/` — no signing, no proxy file, no
`extensions.json` hand-editing, and it hot-reloads on save. This is what
was actually used to get and verify the result above.

**The plain extension-proxy-file mechanism (a file in the profile's
`extensions/` directory containing the plugin's path, plus
`xpinstall.signatures.required=false` and friends — `scripts/dev-profile.sh`
/ `scripts/run-zotero-dev.sh`) was tried first and did not work** across six
attempts against stable Zotero 10.0.1, with `extensions.json` staying
`{"addons":[]}` every time. It's still in the repo as a documented,
working-for-some-setups fallback, but scaffold is the path that's actually
been proven end-to-end here, and is now the primary documented workflow.

## Not working / not verified

- **Clicking the real menu item through the real UI, and confirming the
  helper process actually launches from a live click, has not been done.**
  What *is* confirmed: the menu registers with the correct target/label/
  hooks (above), and `launchFastReader`'s spawn logic is separately
  unit-tested including real success and failure paths. What's not yet
  confirmed: actually right-clicking a PDF attachment in the real UI and
  watching `fast-reader-helper` appear in `ps`. This sandbox has no
  Accessibility/Screen-Recording permission to drive that click or see
  the result, and attempts to trigger it by evaluating JS remotely hit an
  unrelated RDP console flakiness (async evaluations started reporting
  perpetually-"pending" promises after several addon reloads in the same
  debug session — likely a stale console-actor/target issue after
  repeated reloads, not a plugin bug). Next person: this should be a
  two-minute manual check with a real click, now that loading itself is
  confirmed.
- **Text selection**: not implemented, per the explicit v0.1 scope
  decision in `docs/adr/001-reader-helper-stack.md` and brief §8.
- **Continuous scrolling**: not implemented, per brief §8's documented
  fallback (single-page + navigation).
- **Cross-platform binaries**: only `macos-arm64` has been built.
- **No CI**, **no code signing/notarization**, **no `LICENSE` file yet** —
  see `docs/cross-platform.md` and `docs/licensing.md`.

## Important decisions

- **Stack**: Rust + `mupdf` crate + `winit` + `softbuffer`. Full rationale
  in `docs/adr/001-reader-helper-stack.md`.
- **`addon/` subdirectory layout**: `packages/zotero-plugin/{manifest.json,
  bootstrap.js, src/, bin/}` all moved under `packages/zotero-plugin/addon/`
  specifically to match `zotero-plugin-scaffold`'s convention (it expects
  the shippable plugin root at `<dist>/addon/`, built from a
  `source: ["addon"]` config). This wasn't cosmetic — adopting this layout
  is what unlocked the working RDP-based dev-load path above.
- **Cross-file JS loading gotcha, now documented in code**: Zotero's
  `loadSubScript(url)` (single-arg form) puts each loaded file's top-level
  `var`/`function` declarations into the *caller's* shared global, but
  `let`/`const`/`class` are more fragile across separate loadSubScript
  calls — confirmed the hard way (see the bug above). `addon/src/errors.js`
  now documents this precisely; every other module avoids top-level
  `const`/`let`/`class` for anything meant to survive past its own file.
  **This class of bug is exactly why "does it actually load in Zotero"
  needed to be checked empirically rather than trusted from API research
  alone** — the JS was syntactically valid, passed all 36 unit tests (which
  test each module in isolation via Node's own `require`, never replaying
  Zotero's specific multi-file loadSubScript sequence), and still broke
  Zotero at runtime.
- **MuPDF features trimmed** to PDF-only (`default-features = false,
  features = ["base14-fonts"]`).
- **`ReaderSession`** (`src/session.rs`) factored out of `App` so the exact
  render/cache/prefetch/evict path is driven headlessly by the benchmark
  harness — see `docs/benchmark-methodology.md`.
- **MuPDF's own internal resource store** (`FZ_STORE_DEFAULT`, 256MB) is a
  real, separate source of memory growth from this project's own caches,
  confirmed by direct benchmark measurement.
- **AGPL boundary**: `reader-helper` links MuPDF statically; `zotero-plugin`
  does not link MuPDF at all. See `docs/licensing.md`.

## Next concrete step

Manually click "Open in Fast Reader" on a real PDF attachment in the
scaffold-launched Zotero window (`npm start` in `packages/zotero-plugin`,
then a normal click — no automation needed, just a human) and confirm
`fast-reader-helper` appears in `ps` with the right file argument. Given
everything upstream of that click is now independently confirmed (menu
registration) and everything downstream of it is unit-tested (spawn
logic), this is expected to just work, but "expected to work" is exactly
the gap this project's own principles say to close before calling it done.
