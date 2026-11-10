// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Fast Reader contributors

// Evaluates an async JS body in Zotero's parent process over the Firefox remote debugging protocol.
// usage: PORT=63100 node run.mjs 'return Zotero.version'
// usage: node run.mjs '<async js body that may use await and return a value>'
import { connect } from "./rdp.mjs";
const c = await connect(Number(process.env.PORT || 63044));
await c.evalJS(`Zotero.__r = undefined; (async () => { ${process.argv[2]} })().then(v => Zotero.__r = {ok: v}, e => Zotero.__r = {err: String(e && e.stack || e)}); 0`);
for (let i = 0; i < 80; i++) {
  const r = await c.evalJS(`JSON.stringify(Zotero.__r === undefined ? null : Zotero.__r)`);
  if (r.result && r.result !== "null") { console.log(r.result); break; }
  await new Promise((r) => setTimeout(r, 250));
}
c.close(); process.exit(0);
