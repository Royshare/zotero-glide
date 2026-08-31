//! Minimal debug logging (§17 of the brief). Off by default; enabled with
//! `FAST_READER_DEBUG=1`. Only ever called from event-driven code paths
//! (open, navigate, render, cache hit/evict, search, close) -- never from
//! the idle/redraw-request loop, so an idle reader stays silent.

use std::sync::OnceLock;
use std::time::Instant;

fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var("FAST_READER_DEBUG")
            .map(|v| v != "0" && !v.is_empty())
            .unwrap_or(false)
    })
}

fn start_time() -> Instant {
    static START: OnceLock<Instant> = OnceLock::new();
    *START.get_or_init(Instant::now)
}

/// Call once, as early as possible in `main`, so `+Nms` prefixes in later
/// log lines are measured from process start rather than from whenever the
/// first `debug()` call happens to occur.
pub fn init() {
    start_time();
}

pub fn debug(msg: &str) {
    if enabled() {
        eprintln!("[fast-reader] +{}ms {msg}", start_time().elapsed().as_millis());
    }
}
