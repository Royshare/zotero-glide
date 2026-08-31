//! The reader's actual behavior -- navigation, zoom, search, and the
//! render/cache/prefetch/evict cycle -- with no windowing dependency. `App`
//! (winit) and the benchmark harness (`src/bin/bench_navigate.rs`) both
//! drive this same code, so a benchmark run exercises the exact cache
//! policy the live GUI uses, not a re-implementation of it.

use crate::cache::RenderCache;
use crate::engine::{DocumentEngine, PageSize, RenderedPage, SearchHit};
use crate::log;
use crate::state::{ReaderState, ZoomMode};

pub const MIN_SCALE: f32 = 0.15;
pub const MAX_SCALE: f32 = 8.0;
pub const ZOOM_STEP: f32 = 1.15;
/// Current page +/- this many neighbors are kept rendered. See docs/adr and
/// the brief's example cache policy (current, current-1, current+1).
pub const CACHE_RADIUS: u32 = 1;
const SCALE_BUCKET: f32 = 0.02;

pub struct ReaderSession<E: DocumentEngine> {
    pub engine: E,
    pub state: ReaderState,
    cache: RenderCache,
    pub search_hits: Vec<SearchHit>,
    pub search_hit_index: usize,
}

impl<E: DocumentEngine> ReaderSession<E> {
    pub fn new(engine: E, state: ReaderState) -> Self {
        Self {
            engine,
            state,
            cache: RenderCache::new(CACHE_RADIUS, SCALE_BUCKET),
            search_hits: Vec::new(),
            search_hit_index: 0,
        }
    }

    pub fn cache_len(&self) -> usize {
        self.cache.len()
    }

    pub fn effective_scale(&self, window_px: (u32, u32)) -> f32 {
        let page = self
            .engine
            .page_size(self.state.page)
            .unwrap_or(PageSize { width: 612.0, height: 792.0 });
        let scale = match self.state.zoom_mode {
            ZoomMode::Fixed => self.state.zoom_scale,
            ZoomMode::FitWidth => window_px.0 as f32 / page.width,
            ZoomMode::FitPage => {
                (window_px.0 as f32 / page.width).min(window_px.1 as f32 / page.height)
            }
        };
        scale.clamp(MIN_SCALE, MAX_SCALE)
    }

    pub fn navigate_to(&mut self, page: u32) {
        self.state.goto_page(page);
        log::debug(&format!("navigate page={}", self.state.page));
    }

    pub fn run_search(&mut self, query: &str) {
        match self.engine.search(query) {
            Ok(hits) => {
                log::debug(&format!(
                    "search query=\"{query}\" hits_on_pages={}",
                    hits.len()
                ));
                self.search_hits = hits;
                self.search_hit_index = 0;
                if let Some(first) = self.search_hits.first() {
                    self.state.goto_page(first.page);
                }
            }
            Err(e) => log::debug(&format!("search failed: {e}")),
        }
    }

    pub fn search_next(&mut self, query: &str, backwards: bool) {
        if self.search_hits.is_empty() {
            self.run_search(query);
            return;
        }
        let n = self.search_hits.len();
        self.search_hit_index = if backwards {
            (self.search_hit_index + n - 1) % n
        } else {
            (self.search_hit_index + 1) % n
        };
        let page = self.search_hits[self.search_hit_index].page;
        self.state.goto_page(page);
    }

    pub fn clear_search(&mut self) {
        self.search_hits.clear();
        self.search_hit_index = 0;
    }

    pub fn set_zoom_mode(&mut self, mode: ZoomMode, window_px: (u32, u32)) {
        self.state.zoom_mode = mode;
        self.invalidate_scale(window_px);
    }

    pub fn zoom_by(&mut self, factor: f32, window_px: (u32, u32)) {
        let current = self.effective_scale(window_px);
        self.state.zoom_mode = ZoomMode::Fixed;
        self.state.zoom_scale = (current * factor).clamp(MIN_SCALE, MAX_SCALE);
        self.invalidate_scale(window_px);
    }

    pub fn invalidate_scale(&mut self, window_px: (u32, u32)) {
        let scale = self.effective_scale(window_px);
        let window = self.cache.window(self.state.page, self.engine.page_count());
        self.cache.evict_outside(&window, scale);
    }

    /// Ensures the current page (and its cache-window neighbors) are
    /// rendered at `window_px`'s effective scale, evicts anything outside
    /// that window, and returns the current page's render. This is the
    /// single method both the GUI's `RedrawRequested` handler and the
    /// benchmark harness call per "frame".
    pub fn prepare_frame(&mut self, window_px: (u32, u32)) -> Option<&RenderedPage> {
        let scale = self.effective_scale(window_px);
        let page = self.state.page;

        if self.cache.get(page, scale).is_some() {
            log::debug(&format!("cache hit page={page} scale={scale:.3}"));
        } else {
            log::debug(&format!("cache miss page={page} scale={scale:.3}, rendering"));
            match self.engine.render(page, scale) {
                Ok(r) => self.cache.insert(page, scale, r),
                Err(e) => {
                    log::debug(&format!("render failed page={page}: {e}"));
                    return None;
                }
            }
        }

        let window = self.cache.window(page, self.engine.page_count());
        for p in &window {
            if *p != page && self.cache.get(*p, scale).is_none() {
                if let Ok(r) = self.engine.render(*p, scale) {
                    self.cache.insert(*p, scale, r);
                }
            }
        }
        self.cache.evict_outside(&window, scale);

        self.cache.get(page, scale)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::mupdf_engine::MuPdfDocumentEngine;
    use std::path::PathBuf;

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures").join(name)
    }

