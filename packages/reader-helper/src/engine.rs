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
}

pub mod mupdf_engine {
    use super::*;
    use mupdf::{DisplayList, Document, Matrix};
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::path::PathBuf;

    /// How many parsed display lists to keep around. Matches the reader's
    /// render-cache radius (current page +/- 1) -- see docs/adr and
    /// `cache::RenderCache`. Small and fixed, not user-configurable in v0.1.
    const DISPLAY_LIST_CACHE_SIZE: usize = 3;

    #[derive(Debug)]
    pub struct MuPdfDocumentEngine {
        path: PathBuf,
        /// `None` while released (see `release_caches`) -- re-opened lazily by
        /// `with_doc` on next use. Interior mutability so `&self` queries
        /// (`page_size`, `search`) can transparently re-open.
        doc: RefCell<Option<Document>>,
        /// Set by `close()`; unlike a release, this is permanent.
        closed: bool,
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
            Ok(RenderedPage {
                width,
                height,
                rgba: samples.to_vec(),
            })
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
