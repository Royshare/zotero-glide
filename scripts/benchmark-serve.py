#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Zotero Fast Reader contributors
"""Memory/latency benchmark for the in-tab (--serve) mode of fast-reader-helper.

Drives the real helper binary over its stdio protocol exactly as the Zotero
tab does: a retina-sized viewport, then 100 page turns, then `trim`.
Reports phys_footprint (macOS `footprint`, the honest number -- `ps` RSS
overstates, see docs/benchmark-methodology.md) at each stage, and the
command->frame latency per page turn.

    python3 scripts/benchmark-serve.py [path/to/fast-reader-helper]
    python3 scripts/benchmark-serve.py --untuned   # without the allocator knob, for comparison

The plugin launches the helper with an allocator knob (macOS MallocSpaceEfficient=1,
Linux MALLOC_MMAP_THRESHOLD_=1048576; see packages/zotero-plugin/src/buildArgs.ts
helperEnvironment); so does this.
"""
import json, os, re, statistics, subprocess, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
args = [a for a in sys.argv[1:] if not a.startswith("--")]
ENV = dict(os.environ)
if "--untuned" not in sys.argv:
    if sys.platform == "darwin":
        ENV["MallocSpaceEfficient"] = "1"
    elif sys.platform.startswith("linux"):
        ENV["MALLOC_MMAP_THRESHOLD_"] = "1048576"
BIN = args[0] if args else f"{ROOT}/packages/reader-helper/target/release/fast-reader-helper"
FIXTURES = ["paper-a.pdf", "book-b.pdf", "scanned-c.pdf"]
VIEWPORT = (2068, 1382, 2.0)  # a ~1034x691 CSS-px tab on a retina display


def footprint_mb(pid):
    if sys.platform != "darwin":
        return float(subprocess.check_output(["ps", "-o", "rss=", "-p", str(pid)])) / 1024
    out = subprocess.run(["footprint", "-p", str(pid)], capture_output=True, text=True).stdout
    m = re.search(r"Footprint:\s+([\d.]+)\s*(KB|MB|GB)", out)
    return float(m.group(1)) * {"KB": 1 / 1024, "MB": 1, "GB": 1024}[m.group(2)] if m else float("nan")


for name in FIXTURES:
    pdf = f"{ROOT}/benchmarks/fixtures/{name}"
    if not os.path.exists(pdf):
        print(f"{name}: missing (run scripts/gen_fixtures.py)")
        continue
    frames = tempfile.mkdtemp(prefix="fr-bench-")
    p = subprocess.Popen([BIN, "--serve", "--frame-dir", frames, "--file", pdf],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=ENV)
    send = lambda **c: (p.stdin.write(json.dumps(c) + "\n"), p.stdin.flush())
    def frame(page, rid):
        """Render one page and wait for its frame; the host reads and deletes the file, so do we."""
        send(cmd="render", id=rid, page=page, scale=SCALE)
        while True:
            ev = json.loads(p.stdout.readline())
            if ev.get("event") == "frame" and ev["id"] == rid:
                os.remove(ev["path"])
                return ev
    ready = json.loads(p.stdout.readline())
    pages = ready["pageCount"]
    SCALE = VIEWPORT[0] / ready["pages"][0]["w"]  # fit width, retina
    t0 = time.time(); frame(0, 1)
    first_ms = (time.time() - t0) * 1000
    after_first = footprint_mb(p.pid)
    lat, mid = [], None
    turns = min(100, pages - 1)
    for i in range(turns):
        t = time.time(); frame(i + 1, i + 2); lat.append((time.time() - t) * 1000)
        if i == turns // 2: mid = footprint_mb(p.pid)
    end = footprint_mb(p.pid)
    send(cmd="trim"); time.sleep(0.4); trimmed = footprint_mb(p.pid)
    send(cmd="quit"); p.wait()
    lat.sort()
    print(f"{name:14s} {pages:3d}pp  first frame {first_ms:5.0f} ms | page turn p50 {statistics.median(lat):4.0f} ms p95 {lat[int(len(lat)*.95)-1]:4.0f} ms"
          f" | footprint MB: first {after_first:4.0f}  mid-read {mid:4.0f}  after {turns} turns {end:4.0f}  trimmed {trimmed:4.0f}")
