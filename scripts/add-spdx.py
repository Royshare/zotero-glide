#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Zotero Glide contributors
"""Adds the SPDX license + copyright header to every source file that lacks one (idempotent).
  python3 scripts/add-spdx.py          # fix
  python3 scripts/add-spdx.py --check  # exit 1 listing files without a header (used by CI)
"""
import os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TAG = "SPDX-License-Identifier: AGPL-3.0-or-later"
OWNER = "Copyright (C) 2026 Zotero Glide contributors"
STYLES = {".rs": "//", ".ts": "//", ".mts": "//", ".js": "//", ".mjs": "//", ".py": "#", ".sh": "#", ".yml": "#"}
SKIP_NAMES = {"i10n.d.ts"}  # generated

def files():
    out = subprocess.run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                         cwd=ROOT, capture_output=True, text=True, check=True).stdout
    for rel in filter(None, out.split("\0")):
        if os.path.splitext(rel)[1] in STYLES and os.path.basename(rel) not in SKIP_NAMES and os.path.exists(f"{ROOT}/{rel}"):
            yield rel

def main():
    missing = []
    for rel in files():
        path = f"{ROOT}/{rel}"
        text = open(path, encoding="utf-8").read()
        if TAG in "\n".join(text.splitlines()[:6]):
            continue
        missing.append(rel)
        if "--check" in sys.argv:
            continue
        c = STYLES[os.path.splitext(rel)[1]]
        header = f"{c} {TAG}\n{c} {OWNER}\n"
        if text.startswith("#!"):
            first, _, rest = text.partition("\n")
            text = f"{first}\n{header}{rest}"
        else:
            text = f"{header}\n{text}"
        open(path, "w", encoding="utf-8").write(text)
    if "--check" in sys.argv:
        if missing:
            sys.exit("missing SPDX header:\n  " + "\n  ".join(missing))
        print("all source files have an SPDX header")
    else:
        print(f"added headers to {len(missing)} files")

main()
