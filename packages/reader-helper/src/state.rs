// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

//! In-memory reader state. No persistence in v0.1 (see §10 of the brief) --
//! but the fields are chosen so that a future `attachmentKey` +
//! `scrollPosition` persistence layer (docs/future-ipc.md) is a pure
//! addition, not a reshape.

use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ZoomMode {
    FitWidth,
    FitPage,
    Fixed,
}

#[derive(Debug, Clone)]
pub struct ReaderState {
    pub file: PathBuf,
    pub page: u32,
    pub page_count: u32,
    pub zoom_mode: ZoomMode,
    pub zoom_scale: f32,
    pub search_query: String,
    pub search_active: bool,
}

impl ReaderState {
    pub fn new(file: PathBuf, page_count: u32) -> Self {
        Self {
            file,
            page: 0,
            page_count,
            zoom_mode: ZoomMode::FitWidth,
            zoom_scale: 1.0,
            search_query: String::new(),
            search_active: false,
        }
    }

    pub fn goto_page(&mut self, page: u32) {
        self.page = page.min(self.page_count.saturating_sub(1));
    }

    pub fn next_page(&mut self) {
        self.goto_page(self.page + 1);
    }

    pub fn prev_page(&mut self) {
        self.page = self.page.saturating_sub(1);
    }
}
