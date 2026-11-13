# Contributing

Thanks for helping. This is a small project; bug reports, platform testing (especially Windows and
Linux inside Zotero) and focused pull requests are all welcome.

## Before you start

- For anything larger than a bug fix, open an issue first so we can agree on the approach.
- Scope: Zotero Glide is a reader tab, not a PDF editor. See "What it is not" in the
  [README](README.md) and the [ADRs](docs/adr/). Proposals outside that scope will likely be declined.
- Annotations and notes must stay in Zotero's own data model; the plugin must not write to
  `zotero.sqlite` directly or patch Zotero's reader internals.

## Setup

```bash
scripts/setup.sh            # fixtures, helper build, both test suites
cd packages/zotero-plugin && npm ci
```

Requirements: Rust (stable), a C compiler + `make`, Node.js 24+, Python 3 (+ Pillow for image fixtures).
Windows: see [`docs/cross-platform.md`](docs/cross-platform.md).

To try changes in Zotero, use an **isolated** dev profile, never your real library:

```bash
cd packages/zotero-plugin
cp .env.example .env        # set ZOTERO_PLUGIN_ZOTERO_BIN_PATH, ZOTERO_PLUGIN_PROFILE_PATH, ZOTERO_PLUGIN_DATA_DIR
npm start                   # hot-reloads on save
```

## Layout

| Path | What |
|---|---|
| `packages/reader-helper/` | Rust native helper (MuPDF, winit/softbuffer, `--serve` headless mode) |
| `packages/zotero-plugin/` | Zotero plugin: TypeScript in `src/`, static files in `addon/` |
| `docs/adr/` | Architecture decisions: read these before changing the design |
| `scripts/` | Setup, build, benchmark and release helpers |

## Checks to run before a PR

```bash
(cd packages/reader-helper && cargo test)
(cd packages/zotero-plugin && npm test && npm run typecheck)
python3 scripts/add-spdx.py --check
python3 scripts/gen-third-party.py --check     # after dependency changes, run without --check
```

CI runs the same on macOS, Windows and Linux. Please add tests for new logic; pure logic in the plugin
goes in modules that can be tested under Node without Zotero (see `packages/zotero-plugin/test/`).

## Conventions

- Every source file starts with the SPDX header (`AGPL-3.0-or-later`); `scripts/add-spdx.py` adds it.
- Keep PRs focused, with a description of what changed and how you verified it. If you could only
  test on one OS, say so.
- Commit messages: short imperative subject, explanation in the body when the why isn't obvious.
- Spawn the helper with an argv array, never a shell string.
- Dependencies: avoid adding new ones casually. The helper statically links MuPDF (AGPL), and every new
  crate must have a compatible license and appear in `THIRD_PARTY_NOTICES.md`.

## License

By contributing you agree your contribution is licensed under
[AGPL-3.0-or-later](LICENSE), like the rest of the project.
