#!/usr/bin/env python3
"""Usage: python3 compare.py <workdir> [paper-name ...]   (env: OUT=file.jsonl MODES=pdfjs,fast ZOTERO_APP=...)
Needs: an ISOLATED Zotero profile at <workdir>/p10 and data dir <workdir>/d10 with the plugin's
built .xpi installed and the benchmark PDFs imported (attachment ids in PAPERS below).
NEVER point this at your real profile. Summarize with: python3 summarize.py <out.jsonl>
Head-to-head: Zotero's PDF.js reader tab vs the Fast Reader tab, same Zotero, same PDFs.
Fresh Zotero launch per (paper, mode). Memory = sum of macOS phys_footprint over the whole
process tree of that Zotero instance (parent + Gecko children + our helper)."""
import json, os, re, subprocess, sys, time, statistics
HERE = os.path.dirname(os.path.abspath(__file__))
S = sys.argv[1]  # work dir holding the isolated profile (p10/) and data dir (d10/)
APP = os.environ.get("ZOTERO_APP", "/Applications/Zotero.app"); PORT = "63100"
PROFILE, DATA = f"{S}/p10", f"{S}/d10"
# (label, attachment id in the isolated library) -- import your own PDFs and adjust
PAPERS = [("p1-short-8pp", 2), ("p2-draft-5pp", 3), ("p3-large-48pp", 4), ("p4-long-464pp", 5), ("p5-scan-40pp", 6)]
only = sys.argv[2:] 

def js(body, timeout=120):
    r = subprocess.run(["node", "run.mjs", body], cwd=HERE, capture_output=True, text=True, timeout=timeout, env={**os.environ, "PORT": PORT})
    for line in r.stdout.splitlines():
        try:
            o = json.loads(line)
            if "ok" in o: return o["ok"]
            if "err" in o: raise RuntimeError(o["err"][:300])
        except json.JSONDecodeError: pass
    raise RuntimeError("no result: " + r.stdout[-200:] + r.stderr[-200:])

def kids(pid):
    out = subprocess.run(["pgrep", "-P", str(pid)], capture_output=True, text=True).stdout.split()
    res = []
    for k in out: res += [int(k)] + kids(int(k))
    return res

def fp(pid):
    o = subprocess.run(["footprint", "-p", str(pid)], capture_output=True, text=True).stdout
    m = re.search(r"Footprint:\s+([\d.]+)\s*(KB|MB|GB)", o)
    return float(m.group(1)) * {"KB": 1/1024, "MB": 1, "GB": 1024}[m.group(2)] if m else 0.0

def snapshot(root):
    parts = {"zotero": fp(root), "children": 0.0, "helper": 0.0}
    for k in kids(root):
        cmd = subprocess.run(["ps", "-o", "command=", "-p", str(k)], capture_output=True, text=True).stdout
        v = fp(k)
        if "fast-reader-helper" in cmd: parts["helper"] += v
        else: parts["children"] += v
    parts["total"] = parts["zotero"] + parts["children"] + parts["helper"]
    return parts

def settle(root, secs=4):
    time.sleep(secs); return snapshot(root)

