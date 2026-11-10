// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

//! Headless "serve" mode: the helper has no window; a host (the Zotero
//! plugin's reader *tab*) drives it over stdin/stdout and shows the pixels
//! itself. See docs/adr/002-in-tab-reader.md.
//!
//! Protocol: newline-delimited JSON, one object per line.
//!
//! stdin (host -> helper):
//!   {"cmd":"viewport","width":W,"height":H,"dpr":2.0}   physical px
//!   {"cmd":"goto","page":N}                              1-indexed
//!   {"cmd":"next"} {"cmd":"prev"}
//!   {"cmd":"zoom","factor":1.15}
//!   {"cmd":"fit","mode":"width"|"page"}
//!   {"cmd":"search","query":"..."}
//!   {"cmd":"search_next","query":"...","backwards":false}
//!   {"cmd":"clear_search"}
//!   {"cmd":"trim"}     free page memory (tab went to background)
//!   {"cmd":"resume"}   re-render (tab shown again)
//!   {"cmd":"quit"}
//!
//! stdout (helper -> host):
//!   {"event":"ready","pageCount":N}
//!   {"event":"frame","seq":S,"path":"...","width":w,"height":h,
//!    "page":P,"pageCount":N,"zoomPct":P,"zoomMode":"width|page|fixed",
//!    "highlights":[[x,y,w,h],...],"search":{"pages":K,"total":T,"index":I}}
//!   {"event":"error","message":"..."}
//!
//! A frame is the whole page as tightly packed opaque RGBA8 in
//! `<frame-dir>/frame-<seq>.rgba`; the host reads it and deletes it. The
//! page can be taller than the viewport -- the host scrolls it natively.
//!
//! Commands that arrive while a render is pending are coalesced: all
//! queued commands are applied first, then one frame is rendered. A
//! mouse-wheel / resize burst therefore costs one render, not one each.
//! stdin EOF (host died) exits, so the helper can never be orphaned.
//!
//! Memory: on macOS launch this with `MallocSpaceEfficient=1` in the
//! environment (the plugin does; libmalloc only reads it at process start).
//! Otherwise the allocator keeps every freed page buffer resident -- measured
//! 2x the steady-state footprint, and a `trim` returning nothing. See
//! scripts/benchmark-serve.py and STATUS.md.

use crate::engine::DocumentEngine;
use crate::frame::write_opaque_rgba;
use crate::log;
use crate::session::ReaderSession;
use crate::state::{ReaderState, ZoomMode};
use serde_json::{Value, json};
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::mpsc;

#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    Viewport { width: u32, height: u32, dpr: f32 },
    Goto(u32),
    Next,
    Prev,
    Zoom(f32),
    Fit(ZoomMode),
    Search(String),
    SearchNext { query: String, backwards: bool },
    ClearSearch,
    Trim,
    Resume,
    Quit,
}

pub fn parse_command(line: &str) -> Result<Command, String> {
    let v: Value = serde_json::from_str(line).map_err(|e| format!("invalid JSON: {e}"))?;
    let cmd = v.get("cmd").and_then(Value::as_str).ok_or("missing \"cmd\"")?;
    let u = |k: &str| -> Result<u32, String> {
        v.get(k)
            .and_then(Value::as_u64)
            .map(|n| n.min(u32::MAX as u64) as u32)
            .ok_or_else(|| format!("{cmd}: missing/invalid \"{k}\""))
    };
    let s = |k: &str| -> Result<String, String> {
        v.get(k)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| format!("{cmd}: missing/invalid \"{k}\""))
    };
    Ok(match cmd {
        "viewport" => Command::Viewport {
            width: u("width")?.max(1),
            height: u("height")?.max(1),
            dpr: v.get("dpr").and_then(Value::as_f64).unwrap_or(1.0).clamp(0.5, 8.0) as f32,
        },
        "goto" => Command::Goto(u("page")?),
        "next" => Command::Next,
        "prev" => Command::Prev,
        "zoom" => Command::Zoom(
            v.get("factor")
                .and_then(Value::as_f64)
                .filter(|f| f.is_finite() && *f > 0.0)
                .ok_or("zoom: missing/invalid \"factor\"")? as f32,
        ),
        "fit" => Command::Fit(match s("mode")?.as_str() {
            "width" => ZoomMode::FitWidth,
            "page" => ZoomMode::FitPage,
            other => return Err(format!("fit: unknown mode {other:?}")),
        }),
        "search" => Command::Search(s("query")?),
        "search_next" => Command::SearchNext {
            query: s("query")?,
            backwards: v.get("backwards").and_then(Value::as_bool).unwrap_or(false),
        },
        "clear_search" => Command::ClearSearch,
        "trim" => Command::Trim,
        "resume" => Command::Resume,
        "quit" => Command::Quit,
        other => return Err(format!("unknown cmd {other:?}")),
    })
}

