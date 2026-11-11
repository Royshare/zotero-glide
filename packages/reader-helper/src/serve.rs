// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

//! Headless "serve" mode: the helper has no window; a host (the Zotero plugin's reader *tab*) drives it
//! over stdin/stdout and does all layout, scrolling, selection and UI itself. See docs/adr/002 and 003.
//!
//! The helper is deliberately **stateless per request**: the host decides which pages to show and at what
//! scale (continuous scrolling, zoom, rotation, crop), asks for exactly those pages, and keeps only what is
//! visible. Newline-delimited JSON, one object per line.
//!
//! stdin (host -> helper):
//!   {"cmd":"render","id":N,"page":P,"scale":S,"rotate":R,"clip":[x,y,w,h]|null}
//!       P is 0-indexed; S pixels per point; R 0/90/180/270 clockwise; clip in page space, pre-rotation.
//!   {"cmd":"text","page":P}          line boxes + per-character x boundaries (page space)
//!   {"cmd":"search","query":"..."}    every hit in the document, as rectangles per page
//!   {"cmd":"outline"}                 the document outline
//!   {"cmd":"links","page":P}          internal and external links on a page
//!   {"cmd":"annots","page":P}         annotations stored in the PDF file on a page (read-only)
//!   {"cmd":"images","page":P}         rectangles of the raster images on a page (dark mode leaves them as they are)
//!   {"cmd":"margins"}                 uniform white-margin insets, sampled over the document
//!   {"cmd":"export","path":"...","annotations":[{"page","kind","rects","color","contents"}]}
//!   {"cmd":"trim"}                    drop page memory and the open document (tab went to background)
//!   {"cmd":"quit"}
//!
//! stdout (helper -> host):
//!   {"event":"ready","pageCount":N,"pages":[{"w","h","m":[a,b,c,d,e,f]}]}   m: PDF space -> page space
//!   {"event":"frame","id","page","scale","width","height","path"}          raw opaque RGBA8 in a file
//!   {"event":"skipped","id"}          a render superseded by a later one for the same page in the same batch
//!   {"event":"text",...} {"event":"search",...} {"event":"outline",...} {"event":"links",...} {"event":"images","page","rects":[[x,y,w,h]]} {"event":"annots","page","items":[{"k","r","c","t","a","x"}]}
//!   {"event":"margins","insets":[l,t,r,b]|null} {"event":"exported","path","count"}
//!   {"event":"error","message":"...","cmd":"..."}
//!
//! Frames are files, not pipe data: a retina page is 10-25 MB. The host reads then deletes them; the helper
//! also deletes frames older than the newest `KEEP_FRAMES` so a slow host cannot fill the disk.
//!
//! Commands that arrive together are applied as one batch: of several `render`s for the same page only the
//! last is executed (the earlier ids get `skipped`). stdin EOF exits, so the helper can never be orphaned.
//!
//! Memory: on macOS launch with `MallocSpaceEfficient=1` and on Linux with `MALLOC_MMAP_THRESHOLD_=1048576`
//! (the plugin does); otherwise the allocator keeps freed page buffers resident. See scripts/benchmark-serve.py.

use crate::engine::{DocumentEngine, ExportAnnotation, ExportKind, OutlineItem};
use crate::frame::write_opaque_rgba;
use crate::log;
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::mpsc;

const KEEP_FRAMES: usize = 12;
/// Hard ceiling on one frame (pixels), whatever the host asks for: 40M px = 160 MB of RGBA. The host stays
/// well under this (it caps at 16M); this protects memory if a client asks for an absurd scale.
const MAX_FRAME_PIXELS: f32 = 40_000_000.0;
const MAX_SEARCH_RECTS: usize = 20_000;
const MARGIN_SAMPLE_PAGES: u32 = 24;
const MARGIN_PADDING_PT: f32 = 6.0;

#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    Render { id: u64, page: u32, scale: f32, rotate: u32, clip: Option<[f32; 4]> },
    Text(u32),
    Search(String),
    Outline,
    Links(u32),
    Images(u32),
    Annots(u32),
    Margins,
    Export { path: PathBuf, annotations: Vec<ExportAnnotation> },
    Trim,
    Quit,
}

