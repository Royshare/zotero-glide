use fast_reader_helper::engine::mupdf_engine::MuPdfDocumentEngine;
use fast_reader_helper::engine::DocumentEngine;
use mupdf::{Colorspace, ImageFormat, Pixmap};

fn main() {
    let path = std::env::args().nth(1).expect("pdf path");
    let page: u32 = std::env::args().nth(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    let out = std::env::args().nth(3).unwrap_or_else(|| "/tmp/blit_fix_check.png".to_string());

    // Exercises the same production path app.rs's RedrawRequested handler
    // does: MuPdfDocumentEngine::render() via a display list, alpha=true.
    let mut engine = MuPdfDocumentEngine::open(std::path::Path::new(&path)).expect("open");
    let rendered = engine.render(page, 2.0).expect("render");

    // Same composite-against-white formula as app.rs's blit_centered.
    let mut out_rgb = vec![0u8; (rendered.width * rendered.height * 3) as usize];
    for i in 0..(rendered.width * rendered.height) as usize {
        let (pr, pg, pb, a) = (
            rendered.rgba[i * 4],
            rendered.rgba[i * 4 + 1],
            rendered.rgba[i * 4 + 2],
            rendered.rgba[i * 4 + 3],
        );
        let inv_a = 255u32 - a as u32;
        out_rgb[i * 3] = (pr as u32 + inv_a).min(255) as u8;
        out_rgb[i * 3 + 1] = (pg as u32 + inv_a).min(255) as u8;
        out_rgb[i * 3 + 2] = (pb as u32 + inv_a).min(255) as u8;
    }

    let mut pixmap = Pixmap::new_with_w_h(
        &Colorspace::device_rgb(),
        rendered.width as i32,
        rendered.height as i32,
        false,
    )
    .expect("new pixmap");
    pixmap.samples_mut().copy_from_slice(&out_rgb);
    pixmap.save_as(&out, ImageFormat::PNG).expect("save");
    println!("wrote {out} ({}x{})", rendered.width, rendered.height);
}
