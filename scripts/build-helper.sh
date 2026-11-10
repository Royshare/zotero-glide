#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Zotero Fast Reader contributors
# Builds fast-reader-helper for the current host and copies it into
# packages/zotero-plugin/addon/bin/<platform-dir>/, matching the layout
# resolvePlatformDir() (packages/zotero-plugin/src/platform.js) and
# docs/cross-platform.md expect. Does not cross-compile -- run this once
# per target platform, on that platform (or under a matching cross
# toolchain you've set up yourself; not provided here, see
# docs/cross-platform.md's CI matrix sketch for what that would look like).
set -euo pipefail
# The release workflow assembles binaries built on several OSes; it sets this so the
# npm prebuild hook does not try to build the (single, host-only) helper again.
if [[ -n "${FAST_READER_SKIP_HELPER_BUILD:-}" ]]; then
  echo "FAST_READER_SKIP_HELPER_BUILD set: using the helper binaries already in addon/bin/"
  exit 0
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER_DIR="$ROOT/packages/reader-helper"
PLUGIN_BIN_DIR="$ROOT/packages/zotero-plugin/addon/bin"

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin)
    case "$arch" in
      arm64) platform_dir="macos-arm64" ;;
      x86_64) platform_dir="macos-x64" ;;
      *) echo "Unsupported macOS arch: $arch" >&2; exit 1 ;;
    esac
    bin_name="fast-reader-helper"
    ;;
  Linux)
    case "$arch" in
      x86_64) platform_dir="linux-x64" ;;
      *) echo "Unsupported Linux arch: $arch" >&2; exit 1 ;;
    esac
    bin_name="fast-reader-helper"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    platform_dir="windows-x64"
    bin_name="fast-reader-helper.exe"
    ;;
  *)
    echo "Unsupported OS: $os" >&2; exit 1 ;;
esac

echo "Building fast-reader-helper (release) for $platform_dir..."
(cd "$HELPER_DIR" && cargo build --release)

mkdir -p "$PLUGIN_BIN_DIR/$platform_dir"
cp "$HELPER_DIR/target/release/$bin_name" "$PLUGIN_BIN_DIR/$platform_dir/$bin_name"
chmod +x "$PLUGIN_BIN_DIR/$platform_dir/$bin_name" 2>/dev/null || true
echo "Installed: $PLUGIN_BIN_DIR/$platform_dir/$bin_name"
