/**
 * Walnut Sessions host — paths, manifest, and the launch decision.
 *
 * Pure on purpose: every rule here is one a test must be able to pin without a
 * Mac, a compiler, or a real daemon. The macOS side effects (compile, sign,
 * install, spawn) live in ./session-host.ts.
 *
 * Background in src/data/walnut-sessions.swift: the host is a signed bundle
 * that becomes the responsible process for the daemon, so macOS attributes the
 * daemon's file access to `Walnut Sessions` instead of to whichever `node`
 * happens to have started Walnut.
 */
import path from 'node:path';

/**
 * The flag that turns Walnut.app into a supervisor (desktop/SessionHost.swift).
 * Must be argv[1], so a normal launch can never reach supervisor code.
 */
export const SESSION_HOST_FLAG = '--session-host';

/** What the user sees in the macOS dialog and in System Settings: one app. */
export const SESSION_HOST_DISPLAY_NAME = 'Walnut';

/**
 * Status the host exits with when IT refuses (unknown command, unreadable
 * manifest, missing private API). Distinct from any status the payload could
 * choose, so a caller can tell "the host would not run this" from "the daemon
 * exited 1 to ask launchd for a restart".
 */
export const SESSION_HOST_REFUSAL_STATUS = 125;

/**
 * Where the manifest lives, given the REAL user's home.
 *
 * The Swift side derives the same path from the passwd entry (never `$HOME`,
 * never an argument), so what this identity may run cannot be redirected by
 * whoever starts it. Keep the two in step: desktop/SessionHost.swift's
 * `sessionHostManifestPath()`.
 */
export function sessionHostManifestPath(home: string): string {
  if (!path.isAbsolute(home)) throw new Error(`session host: home must be absolute, got ${JSON.stringify(home)}`);
  return path.join(home, 'Library', 'Application Support', 'Open Walnut', 'session-host-launch.json');
}

/**
 * Where Walnut.app may be, most likely first.
 *
 * A repo checkout's `desktop/Walnut.app` comes last on purpose: a contributor who
 * also has the app installed should get the installed one, because that is the
 * bundle their permission grants belong to.
 */
export function desktopAppCandidates(home: string): string[] {
  if (!path.isAbsolute(home)) throw new Error(`session host: home must be absolute, got ${JSON.stringify(home)}`);
  return [
    '/Applications/Walnut.app',
    path.join(home, 'Applications', 'Walnut.app'),
    path.join(home, 'workplace', 'myCode', 'walnut', 'desktop', 'Walnut.app'),
  ];
}

/** The executable inside an app bundle, which is the process TCC attributes to. */
export function desktopAppExecutable(app: string): string {
  return path.join(app, 'Contents', 'MacOS', 'Walnut');
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
  /**
   * A command run once and done (a deploy's self-test, smoke boot, plugin check),
   * never relaunched: the first to go when the manifest is full. The host reads
   * only argv and files, so the mark is invisible to it.
   */
  once?: boolean;
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
    return command.once ? { argv, files, once: true } : { argv, files };
  });
  return `${JSON.stringify({ version: 1, commands: body }, null, 2)}\n`;
}

/**
 * The commands an existing manifest approves. Empty on anything that is not a
 * version 1 manifest with well-formed commands: an unreadable approval is no
 * approval, and the next write replaces it.
 */
export function parseSessionHostManifest(text: string): SessionHostCommand[] {
  let root: unknown;
  try { root = JSON.parse(text); } catch { return []; }
  if (typeof root !== 'object' || root === null) return [];
  const { version, commands } = root as { version?: unknown; commands?: unknown };
  if (version !== 1 || !Array.isArray(commands)) return [];
  const out: SessionHostCommand[] = [];
  for (const command of commands) {
    const argv = (command as { argv?: unknown })?.argv;
    const files = (command as { files?: unknown })?.files ?? [];
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((w) => typeof w === 'string' && w.length > 0)) continue;
    if (!(argv[0] as string).startsWith('/') || !Array.isArray(files)) continue;
    const okFiles = files.every((f) => typeof f?.path === 'string' && f.path.startsWith('/')
      && typeof f?.sha256 === 'string' && HEX64.test(f.sha256));
    if (!okFiles) continue;
    const once = (command as { once?: unknown }).once === true;
    out.push(once ? { argv: argv as string[], files: files as SessionHostFile[], once } : { argv: argv as string[], files: files as SessionHostFile[] });
  }
  return out;
}

