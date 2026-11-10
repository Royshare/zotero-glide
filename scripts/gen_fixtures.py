#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Zotero Fast Reader contributors
"""Generate small, fully synthetic (owned, CC0) PDF fixtures for tests and
benchmarks. No external PDF libraries required -- writes raw PDF syntax
directly so the fixtures have no licensing entanglement of their own.

Usage:
    python3 scripts/gen_fixtures.py
Writes into fixtures/ (used by reader-helper tests) and
benchmarks/fixtures/ (used by scripts/benchmark-reader.py).
"""
import io
import os
import zlib

try:
    from PIL import Image, ImageDraw
    HAVE_PIL = True
except ImportError:
    HAVE_PIL = False

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class PdfWriter:
    """Minimal single-purpose PDF object/xref writer. Not a general PDF
    library -- just enough to emit valid, MuPDF-readable fixtures."""

    def __init__(self):
        self.objects = []  # list of bytes, index 0 unused (obj numbers are 1-based)
        self.objects.append(None)

    def add(self, body: bytes) -> int:
        self.objects.append(body)
        return len(self.objects) - 1

    def add_stream(self, dict_extra: dict, data: bytes, compress=True) -> int:
        if compress:
            data = zlib.compress(data, 6)
            dict_extra = dict(dict_extra)
            dict_extra["Filter"] = "/FlateDecode"
        d = {"Length": len(data), **dict_extra}
        header = pdf_dict(d).encode("latin-1")
        body = header + b"\nstream\n" + data + b"\nendstream"
        return self.add(body)

    def write(self, path: str):
        out = io.BytesIO()
        out.write(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
        offsets = [0] * len(self.objects)
        for i, body in enumerate(self.objects):
            if body is None:
                continue
            offsets[i] = out.tell()
            out.write(f"{i} 0 obj\n".encode("latin-1"))
            out.write(body)
            out.write(b"\nendobj\n")
        xref_offset = out.tell()
        n = len(self.objects)
        out.write(f"xref\n0 {n}\n".encode("latin-1"))
        out.write(b"0000000000 65535 f \n")
        for i in range(1, n):
            out.write(f"{offsets[i]:010d} 00000 n \n".encode("latin-1"))
        out.write(b"trailer\n")
        out.write(pdf_dict({"Size": n, "Root": RefMarker(1)}).encode("latin-1"))
        out.write(f"\nstartxref\n{xref_offset}\n%%EOF".encode("latin-1"))
        with open(path, "wb") as f:
            f.write(out.getvalue())


class RefMarker:
    def __init__(self, num):
        self.num = num


def pdf_value(v):
    if isinstance(v, RefMarker):
        return f"{v.num} 0 R"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, str):
        if v.startswith("/"):
            return v
        return "(" + v.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)") + ")"
    if isinstance(v, list):
        return "[" + " ".join(pdf_value(x) for x in v) + "]"
    if isinstance(v, dict):
        return pdf_dict(v)
    raise TypeError(type(v))


def pdf_dict(d: dict) -> str:
    inner = " ".join(f"/{k} {pdf_value(v)}" for k, v in d.items())
    return "<< " + inner + " >>"


def esc_text(s: str) -> str:
    return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def make_text_pdf(path: str, n_pages: int, title: str, body_lines_per_page,
                   with_figure: bool):
    w = PdfWriter()
    page_w, page_h = 612, 792  # US Letter

    catalog_num = w.add(b"")  # placeholder, fixed below
    pages_num = w.add(b"")
    font_num = w.add(pdf_dict({
        "Type": "/Font", "Subtype": "/Type1", "BaseFont": "/Helvetica",
    }).encode("latin-1"))
    font_bold_num = w.add(pdf_dict({
        "Type": "/Font", "Subtype": "/Type1", "BaseFont": "/Helvetica-Bold",
    }).encode("latin-1"))

    page_nums = []
    for p in range(n_pages):
        lines = body_lines_per_page(p)
        content = []
        content.append("BT /FBold 16 Tf 1 0 0 1 72 730 Tm (%s) Tj ET" % esc_text(
            f"{title} -- page {p + 1}"))
        y = 690
        for line in lines:
            content.append(f"BT /F 10 Tf 1 0 0 1 72 {y} Tm ({esc_text(line)}) Tj ET")
            y -= 14
        if with_figure:
            fx, fy, fw, fh = 72, max(y - 140, 80), 200, 120
            content.append(f"q 0.6 0.6 0.6 RG 1 w {fx} {fy} {fw} {fh} re S Q")
            content.append(
                f"q 0.3 0.3 0.3 RG {fx} {fy} m {fx + fw} {fy + fh} l S "
                f"{fx} {fy + fh} m {fx + fw} {fy} l S Q")
            content.append(
                f"BT /F 8 Tf {fx} {fy - 12} Td (Figure {p + 1}: synthetic vector diagram) Tj ET")
        stream = "\n".join(content).encode("latin-1")
        content_num = w.add_stream({}, stream)
        pg = w.add(pdf_dict({
            "Type": "/Page", "Parent": RefMarker(pages_num),
            "MediaBox": [0, 0, page_w, page_h],
            "Resources": {"Font": {"F": RefMarker(font_num), "FBold": RefMarker(font_bold_num)}},
            "Contents": RefMarker(content_num),
        }).encode("latin-1"))
        page_nums.append(pg)

    w.objects[pages_num] = pdf_dict({
        "Type": "/Pages", "Kids": [RefMarker(n) for n in page_nums],
        "Count": len(page_nums),
    }).encode("latin-1")
    w.objects[catalog_num] = pdf_dict({
        "Type": "/Catalog", "Pages": RefMarker(pages_num),
    }).encode("latin-1")

    w.write(path)
    print(f"wrote {path} ({n_pages} pages)")


