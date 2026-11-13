// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

//! Pure geometry shared by the engine and the serve protocol.
//!
//! Coordinate spaces:
//! - **PDF space**: PDF user space, origin bottom-left, y up. This is what
//!   Zotero stores in annotation positions.
//! - **Page space**: MuPDF's page space after the page's own `/Rotate` and
//!   `/CropBox`: origin top-left, y down, in points. Text geometry and search
//!   hits are reported in this space.
//! - **View space**: page space after an optional crop and an extra view rotation
//!   (multiples of 90 degrees); what is actually drawn.

/// `[a, b, c, d, e, f]`: x' = a*x + c*y + e, y' = b*x + d*y + f.
pub type Matrix = [f32; 6];

pub fn apply(m: &Matrix, x: f32, y: f32) -> (f32, f32) {
    (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
}

/// Inverse of an affine matrix (None if singular).
pub fn invert(m: &Matrix) -> Option<Matrix> {
    let det = m[0] * m[3] - m[1] * m[2];
    if det.abs() < 1e-9 {
        return None;
    }
    let (a, b, c, d) = (m[3] / det, -m[1] / det, -m[2] / det, m[0] / det);
    Some([a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])])
}

/// PDF user space -> page space, for a page with the given `/Rotate`
/// (clockwise, multiple of 90) and effective box `[x0, y0, x1, y1]`
/// (CropBox, defaulting to MediaBox, in PDF space; normalized so x0<x1, y0<y1).
pub fn pdf_to_page_matrix(rotation: i32, b: [f32; 4]) -> Matrix {
    let (x0, y0, x1, y1) = (b[0], b[1], b[2], b[3]);
    // Unrotated page space: px = X - x0, py = y1 - Y; W = x1 - x0, H = y1 - y0.
    match rotation.rem_euclid(360) {
        // clockwise 90: x' = H - py = Y - y0 ; y' = px = X - x0
        90 => [0.0, 1.0, 1.0, 0.0, -y0, -x0],
        // 180: x' = W - px = x1 - X ; y' = H - py = Y - y0
        180 => [-1.0, 0.0, 0.0, 1.0, x1, -y0],
        // clockwise 270: x' = py = y1 - Y ; y' = W - px = x1 - X
        270 => [0.0, -1.0, -1.0, 0.0, y1, x1],
        _ => [1.0, 0.0, 0.0, -1.0, -x0, y1],
    }
}

/// Size of a page of `w` x `h` (unrotated, in points) after rotating by `deg`.
pub fn rotated_size(w: f32, h: f32, deg: u32) -> (f32, f32) {
    if deg % 180 == 90 { (h, w) } else { (w, h) }
}

/// Maps a point in page space of a `cw` x `ch` area (already cropped) to view space
/// after rotating the area clockwise by `deg`.
pub fn rotate_point(x: f32, y: f32, cw: f32, ch: f32, deg: u32) -> (f32, f32) {
    match deg % 360 {
        90 => (ch - y, x),
        180 => (cw - x, ch - y),
        270 => (y, cw - x),
        _ => (x, y),
    }
}

/// Copies the `[x, y, w, h]` pixel rectangle (clamped to the image) out of `rgba`.
pub fn crop_pixels(rgba: &[u8], w: u32, h: u32, x: u32, y: u32, cw: u32, ch: u32) -> (Vec<u8>, u32, u32) {
    let x = x.min(w.saturating_sub(1));
    let y = y.min(h.saturating_sub(1));
    let cw = cw.min(w - x).max(1);
    let ch = ch.min(h - y).max(1);
    let mut out = Vec::with_capacity((cw * ch * 4) as usize);
    for row in y..y + ch {
        let start = ((row * w + x) * 4) as usize;
        out.extend_from_slice(&rgba[start..start + (cw * 4) as usize]);
    }
    (out, cw, ch)
}

