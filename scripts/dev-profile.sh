#!/usr/bin/env bash
# Creates (or reuses) an isolated Zotero profile + data directory for
# developing this plugin, per brief §14: "Do not develop against a user's
# production Zotero database/profile when avoidable." Everything lives
# under $PROFILE_DIR (default: ~/.zotero-fast-reader-dev-profile),
# completely separate from the real ~/Library/Application Support/Zotero
# profile -- this script never touches that.
#
# Installs the plugin via the standard Zotero/Firefox "extension proxy
# file" mechanism: a file named after the plugin's ID in the profile's
# extensions/ directory, containing the absolute path to the plugin
# source directory (see https://www.zotero.org/support/dev/zotero_7_for_developers
# and https://forums.zotero.org/discussion/85336/, both cited here since
# this mechanism is exactly the "how do I develop a Zotero 7+ plugin"
# convention, not something invented for this project).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$ROOT/packages/zotero-plugin"
PLUGIN_ID="fast-reader@zotero-glide.local"
PROFILE_DIR="${PROFILE_DIR:-$HOME/.zotero-fast-reader-dev-profile}"

mkdir -p "$PROFILE_DIR/extensions"
printf '%s' "$PLUGIN_DIR" > "$PROFILE_DIR/extensions/$PLUGIN_ID"

cat > "$PROFILE_DIR/user.js" <<'EOF'
// Development-only prefs for loading an unpacked/unsigned plugin from
// source via the extensions/ proxy-file mechanism. Never used for a real
// Zotero profile.
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("extensions.startupScanScopes", 15);
user_pref("extensions.experiments.enabled", true);
EOF

# Force a full extension rescan on next launch (see zotero_7_for_developers /
# forum guidance: Zotero, like upstream Firefox, skips the extensions/
# directory scan when the app build/version hasn't changed since last run).
if [[ -f "$PROFILE_DIR/prefs.js" ]]; then
  sed -i.bak '/extensions\.lastAppBuildId/d; /extensions\.lastAppVersion/d' "$PROFILE_DIR/prefs.js"
fi
rm -f "$PROFILE_DIR/.parentlock" "$PROFILE_DIR/.startup-incomplete"

echo "Dev profile ready: $PROFILE_DIR"
echo "Plugin proxy file: $PROFILE_DIR/extensions/$PLUGIN_ID -> $PLUGIN_DIR"
echo "Run scripts/run-zotero-dev.sh to launch Zotero against this profile."
