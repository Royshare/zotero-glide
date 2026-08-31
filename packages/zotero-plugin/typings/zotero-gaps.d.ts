/**
 * Ambient declarations for real Zotero globals not (yet) covered by the
 * community `zotero-types` package, confirmed live against a running
 * Zotero instance this session (see STATUS.md). Kept minimal -- only
 * what this plugin actually uses.
 */
declare namespace Zotero {
  /** e.g. "aarch64", "x86_64". Confirmed live; Zotero.platform does NOT exist (see fastReader.ts's hostPlatform()). */
  const arch: string;
  /** This plugin's own instance, attached by src/index.ts so bootstrap.js can drive it without a loadSubScript chain. */
  let FastReader: typeof import("../src/fastReader.js").FastReader;
}

// The sandbox lib set (zotero-types/entries/sandbox) doesn't include DOM,
// but bootstrap-privileged code genuinely has these two (confirmed live
// this session: fetch() reads jar: URIs, setTimeout() drives the
// immediate-crash-detection race in fastReader.ts).
declare function setTimeout(callback: (...args: unknown[]) => void, ms?: number): number;
declare function fetch(url: string): Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;
