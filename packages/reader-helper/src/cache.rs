//! Bounded render cache: current page, plus `radius` neighbors on each
//! side. This is the whole cache policy -- deliberately not an LRU or a
//! generic cache crate, because the eviction rule the product needs
//! ("don't grow with pages visited") is simpler than that: it's just "keep
//! what's near where the reader is now."

use crate::engine::RenderedPage;
use crate::log;
use std::collections::HashMap;

/// Key: (page, quantized scale). Quantizing scale keeps a small zoom jitter
/// (e.g. repeated fit-width recalculation) from spawning near-duplicate
/// cache entries.
type CacheKey = (u32, u32);

pub struct RenderCache {
    radius: u32,
    scale_bucket: f32,
    entries: HashMap<CacheKey, RenderedPage>,
    order: Vec<CacheKey>, // insertion order, oldest-outside-window first
}

fn quantize(scale: f32, bucket: f32) -> u32 {
    (scale / bucket).round() as u32
}

impl RenderCache {
    /// `radius` pages are kept on either side of `current`; `scale_bucket`
    /// controls how finely zoom levels are treated as distinct (e.g. 0.05
    /// groups scales within 5% together).
    pub fn new(radius: u32, scale_bucket: f32) -> Self {
        Self {
            radius,
            scale_bucket,
            entries: HashMap::new(),
            order: Vec::new(),
        }
    }

    pub fn get(&self, page: u32, scale: f32) -> Option<&RenderedPage> {
        self.entries.get(&(page, quantize(scale, self.scale_bucket)))
    }

    pub fn insert(&mut self, page: u32, scale: f32, rendered: RenderedPage) {
        let key = (page, quantize(scale, self.scale_bucket));
        if !self.entries.contains_key(&key) {
            self.order.push(key);
        }
        self.entries.insert(key, rendered);
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Which pages should be kept for `current` at the active scale. Callers
    /// use this to decide what to prefetch and pass to `evict_outside`.
    pub fn window(&self, current: u32, page_count: u32) -> Vec<u32> {
        let lo = current.saturating_sub(self.radius);
        let hi = (current + self.radius).min(page_count.saturating_sub(1));
        (lo..=hi).collect()
    }

    /// Drop every cached render that is neither for a page in `keep_pages`
    /// nor at `keep_scale`. Called on navigation (page changed) and on zoom
    /// changed (all pages, new scale -- old-scale pixmaps are now useless).
    pub fn evict_outside(&mut self, keep_pages: &[u32], keep_scale: f32) {
        let keep_bucket = quantize(keep_scale, self.scale_bucket);
        let before = self.entries.len();
        self.entries
            .retain(|(page, bucket), _| keep_pages.contains(page) && *bucket == keep_bucket);
        self.order.retain(|k| self.entries.contains_key(k));
        let evicted = before - self.entries.len();
        if evicted > 0 {
            log::debug(&format!("cache evict {evicted} entries (kept {})", self.entries.len()));
        }
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(w: u32, h: u32) -> RenderedPage {
        RenderedPage {
            width: w,
            height: h,
            rgba: vec![0; (w * h * 4) as usize],
        }
    }

    #[test]
    fn window_is_bounded_by_radius() {
        let cache = RenderCache::new(1, 0.05);
        assert_eq!(cache.window(5, 100), vec![4, 5, 6]);
    }

    #[test]
    fn window_clamps_at_document_edges() {
        let cache = RenderCache::new(1, 0.05);
        assert_eq!(cache.window(0, 100), vec![0, 1]);
        assert_eq!(cache.window(99, 100), vec![98, 99]);
    }

    #[test]
    fn navigation_evicts_pages_outside_window_and_size_stays_bounded() {
        let mut cache = RenderCache::new(1, 0.05);
        for p in 0..3 {
            cache.insert(p, 1.0, page(10, 10));
        }
        assert_eq!(cache.len(), 3);

        // simulate reading forward one page at a time through a 200-page doc
        let mut max_len = cache.len();
        for current in 1..200u32 {
            let window = cache.window(current, 200);
            for p in &window {
                if cache.get(*p, 1.0).is_none() {
                    cache.insert(*p, 1.0, page(10, 10));
                }
            }
            cache.evict_outside(&window, 1.0);
            max_len = max_len.max(cache.len());
        }
        // radius=1 => window size never exceeds 3; cache must never grow past that
        assert!(max_len <= 3, "cache grew unbounded: max_len={max_len}");
    }

    #[test]
    fn zoom_change_evicts_stale_scale_entries() {
        let mut cache = RenderCache::new(1, 0.05);
        cache.insert(5, 1.0, page(10, 10));
        cache.insert(6, 1.0, page(10, 10));
        assert!(cache.get(5, 1.0).is_some());

        cache.evict_outside(&[5, 6], 2.0);
        assert!(cache.get(5, 1.0).is_none(), "old-scale render should be evicted");
        assert_eq!(cache.len(), 0);
    }

    #[test]
    fn cache_hit_avoids_recompute_marker() {
        let mut cache = RenderCache::new(1, 0.05);
        cache.insert(5, 1.0, page(10, 10));
        assert!(cache.get(5, 1.0).is_some());
        assert!(cache.get(5, 1.0).is_some(), "second get should still hit");
        assert!(cache.get(6, 1.0).is_none());
    }
}
