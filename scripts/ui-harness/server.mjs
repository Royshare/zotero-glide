// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors
//
// Development harness: runs the REAL reader (packages/zotero-plugin/src/readerTab.ts + tabView.ts) in an
// ordinary browser against the REAL helper binary, with Zotero replaced by in-memory stand-ins, so the UI can
// be looked at and driven without a Zotero window. The helper's stdio and frame files are bridged over HTTP.
//
//   node scripts/ui-harness/server.mjs            # http://127.0.0.1:8766/?pdf=/abs/path/to.pdf
//
// Needs the release helper (cargo build --release in packages/reader-helper) and `npm ci` in packages/zotero-plugin.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(path.join(root, "packages/zotero-plugin/package.json"));
const { build } = require("esbuild");
const HELPER = process.env.HELPER || path.join(root, "packages/reader-helper/target/release/fast-reader-helper");
const PORT = Number(process.env.PORT || 8766);

const sessions = new Map(); // id -> { proc, frameDir, chunks: string[], waiters: [] }
let nextSession = 1;

async function bundle() {
  const out = await build({
    entryPoints: [path.join(here, "harness.ts")],
    bundle: true, write: false, format: "iife", target: "es2022", sourcemap: "inline", logLevel: "silent",
  });
  return out.outputFiles[0].text;
}

const HTML = `<!doctype html><meta charset=utf-8><title>Fast Reader UI harness</title>
<style>html,body{margin:0;height:100%;font:13px system-ui}#root{height:100vh;width:100vw}#toast{position:fixed;right:12px;bottom:12px;background:#222;color:#fff;padding:8px 12px;border-radius:6px;display:none;max-width:360px;z-index:99}</style>
<div id=root></div><div id=toast></div><script src="/app.js"></script>`;

function send(res, code, body, type = "text/plain") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/") return send(res, 200, HTML, "text/html");
    if (url.pathname === "/app.js") return send(res, 200, await bundle(), "text/javascript");
    if (url.pathname === "/open") {
      const pdf = url.searchParams.get("pdf");
      if (!pdf || !fs.existsSync(pdf)) return send(res, 400, "pdf not found");
      const id = String(nextSession++);
      const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), "fr-harness-"));
      const proc = spawn(HELPER, ["--serve", "--frame-dir", frameDir, "--file", pdf], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MallocSpaceEfficient: "1" } });
      const s = { proc, frameDir, chunks: [], waiters: [] };
      const push = (d) => { s.chunks.push(d.toString()); s.waiters.splice(0).forEach((w) => w()); };
      proc.stdout.on("data", push);
      proc.stderr.on("data", push);
      proc.on("exit", () => { s.chunks.push(""); s.waiters.splice(0).forEach((w) => w()); });
      sessions.set(id, s);
      return send(res, 200, JSON.stringify({ id, frameDir }), "application/json");
    }
    const s = sessions.get(url.searchParams.get("s") || "");
    if (url.pathname === "/stdin" && s) {
      let body = ""; for await (const c of req) body += c;
      s.proc.stdin.write(body);
      return send(res, 200, "ok");
    }
    if (url.pathname === "/stdout" && s) {
      if (!s.chunks.length) await Promise.race([new Promise((r) => s.waiters.push(r)), new Promise((r) => setTimeout(r, 15000))]);
      const text = s.chunks.length ? s.chunks.shift() : "\u0000"; // \0 = nothing yet: the client polls again
      return send(res, 200, text);
    }
    if (url.pathname === "/file") {
      const p = url.searchParams.get("path") || "";
      if (!p.startsWith(os.tmpdir()) || !p.includes("fr-harness-")) return send(res, 403, "no");
      if (req.method === "DELETE") { fs.rm(p, { force: true }, () => {}); return send(res, 200, "ok"); }
      if (!fs.existsSync(p)) return send(res, 404, "gone");
      return send(res, 200, fs.readFileSync(p), "application/octet-stream");
    }
    send(res, 404, "not found");
  } catch (e) {
    send(res, 500, String(e && e.stack || e));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`UI harness on http://127.0.0.1:${PORT}/?pdf=<absolute path to a pdf>`));