def run(paper, att, mode):
    subprocess.run([f"{HERE}/zlaunch.sh", APP, PROFILE, DATA, PORT], check=True)
    root = int(open(f"{PROFILE}/pid").read())
    for _ in range(60):
        time.sleep(1)
        try:
            if js("return Zotero.getMainWindow().Zotero_Tabs._tabs.length", 15): break
        except Exception: pass
    time.sleep(20)
    res = {"paper": paper, "mode": mode, "baseline": settle(root, 2)}
    PAGES = "app.pagesCount"
    if mode == "pdfjs":
        opened = js(f"""
          const t0 = performance.now();
          const reader = await Zotero.Reader.open({att}, null, {{ allowDuplicate: true }});
          await reader._initPromise;
          let app;
          while (!(app = reader._internalReader?._primaryView?._iframeWindow?.PDFViewerApplication) || !app.pdfViewer) await new Promise(r => setTimeout(r, 5));
          while (!(app.pdfViewer && app.pdfViewer.getPageView(0) && app.pdfViewer.getPageView(0).renderingState === 3)) await new Promise(r => setTimeout(r, 5));
          Zotero.__app = app;
          return JSON.stringify({{ firstPageMs: Math.round(performance.now() - t0), pages: app.pagesCount }});""", 90)
    else:
        opened = js(f"""
          const t0 = performance.now();
          await Zotero.FastReader.openInTab(Zotero.Items.get({att}));
          const d = Zotero.getMainWindow().document;
          while (!(d.querySelector('.fr-root canvas')?.width > 0)) await new Promise(r => setTimeout(r, 5));
          return JSON.stringify({{ firstPageMs: Math.round(performance.now() - t0), pages: parseInt(d.querySelector('.fr-bar .fr-status').textContent.replace('/ ','')) || null }});""", 90)
    o = json.loads(opened); res["firstPageMs"] = o["firstPageMs"]; res["pages"] = o["pages"]
    res["opened"] = settle(root, 5)
    if mode == "pdfjs":
        turns = js("""
          const app = Zotero.__app, n = Math.min(30, app.pagesCount - 1), lat = [];
          for (let i = 2; i <= n + 1; i++) {
            const t = performance.now(); app.page = i;
            while (!(app.pdfViewer.getPageView(i - 1) && app.pdfViewer.getPageView(i - 1).renderingState === 3)) await new Promise(r => setTimeout(r, 2));
            lat.push(performance.now() - t); await new Promise(r => setTimeout(r, 150));
          }
          return JSON.stringify(lat);""", 180)
    else:
        turns = js("""
          const w = Zotero.getMainWindow(), d = w.document, pi = d.querySelector('.fr-page'), root = d.querySelector('.fr-root');
          const total = parseInt(d.querySelector('.fr-bar .fr-status').textContent.replace('/ ', ''));
          const n = Math.min(30, total - 1), lat = [];
          for (let i = 2; i <= n + 1; i++) {
            const t = performance.now();
            root.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
            while (pi.value !== String(i)) await new Promise(r => setTimeout(r, 2));
            lat.push(performance.now() - t); await new Promise(r => setTimeout(r, 150));
          }
          return JSON.stringify(lat);""", 180)
    lat = sorted(json.loads(turns))
    res["turns"] = len(lat); res["turn_p50"] = round(statistics.median(lat)); res["turn_p95"] = round(lat[max(0, int(len(lat) * .95) - 1)])
    res["after_reading"] = settle(root, 4)
    js("Zotero.getMainWindow().Zotero_Tabs.select('zotero-pane'); return 1")
    res["backgrounded"] = settle(root, 6)
    js("""const T = Zotero.getMainWindow().Zotero_Tabs; const t = T._tabs.find(t => t.type !== 'library'); T.close(t.id); return 1""")
    res["closed"] = settle(root, 5)
    try: js("Services.startup.quit(Services.startup.eAttemptForceQuit); return 1", 10)
    except Exception: pass
    for _ in range(20):
        time.sleep(1)
        if subprocess.run(["kill", "-0", str(root)], capture_output=True).returncode: break
    else: subprocess.run(["kill", "-9", str(root)])
    time.sleep(2)
    return res

out = open(f"{S}/{os.environ.get('OUT', 'compare.jsonl')}", "a")
MODES = os.environ.get("MODES", "pdfjs,fast").split(",")
for paper, att, mode in [(p, a, m) for rep in range(2) for p, a in PAPERS for m in MODES]:
    if only and paper not in only: continue
    if True:
        try:
            r = run(paper, att, mode)
        except Exception as e:
            r = {"paper": paper, "mode": mode, "error": str(e)[:300]}
            subprocess.run(["pkill", "-f", PROFILE])
            time.sleep(3)
        out.write(json.dumps(r) + "\n"); out.flush()
        print(paper, mode, "ok" if "error" not in r else r["error"], flush=True)
