/**
 * Typed errors matching the launch-failure categories in the project
 * brief (§12): "helper missing, attachment file missing, unsupported
 * platform, spawn failure, reader crashes immediately." Kept as plain
 * classes with no Zotero/Node dependency so the UI layer (fastReader.ts)
 * can distinguish them with `instanceof` and show the right message, and
 * so tests can assert on error *type*, not just message text.
 *
 * Real ES `class`/`export` now that everything is bundled into one file
 * by esbuild (see zotero-plugin.config.mts) -- the loadSubScript
 * cross-file scoping fragility that forced the old `var X = class {}`
 * workaround (see git history) no longer applies, since there's only
 * one bundled output file for bootstrap.js to load.
 */

export class FastReaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class UnsupportedPlatformError extends FastReaderError {
  platform: string;
  arch: string;

  constructor(platform: string, arch: string) {
    super(`Fast Reader does not support this platform/architecture: ${platform}/${arch}`);
    this.platform = platform;
    this.arch = arch;
  }
}

export class HelperMissingError extends FastReaderError {
  expectedPath: string;

  constructor(expectedPath: string) {
    super(`Fast Reader helper executable not found at: ${expectedPath}`);
    this.expectedPath = expectedPath;
  }
}

export class AttachmentMissingError extends FastReaderError {
  itemKeyOrPath: string;

  constructor(itemKeyOrPath: string) {
    super(`PDF attachment file not found: ${itemKeyOrPath}`);
    this.itemKeyOrPath = itemKeyOrPath;
  }
}

export class SpawnError extends FastReaderError {
  command: string;
  cause: unknown;

  constructor(command: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to launch Fast Reader helper (${command}): ${causeMessage}`);
    this.command = command;
    this.cause = cause;
  }
}

export class ReaderCrashedError extends FastReaderError {
  exitCode: number;

  constructor(exitCode: number) {
    super(`Fast Reader exited immediately with code ${exitCode}`);
    this.exitCode = exitCode;
  }
}
