/**
 * Walnut Sessions host — paths, manifest, and the launch decision.
 *
 * Pure on purpose: every rule here is one a test must be able to pin without a
 * Mac, a compiler, or a real daemon. The macOS side effects (compile, sign,
 * install, spawn) live in ./session-host.ts.
 *
 * Background in desktop/session-host/main.swift: the host is a signed bundle
 * that becomes the responsible process for the daemon, so macOS attributes the
 * daemon's file access to `Walnut Sessions` instead of to whichever `node`
 * happens to have started Walnut.
 */
import path from 'node:path';

/**
 * Version-free signing identifier and bundle id. A certificate-signed TCC grant
 * is remembered against this string, so it must NEVER gain a version suffix:
 * moving it would throw away the grant on every upgrade, which is the exact
 * problem the host exists to fix (same rule as the helper identifiers in
 * src/core/helper-build.ts).
 */
export const SESSION_HOST_BUNDLE_ID = 'dev.openwalnut.sessions';

/** What the user sees in the macOS permission dialog and in System Settings. */
export const SESSION_HOST_DISPLAY_NAME = 'Walnut Sessions';

/** Bundle directory name; also the name shown by Finder. */
export const SESSION_HOST_APP_NAME = 'Walnut Sessions.app';

/** Mach-O name inside the bundle. Shows up in `ps`, so it says what it is. */
export const SESSION_HOST_EXECUTABLE_NAME = 'WalnutSessionsHost';

/**
 * Status the host exits with when IT refuses (unknown command, unreadable
 * manifest, missing private API). Distinct from any status the payload could
 * choose, so a caller can tell "the host would not run this" from "the daemon
 * exited 1 to ask launchd for a restart".
 */
export const SESSION_HOST_REFUSAL_STATUS = 125;

export interface SessionHostPaths {
  /** Directory holding the bundle and the manifest. */
  root: string;
  app: string;
  executable: string;
  infoPlist: string;
  /** Read by the host itself, resolved from ITS OWN bundle path, never from env. */
  manifest: string;
  /** Records what the installed bundle was built from, so a rebuild needs proof. */
  fingerprint: string;
}

/**
 * Where the host lives, given the real user's home.
 *
 * `~/Library/Application Support/Open Walnut/` rather than `~/Applications`:
 * this is Walnut's execution helper, not something to double-click, and an app
 * icon that does nothing when opened is a support question waiting to happen.
 * System Settings takes a pasted path either way.
 *
 * The location is FIXED and version-free. tccd keys a bundle's grant to its
 * identity, but Full Disk Access is administered as a row the user adds by path,
 * so a versioned directory would make every upgrade look like a new program.
 */
export function sessionHostPaths(home: string): SessionHostPaths {
  if (!path.isAbsolute(home)) throw new Error(`session host: home must be absolute, got ${JSON.stringify(home)}`);
  const root = path.join(home, 'Library', 'Application Support', 'Open Walnut');
  const app = path.join(root, SESSION_HOST_APP_NAME);
  return {
    root,
    app,
    executable: path.join(app, 'Contents', 'MacOS', SESSION_HOST_EXECUTABLE_NAME),
    infoPlist: path.join(app, 'Contents', 'Info.plist'),
    manifest: path.join(root, 'session-host-launch.json'),
    fingerprint: path.join(root, 'session-host.srchash'),
  };
}

/**
 * The bundle's Info.plist.
 *
 * `LSUIElement` so the process never takes a Dock tile or a menu bar; it is a
 * supervisor, not an app the user interacts with. No usage-description keys: the
 * host requests nothing promptable itself, and Full Disk Access has no prompt to
 * describe. A key claiming otherwise would put a sentence in a dialog that does
 * not match what is being asked for.
 */
export function renderSessionHostInfoPlist(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>CFBundleExecutable</key>',
    `\t<string>${SESSION_HOST_EXECUTABLE_NAME}</string>`,
    '\t<key>CFBundleIdentifier</key>',
    `\t<string>${SESSION_HOST_BUNDLE_ID}</string>`,
    '\t<key>CFBundleName</key>',
    `\t<string>${SESSION_HOST_DISPLAY_NAME}</string>`,
    '\t<key>CFBundleDisplayName</key>',
    `\t<string>${SESSION_HOST_DISPLAY_NAME}</string>`,
    '\t<key>CFBundlePackageType</key>',
    '\t<string>APPL</string>',
    '\t<key>CFBundleInfoDictionaryVersion</key>',
    '\t<string>6.0</string>',
    // Deliberately fixed: the bundle version is not part of the TCC identity, and
    // a value that moved on every build would suggest it is.
    '\t<key>CFBundleShortVersionString</key>',
    '\t<string>1.0</string>',
    '\t<key>CFBundleVersion</key>',
    '\t<string>1</string>',
    '\t<key>LSUIElement</key>',
    '\t<true/>',
    '\t<key>LSMinimumSystemVersion</key>',
    '\t<string>13.0</string>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export interface SessionHostFile {
  path: string;
  /** Lowercase hex sha256. */
  sha256: string;
}

export interface SessionHostCommand {
  /** Full command line, argv[0] = the absolute program. */
  argv: readonly string[];
  /** Payload files whose contents the host re-verifies before exec. */
  files?: readonly SessionHostFile[];
}