fn f4(v: &Value) -> Option<[f32; 4]> {
    let a = v.as_array()?;
    if a.len() != 4 {
        return None;
    }
    let mut out = [0.0; 4];
    for (i, x) in a.iter().enumerate() {
        let n = x.as_f64()?;
        if !n.is_finite() {
            return None;
        }
        out[i] = n as f32;
    }
    Some(out)
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
        v.get(k).and_then(Value::as_str).map(str::to_string).ok_or_else(|| format!("{cmd}: missing/invalid \"{k}\""))
    };
    Ok(match cmd {
        "render" => {
            let scale = v
                .get("scale")
                .and_then(Value::as_f64)
                .filter(|s| s.is_finite() && *s > 0.0)
                .ok_or("render: missing/invalid \"scale\"")?
                .clamp(0.05, 16.0) as f32;
            let rotate = v.get("rotate").and_then(Value::as_u64).unwrap_or(0) as u32;
            if rotate % 90 != 0 {
                return Err(format!("render: rotate must be a multiple of 90, got {rotate}"));
            }
            let clip = match v.get("clip") {
                None | Some(Value::Null) => None,
                Some(c) => Some(f4(c).ok_or("render: \"clip\" must be [x, y, w, h]")?),
            };
            Command::Render { id: v.get("id").and_then(Value::as_u64).unwrap_or(0), page: u("page")?, scale, rotate: rotate % 360, clip }
        }
        "text" => Command::Text(u("page")?),
        "search" => Command::Search(s("query")?),
        "outline" => Command::Outline,
        "links" => Command::Links(u("page")?),
        "images" => Command::Images(u("page")?),
        "annots" => Command::Annots(u("page")?),
        "margins" => Command::Margins,
        "export" => {
            let mut annotations = Vec::new();
            for a in v.get("annotations").and_then(Value::as_array).ok_or("export: missing \"annotations\"")? {
                let kind = match a.get("kind").and_then(Value::as_str) {
                    Some("highlight") => ExportKind::Highlight,
                    Some("underline") => ExportKind::Underline,
                    Some("note") => ExportKind::Note,
                    other => return Err(format!("export: unknown annotation kind {other:?}")),
                };
                let rects = a
                    .get("rects")
                    .and_then(Value::as_array)
                    .ok_or("export: annotation missing \"rects\"")?
                    .iter()
                    .map(|r| f4(r).ok_or("export: bad rect"))
                    .collect::<Result<Vec<_>, _>>()?;
                let c = a.get("color").and_then(Value::as_array).map(|c| c.iter().filter_map(Value::as_f64).collect::<Vec<_>>());
                let color = match c.as_deref() {
                    Some([r, g, b]) => [*r as f32, *g as f32, *b as f32],
                    _ => [1.0, 0.83, 0.0],
                };
                annotations.push(ExportAnnotation {
                    page: a.get("page").and_then(Value::as_u64).ok_or("export: annotation missing \"page\"")? as u32,
                    kind,
                    rects,
                    color,
                    contents: a.get("contents").and_then(Value::as_str).unwrap_or("").to_string(),
                });
            }
            Command::Export { path: PathBuf::from(s("path")?), annotations }
        }
        "trim" => Command::Trim,
        "quit" => Command::Quit,
        other => return Err(format!("unknown cmd {other:?}")),
    })
}

/// Uniform insets `[l, t, r, b]` (points) to crop from every page, from the ink boxes of sampled pages.
/// Pages with no ink are ignored; the insets are the *smallest* margins seen, so nothing that is drawn on
/// any sampled page is ever cut, minus a small padding. Returns None if every sampled page is blank or the
/// crop would remove less than 2 pt per side.
pub fn margins_from_boxes(boxes: &[(Option<[f32; 4]>, (f32, f32))]) -> Option<[f32; 4]> {
    let mut ins = [f32::MAX; 4];
    let mut any = false;
    for (b, (w, h)) in boxes {
        let Some([x0, y0, x1, y1]) = b else { continue };
        any = true;
        ins[0] = ins[0].min(*x0);
        ins[1] = ins[1].min(*y0);
        ins[2] = ins[2].min(w - x1);
        ins[3] = ins[3].min(h - y1);
    }
    if !any {
        return None;
    }
    let out = ins.map(|v| (v - MARGIN_PADDING_PT).max(0.0));
    if out.iter().all(|v| *v < 2.0) { None } else { Some(out) }
}

