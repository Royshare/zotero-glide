# Cross-platform packaging

## Binary layout

```
packages/zotero-plugin/addon/bin/
├── macos-arm64/fast-reader-helper
├── macos-x64/fast-reader-helper
├── windows-x64/fast-reader-helper.exe
└── linux-x64/fast-reader-helper
```

`addon/` is the plugin's own shippable root (contains `manifest.json`,
`bootstrap.js`) -- this layout matches `zotero-plugin-scaffold`'s
convention (see STATUS.md's "Zotero dev loading" section for why that
tool, not a hand-rolled proxy file, is the dev workflow that actually
works here). Only the platforms/architectures actually built are
populated -- v0.1 was developed and tested on
`macos-arm64` only (see STATUS.md); the resolver below is written to
support all four without assuming any one of them is present, and fails
with a clear, categorized error (see
`packages/zotero-plugin/src/platform.ts` and the Zotero UX error
categories in the brief §12) rather than silently falling back to
something wrong.

`scripts/build-helper.sh` builds the current host's target and copies the
resulting binary into the matching `bin/<platform>/` directory as its last
step -- see that script for the exact `cargo build --release` invocation
and target triple.

## Platform detection

`packages/zotero-plugin/src/platform.ts` maps a platform/arch string pair
to one of the four directory names above. The real caller
(`fastReader.ts`'s `_hostPlatform()`) derives that string from
`Zotero.isMac`/`isWin`/`isLinux` + `Zotero.arch` -- **not**
`Zotero.platform`, which doesn't exist in current Zotero (confirmed live;
see STATUS.md). Tests pass Node's `process.platform`/`process.arch`
directly:

| Zotero/Node platform | Zotero/Node arch | Directory |
|---|---|---|
| `mac` / `darwin` | `aarch64` / `arm64` | `macos-arm64` |
| `mac` / `darwin` | `x86_64` / `x64` | `macos-x64` |
| `win` / `win32` | `x86_64` / `x64` | `windows-x64` |
| `linux` | `x86_64` / `x64` | `linux-x64` |

Anything else (32-bit Windows, Linux arm64, etc.) is deliberately
unsupported in v0.1 and reported as an "unsupported platform" error (brief
§12) rather than guessed at.

## Code signing implications

**[NOT DONE for v0.1 -- documented for whoever picks this up next.]**

- **macOS notarization:** an unsigned/unnotarized `fast-reader-helper`
  binary launched via `Subprocess.call()` will be quarantined by
  Gatekeeper if it was ever downloaded (quarantine xattr), and Gatekeeper
  will block it outright without a Developer ID signature + notarization
  ticket. A locally-built binary (as in this repo's dev workflow) has no
  quarantine attribute and runs fine; a binary fetched from a plugin
  distribution channel will not, without: (1) a paid Apple Developer ID
  certificate, (2) `codesign --sign <identity> --options runtime` on the
  built binary, (3) `xcrun notarytool submit` + `stapler staple`. This is
  a real, non-optional cost of shipping to end users on macOS -- it
  cannot be worked around.
- **Windows signing:** unsigned `.exe`s trigger SmartScreen warnings on
  first run ("Windows protected your PC"). Not a hard block like macOS
  Gatekeeper, but a real trust/adoption cost. Requires an Authenticode
  code-signing certificate (EV certificates avoid SmartScreen's reputation
  ramp-up; standard OV certificates still build reputation over time).
- **Linux packaging:** no OS-level code-signing gate equivalent to the
  above two. Distribution-specific packaging (`.deb`/`.rpm`/Flatpak/AppImage)
  is a packaging-format decision, not a security-gate one; none is
  implemented for v0.1 -- a bare binary in `bin/linux-x64/` is what
  `scripts/build-helper.sh` produces today.

## CI build matrix (not implemented, sketch only)

No CI is configured in this repository for v0.1 (see STATUS.md). If/when
it is, the natural shape is a GitHub Actions matrix:

```yaml
strategy:
  matrix:
    include:
      - os: macos-14        # arm64 runner
        target: aarch64-apple-darwin
        bin_dir: macos-arm64
      - os: macos-13         # x64 runner
        target: x86_64-apple-darwin
        bin_dir: macos-x64
      - os: windows-latest
        target: x86_64-pc-windows-msvc
        bin_dir: windows-x64
      - os: ubuntu-latest
        target: x86_64-unknown-linux-gnu
        bin_dir: linux-x64
```

Each job would run `cargo build --release --target <target>` inside
`packages/reader-helper`, then `cargo test` (the engine/cache/blit test
suite is entirely headless and CI-safe -- it needs no display server,
unlike anything that would try to drive the actual `winit` window). Signing
steps (previous section) would run only on tagged-release builds, not on
every PR, given their cost/complexity.
