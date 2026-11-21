// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

//! `glide-helper`: the headless MuPDF render server behind a Zotero Glide reader tab
//! (see serve.rs and docs/adr/002-in-tab-reader.md). There is no window mode: the
//! plugin owns all UI and this process only renders pages and answers queries.

use glide_helper::engine::mupdf_engine::MuPdfDocumentEngine;
use glide_helper::engine::DocumentEngine;
use glide_helper::log;
use glide_helper::serve::{self, Server};
use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "usage: glide-helper --serve --frame-dir <dir> --file <pdf-path> [--page N]   (headless, JSON over stdio)";

#[derive(Debug, PartialEq)]
struct Args {
    file: PathBuf,
    frame_dir: PathBuf,
}

fn parse_args(argv: &[String]) -> Result<Args, String> {
    if argv.is_empty() {
        return Err(USAGE.into());
    }
    let mut file: Option<PathBuf> = None;
    let mut serve = false;
    let mut frame_dir: Option<PathBuf> = None;
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--file" => {
                i += 1;
                let v = argv.get(i).ok_or("--file requires a value")?;
                file = Some(PathBuf::from(v));
            }
            // Accepted and validated for compatibility with older launchers; the opening page is
            // chosen by the plugin with a `goto`/`resume` command once the helper is ready.
            "--page" => {
                i += 1;
                let v = argv.get(i).ok_or("--page requires a value")?;
                v.parse::<u32>().map_err(|_| format!("invalid --page value: {v}"))?;
            }
            "--serve" => serve = true,
            "--frame-dir" => {
                i += 1;
                let v = argv.get(i).ok_or("--frame-dir requires a value")?;
                frame_dir = Some(PathBuf::from(v));
            }
            other if file.is_none() && !other.starts_with("--") => {
                file = Some(PathBuf::from(other));
            }
            other => return Err(format!("unrecognized argument: {other}")),
        }
        i += 1;
    }
    if !serve {
        return Err(format!("--serve is required (there is no window mode any more)\n{USAGE}"));
    }
    let file = file.ok_or("no PDF path given")?;
    let frame_dir = frame_dir.ok_or("--serve requires --frame-dir")?;
    Ok(Args { file, frame_dir })
}

fn main() -> ExitCode {
    log::init();
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if let Some(info) = glide_helper::about::info_for(&argv) {
        print!("{info}");
        return ExitCode::SUCCESS;
    }
    let args = match parse_args(&argv) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("[glide] {e}");
            return ExitCode::from(2);
        }
    };

    log::debug(&format!("opening {}", args.file.display()));
    let engine = match MuPdfDocumentEngine::open(&args.file) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[glide] {e}");
            return ExitCode::from(1);
        }
    };
    log::debug(&format!("pages={}", engine.page_count()));

    let server = Server::new(engine, args.frame_dir);
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    match serve::run(server, std::io::BufReader::new(stdin), &mut stdout) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("[glide] serve error: {e}");
            ExitCode::from(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn serve_with_file_and_frame_dir_parses() {
        let args = parse_args(&argv(&["--serve", "--frame-dir", "/tmp/f", "--file", "a.pdf"])).unwrap();
        assert_eq!(args, Args { file: PathBuf::from("a.pdf"), frame_dir: PathBuf::from("/tmp/f") });
    }

    #[test]
    fn page_flag_is_still_accepted_and_validated() {
        assert!(parse_args(&argv(&["--serve", "--frame-dir", "/f", "--file", "a.pdf", "--page", "3"])).is_ok());
        let err = parse_args(&argv(&["--serve", "--frame-dir", "/f", "--file", "a.pdf", "--page", "x"])).unwrap_err();
        assert!(err.contains("invalid --page value"), "got: {err}");
    }

    #[test]
    fn a_bare_path_is_taken_as_the_file() {
        let args = parse_args(&argv(&["--serve", "--frame-dir", "/f", "a.pdf"])).unwrap();
        assert_eq!(args.file, PathBuf::from("a.pdf"));
    }

    #[test]
    fn serve_is_required() {
        let err = parse_args(&argv(&["--frame-dir", "/tmp/f", "a.pdf"])).unwrap_err();
        assert!(err.contains("--serve is required"), "got: {err}");
        let err = parse_args(&argv(&["a.pdf"])).unwrap_err();
        assert!(err.contains("--serve is required"), "got: {err}");
    }

    #[test]
    fn serve_needs_a_frame_dir() {
        let err = parse_args(&argv(&["--serve", "a.pdf"])).unwrap_err();
        assert!(err.contains("requires --frame-dir"), "got: {err}");
    }

    #[test]
    fn serve_needs_a_file() {
        let err = parse_args(&argv(&["--serve", "--frame-dir", "/f"])).unwrap_err();
        assert!(err.contains("no PDF path"), "got: {err}");
    }

    #[test]
    fn the_old_dock_flags_are_gone() {
        let err = parse_args(&argv(&["--serve", "--frame-dir", "/f", "a.pdf", "--dock-x", "1"])).unwrap_err();
        assert!(err.contains("unrecognized argument"), "got: {err}");
    }

    #[test]
    fn no_args_at_all_is_a_usage_error() {
        let err = parse_args(&argv(&[])).unwrap_err();
        assert!(err.contains("usage:"), "got: {err}");
    }

    #[test]
    fn unrecognized_flag_is_reported() {
        let err = parse_args(&argv(&["--serve", "--frame-dir", "/f", "a.pdf", "--bogus-flag"])).unwrap_err();
        assert!(err.contains("unrecognized argument"), "got: {err}");
    }
}
