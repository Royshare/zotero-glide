# Future IPC: Zotero ↔ Fast Reader

**Update (v0.3):** a stdin/stdout JSON-lines protocol now exists for the
in-tab reader (`packages/reader-helper/src/serve.rs`, ADR 002), and it is
exactly the transport this document recommends -- no localhost server. The
rest of this document (selection/annotation bridge, hand-back to Zotero's
reader) is still design only.

**Not implemented in v0.1.** This documents a plausible shape for later,
per §11 of the project brief -- "design, but do NOT implement." v0.1's IPC
surface stops at: plugin resolves a helper binary path, spawns it with an
argv array (`fast-reader-helper <pdf-path>` / `--file <path> --page N`),
and does not wait for or talk to it again (see `docs/adr/001-*.md`, §7 of
the brief).

## Why this matters later, and why not now

Once Fast Reader is validated as an alternative reading path, real
usefulness needs some bidirectional signaling:

- `reader.pageChanged(page)` -- so Zotero could show "currently reading
  page 12" or restore position next time.
- `reader.selectionChanged(range)` -- precursor to any future annotation
  bridge (explicitly *not* v0.1 scope -- see brief §2).
- `reader.openInZoteroReader(page)` -- "hand back" to Zotero's real reader
  at the same page, e.g. to annotate.
- `zotero.restorePosition(attachmentKey, page, scroll, zoom)` -- Zotero
  telling a freshly-launched Fast Reader where the user left off.

`state::ReaderState` (`src/state.rs`) already carries the fields this would
need (`page`, `zoom_mode`, `zoom_scale`) precisely so that adding
persistence later is additive, not a reshape -- see the file's own comment.

## Preferred transport, when this is built

**stdio or a named pipe / Unix domain socket, not a long-running HTTP
service.** Per brief §11 and §7 ("the plugin should not require the helper
to expose an HTTP server... do not introduce localhost networking"):

- An HTTP/localhost server means an always-listening socket, a port to
  pick and potentially collide with something else on the user's machine,
  and a much larger attack surface (any local process, or in some
  misconfigurations any web page via DNS rebinding, could talk to it) for
  a feature that only ever needs to talk to the one Zotero process that
  launched it.
- stdio is the simplest possible option: the plugin already owns the
  child process's stdin/stdout via `Subprocess.call()` (see
  `docs/adr/001-*.md`'s citation of Zotero's `Subprocess.sys.mjs`
  research). A newline-delimited JSON protocol over stdout, read
  incrementally by the plugin, costs nothing extra to wire up and needs no
  new permissions.
- A named pipe / Unix domain socket would only earn its complexity if
  Fast Reader needed to be *launched independently* of Zotero (e.g., "open
  recent" from the helper itself, or multiple Zotero windows sharing one
  helper) -- not needed for the "one PDF per helper process" model this
  project intentionally keeps (§1, §22: process isolation over clever
  integration).

## A sketch, not a spec

```
Zotero plugin                          fast-reader-helper (per PDF)
     │  spawn(helper, [--file, path,   │
     │         --page, N])             │
     ├─────────────────────────────────▶
     │                                  │ open document, render page N
     │  (stdout, newline-delimited      │
     │   JSON, best-effort -- plugin    │
     │   need not read it)              │
     │◀─────────────────────────────────┤ {"event":"pageChanged","page":4}
     │◀─────────────────────────────────┤ {"event":"closed","page":4,"zoom":1.3}
     │  on "closed": persist position   │
     │  via Zotero's own extra-data     │  (process exits; OS reclaims all
     │  storage (NOT zotero.sqlite      │   of Fast Reader's memory --
     │  directly -- see brief §3)       │   independent of Zotero, per §1)
```

Two design commitments worth stating now, even though nothing here is
built:

1. **The helper never talks to zotero.sqlite, ever, at any version.** If
   position/selection persistence is built, it goes through the plugin
   (which uses Zotero's supported item-data APIs), not through the helper
   touching Zotero's database directly. This mirrors §3's "must NOT ...
   access zotero.sqlite directly" for the plugin itself.
2. **The helper must keep working with zero IPC.** `fast-reader-helper
   some.pdf` run entirely by hand, with no Zotero involved, is a
   first-class use case (this is exactly how it was developed and tested
   for v0.1 -- see `docs/benchmark-methodology.md`). Any future protocol
   must be optional/best-effort from the helper's side: if Zotero isn't
   listening (or the pipe write fails), the reader keeps working
   standalone. This is also why the sketch above uses one-way
   best-effort stdout events rather than a request/response protocol the
   helper depends on -- a helper that *requires* Zotero to be present to
   function would be a regression from "separate process, separate
   lifecycle" (§1) toward exactly the tight coupling this project exists
   to avoid.

## Explicitly out of scope for "future," not just for v0.1

Annotation sync (creating/editing Zotero annotations from Fast Reader) is
a different, much bigger problem than position sync -- it needs a real
data model reconciliation story with Zotero's existing annotation storage,
which brief §2 rules out even as a design exercise right now. Nothing in
this document should be read as scoping that; it's deliberately absent.
