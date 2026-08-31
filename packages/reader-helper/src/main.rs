use fast_reader_helper::app::App;
use fast_reader_helper::engine::mupdf_engine::MuPdfDocumentEngine;
use fast_reader_helper::engine::DocumentEngine;
use fast_reader_helper::log;
use fast_reader_helper::state::ReaderState;
use std::path::PathBuf;
use std::process::ExitCode;
use winit::event_loop::EventLoop;

struct Args {
    file: PathBuf,
    page: u32,
}

fn parse_args() -> Result<Args, String> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.is_empty() {
        return Err("usage: fast-reader-helper <pdf-path> [--page N]\n   or: fast-reader-helper --file <pdf-path> [--page N]".into());
    }
    let mut file: Option<PathBuf> = None;
    let mut page: u32 = 1;
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
            other if file.is_none() && !other.starts_with("--") => {
                file = Some(PathBuf::from(other));
            }
            other => return Err(format!("unrecognized argument: {other}")),
        }
        i += 1;
    }
    let file = file.ok_or("no PDF path given")?;
    Ok(Args {
        file,
        page: page.saturating_sub(1),
    })
}

fn main() -> ExitCode {
    log::init();
    let args = match parse_args() {
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

    let mut state = ReaderState::new(args.file.clone(), engine.page_count());
    state.goto_page(args.page);

    let event_loop = match EventLoop::new() {
        Ok(el) => el,
        Err(e) => {
            eprintln!("[fast-reader] failed to create event loop (unsupported platform/display?): {e}");
            return ExitCode::from(3);
        }
    };
    let mut app = App::new(engine, state);
    if let Err(e) = event_loop.run_app(&mut app) {
        eprintln!("[fast-reader] event loop error: {e}");
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}
