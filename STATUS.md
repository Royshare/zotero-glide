# Status

## Current milestone

v0.3 (the reader as a Zotero tab) is implemented and verified live -- see the
"v0.3" section below for exactly what was and wasn't checked. v0.1's milestones are done (Milestone 3's plugin loading/launching is
confirmed end-to-end, including bugs a real user's install surfaced that
earlier dev-mode testing hadn't -- see below). Now in v0.2, two pieces
landed so far: the plugin's TypeScript migration, and docked-window UX
(window position/size only -- process isolation unchanged). See
`docs/adr/001-reader-helper-stack.md` and this file's "v0.2" section
below for what's next.

## v0.3: the reader is now a Zotero tab

"Open in Fast Reader" opens the PDF as a tab in Zotero's own tab bar. Design
and rejected alternatives: [`docs/adr/002-in-tab-reader.md`](docs/adr/002-in-tab-reader.md).
In short: `fast-reader-helper --serve` is a headless per-tab render server
(JSON commands on stdin, whole-page RGBA frames written to files); the plugin
paints them on a `<canvas>` inside a real `Zotero_Tabs` tab. The old window is
kept as "Open in Fast Reader (separate window)".

**Verified live** against the isolated dev profile (`Zotero 2.app`, version
11.0-beta.3, driven over RDP; the user's own Zotero was never touched):
- the tab appears in the tab bar (`fastreader:<title>`), canvas is 2068x2677 on
  a dpr-2 display, page content read back from the canvas is the right page,
  white background, correct text;
- real DOM key events: next/prev, Home/End, `+`, fit width/page, go-to-page;
  search finds hits across pages and draws highlights; Enter cycles pages;
- selecting another tab: canvas drops to 0x0 and the helper's footprint falls
  to ~3 MB after 2 s; reselecting re-renders the same page;
- re-opening an already-open PDF selects the existing tab (no second process);
- closing the tab (and reloading the plugin) ends the helper and deletes its
  frame directory -- 0 helper processes remain;
- a corrupt PDF shows the helper's own error text in the tab instead of a
  blank page; both context-menu entries register.

**Memory/latency (`python3 scripts/benchmark-serve.py`, macOS arm64, retina-size
viewport, helper only -- see "what this does not measure" below):**

| fixture | first frame | page turn p50 / p95 | footprint, reading | after `trim` |
|---|---|---|---|---|
| paper-a (24pp, vector) | ~15 ms | 12 / 20 ms | 24 MB | 3 MB |
| book-b (220pp, 100 turns) | ~20 ms | 13 / 25 ms | 25 MB (flat) | 3 MB |
| scanned-c (40pp, JPEG pages) | ~50 ms | 43 / 56 ms | up to 272 MB | 3 MB |

Real numbers behind three design decisions (each found by measuring, each
confirmed by a before/after):
1. *Keep only the current page in serve mode.* With the window's page±1
   prefetch the helper also rendered two neighbors before it could answer, and
   held 3 page buffers (10-25 MB each at retina size). Footprint after a short
   read: 201 MB -> 74 MB with radius 0 plus streaming the frame to disk in
   chunks instead of copying the whole page.
2. *`MallocSpaceEfficient=1` on macOS* (the plugin sets it; libmalloc only
   reads it at process start). `vmmap` showed the rest was not live data:
   "Malloc Large (empty)", i.e. freed page buffers the allocator keeps
   resident. With the knob: steady state 46 -> 24 MB, trim 272 MB -> 3 MB on
   the scan, no latency change. A custom mmap allocator and
   `malloc_zone_pressure_relief` were both tried first; neither beat the knob
   (the former matched it, the latter did nothing) so both were removed.
3. *`trim` drops the open document too, not just the page cache.* The engine
   re-opens lazily on the next query (tested: identical render before/after).

The scan's ~270 MB while reading is MuPDF's live internal image store (the
same effect `docs/benchmark-methodology.md` documents for the window); it
is reclaimed when the tab is backgrounded or closed, not while reading it.

### v0.3 follow-up verification

Run against **Zotero 10.0.8** (the version in `/Applications/Zotero.app`, i.e. the
real target), in a fresh isolated profile and data dir -- the user's own
library and profile were never opened. (The earlier checks above used a
Zotero 11.0 beta; the manifest's `strict_max_version` is `10.*`, so 11 only
works as a temporary/dev install, not a real one.)

**Packed `.xpi` install -- works.** The built `.xpi` installed through the
real add-on manager (`AddonManager.getInstallForFile().install()`): active,
compatible, root URI `jar:file:///...xpi!/`. The first tab open extracted the
helper into the data dir (`fast-reader-helper-bin/`, 6.0 MB, executable); the
tab opened, rendered, and the helper process had the allocator env set.

**Restart with a reader tab open -- found and fixed a real bug.** With a
`fastreader` tab and an ordinary PDF.js reader tab open, quitting Zotero saved
both into the session; on relaunch **neither** came back:
`TypeError: undefined has no properties` at `tabs.js:611`. Zotero calls
`restoreState[type]` per saved tab, and for a type with no hook it destructures
`undefined`, aborting the restore of every later tab -- so a plugin tab could
break the user's *normal* tabs. A plugin-registered hook did not help (the
plugin can start after the pane has restored). Fix: the plugin wraps
`Zotero_Tabs.getState()` so its tabs are never saved (`sessionState.ts`, 3
tests). Re-verified on the final `.xpi`: saved session has only `library` and
`reader`; after relaunch both restore, 0 errors, no helper process left over.
Not fixed: a session file *already* containing a `fastreader` tab (only
possible from a development build) -- delete that entry from the profile's
`session.json`.

**Second bug found by measuring: Zotero-side memory.** After 30 page turns
Zotero's own process held ~1465 MB; a forced GC took it to ~964 MB. Each page
is a 10-25 MB buffer Gecko collects lazily. The tab now forces a GC 1.5 s
after the last frame, and after a background trim or close.

**Memory vs Zotero's PDF.js reader (Zotero 10.0.8, macOS arm64, retina).**
Fresh Zotero launch per run; metric is the summed `phys_footprint` of the
whole process tree (Zotero, its Gecko children, and our helper), as a delta
over that run's own baseline. Same Zotero, same PDFs. Fast Reader = the final
build; 2 runs per cell (PDF.js: 1-2, three PDF.js repeats were lost to a
harness error). Medians, MB:

| PDF | PDF.js: open / after 30 turns | Fast Reader: open / after 30 turns | first page |
|---|---|---|---|
| 0.3 MB, 8 pp | +463 / +934 | +8 / +322 | 407 ms vs 26 ms |
| 2.5 MB, 5 pp | +353 / +517 | +25 / +104 | 426 vs 27 |
| 9.9 MB, 48 pp | +500 / +895 | +1 / +252 | 401 vs 25 |
| 4.2 MB, 464 pp | +424 / +638 | -33 / +86 | 373 vs 26 |
| 5.3 MB, 40 pp, scan | +27 / +688 | -18 / +220 | 384 vs 26 |

A fairer control, because the Fast Reader tab forces GCs and PDF.js does not:
the same sequence with a forced GC applied to **both** (one run each, after a
GC'd baseline). 464 pp: PDF.js +312 after 30 turns / +165 once backgrounded,
Fast Reader +66 / -46. 48 pp: PDF.js +568 / +232, Fast Reader +147 / -102.
So the advantage survives equal treatment: roughly 3-4x less while reading,
and the Fast Reader tab gives its memory back when backgrounded while PDF.js
keeps ~165-230 MB.

Read these with their limits:
- Few runs (1-2 per cell) and a noisy baseline (~+-50 MB between launches);
  differences of tens of MB are noise, the 3-5x gaps are not. Negative deltas
  after backgrounding mean "below this run's baseline" (the forced GC also
  frees garbage Zotero already held), not that the tab uses negative memory.
- "Open" for the scan with PDF.js (+27) looks small only because PDF.js
  renders lazily; its +688 after reading is the real cost.
- Page-turn latency is **not** compared: PDF.js usually has the page
  pre-rendered, so my probe reads ~0 ms. Where it was a real wait (5-pp
  paper) PDF.js was 134/268 ms (p50/p95) vs 52-58 ms. Fast Reader end to end
  (key -> pixels painted in the tab) is 30-76 ms, vs ~12 ms for the helper
  alone: the rest is reading and painting a ~20 MB frame.
- The scan is the Fast Reader's weak case: the helper alone holds ~214 MB while
  reading it (MuPDF's decoded-image store), still well under PDF.js's total.
- Reproduce: `scripts/pdfjs-compare/` (isolated profile required).

**Linux (helper only), real.** `scripts/test-linux-docker.sh` builds and tests
the helper in a Debian container (glibc 2.36, **aarch64**): all 60 Rust tests
pass; serve mode runs end to end. Default glibc malloc balloons (text PDF 71 MB
while reading; the scan keeps 132 MB after `trim`). With
`MALLOC_MMAP_THRESHOLD_=1048576` (now set by the plugin on Linux): 27 MB flat,
scan trims to 10 MB, no latency change. An x86_64 (emulated) container run
crashed the OrbStack daemon before finishing, so **x86_64 Linux -- the
architecture the plugin actually ships for -- was not run**; same code and
allocator, but unmeasured. Zotero-on-Linux (the tab itself) is untested.

**Still not verified:**
- **Windows**, entirely (helper build, `Subprocess` stdio on Windows, whether a
  console window flashes when the console-subsystem helper is spawned -- the
  Windows parts of Gecko's `Subprocess` are not in the macOS bundle to read).
  Review of the portable Rust/JS code found nothing platform-specific, which is
  not the same as running it.
- Real keyboard/trackpad input (keys were dispatched as DOM events; pinch-zoom
  and Cmd/Ctrl+F against Zotero's own shortcuts untried by a person); no
  screenshot of the tab was possible (no screen-capture permission), content was
  verified by reading the canvas back.
- Zotero 11 as a real install (blocked by `strict_max_version`), and the
  window-mode menu entry's spawn on 10.0.8 (only its helper-path resolution is
  shared with the tab path, which was exercised).

**Another real bug found on the way (affects the window mode too):** on Zotero 11
`Zotero.File.pathToFile(rootURI)` throws "Unexpected path value 'file:///...'"
for an unpacked install, so *neither* open path could find the helper binary.
Fixed by converting the URI with Gecko's file protocol handler
(`getFileFromURLSpec`), which works on every version.

Test count: 60 Rust + 75 TypeScript, all passing.

## A third real bug: stale cached extraction after a reinstall

After the docked-window build, a real reinstall+relaunch threw
`SpawnError`. Root-caused live via the same technique as the earlier
bugs, this time by *reproducing the exact scenario* rather than just
reading logs: pre-seeded a fresh test profile's data directory with a
copy of the actual stale binary found in the real environment
(`fast-reader-helper-bin/0.1.0/macos-arm64/fast-reader-helper`, dated
well before the dock-args change), then launched through the real
plugin.

The cause: `resolveHelperPathPacked` skipped extraction whenever a file
already existed at the destination path, keyed only on the plugin's
`package.json` version -- which never changed across the many rebuilds
in this session (still `0.1.0`). So after every `.xpi` reinstall, the
plugin kept silently reusing whatever binary had been extracted the
*first* time, even though the bundle inside the newly-installed `.xpi`
had changed. Confirmed directly: running that stale binary by hand with
the newer `--dock-x ...` flags it predates fails immediately
(`unrecognized argument: --dock-x`, exit code 2) -- exactly the shape of
failure a real user would hit with no clear signal that reinstalling
hadn't actually taken effect.

Fixed by removing the "skip if exists" shortcut entirely --
`resolveHelperPathPacked` now always re-fetches and overwrites on every
launch (7 tests updated/added, including one that pre-populates the
destination and asserts extraction still runs). The fetch+write is
comfortably sub-second even for a several-MB binary (confirmed live), so
this trades a small, constant, predictable per-launch cost for never
serving a stale binary again -- simpler and more robust than a
cache-invalidation scheme that would have to correctly track every
possible reason the binary changed (which is exactly what the
version-based scheme failed to do).

**Verified against the literal reproduction**: pre-seeded the exact
known-stale binary at the exact destination path a fresh profile would
use, installed the fixed plugin, launched a real PDF item through
`Zotero.FastReader.openInFastReader()`, and confirmed both that the
stale file's mtime was overwritten and that a real `fast-reader-helper`
process launched successfully with the correct arguments -- no manual
cleanup of the real environment's stale file needed, since the fix is
self-healing on next use.

**A related DX gap surfaced right after this fix**: the user's own
`npm run build` still produced a failing `.xpi`, even after pulling the
fix above. Cause: `npm run build` (`zotero-plugin build && tsc --noEmit`)
only *packages* whatever is currently sitting in `addon/bin/<platform>/`
-- it never rebuilds the Rust helper itself. That step
(`scripts/build-helper.sh`) was documented as a separate manual
prerequisite, easy to forget on a rebuild (every `.xpi` this session was
built by remembering to run it first). Fixed by adding `prebuild`/
`prestart` npm scripts that run `scripts/build-helper.sh` automatically
-- `npm run build` and `npm start` are now self-sufficient by
construction; there's no longer a manual step to forget. Verified by
deleting `addon/bin/macos-arm64/` entirely (simulating a fresh clone)
and confirming a bare `npm run build` reconstructs a complete, correctly
built `.xpi` on its own.

## v0.2: TypeScript migration + docked-window UX

Both phases from the approved v0.2 plan are done and verified live:

- **TypeScript migration** (`packages/zotero-plugin`): the plugin's
  runtime moved from 7 plain-JS files chained via
  `Services.scriptloader.loadSubScript` to TypeScript, bundled by esbuild
  (via `zotero-plugin-scaffold`) into one output file. Real ES
  `import`/`export` throughout -- the `var X = class {}` workaround
  loadSubScript's cross-file scoping fragility required (see the bug
  writeup further down) no longer applies, since bootstrap.js now loads
  exactly one file. `zotero-types` (community Zotero API typings)
  independently confirmed the live-discovered `MenuData` finding (no
  `label` field, only `l10nID`) and surfaced a nicer API in the process
  (`context.items` on the menu context, replacing a manual
  `Zotero.getActiveZoteroPane().getSelectedItems()` call). Node v26's
  native TypeScript execution (unflagged type-stripping) means `node
  --test` still runs the `.ts` test files directly -- no ts-node, no
  jest, no babel added. 47 tests. Verified against a real packed `.xpi`
  install (not just `zotero-plugin serve`'s dev path): menu registers
  correctly, a real `fast-reader-helper` process spawns with correct
  arguments.
- **Docked-window UX** (`packages/reader-helper` + the plugin):
  `fastReader.ts` reads Zotero's own main window geometry
  (`Zotero.getMainWindow()`'s `screenX`/`screenY`/`outerWidth`/
  `outerHeight`) and passes the target position (immediately right of
  Zotero's window, matching its height) to the helper as `--dock-x
  --dock-y --dock-height`. `reader-helper`'s `main.rs` parses these
  (9 new tests) and `app.rs` positions the `winit` window accordingly
  when present, falling back to the original centered default otherwise
  -- deliberately **not** coupling the helper's lifecycle to Zotero's
  (see the plan: this stays a fully separate, independently-closeable
  process; only its on-screen position/size look integrated). Verified
  live end-to-end: a real click-equivalent call
  (`Zotero.FastReader.openInFastReader()`) against a real Zotero window
  produced a real `fast-reader-helper` process whose actual argv
  (checked via `ps -ww`) carried the correctly-computed dock coordinates
  computed from that window's real on-screen geometry.

Total test count after both phases: 42 Rust + 47 TypeScript = 89, all
passing.

## Working (verified, not just written)

- **Fixed: page rendering showed black instead of white for any unpainted
  page area** -- reported by a real user against both a real scanned
  journal article and this project's own synthetic fixtures. Root-caused
  in the vendored MuPDF C source, not guessed: `fz_new_pixmap_from_display_list`
  (`source/fitz/util.c`) clears a pixmap's unpainted area to fully
  transparent black (`fz_clear_pixmap`, all-zero) rather than white when
  `alpha=true` -- and MuPDF's pixmap data is *premultiplied* alpha
  (documented in `fitz/pixmap.h`). `app.rs`'s `blit_centered` was
  discarding the alpha channel and copying the raw (0,0,0) premultiplied
  color directly, so every unpainted region of every page rendered solid
  black -- normal for any real page with margins, i.e. all of them. Fixed
  by compositing properly against white (`channel + (255 - alpha)`,
  the standard premultiplied-over-white simplification) instead of
  dropping alpha. Verified two ways: 3 new unit tests (fully-transparent
  → white, opaque → unchanged, partial alpha → blended), and a visual
  before/after comparison rendered through the *actual* production path
  (`MuPdfDocumentEngine::render()`, not MuPDF's own convenience
  `page.to_pixmap`/`save_as`, which is why this had gone unnoticed --
  see "Important decisions" below).

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
  preserved in the zip (`zipinfo -l` confirmed `-rwxr-xr-x`). Two real bugs
  were found and fixed here, both caught only by testing the *actual*
  "Install from file" path (see below), not the RDP temporary-install path
  used earlier — these are genuinely different code paths in Zotero and
  passing one does not imply the other passes:
  1. Scaffold's default manifest management injects an `update_url`
     derived from `package.json`'s placeholder `repository` field into the
     built manifest. Fixed with `build.makeManifest.enable: false` in
     `zotero-plugin.config.mts`, so the hand-authored `addon/manifest.json`
     ships untouched.
  2. That then surfaced a **real Zotero requirement this project's own
     research had missed**: a first real-world install attempt (the user,
     via Zotero's own "Install Plugin From File" dialog) failed with *"The
     add-on ... could not be installed. It may be incompatible with this
     version of Zotero."* Root-caused live, empirically, by extracting
     Zotero's own bundled `omni.ja` and reading its patched
     `Extension.sys.mjs` directly (not guessed): Zotero requires
     `applications.zotero.update_url` to be a **truthy, URL-shaped string**
     (`!manifest.applications?.zotero?.update_url` is a hard
     `manifestError`) — unlike stock Firefox, where this field is optional
     — and also requires `strict_max_version` to be present (already had
     that). Omitting `update_url` (this project's original, deliberate
     choice, to avoid shipping a fake-looking link) or setting it to `""`
     both fail this check with `ERROR_CORRUPT_FILE` before any
     compatibility comparison even runs. Fixed by giving it a clearly-
     labeled placeholder (`https://github.com/local-dev/zotero-glide/...`,
     matching the same placeholder convention already used in
     `package.json`'s `repository` field) — inert manifest metadata Zotero
     requires structurally, never rendered to the user, not a claim that
     the URL resolves to anything real.
  3. **Verified the complete fix against the exact failing path**: called
     `AddonManager.getInstallForFile()` → `.install()` on the real,
     rebuilt `.xpi`, live, against real stable Zotero 10.0.1 — not the
     beta used for earlier RDP-temporary-install testing. Result:
     `isActive: true`, and `Zotero.MenuManager`'s registry shows the
     correct menu entry afterward, same as the RDP path confirmed
     earlier. This is the same install mechanism the user's own
     Zotero uses when installing a downloaded `.xpi` by hand.
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

For actually installing a built `.xpi` (e.g. via Zotero's own "Install
Plugin From File" dialog, as a real user would), see the `.xpi`
requirements found and fixed above (`applications.zotero.update_url` must
be a truthy URL-shaped string) — that path was separately, empirically
verified end-to-end (`AddonManager.getInstallForFile()` → `.install()` →
`isActive: true` → menu registered), against real stable Zotero 10.0.1,
not just the beta used for the `serve`/RDP path above.

**The plain extension-proxy-file mechanism (a file in the profile's
`extensions/` directory containing the plugin's path, plus
`xpinstall.signatures.required=false` and friends — `scripts/dev-profile.sh`
/ `scripts/run-zotero-dev.sh`) was tried first and did not work** across six
attempts against stable Zotero 10.0.1, with `extensions.json` staying
`{"addons":[]}` every time. It's still in the repo as a documented,
working-for-some-setups fallback, but scaffold is the path that's actually
been proven end-to-end here, and is now the primary documented workflow.

## A second real user hit a real install, and reported real bugs -- all now fixed and verified live

The first person to actually install the `.xpi` (not `zotero-plugin serve`)
hit two failures the RDP-temporary-install testing above never exercised:
an empty/blank context-menu entry, and a crash (`Zotero.File.pathToFile`
`TypeError`) when clicking it. Root-caused and fixed all three underlying
bugs by reproducing them on an isolated test profile (same real
"Install Plugin From File" path, not simulated) and tracing execution
live via RDP console evaluation, step by step, exactly as the earlier
`loadSubScript`/`update_url` bugs were found:

1. **Blank menu label.** `Zotero.MenuManager`'s item builder (`_initMenu`,
   read live from the running process) only ever sets a menu item's
   visible text from `l10nID` (Fluent) -- a plain `label` field is
   silently accepted by `registerMenu()` but never rendered. Fixed by
   setting `context.menuElem.setAttribute("label", ...)` directly inside
   `onShowing` (`context.menuElem` is the real XUL element, confirmed by
   reading `_updateMenuEvents`'s source) rather than adding a Fluent
   `.ftl` file for one static string.
2. **Crash resolving the helper path.** A real "Install from file" install
   keeps the `.xpi` **packed** -- `rootURI` is
   `jar:file:///.../fast-reader@....xpi!/`, not a plain `file://`
   directory (confirmed live: `AddonManager.getAddonByID(...).getResourceURI()`).
   `loadSubScript` handles `jar:` URIs transparently for *script* loading
   (that's why the plugin's JS ran at all), but `Zotero.File.pathToFile()`
   cannot turn a `jar:...!/` URI into a real `nsIFile`, and even if it
   could, `Subprocess.call()` cannot execute a binary living inside a zip
   in the first place. Fixed with a new pure module,
   `addon/src/extractHelper.js` (`resolveHelperPathPacked`, 7 new unit
   tests), which `fastReader.js` uses instead of the plain
   `resolveHelper.js` whenever `rootURI.startsWith("jar:")`: it `fetch()`s
   the binary's bytes straight out of the packed xpi (confirmed live:
   `fetch()` works transparently on `jar:` URIs), writes them to a real,
   version-scoped path under `Zotero.DataDirectory.dir`, and marks it
   executable -- once per version, cached thereafter.
3. **`Zotero.platform` is `undefined`** in current Zotero (confirmed
   live) -- `Zotero.isMac`/`isWin`/`isLinux` are the real API. This made
   every real launch attempt fail with `UnsupportedPlatformError:
   .../undefined/aarch64` regardless of the other two fixes. Fixed with a
   small `_hostPlatform()` mapping in `fastReader.js`; `platform.js`
   itself (already tested against plain "mac"/"win"/"linux" strings)
   needed no change.
4. **`IOUtils.setPermissions(path, "755")` silently does the wrong
   thing** -- it wants a numeric mode (`0o755`), not the string `"755"`
   (confirmed live: the string version produced `-wxr----t`, not
   `-rwxr-xr-x`, and left the binary unreadable though still technically
   executable by its owner). Found while verifying fix #2. Fixed.

**All four verified together, live, end-to-end, through the actual
`FastReader.openInFastReader()` method** (not a hand-rolled equivalent) --
a real PDF item, a real packed install, `Zotero.isMac`-based platform
detection, real extraction to `Zotero.DataDirectory.dir`, and a real
`fast-reader-helper` process observed in `ps` with the correct file
argument, launched and exited cleanly with no error dialog.

## Not working / not verified

- **An actual mouse click on the real menu item, through the real UI,
  has still not been performed** -- everything above was driven via
  direct method calls (`FastReader.openInFastReader(item)`) replicating
  exactly what `onCommand` does, not a literal right-click + menu
  selection, since this sandbox still has no Accessibility/Screen-Recording
  permission to drive or observe that. Given the menu now visibly renders
  with the correct label (fix #1) and everything the click would trigger
  is independently confirmed working (fixes #2-4), this is expected to be
  a non-event, but "expected" remains the gap this project's own
  principles say to close before calling it fully done.
- **The docked window's actual on-screen appearance hasn't been visually
  confirmed** -- verified so far: Zotero's real window geometry is read
  correctly, the target position/height are computed correctly, and
  those exact values reach the spawned process's real argv (checked via
  `ps -ww`, not just unit tests). Not verified: that the window actually
  *renders* flush against Zotero's window when a human looks at it --
  this sandbox has no way to screenshot a native window (same
  Accessibility/Screen-Recording gap as above). `winit`'s
  `with_position`/`with_inner_size` are being used exactly as documented,
  so this is expected to work, but genuinely seeing it is the next
  concrete step for whoever can run this with a real display.
- **Text selection**: not implemented, per the explicit v0.1 scope
  decision in `docs/adr/001-reader-helper-stack.md` and brief §8.
- **Continuous scrolling**: not implemented, per brief §8's documented
  fallback (single-page + navigation).
- **Cross-platform binaries**: only `macos-arm64` has been built.
- **No CI**, **no code signing/notarization**, **no `LICENSE` file yet** —
  see `docs/cross-platform.md` and `docs/licensing.md`.

## Important decisions

- **Why the black-rendering bug survived earlier "visual confirmation"**:
  the PNG-based visual checks used while first building the engine
  (`examples/render_preview.rs`) call MuPDF's own `page.to_pixmap()` +
  `Pixmap::save_as(..., PNG)` directly -- a different call path from the
  production one (`MuPdfDocumentEngine::render()`, via a display list,
  feeding `app.rs`'s own blit code). The resulting PNG *also* had the same
  transparent-black background, but whatever tool rendered it for
  inspection composited that transparency against its own default white
  canvas, visually hiding the bug. Lesson applied going forward: prefer
  verifying the actual pixels the production code path produces
  (`examples/verify_blit_fix.rs` now does this) over trusting how a
  downstream viewer happens to display an intermediate artifact.
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

Have a human actually click "Open in Fast Reader" on a real PDF
attachment (install the built `.xpi`, or `npm start` for the dev flow)
and *look at it*: confirm the reader window appears, shows the correct
label in the menu, and opens docked to the right of Zotero's window at
the right height. Every individual piece this depends on is now
independently verified live at the data level (menu renders with the
correct label, the full launch pipeline spawns a real process with
correct arguments -- including the right dock coordinates -- on a real
packed install) -- this remaining step is purely "does it look right to
a human," not "does the underlying code work," which is a meaningfully
smaller and lower-risk gap than it was at the start of this session.
