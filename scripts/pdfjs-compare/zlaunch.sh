#!/usr/bin/env bash
# usage: zlaunch.sh <Zotero.app path> <profile dir> <data dir> <rdp port>
APP="$1"; PROFILE="$2"; DATA="$3"; PORT="$4"
mkdir -p "$PROFILE" "$DATA"
cat > "$PROFILE/user.js" <<PREFS
user_pref("devtools.debugger.remote-enabled", true);
user_pref("devtools.debugger.prompt-connection", false);
user_pref("devtools.chrome.enabled", true);
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.update.enabled", false);
user_pref("app.update.enabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("extensions.zotero.firstRun.skipFirefoxProfileAccessCheck", true);
user_pref("extensions.zotero.firstRunGuidance", false);
user_pref("extensions.zotero.firstRun2", false);
user_pref("extensions.zotero.httpServer.enabled", false);
user_pref("extensions.zotero.automaticScraperUpdates", false);
user_pref("extensions.zotero.sync.autoSync", false);
PREFS
nohup "$APP/Contents/MacOS/zotero" --purgecaches no-remote -profile "$PROFILE" --dataDir "$DATA" -start-debugger-server "$PORT" >"$PROFILE/stdout.log" 2>&1 &
echo $! > "$PROFILE/pid"