/// What the main loop should do after a command was applied.
#[derive(Debug, PartialEq)]
pub enum Flow {
    /// State changed -- a (coalesced) frame is needed.
    Render,
    /// State changed in a way that needs no frame.
    Quiet,
    Quit,
}

pub struct Server<E: DocumentEngine> {
    session: ReaderSession<E>,
    viewport: (u32, u32),
    dpr: f32,
    frame_dir: PathBuf,
    seq: u64,
    suspended: bool,
    /// Last frame file written, so an unconsumed one is removed when the
    /// next replaces it (bounded disk use even if the host is slow).
    last_frame: Option<PathBuf>,
}

impl<E: DocumentEngine> Server<E> {
    pub fn new(engine: E, state: ReaderState, frame_dir: PathBuf) -> Self {
        Self {
            // Radius 0: hold only the page being shown (see session.rs).
            session: ReaderSession::with_cache_radius(engine, state, 0),
            viewport: (900, 1150),
            dpr: 1.0,
            frame_dir,
            seq: 0,
            suspended: false,
            last_frame: None,
        }
    }

    pub fn session(&self) -> &ReaderSession<E> {
        &self.session
    }

    pub fn apply(&mut self, cmd: Command) -> Flow {
        let vp = self.viewport;
        match cmd {
            Command::Viewport { width, height, dpr } => {
                self.dpr = dpr;
                if (width, height) != self.viewport {
                    self.viewport = (width, height);
                    self.session.invalidate_scale(self.viewport);
                }
            }
            Command::Goto(n) => self.session.navigate_to(n.saturating_sub(1)),
            Command::Next => self.session.navigate_to(self.session.state.page + 1),
            Command::Prev => self.session.navigate_to(self.session.state.page.saturating_sub(1)),
            Command::Zoom(f) => self.session.zoom_by(f, vp),
            Command::Fit(mode) => self.session.set_zoom_mode(mode, vp),
            Command::Search(q) => self.session.run_search(&q),
            Command::SearchNext { query, backwards } => self.session.search_next(&query, backwards),
            Command::ClearSearch => self.session.clear_search(),
            Command::Trim => {
                self.suspended = true;
                self.session.trim();
                return Flow::Quiet;
            }
            Command::Resume => self.suspended = false,
            Command::Quit => return Flow::Quit,
        }
        if self.suspended { Flow::Quiet } else { Flow::Render }
    }

