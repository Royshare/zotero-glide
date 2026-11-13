// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

// Re-run when the release pipeline changes where/what the source is, so the
// source offer baked into `--version`/`--license` (see src/about.rs) is never stale.
fn main() {
    println!("cargo:rerun-if-env-changed=GLIDE_SOURCE_URL");
    println!("cargo:rerun-if-env-changed=GLIDE_SOURCE_COMMIT");
}
