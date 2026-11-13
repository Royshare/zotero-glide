#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Zotero Glide contributors
# Launches Zotero against the isolated dev profile created by
# scripts/dev-profile.sh, with debug logging on. Set ZOTERO_APP to the
# Zotero executable if it isn't at the default macOS install location.
set -euo pipefail
PROFILE_DIR="${PROFILE_DIR:-$HOME/.zotero-glide-dev-profile}"
ZOTERO_APP="${ZOTERO_APP:-/Applications/Zotero.app/Contents/MacOS/zotero}"

if [[ ! -d "$PROFILE_DIR/extensions" ]]; then
  echo "No dev profile at $PROFILE_DIR -- run scripts/dev-profile.sh first." >&2
  exit 1
fi
if [[ ! -x "$ZOTERO_APP" ]]; then
  echo "Zotero executable not found at $ZOTERO_APP -- set ZOTERO_APP=/path/to/zotero" >&2
  exit 1
fi

exec "$ZOTERO_APP" -profile "$PROFILE_DIR" -no-remote -purgecaches -ZoteroDebugText -datadir profile
