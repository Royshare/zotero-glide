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

echo "==> Copying the built helper into packages/zotero-plugin/bin/<platform>/"
"$ROOT/scripts/build-helper.sh"

echo "==> Running zotero-plugin unit tests"
(cd "$ROOT/packages/zotero-plugin" && node --test)

echo "==> Setting up an isolated Zotero dev profile"
"$ROOT/scripts/dev-profile.sh"

cat <<'EOF'

Setup complete. Next steps:
  scripts/run-zotero-dev.sh       # launch Zotero against the isolated dev profile
  bash scripts/benchmark-reader.sh release   # performance validation (docs/benchmark-methodology.md)
EOF
