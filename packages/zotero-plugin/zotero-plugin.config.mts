// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

// src/ (TypeScript, real import/export) is bundled by esbuild into ONE
// output file; addon/ holds only static files (manifest.json,
// bootstrap.js, bin/) that build.assets copies in as-is. bootstrap.js
// loadSubScript()s that one bundled file -- see its own comment for why
// this replaced the old multi-file loadSubScript chain (a real bug: see
// STATUS.md's `const exportsObj` redeclaration writeup).
export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,

  // `npm run release` = pick a version, bump it, commit, tag vX.Y.Z and push. The pushed tag triggers
  // .github/workflows/release.yml, which builds all platforms and publishes the GitHub release; scaffold's
  // own GitHub publisher is disabled because it would only package this machine's helper.
  release: {
    bumpp: {
      // manifest.json is hand-authored (makeManifest is off), so its version must be bumped alongside.
      files: ["package.json", "addon/manifest.json"],
    },
    github: {
      enable: "false",
    },
  },

  build: {
    // NOT "addon/**/*.*" -- the helper binaries under addon/bin/<platform>/
    // have no file extension (glide-helper, no ".exe" on
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
    // This plugin doesn't use Fluent (no .ftl files -- the one string in
    // its UI is set directly via context.menuElem.setAttribute, see
    // glide.ts). Without this, scaffold regenerates a broken
    // typings/i10n.d.ts (`export type FluentMessageId = ;`, invalid
    // syntax with zero locale files) on every build, which then fails
    // `tsc --noEmit`.
    fluent: {
      dts: false,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        bundle: true,
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },
});