def make_image_heavy_pdf(path: str, n_pages: int):
    if not HAVE_PIL:
        print(f"skip {path}: Pillow not available")
        return
    w = PdfWriter()
    page_w, page_h = 612, 792

    catalog_num = w.add(b"")
    pages_num = w.add(b"")

    page_nums = []
    for p in range(n_pages):
        img = Image.new("RGB", (1275, 1650), "white")
        d = ImageDraw.Draw(img)
        # deterministic pseudo-scan noise pattern so each page differs and
        # doesn't compress to nothing, similar in spirit to a scanned page
        seed = (p * 2654435761) & 0xFFFFFFFF
        for i in range(0, 1650, 7):
            shade = 235 + ((seed >> (i % 24)) & 15)
            d.line([(0, i), (1275, i)], fill=(shade, shade, shade))
        d.rectangle([80, 80, 1195, 1570], outline=(60, 60, 60), width=3)
        d.text((120, 120), f"Scanned page {p + 1}", fill=(20, 20, 20))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=55)
        jpeg_bytes = buf.getvalue()
        img_num = w.add_stream({
            "Type": "/XObject", "Subtype": "/Image",
            "Width": img.width, "Height": img.height,
            "ColorSpace": "/DeviceRGB", "BitsPerComponent": 8,
        }, jpeg_bytes, compress=False)
        w.objects[img_num] = pdf_dict({
            "Type": "/XObject", "Subtype": "/Image",
            "Width": img.width, "Height": img.height,
            "ColorSpace": "/DeviceRGB", "BitsPerComponent": 8,
            "Filter": "/DCTDecode", "Length": len(jpeg_bytes),
        }).encode("latin-1") + b"\nstream\n" + jpeg_bytes + b"\nendstream"

        content = f"q {page_w} 0 0 {page_h} 0 0 cm /Im0 Do Q".encode("latin-1")
        content_num = w.add_stream({}, content)
        pg = w.add(pdf_dict({
            "Type": "/Page", "Parent": RefMarker(pages_num),
            "MediaBox": [0, 0, page_w, page_h],
            "Resources": {"XObject": {"Im0": RefMarker(img_num)}},
            "Contents": RefMarker(content_num),
        }).encode("latin-1"))
        page_nums.append(pg)

    w.objects[pages_num] = pdf_dict({
        "Type": "/Pages", "Kids": [RefMarker(n) for n in page_nums],
        "Count": len(page_nums),
    }).encode("latin-1")
    w.objects[catalog_num] = pdf_dict({
        "Type": "/Catalog", "Pages": RefMarker(pages_num),
    }).encode("latin-1")

    w.write(path)
    print(f"wrote {path} ({n_pages} pages, image-heavy)")


LOREM = (
    "This synthetic paragraph exists only to give the search index and "
    "text layout something real to chew on across the fixture. Zotero "
    "Fast Reader renders this page with MuPDF, not with Gecko or PDF.js. "
    "The quick brown fox jumps over the lazy dog near the render cache."
).split()


def body_lines(page_no, n_lines=30, words_per_line=11):
    lines = []
    idx = page_no
    for _ in range(n_lines):
        chunk = []
        for _ in range(words_per_line):
            chunk.append(LOREM[idx % len(LOREM)])
            idx += 1
        lines.append(" ".join(chunk))
    return lines


def main():
    fixtures_dir = os.path.join(ROOT, "packages", "reader-helper", "fixtures")
    bench_dir = os.path.join(ROOT, "benchmarks", "fixtures")
    os.makedirs(fixtures_dir, exist_ok=True)
    os.makedirs(bench_dir, exist_ok=True)

    # small fixture for unit tests: 3 pages, deterministic, tiny
    make_text_pdf(
        os.path.join(fixtures_dir, "sample.pdf"), 3, "Fast Reader Test Fixture",
        lambda p: body_lines(p, n_lines=8, words_per_line=8), with_figure=True)

    # benchmark Document A: normal academic paper, ~24 pages, vector text + figures
    make_text_pdf(
        os.path.join(bench_dir, "paper-a.pdf"), 24, "Synthetic Academic Paper",
        lambda p: body_lines(p, n_lines=30, words_per_line=11), with_figure=True)

    # benchmark Document B: long paper/book, 220 pages, text only
    make_text_pdf(
        os.path.join(bench_dir, "book-b.pdf"), 220, "Synthetic Long-Form Book",
        lambda p: body_lines(p, n_lines=34, words_per_line=11), with_figure=False)

    # benchmark Document C: image-heavy / scanned-style, 40 pages
    make_image_heavy_pdf(os.path.join(bench_dir, "scanned-c.pdf"), 40)


if __name__ == "__main__":
    main()
