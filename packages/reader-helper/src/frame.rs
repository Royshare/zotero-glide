//! Pixel helpers shared by the winit window (`app.rs`) and the headless
//! in-tab "serve" mode (`serve.rs`).
//!
//! MuPDF renders with premultiplied alpha and clears unpainted page area
//! to fully transparent (0,0,0,0), not white, when `alpha=true` (see the
//! "page rendering showed black" fix in STATUS.md). A page is always
//! opaque paper, so every consumer composites over white.

use crate::engine::RenderedPage;

/// Premultiplied RGBA over white: `channel + (255 - alpha)`.
#[inline]
pub fn over_white(pr: u8, pg: u8, pb: u8, a: u8) -> (u8, u8, u8) {
    let inv_a = 255 - a as u32;
    (
        (pr as u32 + inv_a).min(255) as u8,
        (pg as u32 + inv_a).min(255) as u8,
        (pb as u32 + inv_a).min(255) as u8,
    )
}

/// Returns the page as tightly packed, fully opaque RGBA8 (straight
/// alpha == 255 everywhere) -- exactly what a `<canvas>` `ImageData`
/// wants, so the consumer can `putImageData` with no further conversion.
pub fn to_opaque_rgba(page: &RenderedPage) -> Vec<u8> {
    let mut out = Vec::with_capacity(page.rgba.len());
    for px in page.rgba.chunks_exact(4) {
        let (r, g, b) = over_white(px[0], px[1], px[2], px[3]);
        out.extend_from_slice(&[r, g, b, 255]);
    }
    out
}

/// Same output as `to_opaque_rgba`, written in 64 KiB chunks instead of
/// materializing a second full-page buffer (a page is 10-25 MB at retina
/// sizes).
pub fn write_opaque_rgba(page: &RenderedPage, mut out: impl std::io::Write) -> std::io::Result<()> {
    let mut chunk = [0u8; 64 * 1024];
    for src in page.rgba.chunks(chunk.len()) {
        let n = src.len() / 4 * 4;
        for (d, px) in chunk[..n].chunks_exact_mut(4).zip(src[..n].chunks_exact(4)) {
            let (r, g, b) = over_white(px[0], px[1], px[2], px[3]);
            d.copy_from_slice(&[r, g, b, 255]);
        }
        out.write_all(&chunk[..n])?;
    }
    out.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transparent_becomes_white_opaque_stays_partial_blends() {
        assert_eq!(over_white(0, 0, 0, 0), (255, 255, 255));
        assert_eq!(over_white(10, 20, 30, 255), (10, 20, 30));
        assert_eq!(over_white(0, 0, 0, 128), (127, 127, 127));
    }

    #[test]
    fn streaming_writer_matches_to_opaque_rgba_across_chunk_boundaries() {
        // > 64 KiB so the chunk loop runs several times, with varied alpha
        let n = 50_000u32;
        let mut rgba = Vec::new();
        for i in 0..n {
            rgba.extend_from_slice(&[(i % 251) as u8, (i % 13) as u8, (i % 7) as u8, (i % 256) as u8]);
        }
        let page = RenderedPage { width: n, height: 1, rgba };
        let mut streamed = Vec::new();
        write_opaque_rgba(&page, &mut streamed).unwrap();
        assert_eq!(streamed, to_opaque_rgba(&page));
    }

    #[test]
    fn to_opaque_rgba_sets_alpha_255_and_keeps_length() {
        let page = RenderedPage {
            width: 2,
            height: 1,
            rgba: vec![0, 0, 0, 0, 1, 2, 3, 255],
        };
        assert_eq!(to_opaque_rgba(&page), vec![255, 255, 255, 255, 1, 2, 3, 255]);
    }
}
