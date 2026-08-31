#!/usr/bin/env bash
# One-command setup: generate test/benchmark fixtures, build the helper,
# run both test suites. Per brief §14: a developer shouldn't need to
# manually copy files around to get a working dev loop.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Generating PDF fixtures"
PY="$(command -v python3)"
"$PY" "$ROOT/scripts/gen_fixtures.py"

echo "==> Building reader-helper (release) + running its tests"
(cd "$ROOT/packages/reader-helper" && cargo build --release && cargo test)

echo "==> Copying the built helper into packages/zotero-plugin/addon/bin/<platform>/"
"$ROOT/scripts/build-helper.sh"

echo "==> Running zotero-plugin unit tests"
(cd "$ROOT/packages/zotero-plugin" && node --test)

cat <<'EOF'

Setup complete. Next steps:
  cd packages/zotero-plugin && npm install && cp .env.example .env
      # set ZOTERO_PLUGIN_ZOTERO_BIN_PATH / PROFILE_PATH / DATA_DIR, then:
  npm start                                  # launch Zotero with the plugin loaded (see STATUS.md)
  bash scripts/benchmark-reader.sh release   # performance validation (docs/benchmark-methodology.md)

(scripts/dev-profile.sh + run-zotero-dev.sh are a documented fallback
using the classic extension-proxy-file mechanism -- see STATUS.md for why
`npm start` above is the path that's actually been verified to work.)
EOF