/// Rotates an RGBA image clockwise by `deg` (0/90/180/270). Returns the new buffer and size.
pub fn rotate_pixels(rgba: &[u8], w: u32, h: u32, deg: u32) -> (Vec<u8>, u32, u32) {
    let deg = deg % 360;
    if deg == 0 {
        return (rgba.to_vec(), w, h);
    }
    let (nw, nh) = if deg == 180 { (w, h) } else { (h, w) };
    let mut out = vec![0u8; rgba.len()];
    for y in 0..h {
        for x in 0..w {
            let (nx, ny) = match deg {
                90 => (h - 1 - y, x),
                180 => (w - 1 - x, h - 1 - y),
                _ => (y, w - 1 - x), // 270
            };
            let s = ((y * w + x) * 4) as usize;
            let d = ((ny * nw + nx) * 4) as usize;
            out[d..d + 4].copy_from_slice(&rgba[s..s + 4]);
        }
    }
    (out, nw, nh)
}

/// Bounding box `[x0, y0, x1, y1]` (pixels, x1/y1 exclusive) of everything that is not (near-)white
/// in a premultiplied-RGBA image whose unpainted area is transparent. None if the page is blank.
pub fn content_bbox(rgba: &[u8], w: u32, h: u32) -> Option<[u32; 4]> {
    let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0u32, 0u32);
    for y in 0..h {
        for x in 0..w {
            let i = ((y * w + x) * 4) as usize;
            let (r, g, b) = crate::frame::over_white(rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]);
            if r < 244 || g < 244 || b < 244 {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x + 1);
                y1 = y1.max(y + 1);
            }
        }
    }
    if x1 == 0 { None } else { Some([x0, y0, x1, y1]) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: (f32, f32), b: (f32, f32)) -> bool {
        (a.0 - b.0).abs() < 1e-4 && (a.1 - b.1).abs() < 1e-4
    }

    #[test]
    fn unrotated_letter_page_flips_y() {
        let m = pdf_to_page_matrix(0, [0.0, 0.0, 612.0, 792.0]);
        assert!(close(apply(&m, 0.0, 0.0), (0.0, 792.0)), "PDF origin is the bottom-left of the page");
        assert!(close(apply(&m, 0.0, 792.0), (0.0, 0.0)), "PDF top-left is page-space origin");
        assert!(close(apply(&m, 612.0, 792.0), (612.0, 0.0)));
    }

    #[test]
    fn cropbox_offset_is_subtracted() {
        let m = pdf_to_page_matrix(0, [10.0, 20.0, 110.0, 220.0]);
        assert!(close(apply(&m, 10.0, 220.0), (0.0, 0.0)), "top-left of the CropBox");
        assert!(close(apply(&m, 110.0, 20.0), (100.0, 200.0)), "bottom-right of the CropBox");
    }

    #[test]
    fn every_rotation_maps_the_cropbox_corners_to_the_rotated_page() {
        let b = [10.0, 20.0, 110.0, 320.0]; // 100 wide, 300 tall
        for (rot, (pw, ph)) in [(0, (100.0, 300.0)), (90, (300.0, 100.0)), (180, (100.0, 300.0)), (270, (300.0, 100.0))] {
            let m = pdf_to_page_matrix(rot, b);
            let corners = [(10.0, 20.0), (110.0, 20.0), (10.0, 320.0), (110.0, 320.0)];
            let mapped: Vec<_> = corners.iter().map(|&(x, y)| apply(&m, x, y)).collect();
            for (x, y) in &mapped {
                assert!(*x > -1e-3 && *x < pw + 1e-3 && *y > -1e-3 && *y < ph + 1e-3, "rot {rot}: ({x},{y}) outside {pw}x{ph}");
            }
            let xs: Vec<f32> = mapped.iter().map(|p| p.0).collect();
            let ys: Vec<f32> = mapped.iter().map(|p| p.1).collect();
            assert!((xs.iter().cloned().fold(f32::MIN, f32::max) - pw).abs() < 1e-3, "rot {rot}: width");
            assert!((ys.iter().cloned().fold(f32::MIN, f32::max) - ph).abs() < 1e-3, "rot {rot}: height");
        }
    }

    #[test]
    fn rotation_90_puts_the_pdf_top_left_at_the_page_top_right() {
        // Page rotated 90deg clockwise: what was the top-left of the page is now the top-right.
        let m = pdf_to_page_matrix(90, [0.0, 0.0, 100.0, 300.0]);
        assert!(close(apply(&m, 0.0, 300.0), (300.0, 0.0)), "got {:?}", apply(&m, 0.0, 300.0));
        // PDF origin (bottom-left) goes to the top-left
        assert!(close(apply(&m, 0.0, 0.0), (0.0, 0.0)), "got {:?}", apply(&m, 0.0, 0.0));
    }

    #[test]
    fn rotation_270_puts_the_pdf_top_left_at_the_page_bottom_left() {
        let m = pdf_to_page_matrix(270, [0.0, 0.0, 100.0, 300.0]);
        assert!(close(apply(&m, 0.0, 300.0), (0.0, 100.0)), "got {:?}", apply(&m, 0.0, 300.0));
    }

    #[test]
    fn invert_round_trips() {
        for rot in [0, 90, 180, 270] {
            let m = pdf_to_page_matrix(rot, [10.0, 20.0, 110.0, 320.0]);
            let inv = invert(&m).unwrap();
            let (x, y) = apply(&m, 33.0, 77.0);
            assert!(close(apply(&inv, x, y), (33.0, 77.0)), "rot {rot}");
        }
        assert!(invert(&[0.0; 6]).is_none());
    }

    #[test]
    fn rotate_point_matches_rotate_pixels() {
        // A 3x2 image (w=3,h=2) with a marker at (x=2,y=0): rotate and see where it lands.
        let (w, h) = (3u32, 2u32);
        for deg in [90u32, 180, 270] {
            let mut img = vec![255u8; (w * h * 4) as usize];
            let i = ((0 * w + 2) * 4) as usize;
            img[i..i + 4].copy_from_slice(&[1, 2, 3, 4]);
            let (out, nw, _nh) = rotate_pixels(&img, w, h, deg);
            // pixel centers: point (x+0.5, y+0.5) in the source maps to the marker's new pixel
            let (px, py) = rotate_point(2.5, 0.5, w as f32, h as f32, deg);
            let idx = (((py.floor() as u32) * nw + px.floor() as u32) * 4) as usize;
            assert_eq!(&out[idx..idx + 4], &[1, 2, 3, 4], "deg {deg}");
        }
    }

    #[test]
    fn rotate_pixels_swaps_dimensions_and_four_turns_is_identity() {
        let (w, h) = (4u32, 3u32);
        let img: Vec<u8> = (0..(w * h * 4)).map(|v| (v % 251) as u8).collect();
        let (r1, w1, h1) = rotate_pixels(&img, w, h, 90);
        assert_eq!((w1, h1), (3, 4));
        let (r2, w2, h2) = rotate_pixels(&r1, w1, h1, 90);
        let (r3, w3, h3) = rotate_pixels(&r2, w2, h2, 90);
        let (r4, w4, h4) = rotate_pixels(&r3, w3, h3, 90);
        assert_eq!((w4, h4), (w, h));
        assert_eq!(r4, img);
    }

    #[test]
    fn crop_pixels_extracts_and_clamps() {
        let (w, h) = (4u32, 4u32);
        let img: Vec<u8> = (0..16u8).flat_map(|v| [v, 0, 0, 255]).collect();
        let (c, cw, ch) = crop_pixels(&img, w, h, 1, 1, 2, 2);
        assert_eq!((cw, ch), (2, 2));
        assert_eq!(c.iter().step_by(4).copied().collect::<Vec<_>>(), vec![5, 6, 9, 10]);
        let (_, cw, ch) = crop_pixels(&img, w, h, 3, 3, 10, 10);
        assert_eq!((cw, ch), (1, 1), "clamped to the image");
    }

    #[test]
    fn content_bbox_finds_ink_and_ignores_blank_and_transparent() {
        let (w, h) = (10u32, 8u32);
        let mut img = vec![0u8; (w * h * 4) as usize]; // fully transparent == blank paper
        assert_eq!(content_bbox(&img, w, h), None);
        for (x, y) in [(2u32, 1u32), (6, 5)] {
            let i = ((y * w + x) * 4) as usize;
            img[i..i + 4].copy_from_slice(&[0, 0, 0, 255]);
        }
        assert_eq!(content_bbox(&img, w, h), Some([2, 1, 7, 6]));
    }
}
