// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

//! Small, pragmatic abstraction over the PDF library. GUI and cache code
//! depend only on this trait -- no `mupdf` types cross the boundary.

use crate::log;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageSize {
    pub width: f32,
    pub height: f32,
}

/// A rendered page: tightly-packed RGBA8, row-major, `stride == width * 4`.
#[derive(Debug)]
pub struct RenderedPage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SearchQuad {
    pub ul: (f32, f32),
    pub ur: (f32, f32),
    pub ll: (f32, f32),
    pub lr: (f32, f32),
}

#[derive(Debug, Clone)]
pub struct SearchHit {
    pub page: u32,
    pub quads: Vec<SearchQuad>,
}

/// Per-page geometry. `width`/`height` are the page's size in page space (points, after the page's own
/// `/Rotate`); `matrix` maps PDF user space (what Zotero stores) to that page space.
#[derive(Debug, Clone, PartialEq)]
pub struct PageGeometry {
    pub width: f32,
    pub height: f32,
    pub matrix: crate::geometry::Matrix,
}

/// One line of text. `xs` has `chars + 1` entries: character `i` spans `xs[i]..xs[i + 1]`
/// horizontally (so selecting across a gap or a space is continuous); `bbox` is `[x, y, w, h]`.
#[derive(Debug, Clone, PartialEq)]
pub struct TextLine {
    pub bbox: [f32; 4],
    pub text: String,
    pub xs: Vec<f32>,
    /// Runs of superscript digits (citation markers like `7`, `9-11`), as `[from, to)` code-point indexes into `text`.
    pub sup: Vec<[u32; 2]>,
}

