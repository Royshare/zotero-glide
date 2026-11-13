// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

/**
 * Zotero 7+/10 bootstrapped plugin lifecycle. Structure follows the
 * pattern documented at zotero.org/support/dev/zotero_7_for_developers
 * (still current for Zotero 10 per zotero_8_for_developers's own note)
 * and zotero/make-it-red's bootstrap.js.
 *
 * Deliberately tiny: loads the ONE esbuild-bundled script (built from
 * src/index.ts -- see ../zotero-plugin.config.mts) via
 * `Services.scriptloader.loadSubScript`, which attaches the plugin as
 * `Zotero.Glide`, then just calls its lifecycle methods. No
 * multi-file loadSubScript chain here anymore -- that's what caused a
 * real bug (see STATUS.md: `const exportsObj` redeclaration across
 * separately-loaded files) before the TypeScript/bundling migration.
 */

/* global Services, Zotero */

function install(_data, _reason) {}

function startup({ id, version, rootURI }, _reason) {
  Services.scriptloader.loadSubScript(rootURI + "content/scripts/glide.js");
  Zotero.Glide.init({ id, version, rootURI });
  Zotero.Glide.addToAllWindows();
}

function onMainWindowLoad({ window }) {
  if (Zotero.Glide) {
    Zotero.Glide.addToWindow(window);
  }
}

function onMainWindowUnload({ window }) {
  if (Zotero.Glide) {
    Zotero.Glide.removeFromWindow(window);
  }
}

function shutdown(_data, reason) {
  // On APP_SHUTDOWN there's no point tearing down UI that's about to
  // vanish with the whole process anyway -- and Zotero.MenuManager may
  // already be mid-teardown itself. Only clean up for an actual
  // plugin-level disable/uninstall/upgrade.
  if (reason === "APP_SHUTDOWN") return;
  if (Zotero.Glide) {
    Zotero.Glide.removeFromAllWindows();
  }
}

function uninstall(_data, _reason) {}