/**
 * How many approved commands a manifest keeps. Each deploy approves five: its
 * self-test, smoke boot and plugin check (every run of the file goes through the
 * host, scripts/dev-prod.sh host_prefix_for), the server it launches, and the
 * daemon that server starts. The previous build's server and daemon are still
 * needed until its processes are gone, so the cap leaves room for two deploys
 * and a few failed ones; a deploy that failed removes its stage, which drops its
 * approvals at the next write.
 */
export const SESSION_HOST_MAX_COMMANDS = 16;

function sameArgv(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((word, i) => word === b[i]);
}

/**
 * The manifest after approving `next`: it first, then every other approval
 * whose payload files are all still on disk (`stillThere`), newest first, at
 * most SESSION_HOST_MAX_COMMANDS; when there are more, the oldest `once`
 * approvals go first, so a run of deploys and rehearsals never pushes out the
 * server or daemon launchd relaunches. Approving one command must never revoke
 * another that is still in use: the deploy's server and the daemon it starts
 * both run under the host, and launchd relaunches the server (KeepAlive) with
 * the argv the deploy approved, long after the server approved its daemon.
 * The host re-hashes every file before it runs a command, so an entry kept
 * here can never run a payload that changed since it was approved.
 */
export function mergeSessionHostApprovals(
  next: SessionHostCommand,
  existing: readonly SessionHostCommand[],
  stillThere: (command: SessionHostCommand) => boolean,
): SessionHostCommand[] {
  const all = [next, ...existing.filter((c) => !sameArgv(c.argv, next.argv) && stillThere(c))];
  for (let i = all.length - 1; all.length > SESSION_HOST_MAX_COMMANDS && i > 0; i--) {
    if (all[i]!.once) all.splice(i, 1);
  }
  return all.slice(0, SESSION_HOST_MAX_COMMANDS);
}

/** The argv that runs `program args…` under Walnut's identity. */
export function sessionHostArgv(
  executable: string,
  program: string,
  args: readonly string[],
): string[] {
  checkAbsolute(executable, 'host executable');
  checkAbsolute(program, 'program');
  return [executable, SESSION_HOST_FLAG, '--', program, ...args];
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
  /** No Walnut.app on this machine (an npm/terminal-only install). */
  | 'not_installed'
  /** Walnut.app is there but too old to know the flag, or unreadable. */
  | 'unsupported_app';

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

export type SessionHostStartVerdict = 'started' | 'retry_directly' | 'wait_longer' | 'give_up';

export interface SessionHostStart {
  verdict: SessionHostStartVerdict;
  /** Why, for the log line the operator will read. */
  reason:
    | 'port_file_written'
    | 'host_exited_without_daemon'
    | 'host_still_running'
    | 'plain_spawn_failed';
}

export interface SessionHostStartFacts {
  /** The daemon published its port file within the wait budget. */
  portFileSeen: boolean;
  /** The daemon was started THROUGH the host (false = it was a plain spawn). */
  hostUsed: boolean;
  /** The host process is still alive. Meaningless when `hostUsed` is false. */
  hostAlive: boolean;
  /** The one longer wait a live host earns (`wait_longer`) is already spent. */
  graceSpent?: boolean;
}

/**
 * What to do when a daemon spawn produced no port file.
 *
 * Pure because it is the one decision in this feature that can lose a user's
 * local sessions, and the code path it guards is deliberately unreachable from a
 * test: the host never engages for an isolated daemon dir
 * (`sessionHostUnavailableReason` → `isolated_daemon`), so a fixture could only
 * exercise it by pointing at the REAL production dir and fighting the live
 * daemon. The decision lives here instead, where a fixture can pin every case.
 *
 * The invariant worth stating plainly: a retry is safe ONLY because the host
 * outlives its daemon. A dead host with no port file therefore proves no daemon
 * is running, so the retry cannot end up with two daemons against one runtime
 * dir. A host that is STILL RUNNING proves nothing of the kind (its daemon may
 * be seconds from writing the port file), so that case never starts a
 * competitor: it earns ONE longer wait (waiting starts nothing), then fails
 * loudly. On a loaded machine at deploy the daemon wrote its port file about
 * 1.5s past the first budget (2026-10-05), and the give-up told the user local
 * sessions would fail while that daemon went on to serve them for hours.
 */
export function classifySessionHostStart(facts: SessionHostStartFacts): SessionHostStart {
  if (facts.portFileSeen) return { verdict: 'started', reason: 'port_file_written' };
  if (!facts.hostUsed) return { verdict: 'give_up', reason: 'plain_spawn_failed' };
  if (facts.hostAlive) return { verdict: facts.graceSpent ? 'give_up' : 'wait_longer', reason: 'host_still_running' };
  return { verdict: 'retry_directly', reason: 'host_exited_without_daemon' };
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