pub struct Server<E: DocumentEngine> {
    engine: E,
    frame_dir: PathBuf,
    seq: u64,
    written: VecDeque<PathBuf>,
}

impl<E: DocumentEngine> Server<E> {
    pub fn new(engine: E, frame_dir: PathBuf) -> Self {
        Self { engine, frame_dir, seq: 0, written: VecDeque::new() }
    }

    pub fn engine(&self) -> &E {
        &self.engine
    }

    fn ready_event(&self) -> Value {
        let pages: Vec<Value> = match self.engine.geometries() {
            Ok(g) => g.iter().map(|p| json!({"w": p.width, "h": p.height, "m": p.matrix})).collect(),
            Err(e) => {
                log::debug(&format!("geometries failed: {e}"));
                (0..self.engine.page_count()).map(|i| {
                    let s = self.engine.page_size(i).unwrap_or(crate::engine::PageSize { width: 612.0, height: 792.0 });
                    json!({"w": s.width, "h": s.height, "m": [1.0, 0.0, 0.0, -1.0, 0.0, s.height]})
                }).collect()
            }
        };
        json!({"event": "ready", "pageCount": self.engine.page_count(), "pages": pages})
    }

    fn render(&mut self, id: u64, page: u32, scale: f32, rotate: u32, clip: Option<[f32; 4]>) -> Result<Value, String> {
        let scale = self.capped_scale(page, scale);
        let r = self.engine.render_view(page, scale, rotate, clip).map_err(|e| e.to_string())?;
        self.seq += 1;
        let path = self.frame_dir.join(format!("frame-{}.rgba", self.seq));
        let tmp = self.frame_dir.join(format!("frame-{}.tmp", self.seq));
        write_opaque_rgba(&r, io::BufWriter::new(fs::File::create(&tmp).map_err(|e| e.to_string())?)).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &path).map_err(|e| e.to_string())?; // atomic: the host never sees a half-written frame
        self.written.push_back(path.clone());
        while self.written.len() > KEEP_FRAMES {
            if let Some(old) = self.written.pop_front() {
                let _ = fs::remove_file(old); // already consumed by the host: no-op
            }
        }
        log::debug(&format!("frame id={id} page={page} {}x{}", r.width, r.height));
        Ok(json!({"event": "frame", "id": id, "page": page, "scale": scale, "width": r.width, "height": r.height, "path": path.to_string_lossy()}))
    }

    /// Lowers `scale` so the full-page render stays within `MAX_FRAME_PIXELS`.
    fn capped_scale(&self, page: u32, scale: f32) -> f32 {
        match self.engine.page_size(page) {
            Ok(s) if s.width * s.height * scale * scale > MAX_FRAME_PIXELS => (MAX_FRAME_PIXELS / (s.width * s.height)).sqrt(),
            _ => scale,
        }
    }

    fn outline_json(items: &[OutlineItem]) -> Value {
        Value::Array(items.iter().map(|i| json!({"t": i.title, "p": i.page, "u": i.uri, "c": Self::outline_json(&i.children)})).collect())
    }

    fn margins(&mut self) -> Value {
        let n = self.engine.page_count();
        let step = (n / MARGIN_SAMPLE_PAGES).max(1);
        let mut boxes = Vec::new();
        let mut p = 0;
        while p < n && boxes.len() < MARGIN_SAMPLE_PAGES as usize {
            let size = self.engine.page_size(p).map(|s| (s.width, s.height)).unwrap_or((612.0, 792.0));
            boxes.push((self.engine.content_bbox(p).ok().flatten(), size));
            p += step;
        }
        json!({"event": "margins", "insets": margins_from_boxes(&boxes)})
    }

    /// Runs one command, returning the events to emit and whether to quit.
    pub fn handle(&mut self, cmd: Command) -> (Vec<Value>, bool) {
        let err = |name: &str, m: String| json!({"event": "error", "cmd": name, "message": m});
        match cmd {
            Command::Render { id, page, scale, rotate, clip } => match self.render(id, page, scale, rotate, clip) {
                Ok(v) => (vec![v], false),
                Err(m) => (vec![err("render", format!("page {page}: {m}")), json!({"event": "skipped", "id": id})], false),
            },
            Command::Text(page) => match self.engine.page_text(page) {
                Ok(t) => {
                    let lines: Vec<Value> = t.lines.iter().map(|l| json!({"b": l.bbox, "t": l.text, "x": l.xs})).collect();
                    (vec![json!({"event": "text", "page": page, "lines": lines})], false)
                }
                Err(e) => (vec![err("text", e.to_string())], false),
            },
            Command::Search(q) => match self.engine.search(&q) {
                Ok(hits) => {
                    let mut total = 0usize;
                    let mut truncated = false;
                    let mut out = Vec::new();
                    for h in &hits {
                        if total >= MAX_SEARCH_RECTS {
                            truncated = true;
                            break;
                        }
                        let rects: Vec<[f32; 4]> = h.quads.iter().map(|q| {
                            let xs = [q.ul.0, q.ur.0, q.ll.0, q.lr.0];
                            let ys = [q.ul.1, q.ur.1, q.ll.1, q.lr.1];
                            let (x0, x1) = (xs.iter().cloned().fold(f32::MAX, f32::min), xs.iter().cloned().fold(f32::MIN, f32::max));
                            let (y0, y1) = (ys.iter().cloned().fold(f32::MAX, f32::min), ys.iter().cloned().fold(f32::MIN, f32::max));
                            [x0, y0, x1 - x0, y1 - y0]
                        }).collect();
                        total += rects.len();
                        out.push(json!({"page": h.page, "rects": rects}));
                    }
                    (vec![json!({"event": "search", "query": q, "hits": out, "truncated": truncated})], false)
                }
                Err(e) => (vec![err("search", e.to_string())], false),
            },
            Command::Outline => match self.engine.outline() {
                Ok(items) => (vec![json!({"event": "outline", "items": Self::outline_json(&items)})], false),
                Err(e) => (vec![err("outline", e.to_string())], false),
            },
            Command::Annots(page) => match self.engine.embedded_annotations(page) {
                Ok(list) => {
                    let items: Vec<Value> = list.iter().map(|a| json!({"k": a.kind, "r": a.rects, "c": a.color, "t": a.contents, "a": a.author, "x": a.text})).collect();
                    (vec![json!({"event": "annots", "page": page, "items": items})], false)
                }
                Err(e) => (vec![err("annots", e.to_string())], false),
            },
            Command::Images(page) => match self.engine.image_rects(page) {
                Ok(r) => (vec![json!({"event": "images", "page": page, "rects": r})], false),
                Err(e) => (vec![err("images", e.to_string())], false),
            },
            Command::Links(page) => match self.engine.links(page) {
                Ok(l) => {
                    let links: Vec<Value> = l.iter().map(|x| json!({"r": x.rect, "p": x.page, "u": x.uri})).collect();
                    (vec![json!({"event": "links", "page": page, "links": links})], false)
                }
                Err(e) => (vec![err("links", e.to_string())], false),
            },
            Command::Margins => (vec![self.margins()], false),
            Command::Export { path, annotations } => match self.engine.export_annotated(&path, &annotations) {
                Ok(n) => (vec![json!({"event": "exported", "path": path.to_string_lossy(), "count": n})], false),
                Err(e) => (vec![err("export", e.to_string())], false),
            },
            Command::Trim => {
                self.engine.release_caches();
                (vec![], false)
            }
            Command::Quit => (vec![], true),
        }
    }

    /// Of several renders for the same page within one batch, only the last runs; returns the ids dropped.
    pub fn coalesce(cmds: Vec<Command>) -> (Vec<Command>, Vec<u64>) {
        let mut last: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();
        for (i, c) in cmds.iter().enumerate() {
            if let Command::Render { page, .. } = c {
                last.insert(*page, i);
            }
        }
        let mut skipped = Vec::new();
        let kept = cmds
            .into_iter()
            .enumerate()
            .filter_map(|(i, c)| match &c {
                Command::Render { id, page, .. } if last.get(page) != Some(&i) => {
                    skipped.push(*id);
                    None
                }
                _ => Some(c),
            })
            .collect();
        (kept, skipped)
    }

    pub fn cleanup(&mut self) {
        for p in self.written.drain(..) {
            let _ = fs::remove_file(p);
        }
    }
}

