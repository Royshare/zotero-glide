// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

use fast_reader_helper::app::{App, DockGeometry};
use fast_reader_helper::engine::mupdf_engine::MuPdfDocumentEngine;
use fast_reader_helper::engine::DocumentEngine;
use fast_reader_helper::log;
use fast_reader_helper::serve::{self, Server};
use fast_reader_helper::state::ReaderState;
use std::path::PathBuf;
use std::process::ExitCode;
use winit::event_loop::EventLoop;

#[derive(Debug, PartialEq)]
struct Args {
    file: PathBuf,
    page: u32,
    dock: Option<DockGeometry>,
    /// `--serve --frame-dir DIR`: headless mode for the in-tab reader (see serve.rs).
    serve_frame_dir: Option<PathBuf>,
}

fn parse_args(argv: &[String]) -> Result<Args, String> {
    if argv.is_empty() {
        return Err("usage: fast-reader-helper <pdf-path> [--page N] [--dock-x X --dock-y Y --dock-height H]\n   or: fast-reader-helper --serve --frame-dir <dir> --file <pdf-path> [--page N]   (headless, JSON over stdio)\n   or: fast-reader-helper --file <pdf-path> [--page N] [--dock-x X --dock-y Y --dock-height H]".into());
    }
    let mut file: Option<PathBuf> = None;
    let mut page: u32 = 1;
    let mut dock_x: Option<i32> = None;
    let mut dock_y: Option<i32> = None;
    let mut dock_height: Option<u32> = None;
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
            "--page" => {
                i += 1;
                let v = argv.get(i).ok_or("--page requires a value")?;
                page = v.parse::<u32>().map_err(|_| format!("invalid --page value: {v}"))?;
            }
            // Optional "docked" placement next to Zotero's own window --
            // see docs/adr and STATUS.md for why this is a real process
            // window positioned to look integrated, not a literal embedded
            // tab. All three (or none) must be given; the helper still
            // works standalone with no dock args at all, same as always.
            "--dock-x" => {
                i += 1;
                let v = argv.get(i).ok_or("--dock-x requires a value")?;
                dock_x = Some(v.parse::<i32>().map_err(|_| format!("invalid --dock-x value: {v}"))?);
            }
            "--dock-y" => {
                i += 1;
                let v = argv.get(i).ok_or("--dock-y requires a value")?;
                dock_y = Some(v.parse::<i32>().map_err(|_| format!("invalid --dock-y value: {v}"))?);
            }
            "--dock-height" => {
                i += 1;
                let v = argv.get(i).ok_or("--dock-height requires a value")?;
                dock_height =
                    Some(v.parse::<u32>().map_err(|_| format!("invalid --dock-height value: {v}"))?);
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
    let file = file.ok_or("no PDF path given")?;
    let dock = match (dock_x, dock_y, dock_height) {
        (Some(x), Some(y), Some(height)) => Some(DockGeometry { x, y, height }),
        (None, None, None) => None,
        _ => return Err("--dock-x, --dock-y, and --dock-height must all be given together".into()),
    };
    let serve_frame_dir = match (serve, frame_dir) {
        (true, Some(d)) => Some(d),
        (true, None) => return Err("--serve requires --frame-dir".into()),
        (false, Some(_)) => return Err("--frame-dir only makes sense with --serve".into()),
        (false, None) => None,
    };
    if serve_frame_dir.is_some() && dock.is_some() {
        return Err("--dock-* has no meaning with --serve (there is no window)".into());
    }
    Ok(Args {
        file,
        page: page.saturating_sub(1),
        dock,
        serve_frame_dir,
    })
}

fn main() -> ExitCode {
    log::init();
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if let Some(info) = fast_reader_helper::about::info_for(&argv) {
        print!("{info}");
        return ExitCode::SUCCESS;
    }
    let args = match parse_args(&argv) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("[fast-reader] {e}");
            return ExitCode::from(2);
        }
    };

    log::debug(&format!("opening {}", args.file.display()));
    let engine = match MuPdfDocumentEngine::open(&args.file) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[fast-reader] {e}");
            return ExitCode::from(1);
        }
    };
    log::debug(&format!("pages={}", engine.page_count()));

    if let Some(frame_dir) = args.serve_frame_dir {
        let server = Server::new(engine, frame_dir);
        let stdin = std::io::stdin();
        let mut stdout = std::io::stdout().lock();
        return match serve::run(server, std::io::BufReader::new(stdin), &mut stdout) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("[fast-reader] serve error: {e}");
                ExitCode::from(1)
            }
        };
    }

    let mut state = ReaderState::new(args.file.clone(), engine.page_count());
    state.goto_page(args.page);

    let event_loop = match EventLoop::new() {
        Ok(el) => el,
        Err(e) => {
            eprintln!("[fast-reader] failed to create event loop (unsupported platform/display?): {e}");
            return ExitCode::from(3);
        }
    };
    let mut app = App::new(engine, state, args.dock);
    if let Err(e) = event_loop.run_app(&mut app) {
        eprintln!("[fast-reader] event loop error: {e}");
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn bare_path_with_no_dock_args_works_as_before() {
        let args = parse_args(&argv(&["some.pdf"])).unwrap();
        assert_eq!(args.file, PathBuf::from("some.pdf"));
        assert_eq!(args.page, 0);
        assert_eq!(args.dock, None);
    }

    #[test]
    fn file_and_page_flags_still_work_with_no_dock_args() {
        let args = parse_args(&argv(&["--file", "some.pdf", "--page", "3"])).unwrap();
        assert_eq!(args.file, PathBuf::from("some.pdf"));
        assert_eq!(args.page, 2); // 1-indexed input, 0-indexed internally
        assert_eq!(args.dock, None);
    }

    #[test]
    fn all_three_dock_args_together_produce_dock_geometry() {
        let args = parse_args(&argv(&[
            "some.pdf",
            "--dock-x",
            "1200",
            "--dock-y",
            "40",
            "--dock-height",
            "900",
        ]))
        .unwrap();
        assert_eq!(args.dock, Some(DockGeometry { x: 1200, y: 40, height: 900 }));
    }

    #[test]
    fn dock_x_can_be_negative_for_multi_monitor_setups() {
        let args = parse_args(&argv(&["some.pdf", "--dock-x", "-500", "--dock-y", "0", "--dock-height", "800"]))
            .unwrap();
        assert_eq!(args.dock, Some(DockGeometry { x: -500, y: 0, height: 800 }));
    }

    #[test]
    fn partial_dock_args_is_an_error_not_a_silent_partial_dock() {
        let err = parse_args(&argv(&["some.pdf", "--dock-x", "100", "--dock-y", "0"])).unwrap_err();
        assert!(err.contains("must all be given together"), "got: {err}");
    }

    #[test]
    fn a_single_dock_arg_alone_is_also_an_error() {
        let err = parse_args(&argv(&["some.pdf", "--dock-height", "800"])).unwrap_err();
        assert!(err.contains("must all be given together"), "got: {err}");
    }

    #[test]
    fn invalid_dock_x_value_is_reported_not_panicked() {
        let err = parse_args(&argv(&[
            "some.pdf",
            "--dock-x",
            "not-a-number",
            "--dock-y",
            "0",
            "--dock-height",
            "800",
        ]))
        .unwrap_err();
        assert!(err.contains("invalid --dock-x value"), "got: {err}");
    }

    #[test]
    fn serve_mode_needs_a_frame_dir_and_vice_versa() {
        let args = parse_args(&argv(&["--serve", "--frame-dir", "/tmp/f", "--file", "a.pdf"])).unwrap();
        assert_eq!(args.serve_frame_dir, Some(PathBuf::from("/tmp/f")));
        assert!(parse_args(&argv(&["--serve", "a.pdf"])).unwrap_err().contains("requires --frame-dir"));
        assert!(parse_args(&argv(&["--frame-dir", "/tmp/f", "a.pdf"])).unwrap_err().contains("only makes sense"));
    }

    #[test]
    fn serve_mode_rejects_dock_args() {
        let err = parse_args(&argv(&[
            "--serve", "--frame-dir", "/tmp/f", "a.pdf", "--dock-x", "1", "--dock-y", "2", "--dock-height", "3",
        ]))
        .unwrap_err();
        assert!(err.contains("no meaning with --serve"), "got: {err}");
    }

    #[test]
    fn no_args_at_all_is_a_usage_error() {
        let err = parse_args(&argv(&[])).unwrap_err();
        assert!(err.contains("usage:"), "got: {err}");
    }

    #[test]
    fn unrecognized_flag_is_reported() {
        let err = parse_args(&argv(&["some.pdf", "--bogus-flag"])).unwrap_err();
        assert!(err.contains("unrecognized argument"), "got: {err}");
    }
}
