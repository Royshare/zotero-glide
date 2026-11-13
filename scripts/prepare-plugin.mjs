// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

// npm runs in cmd.exe on Windows. A bare `bash` can resolve to WSL even
// though Node and Cargo are Windows executables. Select Git Bash explicitly
// and discover native build dependencies without changing the user's PATH.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function directories(path) {
  return existsSync(path)
    ? readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    : [];
}

function executable(name, paths) {
  return paths.map((path) => join(path, name)).find(existsSync);
}

export function windowsBuildEnvironment(root, sourceEnv = process.env, run = spawnSync) {
  const env = { ...sourceEnv };
  // Windows env keys are case insensitive, but Node's child-process env
  // serialization can otherwise choose an older PATH over npm's Path.
  const paths = Object.entries(env)
    .filter(([key]) => key.toLowerCase() === "path")
    .flatMap(([, value]) => value.split(";"))
    .filter(Boolean)
    .map((path) => path.replace(/^"(.*)"$/, "$1"));
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") delete env[key];
  }

  const gitRoots = paths.filter((path) => existsSync(join(path, "git.exe")))
    .flatMap((path) => [resolve(path, ".."), resolve(path, "../..")]);
  for (const prefix of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs")]) {
    if (prefix) gitRoots.push(join(prefix, "Git"));
  }
  const bash = gitRoots.map((path) => join(path, "bin", "bash.exe")).find(existsSync);
  if (!bash) throw new Error("Git Bash was not found. Install Git for Windows with its command-line tools on PATH; WSL Bash cannot build the Windows helper.");
  paths.unshift(dirname(bash));

  if (!env.GLIDE_SKIP_HELPER_BUILD) {
    const cargoHome = env.CARGO_HOME || (env.USERPROFILE && join(env.USERPROFILE, ".cargo"));
    if (cargoHome) paths.push(join(cargoHome, "bin"));
    const cargo = executable("cargo.exe", paths);
    if (!cargo) throw new Error("Windows cargo.exe was not found on PATH or in CARGO_HOME/USERPROFILE/.cargo/bin. Install the Rust MSVC toolchain.");
    paths.unshift(dirname(cargo));

    const vswhere = env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "Microsoft Visual Studio", "Installer", "vswhere.exe");
    const vs = vswhere && existsSync(vswhere)
      ? run(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8", windowsHide: true })
      : null;
    const vsRoot = vs?.status === 0 ? vs.stdout.trim() : env.VSINSTALLDIR;

    if (!env.MUPDF_MSVC_PLATFORM_TOOLSET) {
      const vcRoot = vsRoot && join(vsRoot, "MSBuild", "Microsoft", "VC");
      const toolsets = vcRoot ? directories(vcRoot).flatMap((version) =>
        directories(join(vcRoot, version, "Platforms", "x64", "PlatformToolsets"))) : [];
      env.MUPDF_MSVC_PLATFORM_TOOLSET = toolsets.filter((name) => /^v\d+$/.test(name))
        .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))[0];
      if (!env.MUPDF_MSVC_PLATFORM_TOOLSET) {
        throw new Error("Visual Studio C++ x64 build tools were not found. Install the Desktop development with C++ workload and a Windows SDK, or set MUPDF_MSVC_PLATFORM_TOOLSET for your custom installation.");
      }
    }

    if (!env.LIBCLANG_PATH) {
      const clangPaths = [
        join(root, "packages", "reader-helper", "target", "build-tools", "libclang", "clang", "native"),
        env.ProgramFiles && join(env.ProgramFiles, "LLVM", "bin"),
        vsRoot && join(vsRoot, "VC", "Tools", "Llvm", "x64", "bin"),
        ...paths,
      ].filter(Boolean);
      env.LIBCLANG_PATH = clangPaths.find((path) => existsSync(join(path, "libclang.dll")));
      if (!env.LIBCLANG_PATH) {
        throw new Error("libclang.dll was not found. Set LIBCLANG_PATH to its directory, or run from the repository root: python -m pip install --target packages/reader-helper/target/build-tools/libclang libclang==18.1.1");
      }
    }
  }

  env.PATH = [...new Set(paths)].join(";");
  return { bash, env };
}

export function preparePlugin(root) {
  const { bash, env } = process.platform === "win32"
    ? windowsBuildEnvironment(root)
    : { bash: "bash", env: process.env };
  if (process.platform === "win32") {
    console.log(`Windows build shell: ${bash}`);
    if (!env.GLIDE_SKIP_HELPER_BUILD) {
      console.log(`Windows Cargo: ${executable("cargo.exe", env.PATH.split(";"))}`);
      console.log(`MSVC toolset: ${env.MUPDF_MSVC_PLATFORM_TOOLSET}; libclang: ${env.LIBCLANG_PATH}`);
    }
  }
  for (const script of ["scripts/build-helper.sh", "scripts/prepare-legal.sh"]) {
    const result = spawnSync(bash, ["--noprofile", "--norc", script], {
      cwd: root, env, stdio: "inherit", windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = preparePlugin(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  } catch (error) {
    console.error(`Build setup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
