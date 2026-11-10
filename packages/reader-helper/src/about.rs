// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

//! `--version` / `--license`: the helper statically links MuPDF (AGPL-3.0), so
//! every distributed binary must tell the recipient its license and where to get
//! the corresponding source. Release builds bake the source location in via
//! `FAST_READER_SOURCE_URL` / `FAST_READER_SOURCE_COMMIT` (see
//! scripts/prepare-legal.sh and .github/workflows/release.yml).

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
const SOURCE_URL: Option<&str> = option_env!("FAST_READER_SOURCE_URL");
const SOURCE_COMMIT: Option<&str> = option_env!("FAST_READER_SOURCE_COMMIT");

fn source_line(url: Option<&str>, commit: Option<&str>) -> String {
    match (url, commit) {
        (Some(u), Some(c)) => format!("Corresponding source: {u} (commit {c})"),
        (Some(u), None) => format!("Corresponding source: {u}"),
        _ => "Corresponding source: this is a development build with no source location baked in; \
              the source is the repository it was built from (release builds state the exact URL and commit)."
            .to_string(),
    }
}

fn version_text(url: Option<&str>, commit: Option<&str>) -> String {
    format!("fast-reader-helper {VERSION}\n{}\n", source_line(url, commit))
}

fn license_text(url: Option<&str>, commit: Option<&str>) -> String {
    format!(
        "fast-reader-helper {VERSION} -- part of Zotero Fast Reader\n\
         Copyright (C) 2026 Zotero Fast Reader contributors\n\n\
         This program is free software: you can redistribute it and/or modify it under the terms of the\n\
         GNU Affero General Public License as published by the Free Software Foundation, either version 3\n\
         of the License, or (at your option) any later version.\n\n\
         This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without\n\
         even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU\n\
         Affero General Public License for more details.\n\n\
         It statically links MuPDF (c) Artifex Software, Inc., also AGPL-3.0-or-later, and other third-party\n\
         components; see THIRD_PARTY_NOTICES.md. The full license text is in LICENSE (shipped in the\n\
         plugin's legal/ directory) and at https://www.gnu.org/licenses/agpl-3.0.html\n\n\
         {}\n",
        source_line(url, commit)
    )
}

/// If `argv` asks for `--version` or `--license`, the text to print (then exit 0).
pub fn info_for(argv: &[String]) -> Option<String> {
    if argv.iter().any(|a| a == "--version" || a == "-V") {
        Some(version_text(SOURCE_URL, SOURCE_COMMIT))
    } else if argv.iter().any(|a| a == "--license") {
        Some(license_text(SOURCE_URL, SOURCE_COMMIT))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn version_and_license_flags_are_recognized_anywhere_in_argv() {
        assert!(info_for(&argv(&["--version"])).unwrap().contains(VERSION));
        assert!(info_for(&argv(&["-V"])).is_some());
        assert!(info_for(&argv(&["--file", "x.pdf", "--license"])).unwrap().contains("Affero"));
        assert!(info_for(&argv(&["x.pdf"])).is_none());
    }

    #[test]
    fn source_offer_names_the_url_and_commit_when_baked_in() {
        let t = version_text(Some("https://example.org/repo"), Some("abc123"));
        assert!(t.contains("https://example.org/repo") && t.contains("abc123"));
        let t = license_text(Some("https://example.org/repo"), None);
        assert!(t.contains("https://example.org/repo") && t.contains("MuPDF"));
    }

    #[test]
    fn a_dev_build_says_so_rather_than_inventing_a_url() {
        let t = version_text(None, None);
        assert!(t.contains("development build") && !t.contains("http"));
    }
}