    fn session() -> ReaderSession<MuPdfDocumentEngine> {
        let engine = MuPdfDocumentEngine::open(&fixture("sample.pdf")).unwrap();
        let state = ReaderState::new(fixture("sample.pdf"), engine.page_count());
        ReaderSession::new(engine, state)
    }

    #[test]
    fn navigate_to_clamps_within_page_bounds() {
        let mut s = session();
        s.navigate_to(1);
        assert_eq!(s.state.page, 1);
        s.navigate_to(999);
        assert_eq!(s.state.page, s.engine.page_count() - 1, "navigating past the end should clamp, not panic");
    }

    #[test]
    fn fit_width_scale_matches_window_width_over_page_width() {
        let s = session();
        let page_w = s.engine.page_size(0).unwrap().width;
        let scale = s.effective_scale((page_w as u32 * 2, 5000));
        assert!((scale - 2.0).abs() < 0.01, "expected ~2.0, got {scale}");
    }

    #[test]
    fn fit_page_scale_is_the_tighter_of_width_and_height_constraints() {
        let s = session();
        let size = s.engine.page_size(0).unwrap();
        // window narrower (relatively) than the page -> width should govern
        let scale = s.effective_scale((size.width as u32, size.height as u32 * 4));
        assert!((scale - 1.0).abs() < 0.01, "expected width-constrained ~1.0, got {scale}");
    }

    #[test]
    fn zoom_by_multiplies_current_scale_and_switches_to_fixed_mode() {
        let mut s = session();
        s.set_zoom_mode(ZoomMode::Fixed, (900, 1150));
        s.state.zoom_scale = 1.0;
        s.zoom_by(ZOOM_STEP, (900, 1150));
        assert!((s.state.zoom_scale - ZOOM_STEP).abs() < 0.001);
        assert_eq!(s.state.zoom_mode, ZoomMode::Fixed);
    }

    #[test]
    fn zoom_by_clamps_to_min_and_max_scale() {
        let mut s = session();
        s.state.zoom_mode = ZoomMode::Fixed;
        s.state.zoom_scale = MIN_SCALE;
        s.zoom_by(0.01, (900, 1150));
        assert_eq!(s.state.zoom_scale, MIN_SCALE, "must not go below MIN_SCALE");

        s.state.zoom_scale = MAX_SCALE;
        s.zoom_by(100.0, (900, 1150));
        assert_eq!(s.state.zoom_scale, MAX_SCALE, "must not exceed MAX_SCALE");
    }

    #[test]
    fn zoom_change_invalidates_cache_for_the_old_scale() {
        let mut s = session();
        let window_px = (900u32, 1150u32);
        s.prepare_frame(window_px);
        assert!(s.cache_len() > 0);
        let old_scale = s.effective_scale(window_px);

        s.zoom_by(ZOOM_STEP, window_px);
        let new_scale = s.effective_scale(window_px);
        assert!((new_scale - old_scale).abs() > 0.01, "zoom_by should actually change the effective scale");
        // invalidate_scale (called by zoom_by) evicts anything not at the new scale
        assert_eq!(s.cache_len(), 0, "old-scale renders must be evicted, not accumulate");
    }

    #[test]
    fn run_search_finds_hits_and_jumps_to_the_first_hit_page() {
        let mut s = session();
        s.navigate_to(2); // start away from the expected hit page
        s.run_search("brown fox");
        assert!(!s.search_hits.is_empty());
        assert_eq!(s.state.page, s.search_hits[0].page);
    }

    #[test]
    fn search_next_cycles_through_hits_and_wraps_around() {
        let mut s = session();
        s.run_search("synthetic");
        let n = s.search_hits.len();
        if n < 2 {
            // fixture-dependent; still assert the no-crash/no-hang wraparound contract
            s.search_next("synthetic", false);
            return;
        }
        let first_index = s.search_hit_index;
        for _ in 0..n {
            s.search_next("synthetic", false);
        }
        assert_eq!(s.search_hit_index, first_index, "cycling through all hits should wrap back to the start");
    }

    #[test]
    fn search_for_nothing_present_leaves_page_unchanged() {
        let mut s = session();
        s.navigate_to(1);
        s.run_search("xyzzy-not-present-anywhere");
        assert!(s.search_hits.is_empty());
        assert_eq!(s.state.page, 1);
    }

    #[test]
    fn clear_search_resets_hits_and_index() {
        let mut s = session();
        s.run_search("brown fox");
        assert!(!s.search_hits.is_empty());
        s.clear_search();
        assert!(s.search_hits.is_empty());
        assert_eq!(s.search_hit_index, 0);
    }
}
