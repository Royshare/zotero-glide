import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

// No esbuild/TS bundling step: this plugin's runtime is plain JS, loaded
// via bootstrap.js's Services.scriptloader.loadSubScript calls (see
// addon/bootstrap.js and addon/src/errors.js's comment on why -- Zotero's
// loadSubScript scoping rules, not a build-tooling choice). "build.assets"
// below just copies addon/ as-is into dist/addon/, which is exactly what
// `zotero-plugin serve`'s default (RDP temporary-addon) dev-load mechanism
// needs -- see STATUS.md and docs/cross-platform.md for why this
// scaffold-based mechanism replaced the plain proxy-file approach.
export default defineConfig({
  source: ["addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,

  build: {
    // NOT "addon/**/*.*" -- the helper binaries under addon/bin/<platform>/
    // have no file extension (fast-reader-helper, no ".exe" on
    // macOS/Linux), so a "*.*" glob silently drops them. Confirmed by
    // testing: the binary was missing from .scaffold/build/addon/bin/
    // until this was fixed to "addon/**/*".
    assets: ["addon/**/*"],
    define: {
      ...pkg.config,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    // addon/manifest.json is hand-authored and complete (see its own
    // comments/citations) -- scaffold's default manifest management would
    // otherwise inject an `update_url` built from package.json's
    // `repository` field, which is a placeholder, not a real update feed.
    // Shipping a fabricated-looking URL in a distributable manifest isn't
    // acceptable, so scaffold is told to leave manifest.json alone.
    makeManifest: {
      enable: false,
    },
  },
});
