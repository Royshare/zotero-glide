/**
 * Typed errors matching the launch-failure categories in the project
 * brief (§12): "helper missing, attachment file missing, unsupported
 * platform, spawn failure, reader crashes immediately." Kept as plain
 * classes with no Zotero/Node dependency so the UI layer (fastReader.js)
 * can distinguish them with `instanceof` and show the right message, and
 * so tests can assert on error *type*, not just message text.
 *
 * Declared as `var X = class {...}` rather than `class X {...}`: Zotero's
 * `Services.scriptloader.loadSubScript(url)` (no target argument) gives
 * each loaded file its own top-level lexical scope for `let`/`const`/
 * `class` declarations, so a `class` declared here would NOT be visible
 * as a bare identifier from a separately-loaded file (e.g. fastReader.js)
 * even though they share the same global object -- only `var`/`function`
 * declarations reliably attach to that shared global across separate
 * loadSubScript calls (this is the same reason zotero/make-it-red's
 * fastreader-equivalent file uses `var FastReader = {...}`, not `const`).
 * `var X = class {...}` gets both: real ES class semantics, `var`-style
 * cross-file visibility.
 *
 * Dual CommonJS/Zotero-sandbox export at the bottom: in Node, this file
 * is `require()`d normally (module-wrapped, so these are local bindings
 * exported explicitly); in Zotero there is no `module` global, so the
 * guard is skipped and only the `var` bindings above matter.
 */

var FastReaderError = class extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
};

var UnsupportedPlatformError = class extends FastReaderError {
  constructor(platform, arch) {
    super(`Fast Reader does not support this platform/architecture: ${platform}/${arch}`);
    this.platform = platform;
    this.arch = arch;
  }
};

var HelperMissingError = class extends FastReaderError {
  constructor(expectedPath) {
    super(`Fast Reader helper executable not found at: ${expectedPath}`);
    this.expectedPath = expectedPath;
  }
};

var AttachmentMissingError = class extends FastReaderError {
  constructor(itemKeyOrPath) {
    super(`PDF attachment file not found: ${itemKeyOrPath}`);
    this.itemKeyOrPath = itemKeyOrPath;
  }
};

var SpawnError = class extends FastReaderError {
  constructor(command, cause) {
    super(`Failed to launch Fast Reader helper (${command}): ${cause && cause.message ? cause.message : cause}`);
    this.command = command;
    this.cause = cause;
  }
};

var ReaderCrashedError = class extends FastReaderError {
  constructor(exitCode) {
    super(`Fast Reader exited immediately with code ${exitCode}`);
    this.exitCode = exitCode;
  }
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    FastReaderError,
    UnsupportedPlatformError,
    HelperMissingError,
    AttachmentMissingError,
    SpawnError,
    ReaderCrashedError,
  };
}
