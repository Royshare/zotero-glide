// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

use mupdf::{Colorspace, Document, ImageFormat, Matrix};

fn main() {
    let path = std::env::args().nth(1).expect("pdf path");
    let out = std::env::args().nth(2).unwrap_or_else(|| "/tmp/preview.png".to_string());
    let doc = Document::open(&path).expect("open");
    let page = doc.load_page(0).expect("load page");
    let ctm = Matrix::new_scale(2.0, 2.0);
    let pixmap = page
        .to_pixmap(&ctm, &Colorspace::device_rgb(), true, false)
        .expect("render");
    pixmap.save_as(&out, ImageFormat::PNG).expect("save");
    println!("wrote {out} ({}x{})", pixmap.width(), pixmap.height());
}
