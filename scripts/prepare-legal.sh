#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Zotero Fast Reader contributors
#
# Stages the license material that must ship inside the .xpi into
# packages/zotero-plugin/addon/legal/ (git-ignored; rebuilt on every build):
#   LICENSE                  AGPL-3.0 text
#   THIRD_PARTY_NOTICES.md   third-party components and their licenses
#   SOURCE.md                where the complete corresponding source is (AGPL section 6)
#
# The .xpi bundles the helper binary, which statically links MuPDF (AGPL-3.0), so
# distributing it means offering the source. Release builds (CI) set
#   FAST_READER_SOURCE_URL     e.g. https://github.com/<owner>/<repo>
#   FAST_READER_SOURCE_COMMIT  the exact commit built
# Local builds leave them unset and SOURCE.md says so instead of inventing a URL.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEGAL="$ROOT/packages/zotero-plugin/addon/legal"
VERSION="$(node -p "require('$ROOT/packages/zotero-plugin/package.json').version")"
URL="${FAST_READER_SOURCE_URL:-}"
COMMIT="${FAST_READER_SOURCE_COMMIT:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)}"

mkdir -p "$LEGAL"
cp "$ROOT/LICENSE" "$ROOT/THIRD_PARTY_NOTICES.md" "$LEGAL/"

if [[ -n "$URL" ]]; then
  WHERE="The complete corresponding source of exactly this build is at:

    $URL  (commit \`${COMMIT:-unknown}\`)

and is also attached to the release as \`zotero-fast-reader-${VERSION}-source.tar.gz\`, which contains
this project **and the vendored source of every dependency, including MuPDF**."
else
  WHERE="This is a local/development build: no public source location was recorded in it. The source
is the repository it was built from${COMMIT:+ (commit \`$COMMIT\`)}. Official release builds replace this
paragraph with the exact URL and commit and attach a source archive to the release."
fi

cat > "$LEGAL/SOURCE.md" <<MD
# Source code for Zotero Fast Reader ${VERSION}

Zotero Fast Reader is free software, licensed under the **GNU Affero General Public License,
version 3 or (at your option) any later version** (see \`LICENSE\`). The \`bin/\` directory of this
plugin contains compiled \`fast-reader-helper\` programs that statically link MuPDF
(c) Artifex Software, Inc., which is also AGPL-3.0-or-later. Third-party components and their
licenses are listed in \`THIRD_PARTY_NOTICES.md\`.

## Where to get the source

${WHERE}

## Rebuilding this plugin from that source

    git clone <repository> && cd zotero-glide
    scripts/setup.sh                 # builds the helper, runs the tests
    cd packages/zotero-plugin && npm ci && npm run build   # -> .scaffold/build/zotero-fast-reader.xpi

\`fast-reader-helper --version\` and \`--license\` print the same information from the binary itself.
MD
echo "legal material staged in $LEGAL"
