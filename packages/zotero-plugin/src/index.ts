// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

/**
 * Bundle entry point (see zotero-plugin.config.mts's esbuildOptions).
 * Everything else under src/ uses real ES import/export and is bundled
 * into one output file -- addon/bootstrap.js loadSubScript()s that one
 * file, then drives the plugin entirely through Zotero.Glide, with
 * no cross-file loadSubScript chain (and none of its scoping fragility --
 * see errors.ts's git history / STATUS.md for the bug that motivated
 * this).
 */
import { Glide } from "./glide.ts";

Zotero.Glide = Glide;
