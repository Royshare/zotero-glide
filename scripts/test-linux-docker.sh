#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Zotero Fast Reader contributors
# Builds and exercises the helper on real Linux inside a container (Docker /
# OrbStack), from a macOS or Linux host. Covers the HELPER only -- not Zotero
# on Linux (the plugin/tab side needs a real Linux Zotero).
#
#   scripts/test-linux-docker.sh [linux/amd64|linux/arm64]
#
# Runs: cargo test, a release build, then scripts/benchmark-serve.py (the
# in-tab protocol, page turns, trim) twice: default glibc behavior and tuned
# the way the plugin launches the helper (MALLOC_MMAP_THRESHOLD_).
set -euo pipefail
PLATFORM="${1:-linux/amd64}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

docker run --rm --platform "$PLATFORM" -v "$ROOT":/src:ro rust:1-bookworm bash -euo pipefail -c '
  apt-get update -qq
  apt-get install -y -qq clang libclang-dev make python3 >/dev/null
  mkdir /work && cd /src
  tar --exclude=target --exclude=node_modules --exclude=.scaffold --exclude=.git -cf - . | tar -xf - -C /work
  cd /work/packages/reader-helper
  echo "== uname: $(uname -sm)  glibc: $(ldd --version | head -1)"
  cargo test --release 2>&1 | grep -E "^test result|FAILED|panicked|^error" || true
  cargo build --release 2>&1 | tail -1
  cd /work
  echo "== benchmark-serve.py, default glibc malloc"
  python3 scripts/benchmark-serve.py --untuned
  echo "== benchmark-serve.py, tuned as the plugin launches it (MALLOC_MMAP_THRESHOLD_=1048576)"
  python3 scripts/benchmark-serve.py
'
