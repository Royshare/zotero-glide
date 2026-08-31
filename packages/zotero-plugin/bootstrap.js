/**
 * Zotero 7+/10 bootstrapped plugin lifecycle. Structure follows the
 * pattern documented at zotero.org/support/dev/zotero_7_for_developers
 * (still current for Zotero 10 per zotero_8_for_developers's own note)
 * and zotero/make-it-red's bootstrap.js: `startup` loads the plugin's own
 * script(s) via `Services.scriptloader.loadSubScript` with NO scope
 * argument (so top-level `var` declarations land directly in this file's
 * global -- see src/errors.js's comment for why that specifically matters
 * here), then delegates all real work to `FastReader`.
 *
 * This file does no PDF/rendering/menu logic itself -- see src/fastReader.js
 * and the pure modules under src/ for that (brief §3: "keep the Zotero
 * plugin thin").
 */

/* global Services, FastReader */

function install(_data, _reason) {}

async function startup({ id, version, rootURI }, _reason) {
  const files = [
    "src/errors.js",
    "src/platform.js",
    "src/resolveHelper.js",
    "src/pdfAttachment.js",
    "src/buildArgs.js",
    "src/launchFastReader.js",
    "src/fastReader.js",
  ];
  for (const file of files) {
    Services.scriptloader.loadSubScript(rootURI + file);
  }
  FastReader.init({ id, version, rootURI });
  FastReader.addToAllWindows();
}

function onMainWindowLoad({ window }) {
  if (typeof FastReader !== "undefined") {
    FastReader.addToWindow(window);
  }
}

function onMainWindowUnload({ window }) {
  if (typeof FastReader !== "undefined") {
    FastReader.removeFromWindow(window);
  }
}

function shutdown(_data, reason) {
  // On APP_SHUTDOWN there's no point tearing down UI that's about to
  // vanish with the whole process anyway -- and Zotero.MenuManager may
  // already be mid-teardown itself. Only clean up for an actual
  // plugin-level disable/uninstall/upgrade.
  if (reason === "APP_SHUTDOWN") return;
  if (typeof FastReader !== "undefined") {
    FastReader.removeFromAllWindows();
  }
}

function uninstall(_data, _reason) {}
