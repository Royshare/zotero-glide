//! Window, input, and blit-to-surface. Delegates all reader behavior to
//! `ReaderSession`; knows nothing about MuPDF types directly (see docs/adr).
//!
//! v0.1 deliberately draws no on-canvas UI chrome: page/zoom/search status
//! is shown in the OS window title bar. This keeps the renderer to "blit a
//! pixmap" with no bitmap-font/text-layout dependency, in line with the
//! brief's "avoid an elaborate reader UI" non-goal and "avoid speculative
//! abstractions" principle. See docs/future-ipc.md and the v0.2 notes in
//! README for what a real overlay UI would need.

use crate::engine::DocumentEngine;
use crate::log;
use crate::session::{ReaderSession, ZOOM_STEP};
use crate::state::{ReaderState, ZoomMode};
use std::num::NonZeroU32;
use std::rc::Rc;
use winit::application::ApplicationHandler;
use winit::event::{ElementState, KeyEvent, WindowEvent};
use winit::event_loop::ActiveEventLoop;
use winit::keyboard::{Key, ModifiersState, NamedKey};
use winit::window::{Window, WindowId};

const DEFAULT_WINDOW_SIZE: (u32, u32) = (900, 1150);

/// Requested window position/size for "docked" placement next to Zotero's
/// own window (v0.2: visual/positional integration only -- see
/// docs/adr's ADR and STATUS.md for why this stays a separate process
/// rather than a literal embedded tab). `x`/`y` are the target position
/// for the Fast Reader window itself (the caller -- fastReader.ts --
/// computes this as Zotero's own window right edge, not Zotero's own
/// position), and `height` matches Zotero's window height. Width is left
/// at the normal default; only position and height change for "docked."
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DockGeometry {
    pub x: i32,
    pub y: i32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum UiMode {
    Normal,
    Search,
    GotoPage,
}

pub struct App<E: DocumentEngine> {
    session: ReaderSession<E>,
    window: Option<Rc<Window>>,
    surface: Option<softbuffer::Surface<Rc<Window>, Rc<Window>>>,
    modifiers: ModifiersState,
    mode: UiMode,
    input_buffer: String,
    file_label: String,
    first_frame_logged: bool,
    dock: Option<DockGeometry>,
}

impl<E: DocumentEngine> App<E> {
    pub fn new(engine: E, state: ReaderState, dock: Option<DockGeometry>) -> Self {
        let file_label = state
            .file
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "document.pdf".to_string());
        Self {
            session: ReaderSession::new(engine, state),
            window: None,
            surface: None,
            modifiers: ModifiersState::empty(),
            mode: UiMode::Normal,
            input_buffer: String::new(),
            file_label,
            first_frame_logged: false,
            dock,
        }
    }

    fn window_px(&self) -> (u32, u32) {
        self.window
            .as_ref()
            .map(|w| {
                let s = w.inner_size();
                (s.width.max(1), s.height.max(1))
            })
            .unwrap_or(DEFAULT_WINDOW_SIZE)
    }

    fn update_title(&self) {
        let Some(window) = &self.window else { return };
        let page_count = self.session.engine.page_count();
        let zoom_pct = (self.session.effective_scale(self.window_px()) * 100.0).round() as i32;
        let mut title = format!(
            "{} — page {}/{} — {}%",
            self.file_label,
            self.session.state.page + 1,
            page_count,
            zoom_pct
        );
        match self.mode {
            UiMode::Search => {
                if self.session.search_hits.is_empty() {
                    title.push_str(&format!(" — search: \"{}\"", self.input_buffer));
                } else {
                    let total: usize =
                        self.session.search_hits.iter().map(|h| h.quads.len()).sum();
                    title.push_str(&format!(
                        " — search: \"{}\" (page {}/{} matches, {} pages match, {} hits total)",
                        self.input_buffer,
                        self.session.search_hit_index + 1,
                        self.session.search_hits.len(),
                        self.session.search_hits.len(),
                        total
                    ));
                }
            }
            UiMode::GotoPage => {
                title.push_str(&format!(" — go to page: {}_", self.input_buffer));
            }
            UiMode::Normal => {}
        }
        window.set_title(&title);
    }

    fn request_redraw(&self) {
        if let Some(w) = &self.window {
            w.request_redraw();
        }
    }

    fn enter_mode(&mut self, mode: UiMode) {
        self.mode = mode;
        self.input_buffer.clear();
        if mode == UiMode::Search {
            self.session.clear_search();
        }
        self.update_title();
    }

    fn exit_mode(&mut self) {
        self.mode = UiMode::Normal;
        self.input_buffer.clear();
        self.session.clear_search();
        self.update_title();
    }

    fn handle_key(&mut self, event: &KeyEvent, event_loop: &ActiveEventLoop) {
        if event.state != ElementState::Pressed {
            return;
        }
        let primary_mod = if cfg!(target_os = "macos") {
            self.modifiers.super_key()
        } else {
            self.modifiers.control_key()
        };
        let window_px = self.window_px();

        match self.mode {
            UiMode::Search | UiMode::GotoPage => match &event.logical_key {
                Key::Named(NamedKey::Escape) => self.exit_mode(),
                Key::Named(NamedKey::Enter) => {
                    if self.mode == UiMode::Search {
                        self.session
                            .search_next(&self.input_buffer, self.modifiers.shift_key());
                    } else {
                        if let Ok(n) = self.input_buffer.parse::<u32>() {
                            if n >= 1 {
                                self.session.navigate_to(n - 1);
                            }
                        }
                        self.exit_mode();
                    }
                    self.request_redraw();
                }
                Key::Named(NamedKey::Backspace) => {
                    self.input_buffer.pop();
                }
                Key::Character(s) => {
                    let ok = self.mode == UiMode::Search || s.chars().all(|c| c.is_ascii_digit());
                    if ok {
                        self.input_buffer.push_str(s);
                    }
                }
                _ => {}
            },
            UiMode::Normal => {
                if primary_mod {
                    match &event.logical_key {
                        Key::Character(s) if s.eq_ignore_ascii_case("f") => {
                            self.enter_mode(UiMode::Search);
                            return;
                        }
                        Key::Character(s) if s.eq_ignore_ascii_case("g") => {
                            self.enter_mode(UiMode::GotoPage);
                            return;
                        }
                        _ => {}
                    }
                }
                match &event.logical_key {
                    Key::Named(NamedKey::ArrowRight | NamedKey::PageDown | NamedKey::Space) => {
                        self.session.navigate_to(self.session.state.page + 1);
                        self.request_redraw();
                    }
                    Key::Named(NamedKey::ArrowLeft | NamedKey::PageUp) => {
                        self.session
                            .navigate_to(self.session.state.page.saturating_sub(1));
                        self.request_redraw();
                    }
                    Key::Character(s) if s.as_str() == "+" || s.as_str() == "=" => {
                        self.session.zoom_by(ZOOM_STEP, window_px);
                        self.request_redraw();
                    }
                    Key::Character(s) if s.as_str() == "-" => {
                        self.session.zoom_by(1.0 / ZOOM_STEP, window_px);
                        self.request_redraw();
                    }
                    Key::Character(s) if s.as_str() == "1" => {
                        self.session.set_zoom_mode(ZoomMode::FitWidth, window_px);
                        self.request_redraw();
                    }
                    Key::Character(s) if s.as_str() == "2" => {
                        self.session.set_zoom_mode(ZoomMode::FitPage, window_px);
                        self.request_redraw();
                    }
                    Key::Named(NamedKey::Escape) => event_loop.exit(),
                    _ => {}
                }
            }
        }
        self.update_title();
    }

    fn draw(&mut self) {
        let Some(window) = self.window.clone() else { return };
        let size = window.inner_size();
        let (w, h) = (size.width.max(1), size.height.max(1));
        {
            let Some(surface) = self.surface.as_mut() else { return };
            if surface
                .resize(NonZeroU32::new(w).unwrap(), NonZeroU32::new(h).unwrap())
                .is_err()
            {
                return;
            }
        }

        let Some(rendered) = self.session.prepare_frame((w, h)) else { return };
        let Some(surface) = self.surface.as_mut() else { return };

        let mut buffer = match surface.buffer_mut() {
            Ok(b) => b,
            Err(_) => return,
        };
        blit_centered(&mut buffer, w, h, rendered, BACKGROUND_ARGB);

        let _ = buffer.present();
        if !self.first_frame_logged {
            self.first_frame_logged = true;
            log::debug("first frame presented");
        }
    }
}

