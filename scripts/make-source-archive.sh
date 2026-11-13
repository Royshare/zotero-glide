#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Zotero Glide contributors
#
# Builds the "complete corresponding source" archive that accompanies every release
# (AGPL-3.0 section 6): this repository at HEAD plus the vendored source of every Rust
# dependency -- which includes MuPDF itself, since the mupdf-sys crate carries it --
# so the binaries can be rebuilt offline from this one file.
#
#   scripts/make-source-archive.sh <version> <output.tar.gz>
set -euo pipefail
VERSION="${1:?usage: make-source-archive.sh <version> <output.tar.gz>}"
OUT="$(cd "$(dirname "${2:?usage: make-source-archive.sh <version> <output.tar.gz>}")" && pwd)/$(basename "$2")"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="zotero-glide-${VERSION}-source"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

git -C "$ROOT" archive --format=tar --prefix="$NAME/" HEAD | tar -x -C "$WORK"
(
  cd "$WORK/$NAME/packages/reader-helper"
  mkdir -p .cargo
  # `cargo vendor` copies every crate source (all platforms) and prints the config that makes
  # cargo use it; the config is stored so `cargo build --offline` works from the archive.
  cargo vendor --locked vendor > .cargo/config.toml
)
cat > "$WORK/$NAME/BUILDING-FROM-THIS-ARCHIVE.txt" <<TXT
This archive contains the complete corresponding source of Zotero Glide ${VERSION}:
the project, plus the vendored source of all Rust dependencies (packages/reader-helper/vendor/,
which includes MuPDF in mupdf-sys). Rust dependencies need no network:

  cd packages/reader-helper && cargo build --release --offline
  # then scripts/build-helper.sh / scripts/setup.sh as described in README.md

License: AGPL-3.0-or-later (LICENSE). Third-party notices: THIRD_PARTY_NOTICES.md.
TXT
tar -C "$WORK" -czf "$OUT" "$NAME"
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
