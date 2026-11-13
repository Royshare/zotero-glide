# Development

## Building from source

Requires Rust (stable), a C compiler + `make` (MuPDF is built from vendored source), Node.js 24+, and
Python 3 (with Pillow for the image fixtures: `pip install pillow`). On Windows see
[`cross-platform.md`](cross-platform.md).

```bash
scripts/setup.sh                      # fixtures, build helper, run both test suites
```

Build an installable `.xpi` for your own OS/architecture:

```bash
cd packages/zotero-plugin
npm ci
npm run build                         # -> .scaffold/build/zotero-fast-reader.xpi
```

`npm run build` rebuilds the native helper first, then bundles the plugin and type-checks. A local
build contains only your host's helper binary; release builds contain all platforms.

Develop against a live, isolated Zotero profile (hot reload on save):

```bash
cd packages/zotero-plugin
cp .env.example .env                  # set the Zotero binary and an isolated profile / data dir
npm start
```

Never point the dev profile at your real Zotero data.

Run the helper standalone, without Zotero:

```bash
FAST_READER_DEBUG=1 ./packages/reader-helper/target/release/fast-reader-helper path/to/some.pdf
```

| npm command | what it does |
|---|---|
| `npm start` | launch Zotero with the plugin loaded, hot-reload on save |
| `npm run build` | build helper, bundle plugin into the `.xpi`, type-check |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | plugin unit tests (Node's built-in runner) |

Tests: `(cd packages/reader-helper && cargo test)` and `(cd packages/zotero-plugin && npm test)`.
Benchmarks: see [`benchmark-methodology.md`](benchmark-methodology.md).

## Releasing

Maintainers: from `packages/zotero-plugin`, on an up-to-date `main`, run `npm run release`. It prompts for the
version, bumps `package.json` and `addon/manifest.json`, commits, tags `vX.Y.Z` and pushes. The pushed tag triggers the
[release workflow](../.github/workflows/release.yml), which builds the helper on four platforms, assembles one
`.xpi`, and publishes it with the AGPL corresponding-source archive, `SHA256SUMS` and `update.json`
(Zotero's auto-update manifest).
