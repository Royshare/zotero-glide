# ADR 001: reader-helper technology stack

Status: Accepted (v0.1)
Date: 2026-08-31

## Context

`reader-helper` is a standalone native process launched by the Zotero plugin
to display one PDF using MuPDF. The product hypothesis (see root README) is
that a process fully decoupled from Zotero's Gecko/PDF.js reader has
substantially lower lifecycle coupling and, plausibly, lower memory/CPU
overhead. That hypothesis is only interesting to test if the helper itself is
lightweight — so the stack choice is part of the experiment, not an
implementation detail to wave away.

Constraints from the project brief:
- Must run on Windows 10+, macOS 10.15+, modern Linux desktop.
- One shared codebase strongly preferred over three platform-native apps.
- No Electron, no bundled Chromium/browser engine.
- Avoid Qt unless there's a compelling reason (Qt's runtime/binary footprint
  works against the "lightweight" hypothesis we're trying to prove).
- MuPDF accessed through its supported public (C) API.

## Options considered

### A. Rust + `mupdf` crate (FFI to MuPDF C API) + `winit` + `softbuffer`

- MuPDF binding: [`mupdf` / `mupdf-sys`](https://crates.io/crates/mupdf) —
  actively maintained safe wrapper generated with `bindgen` over MuPDF's
  public C headers (fitz/pdf), vendors MuPDF source and builds it with the
  upstream `Makefile` via `cc`. Not a private/internal API — it wraps the
  same public entry points (`fz_context`, `fz_document`, `fz_page`,
  `fz_pixmap`, `fz_stext_page`, `pdf_document`, etc.) documented in MuPDF's
  own C API docs.
- Windowing: [`winit`](https://crates.io/crates/winit) — single crate,
  windows/events/keyboard/mouse on Windows, macOS (AppKit), Linux
  (X11 + Wayland). No native toolkit dependency beyond OS-provided libraries.
- Rendering surface: [`softbuffer`](https://crates.io/crates/softbuffer) —
  presents a CPU-side RGBA buffer to the window's native surface (no GPU
  context, no shader pipeline). This matches the workload exactly: MuPDF
  already rasterizes to a CPU pixmap, so we just blit it. Avoids pulling in
  `wgpu`/OpenGL/Vulkan, which would be dead weight for a page-image viewer.
- Text/search UI, page-number entry: drawn as simple rectangles/software
  text via a tiny bitmap font blit or `winit`'s IME-aware text input events
  feeding a plain overlay — no rich text framework needed for v0.1's minimal
  chrome (see docs/adr's non-goals).

### B. C++ + MuPDF C API directly + a thin windowing lib (GLFW/SDL2)

- Removes the Rust FFI layer; calls MuPDF's C API with zero binding
  generation step.
- Loses Rust's ownership/borrow checking for the resource-lifetime-heavy
  code this project is full of (documents, pages, display lists, pixmaps
  each need exactly one clear owner — see engineering principles in the
  brief). In C++ that discipline is manual and easier to get wrong (double
  free / use-after-free of `fz_document`/`fz_pixmap`).
- GLFW/SDL2 are both real, small, cross-platform, and mature. Comparable
  footprint to `winit`.
- Build/packaging: needs a CMake (or similar) setup per platform, a
  separate MuPDF build step, and manual dependency vendoring — more moving
  parts than Cargo's single `cargo build`.

### C. Qt (widgets or QML) + MuPDF C API

- Excellent text selection, accessibility (QAccessible), input handling,
  and cross-platform maturity essentially for free.
- Directly works against the hypothesis under test: Qt's shared libraries
  and runtime add tens of MB and non-trivial baseline memory even for a
  minimal widget app — the brief explicitly asks to avoid this "unless
  there is a compelling technical reason." There isn't one for a
  single-document page viewer.

### D. Platform-native apps (AppKit / Win32 / GTK) sharing only a MuPDF core

- Best possible per-platform integration (accessibility, text input,
  window chrome) at the cost of three separate GUI codebases.
- Explicitly discouraged by the brief ("prefer ONE shared reader-helper
  codebase"), and triples the maintenance surface for a v0.1 whose purpose
  is architectural validation, not production polish.

## Comparison

| | A: Rust+winit+softbuffer | B: C+++GLFW+MuPDF | C: Qt | D: Native x3 |
|---|---|---|---|---|
| Runtime/binary size | Small (~10-20MB incl. MuPDF static) | Small, similar to A | Large (Qt libs, 40-100MB+) | Smallest per-OS, x3 codebases |
| Baseline memory overhead | Low (no GPU ctx, no toolkit) | Low | Higher (Qt object model, style engine) | Lowest, but not comparable/shared |
| Win/macOS/Linux support | Yes, one codebase | Yes, one codebase, more glue | Yes, one codebase | Yes, three codebases |
| Text input/selection | Basic via winit IME events; robust text-layout selection deferred to v0.2 (see docs/adr and §8 of brief) | Same situation, manual | Best-in-class, built-in | Best-in-class per OS |
| Accessibility | Weak out of the box (no AT tree); `AccessKit` crate exists as a later add-on, not used in v0.1 | Weak, same gap, no ecosystem equivalent as turn-key | Strong (QAccessible) | Strong (native AT APIs) |
| Build complexity | Single `cargo build`, `cc`/`make` under the hood for MuPDF | CMake + manual MuPDF build + GLFW/SDL2 vendoring | Qt SDK/toolchain install, moc/uic build step | Three separate toolchains |
| Packaging complexity | `cargo build --release` per target triple | Per-platform CMake presets | Qt deployment tools (`macdeployqt`, `windeployqt`, linuxdeployqt) needed | Three separate packaging pipelines |
| Maintainability (1 engineer, small scope) | Good — one language, one dependency graph, memory safety for resource ownership | Good, more manual lifetime bookkeeping | Good once past learning curve, heavier dependency | Worst — logic duplicated 3x |

## Decision

**Option A: Rust + `mupdf` crate + `winit` + `softbuffer`.**

Rationale:
- It is the only option that is simultaneously lightweight, genuinely
  single-codebase across the three target platforms, and gives memory-safe
  ownership of MuPDF's native resources (documents/pages/pixmaps/display
  lists) — which matters directly for the "every native resource has an
  obvious owner and cleanup path" principle in the brief.
- `softbuffer` avoids a GPU dependency entirely, which is the right call
  for an app whose entire rendering job is "blit a raster image MuPDF
  already produced" — pulling in `wgpu` would add complexity and overhead
  the workload doesn't need.
- The `mupdf` crate wraps MuPDF's public C API (not private internals), so
  it satisfies "use MuPDF Core through its supported public API," and its
  build already handles vendoring + compiling MuPDF from source per
  platform, which simplifies packaging (§13).

Accepted trade-offs (recorded, not hidden):
- **Accessibility is weak in v0.1.** Screen readers will not see page
  content or reader chrome. `AccessKit` (a cross-platform accessibility-tree
  crate that integrates with `winit`) is the identified path if this
  becomes a requirement later; not implemented now because v0.1's purpose
  is architectural validation, not production accessibility.
- **Robust text selection is out of scope for v0.1**, per §8 of the brief.
  MuPDF's `fz_stext_page` gives us the structured text needed for search
  and, later, selection — but turning that into drag-to-select-and-copy UX
  with correct RTL/line-wrap/hyphenation handling is real work. It is
  explicitly deferred to v0.2 rather than let it balloon v0.1's scope or
  push us toward a heavier text-layout dependency now.
- **Minimal UI chrome.** Page/zoom/search controls are drawn as simple
  software-rendered overlays, not a styled widget kit. This is intentional
  (§21: avoid speculative abstractions, avoid an elaborate reader UI per
  §2 non-goals).

## Consequences

- `packages/reader-helper` is a single Rust crate/binary,
  `glide-helper`, built with `cargo build --release` per target
  triple (see docs/cross-platform.md for the platform/arch matrix).
- MuPDF is statically linked in via `mupdf-sys`'s vendored build — no
  system MuPDF dependency required on end-user machines (see
  docs/licensing.md for what static linking implies under AGPL).
- The `mupdf` crate is used **only** behind the `DocumentEngine` /
  `MuPdfDocumentEngine` abstraction (see §4 of the brief and
  `src/engine.rs`) — no MuPDF types leak into windowing/GUI code.
