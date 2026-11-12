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

## Building on Windows from PowerShell

Install Rust stable for `x86_64-pc-windows-msvc`, Visual Studio C++ Build
Tools with a Windows SDK, Node.js, and Git for Windows. The npm hooks use
`scripts/prepare-plugin.mjs` to select Git Bash explicitly, so Windows' WSL
`bash.exe` cannot accidentally build a Linux helper. It also finds Cargo
on PATH or under `CARGO_HOME` / `%USERPROFILE%\.cargo`, detects the installed
MSVC PlatformToolset with `vswhere`, and discovers libclang in the local
build-tools folder, LLVM, Visual Studio LLVM, or PATH. Existing
`MUPDF_MSVC_PLATFORM_TOOLSET` and `LIBCLANG_PATH` settings take precedence.
Shell scripts are checked out with LF endings via `.gitattributes`.
MuPDF needs libclang for generating Rust bindings. Either set
`LIBCLANG_PATH` to your LLVM installation's `bin` directory, or install
the standalone DLL locally with Python as below (it is only a build
dependency and is not included in the XPI).

Run from the repository root:

```powershell
# One-time libclang installation, unless LLVM already supplies libclang.dll.
python -m pip install --target packages/reader-helper/target/build-tools/libclang libclang==18.1.1

Set-Location packages/zotero-plugin
npm ci
npm run build
```

The same `npm run build` command works in a fresh PowerShell session without
editing PATH or setting build variables. Build setup prints the selected
Windows Cargo, Git Bash, MSVC toolset and libclang paths. If a prerequisite
is missing, it stops with the corresponding setup instruction before compilation.
For direct `bash scripts/build-helper.sh` invocations, use Git Bash and set
`LIBCLANG_PATH` and `MUPDF_MSVC_PLATFORM_TOOLSET` yourself; the automatic
discovery applies to the npm `build` and `start` hooks.

The result is `packages/zotero-plugin/.scaffold/build/zotero-fast-reader.xpi`,
containing `bin/windows-x64/fast-reader-helper.exe`. Install it using
Zotero's Tools → Plugins → gear → Install Plugin From File.

The Windows branch of `build-helper.sh` pre-includes `scripts/msvc-bindgen.h`
for bindgen. This supplies MSVC's `max_align_t` declaration, missing from its
C headers but required by mupdf 0.8.0
([upstream issue](https://github.com/messense/mupdf-rs/issues/222)). It leaves
the Cargo registry and other platforms untouched. For direct Cargo builds
or tests, set the same include explicitly, from the repository root:

```powershell
$header = (Resolve-Path scripts/msvc-bindgen.h).Path.Replace('\', '/')
$env:BINDGEN_EXTRA_CLANG_ARGS = '-include "' + $header + '"'
python scripts/gen_fixtures.py
Set-Location packages/reader-helper
cargo test --release --locked
```

Plugin tests use `npm test` on Node 24+, or
`node --experimental-strip-types --test` on Node 22.

Verified locally on Windows x64 on 2026-11-11 with Rust 1.99.1, VS 2026
toolset v145, libclang 18.1.1, and Node 22.23.2: release build, all 86
native tests, all 120 plugin tests, TypeScript checking, and XPI packaging
passed. The helper extracted from the finished XPI was checked as an AMD64
PE executable matching the release binary, then used to render a real
three-page fixture, extract text, search, trim/reopen, and exit cleanly.
Manual interaction with the installed plugin inside Zotero is still pending.

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

## CI

`.github/workflows/ci.yml` (every push/PR): license headers + notices up to
date; helper `cargo test` + build + the serve-mode benchmark on macOS arm64,
macOS Intel (`macos-15-intel`), Windows and Ubuntu 22.04 (built on 22.04 so the
binary's glibc requirement is as old as practical); plugin typecheck + unit
tests on Node 24.

`.github/workflows/release.yml` (tag `vX.Y.Z`, which must equal the plugin's
`package.json` version): builds the helper on all four platforms, assembles one
`.xpi` containing all four binaries (`FAST_READER_SKIP_HELPER_BUILD=1` makes the
npm `prebuild` hook use them instead of building the host's), builds the
AGPL corresponding-source archive (`scripts/make-source-archive.sh`: project +
`cargo vendor`, MuPDF included), and publishes the three files with SHA256SUMS.

**Honest status:** the scripts the workflows call were run locally on macOS
arm64, and Windows x64 was built and tested locally as described above, but
the workflows themselves have never run on GitHub. The Windows runner's
MuPDF/MSBuild/libclang setup and the Intel macOS leg still need verification
on GitHub. Signing/notarization (above) is still not done, so release binaries
will trigger Gatekeeper/SmartScreen warnings.