    fn zoom_mode_name(&self) -> &'static str {
        match self.session.state.zoom_mode {
            ZoomMode::FitWidth => "width",
            ZoomMode::FitPage => "page",
            ZoomMode::Fixed => "fixed",
        }
    }

    /// Renders the current page, writes the frame file, and emits the
    /// `frame` event. Render failures are reported as an `error` event, not
    /// a crash.
    pub fn emit_frame(&mut self, out: &mut impl Write) -> io::Result<()> {
        let scale = self.session.effective_scale(self.viewport);
        let Some(rendered) = self.session.prepare_frame(self.viewport) else {
            return emit(out, json!({"event":"error","message":"render failed"}));
        };
        let (w, h) = (rendered.width, rendered.height);

        self.seq += 1;
        let path = self.frame_dir.join(format!("frame-{}.rgba", self.seq));
        let tmp = self.frame_dir.join(format!("frame-{}.tmp", self.seq));
        // Streamed in small chunks: no second full-page buffer.
        write_opaque_rgba(rendered, io::BufWriter::new(fs::File::create(&tmp)?))?;
        fs::rename(&tmp, &path)?; // atomic: the host never sees a half-written frame
        if let Some(prev) = self.last_frame.replace(path.clone()) {
            let _ = fs::remove_file(prev); // no-op if the host already consumed it
        }

        let page = self.session.state.page;
        let highlights: Vec<[f32; 4]> = self
            .session
            .search_hits
            .iter()
            .filter(|hit| hit.page == page)
            .flat_map(|hit| hit.quads.iter())
            .map(|q| {
                let xs = [q.ul.0, q.ur.0, q.ll.0, q.lr.0];
                let ys = [q.ul.1, q.ur.1, q.ll.1, q.lr.1];
                let min = |a: &[f32; 4]| a.iter().cloned().fold(f32::INFINITY, f32::min);
                let max = |a: &[f32; 4]| a.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
                [min(&xs) * scale, min(&ys) * scale, (max(&xs) - min(&xs)) * scale, (max(&ys) - min(&ys)) * scale]
            })
            .collect();
        let hits = &self.session.search_hits;
        let total: usize = hits.iter().map(|h| h.quads.len()).sum();

        log::debug(&format!("frame seq={} page={page} {w}x{h}", self.seq));
        emit(
            out,
            json!({
                "event": "frame",
                "seq": self.seq,
                "path": path.to_string_lossy(),
                "width": w,
                "height": h,
                "page": page + 1,
                "pageCount": self.session.engine.page_count(),
                "zoomPct": (scale / self.dpr * 100.0).round() as i64,
                "zoomMode": self.zoom_mode_name(),
                "highlights": highlights,
                "search": { "pages": hits.len(), "total": total, "index": self.session.search_hit_index },
            }),
        )
    }

    pub fn cleanup(&mut self) {
        if let Some(p) = self.last_frame.take() {
            let _ = fs::remove_file(p);
        }
    }
}

fn emit(out: &mut impl Write, v: Value) -> io::Result<()> {
    writeln!(out, "{v}")?;
    out.flush()
}

