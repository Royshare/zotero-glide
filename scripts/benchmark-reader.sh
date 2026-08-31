#!/usr/bin/env bash
# Performance validation procedure for fast-reader-helper (brief §16).
#
# Two measurement paths, on purpose (see docs/benchmark-methodology.md):
#   1. The REAL `fast-reader-helper` GUI binary is launched against each
#      fixture to measure startup time, time-to-first-page, idle RSS, and
#      idle CPU -- the actual shipped binary, actually opening a window.
#   2. `bench_navigate` (a small headless binary sharing the exact same
#      ReaderSession code path -- see src/session.rs) drives page-by-page
#      navigation to measure RSS after 20/100 pages. This exists because
#      this development sandbox cannot inject synthetic OS keyboard events
#      into the real windowed binary, so navigation-driven memory can't be
#      captured by driving the shipped binary end-to-end here. On a
#      developer machine with normal input permissions, re-run the
#      "manual" section at the bottom of this script instead/in addition.
#
# Usage: scripts/benchmark-reader.sh [release|debug]

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${1:-release}"
HELPER_DIR="$ROOT/packages/reader-helper"
BIN="$HELPER_DIR/target/$PROFILE/fast-reader-helper"
BENCH_BIN="$HELPER_DIR/target/$PROFILE/bench_navigate"
FIXTURES_DIR="$ROOT/benchmarks/fixtures"

if [[ ! -x "$BIN" || ! -x "$BENCH_BIN" ]]; then
  echo "Building ($PROFILE)..." >&2
  (cd "$HELPER_DIR" && cargo build --profile "$([[ $PROFILE == release ]] && echo release || echo dev)")
fi

# Raw RSS (from `ps`) double-counts shared framework pages (AppKit, Metal,
# CoreGraphics, etc.) that macOS maps into every windowed process, which
# makes it look far worse than the memory actually attributable to this
# process. On macOS, prefer `footprint`'s phys_footprint (the same metric
# Activity Monitor and the OS's own memory-pressure/jetsam logic use) when
# available; fall back to `ps RSS` elsewhere. See docs/benchmark-methodology.md.
mem_kb() {
  if command -v footprint >/dev/null 2>&1; then
    local mb
    mb=$(footprint "$1" 2>/dev/null | grep phys_footprint: | grep -o '[0-9.]* MB' | head -1 | grep -o '[0-9.]*')
    if [[ -n "$mb" ]]; then
      awk -v mb="$mb" 'BEGIN { printf "%.0f", mb * 1024 }'
      return
    fi
  fi
  ps -o rss= -p "$1" 2>/dev/null | tr -d ' '
}

echo "document,startup_to_window_ms,startup_to_first_page_ms,idle_mem_kb_at_1s,idle_cpu_pct_over_2s"
for doc in "$FIXTURES_DIR"/paper-a.pdf "$FIXTURES_DIR"/book-b.pdf "$FIXTURES_DIR"/scanned-c.pdf; do
  name="$(basename "$doc")"
  log="$(mktemp)"
  FAST_READER_DEBUG=1 "$BIN" "$doc" >"$log" 2>&1 &
  pid=$!
  sleep 1
  rss1="$(mem_kb "$pid")"
  sleep 2
  cpu2_ticks=$(ps -o %cpu= -p "$pid" 2>/dev/null | tr -d ' ')
  first_page_ms=$(grep -o '+\([0-9]*\)ms first frame presented' "$log" | head -1 | grep -o '[0-9]*' | head -1)
  window_ms=$(grep -o '+\([0-9]*\)ms pages=' "$log" | head -1 | grep -o '[0-9]*' | head -1)
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  echo "$name,${window_ms:-NA},${first_page_ms:-NA},${rss1:-NA},${cpu2_ticks:-NA}"
  rm -f "$log"
done

echo
echo "--- navigation memory (headless ReaderSession harness, see header comment) ---"
echo "document,checkpoint,page_count,rss_kb,cache_entries_bounded_to_3"
for doc in "$FIXTURES_DIR"/paper-a.pdf "$FIXTURES_DIR"/book-b.pdf "$FIXTURES_DIR"/scanned-c.pdf; do
  name="$(basename "$doc")"
  "$BENCH_BIN" "$doc" | while read -r line; do
    echo "$name,$line"
  done
done

cat <<'EOF'

--- manual step (not automatable in this sandbox) ---
To validate navigation memory against the REAL windowed binary on a
developer machine with normal OS input permissions:
  FAST_READER_DEBUG=1 ./target/release/fast-reader-helper <doc.pdf>
  # press PageDown 20 times, then: ps -o rss= -p <pid>
  # press PageDown 80 more times (100 total), then: ps -o rss= -p <pid>
Compare against the bench_navigate numbers above -- they should be close,
since both paths call the same ReaderSession::prepare_frame.
EOF