const BACKGROUND_ARGB: u32 = 0x00303030;

/// Centers `page` on a `dst_w`x`dst_h` canvas already filled by the caller's
/// surface, in softbuffer's `0RRGGBB` pixel format. Pure and window-free so
/// the pixel math can be unit-tested without a real window/surface.
fn blit_centered(
    dst: &mut [u32],
    dst_w: u32,
    dst_h: u32,
    page: &crate::engine::RenderedPage,
    background: u32,
) {
    dst.fill(background);

    let ox = ((dst_w as i64 - page.width as i64) / 2).max(0) as u32;
    let oy = ((dst_h as i64 - page.height as i64) / 2).max(0) as u32;
    let copy_w = page.width.min(dst_w.saturating_sub(ox));
    let copy_h = page.height.min(dst_h.saturating_sub(oy));

    for y in 0..copy_h {
        let src_row = (y * page.width * 4) as usize;
        let dst_row = ((y + oy) * dst_w + ox) as usize;
        for x in 0..copy_w {
            let i = src_row + (x * 4) as usize;
            if i + 3 >= page.rgba.len() {
                break;
            }
            let (pr, pg, pb, a) = (page.rgba[i], page.rgba[i + 1], page.rgba[i + 2], page.rgba[i + 3]);
            // Premultiplied RGBA -> composite over white; see frame.rs.
            let (r, g, b) = crate::frame::over_white(pr, pg, pb, a);
            dst[dst_row + x as usize] = ((r as u32) << 16) | ((g as u32) << 8) | b as u32;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::RenderedPage;

    fn solid_page(w: u32, h: u32, rgb: (u8, u8, u8)) -> RenderedPage {
        let mut rgba = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..(w * h) {
            rgba.extend_from_slice(&[rgb.0, rgb.1, rgb.2, 255]);
        }
        RenderedPage { width: w, height: h, rgba }
    }

    #[test]
    fn centers_smaller_page_on_larger_canvas_with_background_border() {
        let page = solid_page(2, 2, (0x11, 0x22, 0x33));
        let mut dst = vec![0u32; 4 * 4];
        blit_centered(&mut dst, 4, 4, &page, 0x00AAAAAA);

        assert_eq!(dst[0], 0x00AAAAAA);
        assert_eq!(dst[1 * 4 + 1], 0x00112233);
        assert_eq!(dst[2 * 4 + 2], 0x00112233);
    }

    #[test]
    fn exact_fit_covers_entire_canvas() {
        let page = solid_page(3, 2, (0xFF, 0x00, 0x80));
        let mut dst = vec![0u32; 3 * 2];
        blit_centered(&mut dst, 3, 2, &page, 0x0);
        assert!(dst.iter().all(|&px| px == 0x00FF0080));
    }

    #[test]
    fn larger_page_than_canvas_is_cropped_not_panicking() {
        let page = solid_page(5, 5, (0x01, 0x02, 0x03));
        let mut dst = vec![0u32; 2 * 2];
        blit_centered(&mut dst, 2, 2, &page, 0x0);
        assert!(dst.iter().all(|&px| px == 0x00010203));
    }

    #[test]
    fn row_major_layout_is_preserved() {
        let w = 2;
        let h = 2;
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        rgba[0..4].copy_from_slice(&[255, 0, 0, 255]);
        rgba[4..8].copy_from_slice(&[255, 0, 0, 255]);
        rgba[8..12].copy_from_slice(&[0, 0, 255, 255]);
        rgba[12..16].copy_from_slice(&[0, 0, 255, 255]);
        let page = RenderedPage { width: w, height: h, rgba };
        let mut dst = vec![0u32; (w * h) as usize];
        blit_centered(&mut dst, w, h, &page, 0x0);
        assert_eq!(dst[0], 0x00FF0000);
        assert_eq!(dst[1], 0x00FF0000);
        assert_eq!(dst[2], 0x000000FF);
        assert_eq!(dst[3], 0x000000FF);
    }

    #[test]
    fn fully_transparent_pixels_composite_to_white_not_black() {
        // Regression test: MuPDF clears unpainted page area to fully
        // transparent black (0,0,0,0), not white, when rendering with
        // alpha=true (fz_new_pixmap_from_display_list: `if (alpha)
        // fz_clear_pixmap(...)`). A naive blit that copies RGB and drops
        // alpha renders every unpainted part of every page as solid black.
        let page = RenderedPage {
            width: 1,
            height: 1,
            rgba: vec![0, 0, 0, 0], // premultiplied black, alpha=0
        };
        let mut dst = vec![0u32; 1];
        blit_centered(&mut dst, 1, 1, &page, 0x0);
        assert_eq!(dst[0], 0x00FFFFFF, "transparent page background must composite to white");
    }

    #[test]
    fn opaque_pixels_are_unaffected_by_the_white_composite() {
        let page = RenderedPage {
            width: 1,
            height: 1,
            rgba: vec![0x10, 0x20, 0x30, 255], // fully opaque ink
        };
        let mut dst = vec![0u32; 1];
        blit_centered(&mut dst, 1, 1, &page, 0x0);
        assert_eq!(dst[0], 0x00102030);
    }

    #[test]
    fn partial_alpha_blends_premultiplied_color_toward_white() {
        // Premultiplied 50%-opaque mid-gray ink (~0x80 alpha) should land
        // roughly halfway between its own color and white, not show the
        // raw premultiplied (too-dark) color unmodified.
        let page = RenderedPage {
            width: 1,
            height: 1,
            rgba: vec![0x40, 0x40, 0x40, 0x80], // premultiplied gray at ~50% alpha
        };
        let mut dst = vec![0u32; 1];
        blit_centered(&mut dst, 1, 1, &page, 0x0);
        let packed = dst[0];
        let r = ((packed >> 16) & 0xFF) as u8;
        assert!(r > 0x40 && r < 0xFF, "expected a blend toward white, got {r:#x}");
    }
}

impl<E: DocumentEngine> ApplicationHandler for App<E> {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let mut attrs = Window::default_attributes().with_title(&self.file_label);
        attrs = match self.dock {
            Some(dock) => attrs
                .with_position(winit::dpi::LogicalPosition::new(dock.x, dock.y))
                .with_inner_size(winit::dpi::LogicalSize::new(DEFAULT_WINDOW_SIZE.0, dock.height)),
            None => attrs.with_inner_size(winit::dpi::LogicalSize::new(
                DEFAULT_WINDOW_SIZE.0,
                DEFAULT_WINDOW_SIZE.1,
            )),
        };
        let window = match event_loop.create_window(attrs) {
            Ok(w) => Rc::new(w),
            Err(e) => {
                eprintln!("[fast-reader] failed to create window: {e}");
                event_loop.exit();
                return;
            }
        };
        let context = match softbuffer::Context::new(window.clone()) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[fast-reader] failed to create render context: {e}");
                event_loop.exit();
                return;
            }
        };
        let surface = match softbuffer::Surface::new(&context, window.clone()) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[fast-reader] failed to create render surface: {e}");
                event_loop.exit();
                return;
            }
        };
        self.window = Some(window);
        self.surface = Some(surface);
        self.update_title();
        self.request_redraw();
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => {
                log::debug("window close requested, releasing document resources");
                self.session.engine.close();
                event_loop.exit();
            }
            WindowEvent::Resized(_) => {
                self.session.invalidate_scale(self.window_px());
                self.update_title();
                self.request_redraw();
            }
            WindowEvent::ModifiersChanged(m) => {
                self.modifiers = m.state();
            }
            WindowEvent::KeyboardInput { event, .. } => {
                self.handle_key(&event, event_loop);
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let dy = match delta {
                    winit::event::MouseScrollDelta::LineDelta(_, y) => y,
                    winit::event::MouseScrollDelta::PixelDelta(p) => (p.y / 40.0) as f32,
                };
                if dy.abs() >= 1.0 {
                    if dy > 0.0 {
                        self.session
                            .navigate_to(self.session.state.page.saturating_sub(1));
                    } else {
                        self.session.navigate_to(self.session.state.page + 1);
                    }
                    self.update_title();
                    self.request_redraw();
                }
            }
            WindowEvent::RedrawRequested => {
                self.draw();
            }
            _ => {}
        }
    }
}