/// Runs the protocol loop until `quit` or stdin EOF. A reader thread feeds a
/// channel so queued commands can be drained and coalesced before rendering.
pub fn run<E: DocumentEngine, R: BufRead + Send + 'static, W: Write>(
    mut server: Server<E>,
    input: R,
    out: &mut W,
) -> io::Result<()> {
    fs::create_dir_all(&server.frame_dir)?;
    emit(out, json!({"event":"ready","pageCount": server.session.engine.page_count()}))?;

    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in input.lines() {
            match line {
                Ok(l) if !l.trim().is_empty() => {
                    if tx.send(l).is_err() {
                        break;
                    }
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        // dropping tx == EOF
    });

    let result = (|| -> io::Result<()> {
        'outer: loop {
            let Ok(first) = rx.recv() else { break }; // EOF: host went away
            let mut need_frame = false;
            let mut pending = vec![first];
            while let Ok(more) = rx.try_recv() {
                pending.push(more);
            }
            for line in pending {
                match parse_command(&line) {
                    Ok(cmd) => match server.apply(cmd) {
                        Flow::Render => need_frame = true,
                        Flow::Quiet => {}
                        Flow::Quit => break 'outer,
                    },
                    Err(message) => emit(out, json!({"event":"error","message":message}))?,
                }
            }
            if need_frame {
                server.emit_frame(out)?;
            }
        }
        Ok(())
    })();
    server.cleanup();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::mupdf_engine::MuPdfDocumentEngine;
    use crate::session::ZOOM_STEP;
    use std::io::Cursor;
    use std::path::Path;

    fn fixture() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures").join("sample.pdf")
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fr-serve-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    fn server(dir: &Path) -> Server<MuPdfDocumentEngine> {
        let engine = MuPdfDocumentEngine::open(&fixture()).unwrap();
        let state = ReaderState::new(fixture(), engine.page_count());
        Server::new(engine, state, dir.to_path_buf())
    }

    fn events(out: &[u8]) -> Vec<Value> {
        String::from_utf8_lossy(out)
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[test]
    fn parses_every_command() {
        assert_eq!(
            parse_command(r#"{"cmd":"viewport","width":800,"height":600,"dpr":2}"#).unwrap(),
            Command::Viewport { width: 800, height: 600, dpr: 2.0 }
        );
        assert_eq!(parse_command(r#"{"cmd":"goto","page":3}"#).unwrap(), Command::Goto(3));
        assert_eq!(parse_command(r#"{"cmd":"next"}"#).unwrap(), Command::Next);
        assert_eq!(parse_command(r#"{"cmd":"prev"}"#).unwrap(), Command::Prev);
        assert_eq!(parse_command(r#"{"cmd":"zoom","factor":1.5}"#).unwrap(), Command::Zoom(1.5));
        assert_eq!(
            parse_command(r#"{"cmd":"fit","mode":"page"}"#).unwrap(),
            Command::Fit(ZoomMode::FitPage)
        );
        assert_eq!(parse_command(r#"{"cmd":"search","query":"fox"}"#).unwrap(), Command::Search("fox".into()));
        assert_eq!(
            parse_command(r#"{"cmd":"search_next","query":"fox","backwards":true}"#).unwrap(),
            Command::SearchNext { query: "fox".into(), backwards: true }
        );
        assert_eq!(parse_command(r#"{"cmd":"trim"}"#).unwrap(), Command::Trim);
        assert_eq!(parse_command(r#"{"cmd":"resume"}"#).unwrap(), Command::Resume);
        assert_eq!(parse_command(r#"{"cmd":"quit"}"#).unwrap(), Command::Quit);
    }

    #[test]
    fn rejects_malformed_commands_with_a_message() {
        for bad in [
            "not json",
            r#"{"nocmd":1}"#,
            r#"{"cmd":"bogus"}"#,
            r#"{"cmd":"goto"}"#,
            r#"{"cmd":"zoom","factor":-1}"#,
            r#"{"cmd":"fit","mode":"sideways"}"#,
        ] {
            assert!(parse_command(bad).is_err(), "should reject {bad}");
        }
    }

    #[test]
    fn viewport_is_clamped_to_at_least_one_pixel() {
        assert_eq!(
            parse_command(r#"{"cmd":"viewport","width":0,"height":0}"#).unwrap(),
            Command::Viewport { width: 1, height: 1, dpr: 1.0 }
        );
    }

    #[test]
    fn frame_is_a_full_opaque_rgba_page_matching_the_event() {
        let dir = temp_dir("frame");
        fs::create_dir_all(&dir).unwrap();
        let mut s = server(&dir);
        s.apply(Command::Viewport { width: 600, height: 800, dpr: 1.0 });
        let mut out = Vec::new();
        s.emit_frame(&mut out).unwrap();
        let ev = &events(&out)[0];
        assert_eq!(ev["event"], "frame");
        let (w, h) = (ev["width"].as_u64().unwrap(), ev["height"].as_u64().unwrap());
        assert_eq!(w, 600, "fit-width => frame as wide as the viewport");
        let bytes = fs::read(ev["path"].as_str().unwrap()).unwrap();
        assert_eq!(bytes.len() as u64, w * h * 4);
        assert!(bytes.chunks_exact(4).all(|p| p[3] == 255), "all pixels opaque");
        // top-left corner of a page margin must be white, not black (regression: STATUS.md)
        assert_eq!(&bytes[0..4], &[255, 255, 255, 255]);
        assert_eq!(ev["page"], 1);
        assert_eq!(ev["zoomMode"], "width");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn navigation_clamps_and_reports_one_indexed_pages() {
        let dir = temp_dir("nav");
        fs::create_dir_all(&dir).unwrap();
        let mut s = server(&dir);
        s.apply(Command::Goto(2));
        assert_eq!(s.session().state.page, 1);
        s.apply(Command::Goto(9999));
        assert_eq!(s.session().state.page, s.session().state.page_count - 1);
        s.apply(Command::Prev);
        s.apply(Command::Goto(0)); // 0 saturates to first page, never underflows
        assert_eq!(s.session().state.page, 0);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn zoom_switches_to_fixed_and_fit_restores() {
        let dir = temp_dir("zoom");
        fs::create_dir_all(&dir).unwrap();
        let mut s = server(&dir);
        s.apply(Command::Zoom(ZOOM_STEP));
        assert_eq!(s.session().state.zoom_mode, ZoomMode::Fixed);
        s.apply(Command::Fit(ZoomMode::FitWidth));
        assert_eq!(s.session().state.zoom_mode, ZoomMode::FitWidth);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn search_reports_highlights_in_frame_pixels() {
        let dir = temp_dir("search");
        fs::create_dir_all(&dir).unwrap();
        let mut s = server(&dir);
        s.apply(Command::Viewport { width: 600, height: 800, dpr: 1.0 });
        s.apply(Command::Search("brown fox".into()));
        let mut out = Vec::new();
        s.emit_frame(&mut out).unwrap();
        let ev = &events(&out)[0];
        let hl = ev["highlights"].as_array().unwrap();
        assert!(!hl.is_empty(), "frame for the hit page must carry highlights");
        let r = hl[0].as_array().unwrap();
        let (x, y, w, h) = (r[0].as_f64().unwrap(), r[1].as_f64().unwrap(), r[2].as_f64().unwrap(), r[3].as_f64().unwrap());
        assert!(x >= 0.0 && y >= 0.0 && w > 0.0 && h > 0.0);
        assert!(x + w <= ev["width"].as_f64().unwrap() && y + h <= ev["height"].as_f64().unwrap());
        assert!(ev["search"]["total"].as_u64().unwrap() >= 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn trim_frees_memory_and_suppresses_frames_until_resume() {
        let dir = temp_dir("trim");
        fs::create_dir_all(&dir).unwrap();
        let mut s = server(&dir);
        let mut out = Vec::new();
        s.emit_frame(&mut out).unwrap();
        assert!(s.session().cache_len() > 0);
        assert_eq!(s.apply(Command::Trim), Flow::Quiet);
        assert_eq!(s.session().cache_len(), 0, "trim must drop cached renders");
        assert_eq!(s.apply(Command::Next), Flow::Quiet, "no rendering while backgrounded");
        assert_eq!(s.apply(Command::Resume), Flow::Render);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_new_frame_removes_the_previous_unconsumed_one() {
        let dir = temp_dir("gc");
        fs::create_dir_all(&dir).unwrap();
        let mut s = server(&dir);
        let mut out = Vec::new();
        s.emit_frame(&mut out).unwrap();
        s.apply(Command::Next);
        s.emit_frame(&mut out).unwrap();
        let n = fs::read_dir(&dir).unwrap().count();
        assert_eq!(n, 1, "only the latest frame file may remain on disk");
        s.cleanup();
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn run_coalesces_a_burst_into_one_frame_and_quits_cleanly() {
        let dir = temp_dir("run");
        let s = server(&dir);
        let input = "{\"cmd\":\"viewport\",\"width\":500,\"height\":700}\n{\"cmd\":\"next\"}\n{\"cmd\":\"next\"}\n{\"cmd\":\"bogus\"}\n{\"cmd\":\"quit\"}\n";
        let mut out = Vec::new();
        run(s, Cursor::new(input.to_string()), &mut out).unwrap();
        let evs = events(&out);
        assert_eq!(evs[0]["event"], "ready");
        let frames: Vec<_> = evs.iter().filter(|e| e["event"] == "frame").collect();
        // quit arrives in the same drained batch, so it ends the loop before rendering;
        // the bogus command is reported, not fatal.
        assert!(frames.len() <= 1);
        assert!(evs.iter().any(|e| e["event"] == "error"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn eof_on_stdin_ends_the_loop() {
        let dir = temp_dir("eof");
        let s = server(&dir);
        let mut out = Vec::new();
        run(s, Cursor::new("{\"cmd\":\"viewport\",\"width\":400,\"height\":400}\n".to_string()), &mut out).unwrap();
        let evs = events(&out);
        assert!(evs.iter().any(|e| e["event"] == "frame"), "command before EOF is still served");
        let _ = fs::remove_dir_all(&dir);
    }
}
