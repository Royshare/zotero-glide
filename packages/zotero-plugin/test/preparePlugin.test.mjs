// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { windowsBuildEnvironment } from "../../../scripts/prepare-plugin.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "glide-build-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = (...parts) => {
    const path = join(root, ...parts);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
    return path;
  };
  const wsl = dirname(file("Windows", "System32", "bash.exe"));
  const git = dirname(file("Custom Git", "cmd", "git.exe"));
  const bash = file("Custom Git", "bin", "bash.exe");
  const cargo = file("User", ".cargo", "bin", "cargo.exe");
  file("Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  const vsRoot = join(root, "Visual Studio");
  file("Visual Studio", "MSBuild", "Microsoft", "VC", "v180", "Platforms", "x64", "PlatformToolsets", "v145", "Toolset.props");
  file("Visual Studio", "MSBuild", "Microsoft", "VC", "v170", "Platforms", "x64", "PlatformToolsets", "v143", "Toolset.props");
  const clang = dirname(file("packages", "reader-helper", "target", "build-tools", "libclang", "clang", "native", "libclang.dll"));
  const env = {
    Path: `${wsl};${git}`,
    PATH: join(root, "npm binaries"),
    USERPROFILE: join(root, "User"),
    "ProgramFiles(x86)": join(root, "Program Files (x86)"),
  };
  const run = () => ({ status: 0, stdout: `${vsRoot}\r\n` });
  return { root, file, wsl, git, bash, cargo, clang, env, run };
}

test("Windows npm build ignores WSL Bash and discovers Cargo, libclang and VS 2026", (t) => {
  const f = fixture(t);
  const before = { ...f.env };
  const { bash, env } = windowsBuildEnvironment(f.root, f.env, f.run);
  assert.equal(bash, f.bash);
  assert.equal(env.PATH.split(";")[0], dirname(f.cargo));
  assert.ok(env.PATH.split(";").includes(dirname(f.bash)));
  assert.ok(env.PATH.split(";").includes(f.wsl));
  assert.ok(env.PATH.split(";").includes(f.env.PATH));
  assert.equal(env.Path, undefined);
  assert.equal(env.MUPDF_MSVC_PLATFORM_TOOLSET, "v145");
  assert.equal(env.LIBCLANG_PATH, f.clang);
  assert.deepEqual(f.env, before, "configuration must not alter the parent shell");
});

test("custom CARGO_HOME and explicit dependency settings take precedence", (t) => {
  const f = fixture(t);
  const cargo = f.file("Custom Rust", "bin", "cargo.exe");
  const { env } = windowsBuildEnvironment(f.root, {
    ...f.env,
    CARGO_HOME: dirname(dirname(cargo)),
    MUPDF_MSVC_PLATFORM_TOOLSET: "v143",
    LIBCLANG_PATH: join(f.root, "Custom LLVM"),
  }, f.run);
  assert.equal(env.PATH.split(";")[0], dirname(cargo));
  assert.equal(env.MUPDF_MSVC_PLATFORM_TOOLSET, "v143");
  assert.equal(env.LIBCLANG_PATH, join(f.root, "Custom LLVM"));
});

test("release packaging can skip the helper without a native build toolchain", (t) => {
  const f = fixture(t);
  rmSync(dirname(f.cargo), { recursive: true });
  const { bash, env } = windowsBuildEnvironment(f.root, {
    Path: `${f.wsl};${f.git}`, GLIDE_SKIP_HELPER_BUILD: "1",
  }, () => { throw new Error("must not look for Visual Studio"); });
  assert.equal(bash, f.bash);
  assert.equal(env.MUPDF_MSVC_PLATFORM_TOOLSET, undefined);
});

test("missing Git Bash never falls back to the WSL executable on PATH", (t) => {
  const f = fixture(t);
  rmSync(f.bash);
  assert.throws(() => windowsBuildEnvironment(f.root, f.env, f.run), /Git Bash was not found/);
});

test("missing Windows Cargo produces an actionable error before compilation", (t) => {
  const f = fixture(t);
  rmSync(f.cargo);
  assert.throws(() => windowsBuildEnvironment(f.root, f.env, f.run), /Windows cargo.exe was not found/);
});

test("missing libclang explains how to install the local build dependency", (t) => {
  const f = fixture(t);
  rmSync(join(f.clang, "libclang.dll"));
  assert.throws(() => windowsBuildEnvironment(f.root, f.env, f.run), /python -m pip install --target/);
});

test("missing Visual Studio explains the required C++ workload", (t) => {
  const f = fixture(t);
  assert.throws(() => windowsBuildEnvironment(f.root, f.env, () => ({ status: 1 })), /Desktop development with C\+\+/);
});
