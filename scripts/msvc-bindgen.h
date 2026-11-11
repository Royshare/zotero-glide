// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

#ifndef FAST_READER_MSVC_BINDGEN_H
#define FAST_READER_MSVC_BINDGEN_H

// mupdf 0.8.0 expects bindgen to export max_align_t, but MSVC's C headers
// do not declare it. Match MSVC's <cstddef> definition (double, alignment 8).
// This header is pre-included only when generating bindings on Windows/MSVC.
// Upstream: https://github.com/messense/mupdf-rs/issues/222
#if defined(_MSC_VER) && !defined(__cplusplus)
typedef double max_align_t;
#endif

#endif