fn emit(out: &mut impl Write, v: &Value) -> io::Result<()> {
    writeln!(out, "{v}")?;
    out.flush()
}

/// Runs the protocol loop until `quit` or stdin EOF. A reader thread feeds a channel so queued commands can
/// be drained and coalesced before rendering.
pub fn run<E: DocumentEngine, R: BufRead + Send + 'static, W: Write>(mut server: Server<E>, input: R, out: &mut W) -> io::Result<()> {
    fs::create_dir_all(&server.frame_dir)?;
    emit(out, &server.ready_event())?;

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
    });

    let result = (|| -> io::Result<()> {
        loop {
            let Ok(first) = rx.recv() else { break }; // EOF: the host went away
            let mut lines = vec![first];
            while let Ok(more) = rx.try_recv() {
                lines.push(more);
            }
            let mut cmds = Vec::new();
            for line in lines {
                match parse_command(&line) {
                    Ok(c) => cmds.push(c),
                    Err(message) => emit(out, &json!({"event": "error", "message": message}))?,
                }
            }
            let (cmds, skipped) = Server::<E>::coalesce(cmds);
            for id in skipped {
                emit(out, &json!({"event": "skipped", "id": id}))?;
            }
            for c in cmds {
                let (events, quit) = server.handle(c);
                for e in events {
                    emit(out, &e)?;
                }
                if quit {
                    return Ok(());
                }
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
    use std::io::Cursor;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fr-serve-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn server(tag: &str) -> (Server<MuPdfDocumentEngine>, PathBuf, PathBuf) {
        let pdf = crate::testpdf::write_temp(tag, &crate::testpdf::standard());
        let dir = temp_dir(tag);
        (Server::new(MuPdfDocumentEngine::open(&pdf).unwrap(), dir.clone()), dir, pdf)
    }

    fn render(id: u64, page: u32, scale: f32, rotate: u32, clip: Option<[f32; 4]>) -> Command {
        Command::Render { id, page, scale, rotate, clip }
    }

    #[test]
    fn parses_every_command() {
        assert_eq!(
            parse_command(r#"{"cmd":"render","id":7,"page":2,"scale":1.5,"rotate":90,"clip":[1,2,3,4]}"#).unwrap(),
            render(7, 2, 1.5, 90, Some([1.0, 2.0, 3.0, 4.0]))
        );
        assert_eq!(parse_command(r#"{"cmd":"render","page":0,"scale":2}"#).unwrap(), render(0, 0, 2.0, 0, None));
        assert_eq!(parse_command(r#"{"cmd":"text","page":3}"#).unwrap(), Command::Text(3));
        assert_eq!(parse_command(r#"{"cmd":"search","query":"fox"}"#).unwrap(), Command::Search("fox".into()));
        assert_eq!(parse_command(r#"{"cmd":"outline"}"#).unwrap(), Command::Outline);
        assert_eq!(parse_command(r#"{"cmd":"links","page":1}"#).unwrap(), Command::Links(1));
        assert_eq!(parse_command(r#"{"cmd":"margins"}"#).unwrap(), Command::Margins);
        assert_eq!(parse_command(r#"{"cmd":"trim"}"#).unwrap(), Command::Trim);
        assert_eq!(parse_command(r#"{"cmd":"quit"}"#).unwrap(), Command::Quit);
        match parse_command(r#"{"cmd":"export","path":"/tmp/o.pdf","annotations":[{"page":0,"kind":"highlight","rects":[[1,2,3,4]],"color":[1,0,0],"contents":"c"}]}"#).unwrap() {
            Command::Export { path, annotations } => {
                assert_eq!(path, PathBuf::from("/tmp/o.pdf"));
                assert_eq!(annotations[0].kind, ExportKind::Highlight);
                assert_eq!(annotations[0].rects, vec![[1.0, 2.0, 3.0, 4.0]]);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn rejects_malformed_commands_with_a_message() {
        for bad in [
            "not json", r#"{"nocmd":1}"#, r#"{"cmd":"bogus"}"#, r#"{"cmd":"text"}"#,
            r#"{"cmd":"render","page":0}"#, r#"{"cmd":"render","page":0,"scale":-1}"#,
            r#"{"cmd":"render","page":0,"scale":1,"rotate":45}"#, r#"{"cmd":"render","page":0,"scale":1,"clip":[1,2]}"#,
            r#"{"cmd":"export","path":"x","annotations":[{"page":0,"kind":"sparkle","rects":[]}]}"#,
        ] {
            assert!(parse_command(bad).is_err(), "should reject {bad}");
        }
    }

    #[test]
    fn scale_is_clamped_to_a_sane_range() {
        match parse_command(r#"{"cmd":"render","page":0,"scale":1000}"#).unwrap() {
            Command::Render { scale, .. } => assert_eq!(scale, 16.0),
            _ => unreachable!(),
        }
    }

    #[test]
    fn ready_carries_every_pages_size_and_matrix() {
        let (s, dir, pdf) = server("ready");
        let v = s.ready_event();
        assert_eq!(v["pageCount"], 2);
        assert_eq!(v["pages"][0]["w"], 612.0);
        assert_eq!(v["pages"][1]["w"], 500.0, "page 2: cropped 400x500 then rotated 90");
        assert_eq!(v["pages"][0]["m"].as_array().unwrap().len(), 6);
        fs::remove_dir_all(&dir).ok();
        crate::testpdf::cleanup(&pdf);
    }

    #[test]
    fn a_frame_is_an_opaque_rgba_file_of_the_reported_size() {
        let (mut s, dir, pdf) = server("frame");
        let (events, quit) = s.handle(render(5, 0, 1.0, 0, None));
        assert!(!quit);
        let ev = &events[0];
        assert_eq!((ev["event"].as_str(), ev["id"].as_u64(), ev["page"].as_u64()), (Some("frame"), Some(5), Some(0)));
        let (w, h) = (ev["width"].as_u64().unwrap(), ev["height"].as_u64().unwrap());
        assert_eq!((w, h), (612, 792));
        let bytes = fs::read(ev["path"].as_str().unwrap()).unwrap();
        assert_eq!(bytes.len() as u64, w * h * 4);
        assert!(bytes.chunks_exact(4).all(|p| p[3] == 255), "opaque");
        assert_eq!(&bytes[0..4], &[255, 255, 255, 255], "paper margin is white, not black");
        fs::remove_dir_all(&dir).ok();
        crate::testpdf::cleanup(&pdf);
    }

    #[test]
    fn rotate_and_clip_change_the_frame_size_as_the_overlay_math_assumes() {
        let (mut s, dir, pdf) = server("rotclip");
        let size = |s: &mut Server<MuPdfDocumentEngine>, rot, clip| {
            let (e, _) = s.handle(render(1, 0, 2.0, rot, clip));
            (e[0]["width"].as_u64().unwrap(), e[0]["height"].as_u64().unwrap())
        };
        assert_eq!(size(&mut s, 0, None), (1224, 1584));
        assert_eq!(size(&mut s, 90, None), (1584, 1224));
        assert_eq!(size(&mut s, 0, Some([10.0, 20.0, 100.0, 50.0])), (200, 100));
        assert_eq!(size(&mut s, 180, Some([10.0, 20.0, 100.0, 50.0])), (200, 100));
        assert_eq!(size(&mut s, 270, Some([10.0, 20.0, 100.0, 50.0])), (100, 200));
        fs::remove_dir_all(&dir).ok();
        crate::testpdf::cleanup(&pdf);
    }

    #[test]
    fn an_absurd_scale_is_capped_so_one_frame_cannot_eat_the_machine() {
        let (mut s, dir, pdf) = server("cap");
        let (e, _) = s.handle(render(1, 0, 16.0, 0, None)); // 612x792 at 16x would be 124M px
        let (w, h) = (e[0]["width"].as_u64().unwrap(), e[0]["height"].as_u64().unwrap());
        assert!(w * h <= 40_100_000, "{w}x{h}");
        assert!(w * h > 30_000_000, "it is reduced to the cap, not to something tiny: {w}x{h}");
        assert!(e[0]["scale"].as_f64().unwrap() < 16.0, "the reported scale is the one actually used");
        fs::remove_dir_all(&dir).ok();
        crate::testpdf::cleanup(&pdf);
    }

    #[test]
    fn a_bad_page_is_reported_and_the_id_is_released_not_a_crash() {
        let (mut s, dir, pdf) = server("badpage");
        let (events, _) = s.handle(render(9, 99, 1.0, 0, None));
        assert_eq!(events[0]["event"], "error");
        assert_eq!(events[1], json!({"event": "skipped", "id": 9}), "the host must be able to forget the request");
        fs::remove_dir_all(&dir).ok();
        crate::testpdf::cleanup(&pdf);
    }

    #[test]
    fn coalescing_keeps_only_the_last_render_per_page_and_reports_the_rest() {
        let batch = vec![
            render(1, 0, 1.0, 0, None), render(2, 1, 1.0, 0, None), render(3, 0, 2.0, 0, None),
            Command::Text(0), render(4, 0, 3.0, 0, None),
        ];
        let (kept, skipped) = Server::<MuPdfDocumentEngine>::coalesce(batch);
        assert_eq!(skipped, vec![1, 3]);
        assert_eq!(kept.len(), 3);
        assert!(matches!(kept[0], Command::Render { id: 2, .. }));
        assert!(matches!(kept[2], Command::Render { id: 4, .. }));
    }

    #[test]
    fn old_frames_are_deleted_so_a_slow_host_cannot_fill_the_disk() {
        let (mut s, dir, pdf) = server("gc");
        for i in 0..(KEEP_FRAMES as u64 + 5) {
            s.handle(render(i, 0, 0.2, 0, None));
        }
        let n = fs::read_dir(&dir).unwrap().count();
        assert_eq!(n, KEEP_FRAMES);
        s.cleanup();
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        fs::remove_dir_all(&dir).ok();
        crate::testpdf::cleanup(&pdf);
    }

    #[test]
    fn text_search_outline_links_events_have_the_documented_shape() {
        let (mut s, dir, pdf) = server("events");
        let (e, _) = s.handle(Command::Text(0));
        assert_eq!(e[0]["event"], "text");
        let line = e[0]["lines"].as_array().unwrap().iter().find(|l| l["t"].as_str().unwrap().contains("Hello world")).unwrap();
        assert_eq!(line["x"].as_array().unwrap().len(), line["t"].as_str().unwrap().chars().count() + 1);
        assert_eq!(line["b"].as_array().unwrap().len(), 4);

        let (e, _) = s.handle(Command::Search("quick brown".into()));
        assert_eq!(e[0]["event"], "search");
        let hit = &e[0]["hits"][0];
        assert_eq!(hit["page"], 0);
        let r = hit["rects"][0].as_array().unwrap();
        assert!(r[2].as_f64().unwrap() > 20.0 && r[3].as_f64().unwrap() > 5.0, "a rect, not a quad: {r:?}");

        let (e, _) = s.handle(Command::Outline);
        assert_eq!(e[0]["items"][0]["t"], "Chapter 1");
        assert_eq!(e[0]["items"][1]["c"][0]["t"], "Section 2.1");

        let (e, _) = s.handle(Command::Links(0));
        let links = e[0]["links"].as_array().unwrap();
        assert!(links.iter().any(|l| l["p"] == 1) && links.iter().any(|l| l["u"] == "https://example.org/x"));
        fs::remove_dir_all(&dir).ok();
        crate::testpdf::cleanup(&pdf);
    }

    #[test]
    fn export_writes_a_pdf_with_the_requested_annotations() {
        let (mut s, dir, pdf) = server("export");
        let out = dir.join("annotated.pdf");
        let (e, _) = s.handle(Command::Export {
            path: out.clone(),
            annotations: vec![ExportAnnotation { page: 0, kind: ExportKind::Underline, rects: vec![[72.0, 80.0, 60.0, 14.0]], color: [1.0, 0.0, 0.0], contents: String::new() }],
        });
        assert_eq!(e[0]["event"], "exported");
        assert_eq!(e[0]["count"], 1);
        assert!(MuPdfDocumentEngine::open(&out).is_ok(), "the exported file must open");
        fs::remove_dir_all(&dir).ok();
        crate::testpdf::cleanup(&pdf);
    }

    #[test]
    fn margins_use_the_smallest_ink_margin_and_ignore_blank_pages() {
        let boxes = vec![
            (Some([60.0, 70.0, 540.0, 720.0]), (612.0, 792.0)),
            (None, (612.0, 792.0)),
            (Some([80.0, 50.0, 500.0, 760.0]), (612.0, 792.0)),
        ];
        let m = margins_from_boxes(&boxes).unwrap();
        assert_eq!(m, [54.0, 44.0, 66.0, 26.0], "min margins 60/50/72/32 minus 6pt padding");
        assert_eq!(margins_from_boxes(&[(None, (612.0, 792.0))]), None, "all blank -> no crop");
        assert_eq!(margins_from_boxes(&[(Some([3.0, 3.0, 609.0, 789.0]), (612.0, 792.0))]), None, "scans with no margin: nothing to crop");
    }

    #[test]
    fn margins_command_finds_the_margins_of_a_real_page() {
        let (mut s, dir, pdf) = server("margins");
        let (e, _) = s.handle(Command::Margins);
        let ins = e[0]["insets"].as_array().expect("text pages have margins to crop");
        assert!(ins[0].as_f64().unwrap() > 40.0, "left margin ~72pt: {ins:?}");
        fs::remove_dir_all(&dir).ok();
        crate::testpdf::cleanup(&pdf);
    }

    #[test]
    fn run_serves_a_session_over_the_protocol_and_cleans_up_on_quit() {
        let (s, dir, pdf) = server("run");
        let input = "{\"cmd\":\"render\",\"id\":1,\"page\":0,\"scale\":0.5}\n{\"cmd\":\"bogus\"}\n{\"cmd\":\"quit\"}\n";
        let mut out = Vec::new();
        run(s, Cursor::new(input.to_string()), &mut out).unwrap();
        let evs: Vec<Value> = String::from_utf8_lossy(&out).lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(evs[0]["event"], "ready");
        assert!(evs.iter().any(|e| e["event"] == "error"), "the bad command is reported, not fatal");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0, "frame files are removed on exit");
        fs::remove_dir_all(&dir).ok();
        crate::testpdf::cleanup(&pdf);
    }

    #[test]
    fn eof_on_stdin_ends_the_loop_after_serving_what_was_queued() {
        let (s, dir, pdf) = server("eof");
        let mut out = Vec::new();
        run(s, Cursor::new("{\"cmd\":\"render\",\"id\":1,\"page\":0,\"scale\":0.5}\n".to_string()), &mut out).unwrap();
        assert!(String::from_utf8_lossy(&out).contains("\"event\":\"frame\""));
        fs::remove_dir_all(&dir).ok();
        crate::testpdf::cleanup(&pdf);
    }
}