const HEX64 = /^[0-9a-f]{64}$/;

function checkArgvWord(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`session host manifest: ${where} must be a non-empty string`);
  }
  // posix_spawn cannot carry a NUL, so a value containing one could never be the
  // command that actually ran; refuse instead of writing a manifest that lies.
  if (value.includes('\0')) throw new Error(`session host manifest: ${where} must not contain NUL`);
  return value;
}

function checkAbsolute(value: unknown, where: string): string {
  const text = checkArgvWord(value, where);
  if (!text.startsWith('/')) throw new Error(`session host manifest: ${where} must be absolute, got ${JSON.stringify(text)}`);
  return text;
}

/**
 * The manifest the host reads before it runs anything.
 *
 * Deterministic output (fixed key order, no incidental whitespace) so an
 * unchanged approval rewrites the same bytes and callers can compare cheaply.
 */
export function buildSessionHostManifest(commands: readonly SessionHostCommand[]): string {
  if (commands.length === 0) throw new Error('session host manifest: at least one command is required');
  const body = commands.map((command) => {
    const argv = [...command.argv];
    if (argv.length === 0) throw new Error('session host manifest: argv must not be empty');
    checkAbsolute(argv[0], 'argv[0]');
    argv.slice(1).forEach((word, i) => checkArgvWord(word, `argv[${i + 1}]`));
    const files = (command.files ?? []).map((file) => {
      const filePath = checkAbsolute(file.path, 'files[].path');
      if (typeof file.sha256 !== 'string' || !HEX64.test(file.sha256)) {
        throw new Error(`session host manifest: ${filePath} needs a lowercase hex sha256`);
      }
      return { path: filePath, sha256: file.sha256 };
    });
    return { argv, files };
  });
  return `${JSON.stringify({ version: 1, commands: body }, null, 2)}\n`;
}

/** The argv that runs `program args…` under the host. */
export function sessionHostArgv(
  executable: string,
  program: string,
  args: readonly string[],
): string[] {
  checkAbsolute(executable, 'host executable');
  checkAbsolute(program, 'program');
  return [executable, '--', program, ...args];
}

/**
 * Why this box will not run the daemon under the host. `null` = it may.
 *
 * `ephemeral` mirrors src/core/helper-build.ts: a throwaway data dir must never
 * install or run a native macOS component, because that is what puts permission
 * dialogs on a developer's screen during a test run.
 *
 * `isolated_daemon` keeps test and sandbox daemons on the plain spawn path. The
 * host is about the identity the USER grants to; an isolated daemon has no
 * business borrowing it, and routing tests through a signed bundle in the real
 * home would make a test run mutate the user's permission surface.
 */
export type SessionHostUnavailable =
  | 'not_macos'
  | 'cloud'
  | 'ephemeral'
  | 'isolated_daemon'
  | 'disabled'
  | 'not_installed'
  | 'build_failed';

export interface SessionHostApplicability {
  platform: string;
  cloudMode: boolean;
  ephemeral: boolean;
  /** Daemon runtime dir this LocalDaemon instance manages. */
  daemonDir: string;
  /** The one production daemon dir (src/providers/local-daemon.ts). */
  prodDaemonDir: string;
  /** `WALNUT_SESSION_HOST=0` turns the whole thing off. */
  optedOut: boolean;
}

export function sessionHostUnavailableReason(
  input: SessionHostApplicability,
): SessionHostUnavailable | null {
  if (input.platform !== 'darwin') return 'not_macos';
  if (input.cloudMode) return 'cloud';
  if (input.optedOut) return 'disabled';
  if (input.ephemeral) return 'ephemeral';
  if (path.resolve(input.daemonDir) !== path.resolve(input.prodDaemonDir)) return 'isolated_daemon';
  return null;
}

export interface SessionHostIdentity {
  pid: number;
  responsiblePid: number;
  /** The host's own claim that macOS holds it responsible for itself. */
  selfResponsible: boolean;
  bundlePath: string;
  bundleIdentifier: string;
  executablePath: string;
  disclaimed: boolean;
  manifestPath: string;
}

/**
 * Parse `WalnutSessionsHost --identity`.
 *
 * Returns null rather than throwing on anything unexpected: this is used to
 * REPORT whether the identity is real, and a parse failure means "unknown",
 * which must never be presented as a working separation.
 */
export function parseSessionHostIdentity(stdout: string): SessionHostIdentity | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const pid = raw.pid;
  const responsiblePid = raw.responsiblePid;
  if (typeof pid !== 'number' || typeof responsiblePid !== 'number') return null;
  if (typeof raw.bundleIdentifier !== 'string' || typeof raw.bundlePath !== 'string') return null;
  if (typeof raw.executablePath !== 'string' || typeof raw.manifestPath !== 'string') return null;
  return {
    pid,
    responsiblePid,
    // Trust the SYSTEM's answer (pid vs responsible pid), not the host's summary
    // flag: the two come from the same process, and the number is the evidence.
    selfResponsible: pid === responsiblePid,
    bundlePath: raw.bundlePath,
    bundleIdentifier: raw.bundleIdentifier,
    executablePath: raw.executablePath,
    disclaimed: raw.disclaimed === true,
    manifestPath: raw.manifestPath,
  };
}
