# Benchmark methodology

This documents how `scripts/benchmark-reader.sh` measures the product
hypothesis in the brief: *"memory should plateau under ordinary navigation
rather than continuously increasing with every visited page."* It also
records the actual numbers observed while building v0.1, and is honest
about two measurement compromises forced by the sandboxed environment this
was built in -- both are called out below rather than hidden.

## Fixtures

`scripts/gen_fixtures.py` generates three fully synthetic, owned (CC0), raw
PDF fixtures -- no external PDF library, so there is no licensing
entanglement in the fixtures themselves:

| File | Pages | Content | Stands in for |
|---|---|---|---|
| `benchmarks/fixtures/paper-a.pdf` | 24 | vector text + line-drawn figures | Document A: normal academic paper |
| `benchmarks/fixtures/book-b.pdf` | 220 | vector text only | Document B: long paper/book |
| `benchmarks/fixtures/scanned-c.pdf` | 40 | one full-page JPEG per page | Document C: image-heavy/scanned |

## Two measurement paths (and why)

1. **Startup time, time-to-first-page, idle memory, idle CPU** are measured
   against the actual shipped `fast-reader-helper` GUI binary -- it is
   launched for real, opens a real window, and its own debug log
   (`FAST_READER_DEBUG=1`, timestamped in `src/log.rs`) is parsed for the
   `first frame presented` marker.

2. **Memory after navigating 20 / 100 pages** is measured with
   `bench_navigate` (`src/bin/bench_navigate.rs`), a small headless binary
   that drives `ReaderSession` (`src/session.rs`) directly, calling exactly
   the same `prepare_frame()` method the GUI's `RedrawRequested` handler
   calls on every page turn -- same cache, same prefetch, same eviction.

   **Why not just drive the real GUI end-to-end for this too:** this
   repository was built in a sandboxed development environment with no
   permission to inject synthetic OS keyboard/window events (confirmed:
   both `osascript ... keystroke` and Accessibility-based input are
   refused by macOS with "not allowed to send keystrokes"). There was no
   way to press PageDown 100 times against the real window from here. Since
   `ReaderSession` is the literal method the GUI calls, not a
   reimplementation, this is a faithful proxy -- but it is still a proxy,
   and the bottom of `scripts/benchmark-reader.sh`'s output says exactly
   how to re-validate it against the real binary on a normal developer
   machine (open the real window, press PageDown, read `ps`/`footprint`
   yourself). Do that before treating these numbers as final.

## RSS vs. physical footprint (macOS)

Raw `ps -o rss=` on macOS counts shared framework pages (AppKit, Metal,
CoreGraphics, CoreText, ...) that the OS maps into *every* windowed
process -- it is not memory this application uniquely holds. It made the
windowed binary look like it used ~175-186MB at idle, which is misleading.

Apple's `footprint <pid>` CLI reports `phys_footprint`, the same metric
Activity Monitor and the kernel's own memory-pressure/jetsam accounting
use. `scripts/benchmark-reader.sh` and `bench_navigate` both prefer
`footprint` when it's on `$PATH` and fall back to `ps` RSS elsewhere
(non-macOS, or if `footprint` is unavailable). This is a real methodology
choice, not an attempt to make the numbers look better -- `footprint` is
just the more meaningful number on this platform, and this doc says so
explicitly per the brief's "do not artificially optimize benchmark
numbers."

## Observed results (this machine, Apple Silicon, macOS, release build)

Reproduce with `bash scripts/benchmark-reader.sh release`.

Real GUI binary, idle:

| document | window shown | first page shown | idle phys_footprint (1s) | idle CPU (2s sample) |
|---|---|---|---|---|
| paper-a.pdf (24p) | ~2ms | ~120ms | ~104 MB | 0.0% |
| book-b.pdf (220p) | ~1ms | ~135ms | ~104 MB | 0.0% |
| scanned-c.pdf (40p) | ~1ms | ~180ms | ~116 MB | 0.0% |

The ~104MB idle floor is essentially constant across documents -- it's the
cost of an AppKit window + softbuffer/CoreGraphics surface existing at all,
not something that scales with document size. Idle CPU reads 0.0% because
v0.1 draws nothing on an idle event loop (see `src/log.rs`'s note: debug
logging never fires from the idle path either) -- there is no polling
timer, animation, or background thread.

Headless `ReaderSession` navigation (`bench_navigate`), same fixtures:

| document | after 20 pages | after 100 pages | cache entries (bounded) |
|---|---|---|---|
| paper-a.pdf (24p) | ~24 MB | n/a (only 24 pages) | ≤3 throughout |
| book-b.pdf (220p) | ~24 MB | ~25 MB | ≤3 throughout |
| scanned-c.pdf (40p) | ~157 MB | n/a (only 40 pages) | ≤3 throughout |

`book-b.pdf` going from ~24MB to ~25MB between page 20 and page 100 (80
more pages visited) is the plateau the hypothesis asked for: this
application's own caches (`RenderCache` in `src/cache.rs`, the
display-list cache in `src/engine.rs`) are provably bounded --
`cache::tests::navigation_evicts_pages_outside_window_and_size_stays_bounded`
walks a simulated 200-page read and asserts the cache never exceeds 3
entries; `bench_navigate` confirms `cache_entries` never exceeds 3 for real
documents either.

## A real, documented finding: MuPDF's own resource store

`scanned-c.pdf` (unique full-page JPEGs) does **not** plateau the same way
-- it climbs roughly linearly, about 6.3MB per page, reaching ~157MB by
page 20. This is not a leak in this project's code: it comes from MuPDF's
own internal `fz_context` resource store, which caches decoded
images/glyphs/fonts across the whole process independent of anything this
project's `RenderCache` does. Confirmed directly in the vendored MuPDF
source:

```
mupdf-sys-0.8.0/wrapper/context.c:67:
    fz_context *ctx = fz_new_context(NULL, &locks, FZ_STORE_DEFAULT);

mupdf-sys-0.8.0/mupdf/include/mupdf/fitz/context.h:317:
    FZ_STORE_DEFAULT = 256 << 20,   // 256 MiB
```

MuPDF's store auto-evicts under its own LRU policy once it approaches this
256MB budget -- so growth for image-heavy documents is bounded, just at a
much higher ceiling than this project's own page cache, and the ceiling is
a MuPDF-wide constant, not something `RenderCache` controls. This is worth
knowing (and re-testing against a real 200+ page scanned book, not just 40
synthetic pages, once available) rather than something to paper over. If a
tighter ceiling turns out to matter, `fz_new_context`'s `max_store`
argument is the lever -- not exposed by the `mupdf` crate today, so doing
this would mean calling MuPDF's C API more directly than the crate
currently allows, which is out of scope for v0.1.

## What this does and doesn't validate

It validates: this project's own render cache and display-list cache are
genuinely bounded, on real (if synthetic) documents, measured with a real
memory-accounting tool. It does not yet validate: the "substantially lower
lifecycle coupling" comparison against Zotero's actual Gecko/PDF.js reader,
which requires a real Zotero installation with the plugin loaded side by
side -- that comparison is v0.1's stated open item, not something to
approximate here.
