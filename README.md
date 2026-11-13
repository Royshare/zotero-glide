# Zotero Glide

<img src="packages/zotero-plugin/addon/content/icons/zotero-glide.svg" alt="Zotero Glide icon: an open book with a red-tinted right page" width="96" height="96">

A lightweight, MuPDF-based PDF reader that opens as a tab inside Zotero.

> **Status: early (v0.1), experimental.** Developed and tested mostly on macOS (Apple Silicon).
> Windows and Linux builds are produced by CI but have had little hands-on testing inside Zotero.
> Expect rough edges, and please [report them](https://github.com/Royshare/zotero-glide/issues/new/choose).

## What it does

Adds **Open in Zotero Glide** to a PDF attachment's context menu. The PDF opens as a tab in Zotero's
own tab bar, rendered by a separate native MuPDF process (one per tab). It sits alongside Zotero's
built-in PDF.js reader and does not replace or modify it. **Open in Zotero Glide (separate window)**
opens the same renderer in its own OS window.

- Continuous scrolling, zoom, fit width / fit page, rotate, crop margins, light / dark / sepia themes
- Text selection and copy, find with highlights, clickable links, outline and thumbnails
- Highlight, underline and note annotations, stored in **Zotero** (they sync and show up in Zotero's
  own reader; the PDF file is never modified)
- A notes pane that edits the item's child notes with Zotero's own note editor
- Copy citation, export a PDF copy with annotations embedded, reading mode with reflowed text
- Remembers your place in each PDF; background tabs free their memory

## Install

1. Download `zotero-glide-<version>.xpi` from the
   [latest release](https://github.com/Royshare/zotero-glide/releases/latest). Right-click the link and save it; don't open it in a browser.
2. In Zotero: **Tools → Plugins** → gear icon → **Install Plugin From File...** → pick the `.xpi`.
3. Right-click a PDF attachment → **Open in Zotero Glide**.

Requires Zotero 7 or newer. The `.xpi` bundles the helper for macOS (Apple Silicon and Intel),
Windows x64 and Linux x64.

**Unsigned binaries.** The helper is not yet code-signed or notarized. macOS Gatekeeper or Windows
SmartScreen may warn the first time it runs. Verify the download against `SHA256SUMS` on the release
page. Signing is tracked in [`docs/cross-platform.md`](docs/cross-platform.md).

Settings are under **Zotero ▸ Settings ▸ Zotero Glide**: open PDFs here by default, and how long a
background tab waits before freeing its memory.

## Docs

- [Usage](docs/usage.md): keyboard shortcuts, scope and known limitations
- [Architecture](docs/architecture.md): how the plugin and native helper fit together, and why process isolation
- [Development](docs/development.md): building from source, dev profile, tests, releasing
- [Benchmarks](docs/benchmark-methodology.md), [cross-platform notes](docs/cross-platform.md), [ADRs](docs/adr)

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Security issues: [`SECURITY.md`](SECURITY.md).
Project history and verification notes: [`STATUS.md`](STATUS.md).

## License

AGPL-3.0-or-later (see `LICENSE`). The helper statically links MuPDF (AGPL-3.0-or-later), so the whole
project is too. Third-party components: `THIRD_PARTY_NOTICES.md`; source and obligations:
[`docs/licensing.md`](docs/licensing.md).
