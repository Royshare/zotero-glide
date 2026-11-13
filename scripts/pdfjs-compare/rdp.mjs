// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Zotero Glide contributors

// Minimal Firefox RDP client: evaluates JS in Zotero's parent process (chrome privileges).
import net from "node:net";
export function connect(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    let buf = Buffer.alloc(0);
    const waiters = []; const queue = [];
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const i = buf.indexOf(":"); if (i < 0) return;
        const len = parseInt(buf.slice(0, i).toString(), 10);
        if (isNaN(len) || buf.length < i + 1 + len) return;
        const msg = JSON.parse(buf.slice(i + 1, i + 1 + len).toString());
        buf = buf.slice(i + 1 + len);
        const w = waiters.findIndex((x) => x.pred(msg));
        if (w >= 0) waiters.splice(w, 1)[0].res(msg); else queue.push(msg);
      }
    });
    sock.on("error", reject);
    const next = (pred) => new Promise((res) => { const q = queue.findIndex(pred); if (q >= 0) res(queue.splice(q, 1)[0]); else waiters.push({ pred, res }); });
    const send = (o) => { const s = JSON.stringify(o); sock.write(`${Buffer.byteLength(s)}:${s}`); };
    const request = async (to, type, extra = {}) => { send({ to, type, ...extra }); return next((m) => m.from === to && !m.type); };
    next((m) => m.from === "root").then(async (greet) => {
      try {
        const proc = await request("root", "getProcess", { id: 0 });
        const desc = proc.processDescriptor;
        const t = await request(desc.actor, "getTarget");
        const consoleActor = t.process.consoleActor;
        const evalJS = async (text) => {
          send({ to: consoleActor, type: "evaluateJSAsync", text, mapped: { await: true } });
          const ack = await next((m) => m.from === consoleActor && m.resultID);
          const res = await next((m) => m.from === consoleActor && m.type === "evaluationResult" && m.resultID === ack.resultID);
          return res;
        };
        resolve({ evalJS, close: () => sock.destroy() });
      } catch (e) { reject(e); }
    });
  });
}
