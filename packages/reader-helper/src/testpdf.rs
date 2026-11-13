// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

//! Builds small, valid PDFs in memory for tests: known text at known positions, an outline, internal
//! and external links, a rotated page and an offset CropBox. No external fixtures needed.
#![cfg(test)]

use std::io::Write;
use std::path::{Path, PathBuf};

/// A page of the test document: text drawn at PDF position (x, y) in a 12pt Helvetica.
pub struct Spec {
    pub media: [f32; 4],
    pub crop: Option<[f32; 4]>,
    pub rotate: i32,
    pub text: Vec<(f32, f32, &'static str)>,
    /// Link annotations: (rect in PDF space, destination)
    pub links: Vec<([f32; 4], LinkTo)>,
}

pub enum LinkTo {
    Page(usize),
    Uri(&'static str),
}

/// Returns the PDF bytes. Object numbering: 1 catalog, 2 pages, 3 font, 4 outlines,
/// then per page i (0-based): page = 10 + i*10, content = 11 + i*10, link annots = 12 + i*10 + k.
/// Outline: "Chapter 1" -> page 0, "Chapter 2" -> page 1 with child "Section 2.1" -> page 1.
pub fn build(pages: &[Spec]) -> Vec<u8> {
    let mut objs: Vec<(u32, String)> = Vec::new();
    let kids: Vec<String> = (0..pages.len()).map(|i| format!("{} 0 R", 10 + i * 10)).collect();
    objs.push((1, "<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R >>".into()));
    objs.push((2, format!("<< /Type /Pages /Count {} /Kids [{}] >>", pages.len(), kids.join(" "))));
    objs.push((3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".into()));
    let page_ref = |i: usize| format!("{} 0 R", 10 + i * 10);
    objs.push((4, format!("<< /Type /Outlines /First 5 0 R /Last 6 0 R /Count 3 >>")));
    objs.push((5, format!("<< /Title (Chapter 1) /Parent 4 0 R /Next 6 0 R /Dest [{} /Fit] >>", page_ref(0))));
    objs.push((6, format!("<< /Title (Chapter 2) /Parent 4 0 R /Prev 5 0 R /First 7 0 R /Last 7 0 R /Count 1 /Dest [{} /Fit] >>", page_ref(pages.len() - 1))));
    objs.push((7, format!("<< /Title (Section 2.1) /Parent 6 0 R /Dest [{} /Fit] >>", page_ref(pages.len() - 1))));
    for (i, p) in pages.iter().enumerate() {
        let (page_id, content_id) = (10 + i as u32 * 10, 11 + i as u32 * 10);
        let mut stream = String::from("BT /F1 12 Tf\n");
        for (x, y, t) in &p.text {
            stream.push_str(&format!("1 0 0 1 {x} {y} Tm ({t}) Tj\n"));
        }
        stream.push_str("ET\n");
        objs.push((content_id, format!("<< /Length {} >>\nstream\n{}endstream", stream.len(), stream)));
        let mut annots = Vec::new();
        for (k, (r, to)) in p.links.iter().enumerate() {
            let id = 12 + i as u32 * 10 + k as u32;
            let action = match to {
                LinkTo::Page(n) => format!("/Dest [{} /Fit]", page_ref(*n)),
                LinkTo::Uri(u) => format!("/A << /S /URI /URI ({u}) >>"),
            };
            objs.push((id, format!("<< /Type /Annot /Subtype /Link /Rect [{} {} {} {}] /Border [0 0 0] {} >>", r[0], r[1], r[2], r[3], action)));
            annots.push(format!("{id} 0 R"));
        }
        let crop = p.crop.map(|c| format!(" /CropBox [{} {} {} {}]", c[0], c[1], c[2], c[3])).unwrap_or_default();
        objs.push((
            page_id,
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [{} {} {} {}]{crop} /Rotate {} /Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R /Annots [{}] >>",
                p.media[0], p.media[1], p.media[2], p.media[3], p.rotate, annots.join(" ")
            ),
        ));
    }
    objs.sort_by_key(|(n, _)| *n);
    let mut out = b"%PDF-1.7\n".to_vec();
    let mut offsets = Vec::new();
    for (n, body) in &objs {
        offsets.push((*n, out.len()));
        write!(out, "{n} 0 obj\n{body}\nendobj\n").unwrap();
    }
    let max = objs.iter().map(|(n, _)| *n).max().unwrap();
    let xref = out.len();
    write!(out, "xref\n0 {}\n0000000000 65535 f \n", max + 1).unwrap();
    for n in 1..=max {
        match offsets.iter().find(|(m, _)| *m == n) {
            Some((_, off)) => write!(out, "{off:010} 00000 n \n").unwrap(),
            None => write!(out, "0000000000 65535 f \n").unwrap(),
        }
    }
    write!(out, "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", max + 1).unwrap();
    out
}

pub fn write_temp(tag: &str, bytes: &[u8]) -> PathBuf {
    // unique per call: tests run in parallel and each cleans up its own directory
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("fr-testpdf-{}-{tag}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("t.pdf");
    std::fs::write(&path, bytes).unwrap();
    path
}

pub fn cleanup(path: &Path) {
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

/// The standard two-page test document: page 1 US-letter with text + two links; page 2 rotated 90 with an
/// offset CropBox.
pub fn standard() -> Vec<u8> {
    build(&[
        Spec {
            media: [0.0, 0.0, 612.0, 792.0],
            crop: None,
            rotate: 0,
            text: vec![(72.0, 700.0, "Hello world"), (72.0, 650.0, "The quick brown fox")],
            links: vec![([72.0, 695.0, 140.0, 712.0], LinkTo::Page(1)), ([72.0, 645.0, 200.0, 662.0], LinkTo::Uri("https://example.org/x"))],
        },
        Spec {
            media: [0.0, 0.0, 612.0, 792.0],
            crop: Some([50.0, 100.0, 450.0, 600.0]), // 400 x 500
            rotate: 90,
            text: vec![(100.0, 550.0, "Rotated page text")],
            links: vec![],
        },
    ])
}
