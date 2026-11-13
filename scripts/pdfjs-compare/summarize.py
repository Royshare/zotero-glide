# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Zotero Glide contributors

import json, statistics, sys, collections
rows = [json.loads(l) for l in open(sys.argv[1])]
by = collections.defaultdict(list)
for r in rows:
    if "error" in r: print("ERROR", r["paper"], r["mode"], r["error"]); continue
    by[(r["paper"], r["mode"])].append(r)
med = lambda xs: statistics.median(xs)
def delta(rs, key): return [r[key]["total"] - r["baseline"]["total"] for r in rs]
print(f"{'paper':15s} {'mode':6s} {'n':>1s} {'base MB':>8s} | {'first page':>10s} | {'Δ open':>7s} {'Δ read30':>8s} {'Δ bg':>6s} {'Δ closed':>8s} | helper@read | turn p50/p95 ms")
for paper in sorted({p for p, _ in by}):
    for mode in ("pdfjs", "fast"):
        rs = by.get((paper, mode), [])
        if not rs: continue
        helper = med([r["after_reading"]["helper"] for r in rs])
        print(f"{paper:15s} {mode:6s} {len(rs):>1d} {med([r['baseline']['total'] for r in rs]):8.0f} | {med([r['firstPageMs'] for r in rs]):8.0f}ms | "
              f"{med(delta(rs,'opened')):7.0f} {med(delta(rs,'after_reading')):8.0f} {med(delta(rs,'backgrounded')):6.0f} {med(delta(rs,'closed')):8.0f} | {helper:8.0f}    | {med([r['turn_p50'] for r in rs]):.0f}/{med([r['turn_p95'] for r in rs]):.0f}")
    print()