/// Superscript digit runs in a line: characters set clearly smaller than the line's text that are digits or the
/// `,` `-` en-dash between them. A run starts and ends on a digit (an exponent like m-1 is not a citation).
pub fn superscript_runs(chars: &[(char, f32)]) -> Vec<[u32; 2]> {
    let max = chars.iter().map(|c| c.1).fold(0.0f32, f32::max);
    let small = |i: usize| chars[i].1 < max * 0.82;
    let ok = |c: char| c.is_ascii_digit() || matches!(c, ',' | '-' | '\u{2013}' | '\u{2212}' | '\u{2009}');
    let dash = |c: char| matches!(c, '-' | '\u{2013}' | '\u{2212}');
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if !(small(i) && ok(chars[i].0)) {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && small(i) && ok(chars[i].0) {
            i += 1;
        }
        let (mut a, mut b) = (start, i);
        while a < b && !chars[a].0.is_ascii_digit() {
            a += 1;
        }
        while b > a && !chars[b - 1].0.is_ascii_digit() {
            b -= 1;
        }
        let negative = start < a && dash(chars[start].0);
        if a < b && !negative {
            out.push([a as u32, b as u32]);
        }
    }
    out
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct PageText {
    pub lines: Vec<TextLine>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OutlineItem {
    pub title: String,
    pub page: Option<u32>,
    pub uri: Option<String>,
    pub children: Vec<OutlineItem>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LinkInfo {
    /// `[x, y, w, h]` in page space.
    pub rect: [f32; 4],
    /// Internal destination page (0-indexed), if any.
    pub page: Option<u32>,
    /// External URI, if any.
    pub uri: Option<String>,
    /// Where on the destination page the link points: `[left, top]` in PDF space (y up), when the file says.
    pub dest_at: Option<[f32; 2]>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ExportKind {
    Highlight,
    Underline,
    Note,
}

/// An annotation to embed when exporting a copy of the PDF. `rects` are `[x, y, w, h]` in page space.
#[derive(Debug, Clone, PartialEq)]
pub struct ExportAnnotation {
    pub page: u32,
    pub kind: ExportKind,
    pub rects: Vec<[f32; 4]>,
    pub color: [f32; 3],
    pub contents: String,
}

/// An annotation stored inside the PDF file itself (made by another reader, or by "Export with annotations").
#[derive(Debug, Clone, PartialEq)]
pub struct EmbeddedAnnotation {
    /// highlight | underline | note | text | ink
    pub kind: &'static str,
    /// `[x, y, w, h]` in page space
    pub rects: Vec<[f32; 4]>,
    pub color: Option<[f32; 3]>,
    pub contents: String,
    pub author: String,
    /// the page text under a highlight/underline
    pub text: String,
}

#[derive(Debug)]
pub enum EngineError {
    /// The file does not exist or isn't readable.
    FileNotFound(String),
    /// The library rejected the file (corrupt, encrypted, unsupported).
    OpenFailed(String),
    /// A page index outside `0..page_count()` was requested.
    PageOutOfBounds(u32),
    /// Any other library-reported failure.
    Other(String),
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineError::FileNotFound(p) => write!(f, "file not found: {p}"),
            EngineError::OpenFailed(m) => write!(f, "failed to open document: {m}"),
            EngineError::PageOutOfBounds(p) => write!(f, "page {p} is out of bounds"),
            EngineError::Other(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for EngineError {}

/// Contract the GUI/cache layer programs against. Deliberately small: it is
/// the seam between "PDF library" and "everything else" (see docs/adr and
/// the project brief's engineering principles).
pub trait DocumentEngine: Sized {
    fn open(path: &Path) -> Result<Self, EngineError>;
    fn page_count(&self) -> u32;
    fn page_size(&self, page: u32) -> Result<PageSize, EngineError>;
    /// `&mut self`: implementations may keep a small bounded display-list
    /// cache internally so repeated renders of the same page at a new zoom
    /// level skip re-parsing the page's content stream (see docs/adr).
    fn render(&mut self, page: u32, scale: f32) -> Result<RenderedPage, EngineError>;
    /// Whole-document text search. Synchronous by design for v0.1 -- see
    /// docs/future-ipc.md for why this stays simple rather than growing an
    /// incremental/async search protocol prematurely.
    fn search(&self, query: &str) -> Result<Vec<SearchHit>, EngineError>;
    fn extract_text(&self, page: u32) -> Result<String, EngineError>;
    fn close(&mut self);
    /// Drops any internal caches (parsed display lists) without closing the
    /// document. Used when a reader tab goes to the background.
    fn release_caches(&mut self) {}

    /// Size and PDF->page matrix of every page.
    fn geometries(&self) -> Result<Vec<PageGeometry>, EngineError>;
    /// Structured text (line boxes + per-character boundaries) for selection.
    fn page_text(&self, page: u32) -> Result<PageText, EngineError>;
    fn outline(&self) -> Result<Vec<OutlineItem>, EngineError>;
    fn links(&self, page: u32) -> Result<Vec<LinkInfo>, EngineError>;
    /// The annotations stored in the PDF file on a page (read-only; Zotero's own live in its database).
    fn embedded_annotations(&self, _page: u32) -> Result<Vec<EmbeddedAnnotation>, EngineError> {
        Ok(Vec::new())
    }
    /// Where raster images are painted on the page, `[x, y, w, h]` in page space (the host's dark mode leaves them alone).
    fn image_rects(&mut self, _page: u32) -> Result<Vec<[f32; 4]>, EngineError> {
        Ok(Vec::new())
    }
    /// Bounding box of everything painted on the page, `[x0, y0, x1, y1]` in page space (None: blank).
    fn content_bbox(&mut self, page: u32) -> Result<Option<[f32; 4]>, EngineError>;
    /// Writes a copy of the document with `annots` embedded; returns how many were embedded.
    fn export_annotated(&self, out: &Path, annots: &[ExportAnnotation]) -> Result<u32, EngineError>;

    /// A view of the page: the page at `scale` (pixels per point), cropped to `clip` (`[x, y, w, h]` in
    /// page space, pre-rotation) and then rotated clockwise by `rotate` degrees. This is exactly what the
    /// tab displays, so overlays (selection, search hits, annotations) can be placed with the same math.
    fn render_view(&mut self, page: u32, scale: f32, rotate: u32, clip: Option<[f32; 4]>) -> Result<RenderedPage, EngineError> {
        let full = self.render(page, scale)?;
        let (mut rgba, mut w, mut h) = (full.rgba, full.width, full.height);
        if let Some([cx, cy, cw, ch]) = clip {
            let x = (cx * scale).round().max(0.0) as u32;
            let y = (cy * scale).round().max(0.0) as u32;
            let pw = (cw * scale).round().max(1.0) as u32;
            let ph = (ch * scale).round().max(1.0) as u32;
            (rgba, w, h) = crate::geometry::crop_pixels(&rgba, w, h, x, y, pw, ph);
        }
        if rotate % 360 != 0 {
            (rgba, w, h) = crate::geometry::rotate_pixels(&rgba, w, h, rotate);
        }
        Ok(RenderedPage { width: w, height: h, rgba })
    }
}

pub mod mupdf_engine {
    use super::*;
    use mupdf::pdf::PdfPage;
    use mupdf::text_page::{TextBlockType, TextPageFlags};
    use mupdf::{DisplayList, Document, Matrix};
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::path::PathBuf;

    /// How many parsed display lists to keep around. Matches the reader's
    /// render-cache radius (current page +/- 1) -- see docs/adr and
    /// `cache::RenderCache`. Small and fixed, not user-configurable in v0.1.
    const DISPLAY_LIST_CACHE_SIZE: usize = 3;

    /// MuPDF keeps decoded images in an internal store (up to 256 MB) that the safe API cannot flush, but
    /// dropping the open document evicts everything keyed to it. An image-heavy (scanned) document would
    /// otherwise grow the helper to ~270 MB while reading, so every this-many renders the document is
    /// dropped (and lazily re-opened, a few ms). Measured: see STATUS.md.
    const FLUSH_EVERY_RENDERS: u32 = 8;

    fn other<E: std::fmt::Display>(e: E) -> EngineError {
        EngineError::Other(e.to_string())
    }

    /// The page's own `/Rotate` and effective box (CropBox, else MediaBox) in PDF space; falls back to an
    /// unrotated box of the page's size if the page object can't be read.
    fn page_rotation_and_box(page: mupdf::Page, width: f32, height: f32) -> (i32, [f32; 4]) {
        let fallback = (0, [0.0, 0.0, width, height]);
        let Ok(pdf) = PdfPage::try_from(page) else { return fallback };
        let rotation = pdf.rotation().unwrap_or(0);
        let obj = pdf.object();
        let read_box = |key: &str| -> Option<[f32; 4]> {
            let arr = obj.get_dict_inheritable(key).ok()??;
            let mut v = [0.0f32; 4];
            for (i, slot) in v.iter_mut().enumerate() {
                *slot = arr.get_array(i as i32).ok()??.as_float().ok()?;
            }
            Some([v[0].min(v[2]), v[1].min(v[3]), v[0].max(v[2]), v[1].max(v[3])])
        };
        match read_box("CropBox").or_else(|| read_box("MediaBox")) {
            Some(b) => (rotation, b),
            None => fallback,
        }
    }

    #[derive(Debug)]
    pub struct MuPdfDocumentEngine {
        path: PathBuf,
        /// `None` while released (see `release_caches`) -- re-opened lazily by
        /// `with_doc` on next use. Interior mutability so `&self` queries
        /// (`page_size`, `search`) can transparently re-open.
        doc: RefCell<Option<Document>>,
        /// Set by `close()`; unlike a release, this is permanent.
        closed: bool,
        /// Renders since the document was (re)opened; see `FLUSH_EVERY_RENDERS`.
        renders_since_open: u32,
        page_count: u32,
        display_lists: HashMap<u32, DisplayList>,
        display_list_order: Vec<u32>,
    }

    impl MuPdfDocumentEngine {
        fn open_document(path: &Path) -> Result<Document, EngineError> {
            let path_str = path
                .to_str()
                .ok_or_else(|| EngineError::OpenFailed("path is not valid UTF-8".into()))?;
            Document::open(path_str).map_err(|e| EngineError::OpenFailed(e.to_string()))
        }

        /// Runs `f` with the open document, re-opening it first if a
        /// `release_caches()` dropped it.
        fn with_doc<T>(&self, f: impl FnOnce(&Document) -> Result<T, EngineError>) -> Result<T, EngineError> {
            if self.closed {
                return Err(EngineError::Other("document already closed".into()));
            }
            let mut slot = self.doc.borrow_mut();
            if slot.is_none() {
                log::debug("re-opening released document");
                *slot = Some(Self::open_document(&self.path)?);
            }
            f(slot.as_ref().unwrap())
        }

        fn check_bounds(&self, page: u32) -> Result<(), EngineError> {
            if page >= self.page_count {
                Err(EngineError::PageOutOfBounds(page))
            } else {
                Ok(())
            }
        }

        /// Returns the page's parsed display list, from cache if present.
        /// Evicts the oldest entry when the bounded cache is full.
        fn display_list_for(&mut self, page: u32) -> Result<&DisplayList, EngineError> {
            if !self.display_lists.contains_key(&page) {
                let list = self.with_doc(|doc| {
                    let p = doc
                        .load_page(page as i32)
                        .map_err(|e| EngineError::Other(e.to_string()))?;
                    p.to_display_list(true)
                        .map_err(|e| EngineError::Other(e.to_string()))
                })?;
                if self.display_list_order.len() >= DISPLAY_LIST_CACHE_SIZE {
                    let evict = self.display_list_order.remove(0);
                    self.display_lists.remove(&evict);
                    log::debug(&format!("display-list cache evict page={evict}"));
                }
                self.display_list_order.push(page);
                self.display_lists.insert(page, list);
                log::debug(&format!("display-list cache miss page={page}"));
            } else {
                log::debug(&format!("display-list cache hit page={page}"));
            }
            Ok(self.display_lists.get(&page).unwrap())
        }
    }

    impl DocumentEngine for MuPdfDocumentEngine {
        fn open(path: &Path) -> Result<Self, EngineError> {
            if !path.exists() {
                return Err(EngineError::FileNotFound(path.display().to_string()));
            }
            let doc = Self::open_document(path)?;
            let page_count = doc
                .page_count()
                .map_err(|e| EngineError::OpenFailed(e.to_string()))?;
            if page_count <= 0 {
                return Err(EngineError::OpenFailed("document has no pages".into()));
            }
            Ok(Self {
                path: path.to_path_buf(),
                doc: RefCell::new(Some(doc)),
                closed: false,
                renders_since_open: 0,
                page_count: page_count as u32,
                display_lists: HashMap::new(),
                display_list_order: Vec::new(),
            })
        }

        fn page_count(&self) -> u32 {
            self.page_count
        }

        fn page_size(&self, page: u32) -> Result<PageSize, EngineError> {
            self.check_bounds(page)?;
            self.with_doc(|doc| {
                let p = doc
                    .load_page(page as i32)
                    .map_err(|e| EngineError::Other(e.to_string()))?;
                let b = p.bounds().map_err(|e| EngineError::Other(e.to_string()))?;
                Ok(PageSize {
                    width: b.width(),
                    height: b.height(),
                })
            })
        }

        fn render(&mut self, page: u32, scale: f32) -> Result<RenderedPage, EngineError> {
            self.check_bounds(page)?;
            let ctm = Matrix::new_scale(scale, scale);
            let list = self.display_list_for(page)?;
            let pixmap = list
                .to_pixmap(&ctm, &mupdf::Colorspace::device_rgb(), true)
                .map_err(|e| EngineError::Other(e.to_string()))?;
            let width = pixmap.width();
            let height = pixmap.height();
            let samples = pixmap.samples();
            let rendered = RenderedPage {
                width,
                height,
                rgba: samples.to_vec(),
            };
            self.renders_since_open += 1;
            if self.renders_since_open >= FLUSH_EVERY_RENDERS {
                self.release_caches();
            }
            Ok(rendered)
        }

        fn search(&self, query: &str) -> Result<Vec<SearchHit>, EngineError> {
            if query.trim().is_empty() {
                return Ok(Vec::new());
            }
            self.with_doc(|doc| {
            let mut hits = Vec::new();
            for page_no in 0..self.page_count {
                let p = doc
                    .load_page(page_no as i32)
                    .map_err(|e| EngineError::Other(e.to_string()))?;
                let quads = p
                    .search(query, 64)
                    .map_err(|e| EngineError::Other(e.to_string()))?;
                if quads.len() > 0 {
                    let converted = quads
                        .iter()
                        .map(|q| SearchQuad {
                            ul: (q.ul.x, q.ul.y),
                            ur: (q.ur.x, q.ur.y),
                            ll: (q.ll.x, q.ll.y),
                            lr: (q.lr.x, q.lr.y),
                        })
                        .collect();
                    hits.push(SearchHit {
                        page: page_no,
                        quads: converted,
                    });
                }
            }
            Ok(hits)
            })
        }

        fn extract_text(&self, page: u32) -> Result<String, EngineError> {
            self.check_bounds(page)?;
            self.with_doc(|doc| {
                let p = doc
                    .load_page(page as i32)
                    .map_err(|e| EngineError::Other(e.to_string()))?;
                p.text(mupdf::TextExtractOptions::default())
                    .map_err(|e| EngineError::Other(e.to_string()))
            })
        }

        /// Also drops the open `Document`: MuPDF keeps decoded images/fonts
        /// in an internal store (up to 256 MB) that the safe API can't flush
        /// directly, but dropping the document evicts everything keyed to
        /// it (measured on the image-heavy fixture: see STATUS.md). The
        /// next query re-opens it lazily.
        fn release_caches(&mut self) {
            self.display_lists.clear();
            self.display_list_order.clear();
            *self.doc.borrow_mut() = None;
            self.renders_since_open = 0;
        }


        fn geometries(&self) -> Result<Vec<PageGeometry>, EngineError> {
            self.with_doc(|doc| {
                let mut out = Vec::with_capacity(self.page_count as usize);
                for i in 0..self.page_count {
                    let page = doc.load_page(i as i32).map_err(other)?;
                    let b = page.bounds().map_err(other)?;
                    let (width, height) = (b.width(), b.height());
                    let (rotation, pdf_box) = page_rotation_and_box(page, width, height);
                    out.push(PageGeometry {
                        width,
                        height,
                        matrix: crate::geometry::pdf_to_page_matrix(rotation, pdf_box),
                    });
                }
                Ok(out)
            })
        }

        fn page_text(&self, page: u32) -> Result<PageText, EngineError> {
            self.check_bounds(page)?;
            self.with_doc(|doc| {
                let p = doc.load_page(page as i32).map_err(other)?;
                let tp = p.to_text_page(TextPageFlags::PRESERVE_WHITESPACE).map_err(other)?;
                let mut lines = Vec::new();
                for block in tp.blocks() {
                    if block.r#type() != TextBlockType::Text {
                        continue;
                    }
                    for line in block.lines() {
                        let mut text = String::new();
                        let mut xs: Vec<f32> = Vec::new();
                        let mut last_end = 0.0f32;
                        let mut sized: Vec<(char, f32)> = Vec::new();
                        for ch in line.chars() {
                            let Some(c) = ch.char() else { continue };
                            sized.push((c, ch.size()));
                            let q = ch.quad();
                            let x0 = q.ul.x.min(q.ll.x).min(q.ur.x).min(q.lr.x);
                            let x1 = q.ul.x.max(q.ll.x).max(q.ur.x).max(q.lr.x);
                            xs.push(x0);
                            text.push(c);
                            last_end = x1;
                        }
                        if text.is_empty() {
                            continue;
                        }
                        xs.push(last_end);
                        let b = line.bounds();
                        lines.push(TextLine { bbox: [b.x0, b.y0, b.width(), b.height()], text, xs, sup: superscript_runs(&sized) });
                    }
                }
                Ok(PageText { lines })
            })
        }

        fn outline(&self) -> Result<Vec<OutlineItem>, EngineError> {
            fn convert(o: &mupdf::outline::Outline) -> OutlineItem {
                OutlineItem {
                    title: o.title.clone(),
                    page: o.dest.map(|d| d.loc.page_number),
                    uri: o.uri.clone().filter(|u| !u.is_empty() && o.dest.is_none()),
                    children: o.down.iter().map(convert).collect(),
                }
            }
            let existing: Vec<OutlineItem> = self.with_doc(|doc| {
                let outlines = doc.outlines().map_err(other)?;
                Ok(outlines.iter().map(convert).collect())
            })?;
            if !existing.is_empty() {
                return Ok(existing);
            }
            // no outline in the file: find the headings from the type, as Zotero's reader does
            self.with_doc(|doc| {
                let pages = doc.page_count().map_err(other)?.min(100);
                let mut lines = Vec::new();
                for pi in 0..pages {
                    let p = doc.load_page(pi).map_err(other)?;
                    let tp = p.to_text_page(TextPageFlags::empty()).map_err(other)?;
                    for block in tp.blocks() {
                        if block.r#type() != TextBlockType::Text {
                            continue;
                        }
                        for line in block.lines() {
                            let mut text = String::new();
                            let mut font = String::new();
                            let mut size = 0.0f32;
                            let mut uniform = true;
                            for ch in line.chars() {
                                let Some(c) = ch.char() else { continue };
                                text.push(c);
                                if c.is_whitespace() {
                                    continue;
                                }
                                let name = ch.font().map(|f| crate::headings::family_name(f.name())).unwrap_or_default();
                                if font.is_empty() {
                                    font = name;
                                    size = ch.size();
                                } else if font != name && c.is_alphabetic() {
                                    uniform = false; // (a dash or digit from a fallback font does not make a line mixed)
                                }
                            }
                            if font.is_empty() || text.trim().is_empty() {
                                continue;
                            }
                            lines.push(crate::headings::RawLine { page: pi as u32, text, font, size, y: line.bounds().y0, x0: line.bounds().x0, x1: line.bounds().x1, uniform });
                        }
                    }
                }
                Ok(crate::headings::extract_outline(&lines))
            })
        }

        fn links(&self, page: u32) -> Result<Vec<LinkInfo>, EngineError> {
            self.check_bounds(page)?;
            self.with_doc(|doc| {
                let p = doc.load_page(page as i32).map_err(other)?;
                let mut out = Vec::new();
                for link in p.links().map_err(other)? {
                    let b = link.bounds;
                    let dest_page = link.dest.map(|d| d.loc.page_number);
                    let uri = (dest_page.is_none() && !link.uri.is_empty()).then(|| link.uri.clone());
                    if dest_page.is_none() && uri.is_none() {
                        continue;
                    }
                    let dest_at = link.dest.and_then(|d| match d.kind {
                        mupdf::destination::DestinationKind::XYZ { left, top: Some(top), .. } => Some([left.unwrap_or(0.0), top]),
                        mupdf::destination::DestinationKind::FitH { top: Some(top) } => Some([0.0, top]),
                        _ => None,
                    });
                    out.push(LinkInfo { rect: [b.x0, b.y0, b.width(), b.height()], page: dest_page, uri, dest_at });
                }
                Ok(out)
            })
        }

        fn embedded_annotations(&self, page: u32) -> Result<Vec<EmbeddedAnnotation>, EngineError> {
            use mupdf::pdf::{PdfAnnotationType as T, PdfPage};
            self.check_bounds(page)?;
            self.with_doc(|doc| {
                let p = doc.load_page(page as i32).map_err(other)?;
                let Ok(pp) = PdfPage::try_from(p.clone()) else { return Ok(Vec::new()) };
                let mut out = Vec::new();
                let mut text_page = None;
                for a in pp.annotations() {
                    let Ok(t) = a.r#type() else { continue };
                    let kind = match t {
                        T::Highlight => "highlight",
                        T::Underline | T::Squiggly | T::StrikeOut => "underline",
                        T::Text => "note",
                        T::FreeText => "text",
                        T::Ink | T::Square | T::Circle | T::Line | T::Polygon | T::PolyLine | T::Stamp | T::Caret => "ink",
                        _ => continue,
                    };
                    let boxes = |r: mupdf::Rect| [r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0];
                    let rects: Vec<[f32; 4]> = if matches!(kind, "highlight" | "underline") {
                        a.quads().unwrap_or_default().iter().map(|q| {
                            let xs = [q.ul.x, q.ur.x, q.ll.x, q.lr.x];
                            let ys = [q.ul.y, q.ur.y, q.ll.y, q.lr.y];
                            let x0 = xs.iter().cloned().fold(f32::MAX, f32::min);
                            let y0 = ys.iter().cloned().fold(f32::MAX, f32::min);
                            [x0, y0, xs.iter().cloned().fold(f32::MIN, f32::max) - x0, ys.iter().cloned().fold(f32::MIN, f32::max) - y0]
                        }).collect()
                    } else {
                        a.bounds().map(|r| vec![boxes(r)]).unwrap_or_default()
                    };
                    if rects.is_empty() {
                        continue;
                    }
                    let color = a.color().ok().flatten().map(|c| match c {
                        mupdf::color::AnnotationColor::Gray(g) => [g, g, g],
                        mupdf::color::AnnotationColor::Rgb { red, green, blue } => [red, green, blue],
                        mupdf::color::AnnotationColor::Cmyk { cyan, magenta, yellow, key } => [(1.0 - cyan) * (1.0 - key), (1.0 - magenta) * (1.0 - key), (1.0 - yellow) * (1.0 - key)],
                    });
                    let mut text = String::new();
                    if matches!(kind, "highlight" | "underline") {
                        if text_page.is_none() {
                            text_page = p.to_text_page(TextPageFlags::empty()).ok();
                        }
                        if let Some(tp) = &text_page {
                            for block in tp.blocks() {
                                if block.r#type() != TextBlockType::Text {
                                    continue;
                                }
                                for line in block.lines() {
                                    let mut piece = String::new();
                                    for ch in line.chars() {
                                        let Some(c) = ch.char() else { continue };
                                        let q = ch.quad();
                                        let (cx, cy) = ((q.ul.x + q.lr.x) / 2.0, (q.ul.y + q.lr.y) / 2.0);
                                        if rects.iter().any(|r| cx >= r[0] && cx <= r[0] + r[2] && cy >= r[1] && cy <= r[1] + r[3]) {
                                            piece.push(c);
                                        }
                                    }
                                    if !piece.is_empty() {
                                        if !text.is_empty() {
                                            text.push(' ');
                                        }
                                        text.push_str(piece.trim());
                                    }
                                }
                            }
                        }
                    }
                    out.push(EmbeddedAnnotation {
                        kind,
                        rects,
                        color,
                        contents: a.contents().ok().flatten().unwrap_or("").to_string(),
                        author: a.author().ok().flatten().unwrap_or("").to_string(),
                        text,
                    });
                }
                Ok(out)
            })
        }

        fn image_rects(&mut self, page: u32) -> Result<Vec<[f32; 4]>, EngineError> {
            use mupdf::{Device, Matrix, Rect};
            use mupdf::device::NativeDevice;
            use std::{cell::RefCell, rc::Rc};
            struct Recorder(Rc<RefCell<Vec<[f32; 4]>>>);
            impl NativeDevice for Recorder {
                fn fill_image(&mut self, _img: &mupdf::Image, cmt: Matrix, _alpha: f32, _cp: mupdf::ColorParams) {
                    // an image fills the unit square transformed by `cmt`
                    let pts = [cmt.transform_xy(0.0, 0.0), cmt.transform_xy(1.0, 0.0), cmt.transform_xy(0.0, 1.0), cmt.transform_xy(1.0, 1.0)];
                    let x0 = pts.iter().map(|p| p.0).fold(f32::MAX, f32::min);
                    let y0 = pts.iter().map(|p| p.1).fold(f32::MAX, f32::min);
                    let x1 = pts.iter().map(|p| p.0).fold(f32::MIN, f32::max);
                    let y1 = pts.iter().map(|p| p.1).fold(f32::MIN, f32::max);
                    if x1 - x0 >= 4.0 && y1 - y0 >= 4.0 {
                        self.0.borrow_mut().push([x0, y0, x1 - x0, y1 - y0]);
                    }
                }
            }
            self.check_bounds(page)?;
            let found = Rc::new(RefCell::new(Vec::new()));
            let device = Device::from_native(Recorder(found.clone())).map_err(|e| EngineError::Other(e.to_string()))?;
            let list = self.display_list_for(page)?;
            list.run(&device, &Matrix::IDENTITY, Rect::INF).map_err(|e| EngineError::Other(e.to_string()))?;
            drop(device);
            let out = found.borrow().clone();
            // scanning a whole scanned book for pictures would otherwise pile its decoded page images up in MuPDF's store
            self.renders_since_open += 1;
            if self.renders_since_open >= FLUSH_EVERY_RENDERS {
                self.release_caches();
            }
            Ok(out)
        }

        fn content_bbox(&mut self, page: u32) -> Result<Option<[f32; 4]>, EngineError> {
            const S: f32 = 0.3; // a coarse render is plenty to find the ink
            let r = self.render(page, S)?;
            Ok(crate::geometry::content_bbox(&r.rgba, r.width, r.height)
                .map(|[x0, y0, x1, y1]| [x0 as f32 / S, y0 as f32 / S, x1 as f32 / S, y1 as f32 / S]))
        }

        fn export_annotated(&self, out: &Path, annots: &[ExportAnnotation]) -> Result<u32, EngineError> {
            use mupdf::color::AnnotationColor;
            use mupdf::pdf::PdfDocument;
            use mupdf::quad::Quad;
            use mupdf::rect::Rect;
            let src = self.path.to_str().ok_or_else(|| EngineError::OpenFailed("path is not valid UTF-8".into()))?;
            let dst = out.to_str().ok_or_else(|| EngineError::Other("output path is not valid UTF-8".into()))?;
            let doc = PdfDocument::open(src).map_err(other)?;
            let mut count = 0;
            for a in annots {
                if a.page >= self.page_count || a.rects.is_empty() {
                    continue;
                }
                let page = doc.load_page(a.page as i32).map_err(other)?;
                let mut page = PdfPage::try_from(page).map_err(other)?;
                let rect = |r: &[f32; 4]| Rect { x0: r[0], y0: r[1], x1: r[0] + r[2], y1: r[1] + r[3] };
                let color = AnnotationColor::Rgb { red: a.color[0], green: a.color[1], blue: a.color[2] };
                let mut annot = match a.kind {
                    ExportKind::Highlight => {
                        let quads: Vec<Quad> = a.rects.iter().map(|r| Quad::from(rect(r))).collect();
                        page.add_highlight_annotation(quads).map_err(other)?
                    }
                    ExportKind::Underline => {
                        let quads: Vec<Quad> = a.rects.iter().map(|r| Quad::from(rect(r))).collect();
                        page.add_underline_annotation(quads).map_err(other)?
                    }
                    ExportKind::Note => page.add_text_annotation(rect(&a.rects[0]), &a.contents).map_err(other)?,
                };
                annot.set_color(color).map_err(other)?;
                if a.kind != ExportKind::Note && !a.contents.is_empty() {
                    annot.set_contents(&a.contents).map_err(other)?;
                }
                page.update().map_err(other)?;
                count += 1;
            }
            doc.save(dst).map_err(other)?;
            Ok(count)
        }

        fn close(&mut self) {
            self.display_lists.clear();
            self.display_list_order.clear();
            *self.doc.borrow_mut() = None;
            self.closed = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::mupdf_engine::MuPdfDocumentEngine;
    use super::*;
    use std::path::PathBuf;

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures")
            .join(name)
    }

    #[test]
    fn opens_and_reports_page_count() {
        let engine = MuPdfDocumentEngine::open(&fixture("sample.pdf")).unwrap();
        assert_eq!(engine.page_count(), 3);
    }

    #[test]
    fn missing_file_is_reported_not_panicked() {
        let err = MuPdfDocumentEngine::open(&fixture("does-not-exist.pdf")).unwrap_err();
        assert!(matches!(err, EngineError::FileNotFound(_)));
    }

    #[test]
    fn invalid_file_is_reported() {
        let dir = std::env::temp_dir().join("fast-reader-helper-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let bogus = dir.join("not-a-pdf.pdf");
        std::fs::write(&bogus, b"this is not a pdf").unwrap();
        let err = MuPdfDocumentEngine::open(&bogus).unwrap_err();
        assert!(matches!(err, EngineError::OpenFailed(_)));
    }

    #[test]
    fn page_out_of_bounds_is_reported() {
        let mut engine = MuPdfDocumentEngine::open(&fixture("sample.pdf")).unwrap();
        let err = engine.render(99, 1.0).unwrap_err();
        assert!(matches!(err, EngineError::PageOutOfBounds(99)));
        let err = engine.page_size(99).unwrap_err();
        assert!(matches!(err, EngineError::PageOutOfBounds(99)));
    }

    #[test]
    fn renders_page_with_expected_dimensions() {
        let mut engine = MuPdfDocumentEngine::open(&fixture("sample.pdf")).unwrap();
        let size = engine.page_size(0).unwrap();
        let rendered = engine.render(0, 1.0).unwrap();
        assert_eq!(rendered.width, size.width.round() as u32);
        assert_eq!(rendered.height, size.height.round() as u32);
        assert_eq!(rendered.rgba.len(), (rendered.width * rendered.height * 4) as usize);
        // not a blank page: some non-white pixel should exist (text/figure ink)
        assert!(rendered.rgba.chunks(4).any(|px| px != [255, 255, 255, 255]));
    }

    #[test]
    fn render_scale_changes_output_size() {
        let mut engine = MuPdfDocumentEngine::open(&fixture("sample.pdf")).unwrap();
        let r1 = engine.render(0, 1.0).unwrap();
        let r2 = engine.render(0, 2.0).unwrap();
        assert_eq!(r2.width, r1.width * 2);
        assert_eq!(r2.height, r1.height * 2);
    }

    #[test]
    fn search_finds_known_text_and_reports_pages() {
        let engine = MuPdfDocumentEngine::open(&fixture("sample.pdf")).unwrap();
        let hits = engine.search("brown fox").unwrap();
        assert!(!hits.is_empty(), "expected at least one hit for known fixture text");
        for hit in &hits {
            assert!(hit.page < engine.page_count());
            assert!(!hit.quads.is_empty());
        }
    }

    #[test]
    fn search_for_absent_text_returns_no_hits() {
        let engine = MuPdfDocumentEngine::open(&fixture("sample.pdf")).unwrap();
        let hits = engine.search("xyzzy-not-present-anywhere").unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn empty_query_returns_no_hits_without_scanning() {
        let engine = MuPdfDocumentEngine::open(&fixture("sample.pdf")).unwrap();
        let hits = engine.search("").unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn extract_text_is_nonempty_for_text_page() {
        let engine = MuPdfDocumentEngine::open(&fixture("sample.pdf")).unwrap();
        let text = engine.extract_text(0).unwrap();
        assert!(text.contains("Fast Reader Test Fixture") || text.contains("page"));
    }

    // ---- structure tests, against an in-memory PDF with known geometry (see testpdf.rs) ----

    fn std_engine(tag: &str) -> (MuPdfDocumentEngine, PathBuf) {
        let path = crate::testpdf::write_temp(tag, &crate::testpdf::standard());
        (MuPdfDocumentEngine::open(&path).unwrap(), path)
    }

    #[test]
    fn geometry_reports_page_size_and_a_matrix_that_lands_pdf_points_on_page_space() {
        let (e, path) = std_engine("geom");
        let g = e.geometries().unwrap();
        assert_eq!(g.len(), 2);
        // page 1: letter, rotation 0: PDF (72, 700) -> page space (72, 792-700)
        assert_eq!((g[0].width, g[0].height), (612.0, 792.0));
        let (x, y) = crate::geometry::apply(&g[0].matrix, 72.0, 700.0);
        assert!((x - 72.0).abs() < 1e-3 && (y - 92.0).abs() < 1e-3, "({x},{y})");
        // page 2: CropBox 400x500, rotated 90 -> 500 wide, 400 tall
        assert_eq!((g[1].width, g[1].height), (500.0, 400.0));
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn matrix_agrees_with_where_mupdf_actually_puts_the_text_on_every_page() {
        // The text is drawn at known PDF positions; MuPDF's own text geometry must match what the matrix predicts.
        let (e, path) = std_engine("matrix");
        let g = e.geometries().unwrap();
        for (page, (px, py)) in [(0u32, (72.0f32, 700.0f32)), (1, (100.0, 550.0))] {
            let t = e.page_text(page).unwrap();
            let line = &t.lines[0];
            let (ex, ey) = crate::geometry::apply(&g[page as usize].matrix, px, py);
            // the text's origin is on the baseline: it must be inside the line box horizontally at the start
            // and the baseline must lie within the line's vertical extent (or just below the box for descenders)
            let [bx, by, bw, bh] = line.bbox;
            assert!(ex >= bx - 1.0 && ex <= bx + bw + 1.0, "page {page}: x {ex} not in line box {:?}", line.bbox);
            assert!(ey >= by - 1.0 && ey <= by + bh + 3.0, "page {page}: baseline y {ey} not in line box {:?}", line.bbox);
        }
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn page_text_has_one_char_boundary_per_char_plus_one_and_they_increase() {
        let (e, path) = std_engine("text");
        let t = e.page_text(0).unwrap();
        let hello = t.lines.iter().find(|l| l.text.contains("Hello world")).expect("line present");
        let chars = hello.text.chars().count();
        assert_eq!(hello.xs.len(), chars + 1);
        assert!(hello.xs.windows(2).all(|w| w[1] >= w[0] - 0.01), "boundaries must not go backwards: {:?}", hello.xs);
        assert!((hello.xs[0] - hello.bbox[0]).abs() < 2.0, "first char starts at the line start");
        assert!(t.lines.iter().any(|l| l.text.contains("quick brown fox")));
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn superscript_runs_find_citation_numbers_only() {
        let line = |s: &str, small: &[usize]| -> Vec<(char, f32)> { s.chars().enumerate().map(|(i, c)| (c, if small.contains(&i) { 6.0 } else { 9.0 })).collect() };
        assert_eq!(superscript_runs(&line("manner.4", &[7])), vec![[7, 8]]);
        assert_eq!(superscript_runs(&line("yeast7\u{2013}9 and", &[5, 6, 7])), vec![[5, 8]]);
        assert_eq!(superscript_runs(&line("bacteria,7,10,11", &[9, 10, 11, 12, 13, 14, 15])), vec![[9, 16]]);
        assert!(superscript_runs(&line("m\u{2013}1", &[1, 2])).is_empty(), "a negative exponent is not a citation");
        assert!(superscript_runs(&line("page 12", &[])).is_empty(), "full-size digits are not superscripts");
    }

    #[test]
    fn outline_has_titles_destinations_and_nesting() {
        let (e, path) = std_engine("outline");
        let o = e.outline().unwrap();
        assert_eq!(o.iter().map(|i| i.title.as_str()).collect::<Vec<_>>(), vec!["Chapter 1", "Chapter 2"]);
        assert_eq!(o[0].page, Some(0));
        assert_eq!(o[1].page, Some(1));
        assert_eq!(o[1].children.len(), 1);
        assert_eq!(o[1].children[0].title, "Section 2.1");
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn links_report_internal_pages_and_external_uris_in_page_space() {
        let (e, path) = std_engine("links");
        let l = e.links(0).unwrap();
        assert_eq!(l.len(), 2, "{l:?}");
        let internal = l.iter().find(|x| x.page.is_some()).unwrap();
        assert_eq!(internal.page, Some(1));
        let external = l.iter().find(|x| x.uri.is_some()).unwrap();
        assert_eq!(external.uri.as_deref(), Some("https://example.org/x"));
        // PDF rect y 695..712 -> page space y 80..97
        assert!((internal.rect[1] - 80.0).abs() < 1.0 && (internal.rect[3] - 17.0).abs() < 1.0, "{:?}", internal.rect);
        assert!(e.links(1).unwrap().is_empty());
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn content_bbox_encloses_the_text_and_is_none_for_a_blank_page() {
        let (mut e, path) = std_engine("bbox");
        let [x0, y0, x1, y1] = e.content_bbox(0).unwrap().expect("page 1 has ink");
        assert!(x0 > 60.0 && x0 < 80.0, "left margin ~72pt, got {x0}");
        assert!(y0 > 70.0 && y1 < 160.0 && x1 < 250.0, "{x0} {y0} {x1} {y1}");
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
        let blank = crate::testpdf::write_temp("blank", &crate::testpdf::build(&[crate::testpdf::Spec {
            media: [0.0, 0.0, 200.0, 200.0], crop: None, rotate: 0, text: vec![], links: vec![],
        }]));
        let mut b = MuPdfDocumentEngine::open(&blank).unwrap();
        assert_eq!(b.content_bbox(0).unwrap(), None);
        std::fs::remove_dir_all(blank.parent().unwrap()).ok();
    }

    #[test]
    fn render_view_crops_and_rotates_to_the_expected_pixel_size() {
        let (mut e, path) = std_engine("view");
        let full = e.render_view(0, 1.0, 0, None).unwrap();
        assert_eq!((full.width, full.height), (612, 792));
        let rot = e.render_view(0, 1.0, 90, None).unwrap();
        assert_eq!((rot.width, rot.height), (792, 612));
        let cropped = e.render_view(0, 2.0, 0, Some([50.0, 60.0, 100.0, 40.0])).unwrap();
        assert_eq!((cropped.width, cropped.height), (200, 80));
        let both = e.render_view(0, 1.0, 270, Some([50.0, 60.0, 100.0, 40.0])).unwrap();
        assert_eq!((both.width, both.height), (40, 100));
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn export_embeds_annotations_that_render_and_that_survive_a_reopen() {
        let (e, path) = std_engine("export");
        let t = e.page_text(0).unwrap();
        let line = t.lines.iter().find(|l| l.text.contains("Hello world")).unwrap().bbox;
        let out = path.parent().unwrap().join("out.pdf");
        let n = e
            .export_annotated(&out, &[ExportAnnotation {
                page: 0,
                kind: ExportKind::Highlight,
                rects: vec![line],
                color: [1.0, 0.83, 0.0],
                contents: "note".into(),
            }])
            .unwrap();
        assert_eq!(n, 1);
        let mut re = MuPdfDocumentEngine::open(&out).unwrap();
        let r = re.render(0, 1.0).unwrap();
        // inside the highlighted line, the paper must be yellow-ish (high R, high G, low B), not white
        let (cx, cy) = ((line[0] + line[2] / 2.0) as u32, (line[1] + line[3] - 2.0) as u32);
        let i = ((cy * r.width + cx) * 4) as usize;
        let (pr, pg, pb) = crate::frame::over_white(r.rgba[i], r.rgba[i + 1], r.rgba[i + 2], r.rgba[i + 3]);
        assert!(pr > 200 && pg > 150 && pb < 200, "expected yellow highlight at the line, got ({pr},{pg},{pb})");
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn embedded_annotations_come_back_with_geometry_color_text_and_contents() {
        let (e, path) = std_engine("embedded");
        let t = e.page_text(0).unwrap();
        let line = t.lines.iter().find(|l| l.text.contains("Hello world")).unwrap().bbox;
        let out = path.parent().unwrap().join("emb.pdf");
        e.export_annotated(&out, &[ExportAnnotation { page: 0, kind: ExportKind::Highlight, rects: vec![line], color: [1.0, 0.0, 0.0], contents: "why".into() }]).unwrap();
        assert!(e.embedded_annotations(0).unwrap().is_empty(), "the original has none");
        let re = MuPdfDocumentEngine::open(&out).unwrap();
        let a = re.embedded_annotations(0).unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].kind, "highlight");
        assert_eq!(a[0].contents, "why");
        assert!(a[0].text.contains("Hello world"), "text under the highlight: {:?}", a[0].text);
        let r = a[0].rects[0];
        assert!((r[0] - line[0]).abs() < 2.0 && (r[1] - line[1]).abs() < 2.0, "rect {r:?} vs line {line:?}");
        assert!(a[0].color.unwrap()[0] > 0.9);
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn release_caches_drops_the_document_but_queries_transparently_reopen_it() {
        let mut engine = MuPdfDocumentEngine::open(&fixture("sample.pdf")).unwrap();
        let before = engine.render(0, 1.0).unwrap();
        engine.release_caches();
        // every query kind works after a release
        assert!(engine.page_size(0).is_ok());
        assert!(!engine.search("brown fox").unwrap().is_empty());
        assert!(!engine.extract_text(0).unwrap().is_empty());
        let after = engine.render(0, 1.0).unwrap();
        assert_eq!((before.width, before.height), (after.width, after.height));
        assert_eq!(before.rgba, after.rgba, "a re-opened document must render identically");
    }

    #[test]
    fn close_is_permanent_even_after_a_release() {
        let mut engine = MuPdfDocumentEngine::open(&fixture("sample.pdf")).unwrap();
        engine.release_caches();
        engine.close();
        assert!(engine.page_size(0).is_err());
        assert!(engine.render(0, 1.0).is_err());
    }

    #[test]
    fn close_then_operations_report_error_not_panic() {
        let mut engine = MuPdfDocumentEngine::open(&fixture("sample.pdf")).unwrap();
        engine.close();
        assert!(engine.render(0, 1.0).is_err());
        assert!(engine.page_size(0).is_err());
    }
}
