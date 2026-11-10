// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

//! Headless navigation benchmark: drives `ReaderSession` (the same
//! render/cache/prefetch/evict code path `App`'s `RedrawRequested` handler
//! uses) through a document without opening a window, and reports RSS and
//! bounded-cache-size at checkpoints.
//!
//! This exists because the sandboxed dev environment used to build v0.1
//! cannot inject synthetic keyboard/window events into the real windowed
//! binary (no OS input-automation permission), so "memory after navigating
//! N pages" can't be measured by driving the actual GUI end-to-end here.
//! Since `ReaderSession` (src/session.rs) is the exact same struct the GUI
//! calls on every `RedrawRequested`, walking it directly is a faithful
//! stand-in for "the user pressed PageDown N times" -- see
//! docs/benchmark-methodology.md for the full rationale and its limits.
//!
//! Usage: bench_navigate <pdf-path> [window_w] [window_h]

use fast_reader_helper::engine::mupdf_engine::MuPdfDocumentEngine;
use fast_reader_helper::engine::DocumentEngine;
use fast_reader_helper::session::ReaderSession;
use fast_reader_helper::state::ReaderState;
use std::time::Instant;

/// Prefers macOS's `footprint` (phys_footprint -- the same metric Activity
/// Monitor and the OS's jetsam/memory-pressure logic use) over raw `ps`
/// RSS, which double-counts shared framework pages. Falls back to `ps` RSS
/// where `footprint` isn't available (non-macOS, or sandboxed/no-privilege
/// environments). See docs/benchmark-methodology.md.
fn rss_kb() -> Option<u64> {
    let pid = std::process::id();
    if let Ok(out) = std::process::Command::new("footprint").arg(pid.to_string()).output() {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            if let Some(line) = text.lines().find(|l| l.contains("phys_footprint:")) {
                if let Some(mb_str) = line.split(':').nth(1) {
                    if let Some(num) = mb_str.trim().strip_suffix("MB").map(str::trim) {
                        if let Ok(mb) = num.parse::<f64>() {
                            return Some((mb * 1024.0).round() as u64);
                        }
                    }
                }
            }
        }
    }
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

fn report(label: &str, page: u32, cache_len: usize, start: Instant) {
    println!(
        "{{\"checkpoint\":\"{}\",\"page\":{},\"cache_entries\":{},\"rss_kb\":{},\"elapsed_ms\":{}}}",
        label,
        page,
        cache_len,
        rss_kb().unwrap_or(0),
        start.elapsed().as_millis()
    );
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: bench_navigate <pdf-path>");
    let window_w: u32 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(900);
    let window_h: u32 = std::env::args().nth(3).and_then(|s| s.parse().ok()).unwrap_or(1150);

    let start = Instant::now();
    let engine = MuPdfDocumentEngine::open(std::path::Path::new(&path))
        .unwrap_or_else(|e| panic!("open failed: {e}"));
    let page_count = engine.page_count();
    let state = ReaderState::new(std::path::PathBuf::from(&path), page_count);
    let mut session = ReaderSession::new(engine, state);

    report("startup", 0, session.cache_len(), start);

    session.prepare_frame((window_w, window_h));
    report("first_page", 0, session.cache_len(), start);

    let checkpoints = [20u32, 100u32];
    let mut max_cache_len = session.cache_len();
    for target in 0..page_count {
        session.navigate_to(target);
        session.prepare_frame((window_w, window_h));
        max_cache_len = max_cache_len.max(session.cache_len());
        if checkpoints.contains(&(target + 1)) {
            report(
                &format!("after_{}_pages", target + 1),
                target,
                session.cache_len(),
                start,
            );
        }
        if target + 1 >= 100 {
            break;
        }
    }
    println!(
        "{{\"checkpoint\":\"summary\",\"page_count\":{page_count},\"max_cache_entries_observed\":{max_cache_len}}}"
    );
}
