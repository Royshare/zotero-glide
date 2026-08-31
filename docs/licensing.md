# MuPDF licensing boundary

This is engineering documentation, not legal advice. Anything marked
**[LEGAL REVIEW NEEDED]** must be confirmed by a lawyer before any
commercial or public distribution of this project.

## What's actually vendored

- **Library:** MuPDF core (fitz + PDF interpreter), consumed via the Rust
  crate [`mupdf` v0.8.0](https://crates.io/crates/mupdf) /
  [`mupdf-sys` v0.8.0](https://crates.io/crates/mupdf-sys)
  (`messense/mupdf-rs`), which vendors MuPDF's C source and compiles it as
  part of `cargo build` (`mupdf-sys/build.rs`, using MuPDF's own
  `Makefile`).
- **MuPDF version actually built:** whatever source tree ships inside
  `mupdf-sys` 0.8.0 (present in
  `~/.cargo/registry/src/.../mupdf-sys-0.8.0/mupdf/`, `COPYING` file
  confirms AGPL). Pin this crate version deliberately -- do not let it
  float, since the license and source availability obligations below are
  tied to whatever MuPDF version is actually compiled in.
- **Features compiled in (`packages/reader-helper/Cargo.toml`):**
  `default-features = false, features = ["base14-fonts"]` -- PDF core only.
  HTML/EPUB/XPS/CBZ/SVG/JS/tesseract-OCR/docx-output support are
  deliberately excluded (smaller build, smaller binary, and no reason for
  a PDF-only reader to carry a JS interpreter or an OCR engine).
- **Linking:** static. `mupdf-sys` compiles MuPDF's C sources and links
  them directly into the `fast-reader-helper` binary -- there is no system
  MuPDF `.so`/`.dylib`/`.dll` dependency at runtime.

`mupdf-sys`'s own `Cargo.toml` declares `license = "AGPL-3.0"`. The vendored
MuPDF source's `COPYING` file is the GNU Affero General Public License v3.

## What AGPL-3.0 actually requires (plain-language summary)

**[LEGAL REVIEW NEEDED for the exact boundary in this project's specific
distribution model -- summary below is the standard, uncontroversial
reading, not a substitute for counsel.]**

- Any work that **links against** MuPDF (static or dynamic linking both
  count -- AGPL is copyleft at the "combined work" level, not just "network
  use") becomes a "covered work" that must itself be distributed under
  AGPL-3.0-compatible terms, or under a commercial MuPDF license instead
  (see below).
- AGPL's distinguishing clause vs. plain GPL: if you run a **modified**
  version of the covered work as a network service that users interact
  with remotely, you must offer them the corresponding source, even though
  no binary was "distributed" to them in the traditional sense. This
  project has no network service or server component (`docs/future-ipc.md`
  explicitly avoids one), so the AGPL network clause does not add
  obligations beyond ordinary GPL-style distribution -- **but** if a future
  version adds a server/sync component that embeds MuPDF, this clause
  becomes directly relevant again.
- If `fast-reader-helper` (and, by extension, anything that statically
  links it in) is distributed to anyone outside the development team, the
  complete corresponding source -- this project's own source *and* the
  exact MuPDF source version it was built against -- must be made
  available under AGPL-3.0 terms to recipients.

## Does the *Zotero plugin* need to be AGPL too?

`packages/zotero-plugin` does not link MuPDF at all -- it never imports the
`mupdf`/`mupdf-sys` crates, never calls into MuPDF, and its only
interaction with `fast-reader-helper` is spawning it as a separate OS
process and passing a file path as a command-line argument (see §7 of the
brief and `docs/future-ipc.md`). Process-boundary invocation (spawn +
argv, no shared address space, no linking) is the standard,
widely-accepted line past which AGPL's copyleft does not propagate into
the calling program.

**[LEGAL REVIEW NEEDED]** to confirm this holds for this project's
specific packaging (e.g., if the plugin ever bundled/redistributed the
helper binary as part of a single combined installer/artifact, that's
still "distribution of the AGPL binary," which is fine *as long as the
whole combined distribution satisfies AGPL* -- it just doesn't force the
*plugin's own JS source* to be AGPL-licensed, since it isn't a derivative
work of MuPDF).

## Does this *repository* need a compatible open-source license?

For v0.1, this repository should carry an OSI-approved copyleft-compatible
license for the `reader-helper` package specifically -- AGPL-3.0 itself is
the simplest, most defensible choice for that package, since it's already
what's linked in. `zotero-plugin` and shared docs/tooling could in
principle use a more permissive license (MIT/Apache-2.0), but mixing
licenses per-package adds review overhead for limited benefit at this
stage; **[LEGAL REVIEW NEEDED]** before finalizing a per-package license
split. No `LICENSE` file has been added to the repo yet -- this is a
decision to make deliberately, not by omission, before any public release.

## What changes if a commercial MuPDF license were used instead

Artifex (MuPDF's publisher) sells commercial licenses specifically so
vendors can avoid AGPL's copyleft obligations. Under a commercial license:

- `fast-reader-helper` (and this repository) would **not** be required to
  be open-sourced or AGPL-licensed because of the MuPDF dependency.
- The Zotero plugin's redistribution story gets simpler (no AGPL-source
  offer requirement flowing from the MuPDF dependency at all).
- Cost, license terms, and any per-seat/per-distribution conditions would
  need to be reviewed against how Zotero plugins are actually distributed
  (a public repository / Zotero plugin listing implies broad
  redistribution, which is exactly the scenario AGPL is engineered to
  catch).
- **[LEGAL REVIEW NEEDED]** to obtain and review an actual commercial
  quote/contract from Artifex before treating this as a real option --
  nothing here should be read as confirming pricing or availability.

## For v0.1 specifically

This is being developed and used as an **open-source development/research
prototype**: source is (or will be) publicly available, nothing here is
sold or distributed as a proprietary binary, and the intent is to keep it
that way through v0.1. Under that model, using MuPDF under AGPL-3.0 as
vendored today is appropriate and requires no commercial license -- as
long as this project's own source (this repo) is/remains available under
AGPL-3.0-compatible terms once it is distributed to anyone outside active
development. Revisit this document *before* any of the following:

- Distributing compiled binaries to end users (even for free), if this
  repository has not yet picked and applied a license file.
- Offering `fast-reader-helper` or the Zotero plugin through any
  commercial channel, paid or not.
- Adding a server/sync component (see `docs/future-ipc.md`'s explicit
  "no HTTP service" stance -- this is one of the reasons that stance
  exists).
