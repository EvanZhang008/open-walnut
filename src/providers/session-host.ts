/**
 * Session host — find Walnut.app, approve one command, launch the daemon under it.
 *
 * What this buys and what it deliberately does not is documented at the top of
 * desktop/SessionHost.swift; the short version is that the daemon (and therefore
 * every `claude` CLI and tool under it) becomes attributed to Walnut instead of to
 * whichever `node` started the server.
 *
 * Three rules this file encodes:
 *
 *  - It uses the app the user ALREADY has. Nothing is compiled, signed or
 *    installed here: a second bundle would mean a second row in Privacy &
 *    Security for something the user thinks of as one app, which is exactly the
 *    over-engineering this replaced.
 *  - It never runs an app that does not know the flag. An older Walnut.app handed
 *    `--session-host` would ignore it and boot the GUI, putting a window on
 *    screen; support is checked by looking for the flag IN the binary, without
 *    executing it.
 *  - A missing or unsupported app degrades to the plain spawn. Local sessions are
 *    the product; an identity improvement must never be able to take them down.
 *    It is logged and reported as "not isolated" rather than quietly pretended.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CLOUD_MODE, IS_EPHEMERAL } from '../constants.js';
import { log } from '../logging/index.js';
import { withFileLock } from '../utils/file-lock.js';
import { findDesktopApp, findDesktopAppWith, realHome } from './desktop-app.js';
import {
  buildSessionHostManifest,
  mergeSessionHostApprovals,
  parseSessionHostIdentity,
  parseSessionHostManifest,
  sessionHostArgv,
  sessionHostManifestPath,
  sessionHostUnavailableReason,
  SESSION_HOST_FLAG,
  type SessionHostFile,
  type SessionHostIdentity,
  type SessionHostUnavailable,
} from './session-host-core.js';

async function hashFile(target: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await fsp.open(target, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

/**
 * Approve one more command the host may run, with the hash of every payload file.
 *
 * The other approvals stay while their payload files are still on disk
 * (mergeSessionHostApprovals): the deploy approves the server it launches
 * through the host, and that server approves its daemon a moment later, so a
 * rewrite that kept only the newest command would leave launchd unable to
 * relaunch the server. Read, merged and written under a lock, because the
 * deploy and a running server can approve at the same time. 0600 because the
 * file names what this identity will execute.
 */
export async function approveSessionHostCommand(
  manifest: string,
  argv: readonly string[],
): Promise<void> {
  const files: SessionHostFile[] = [];
  for (const word of argv) {
    // Every argv element that IS a file gets hashed: the daemon binary, or the
    // interpreter plus its script. A flag like `--start` is not a path and is
    // skipped, with no per-shape special casing to get wrong.
    if (!path.isAbsolute(word)) continue;
    let stat: fs.Stats;
    try { stat = await fsp.stat(word); } catch { continue; }
    if (!stat.isFile()) continue;
    files.push({ path: word, sha256: await hashFile(word) });
  }
  await fsp.mkdir(path.dirname(manifest), { recursive: true, mode: 0o700 });
  await withFileLock(manifest, async () => {
    const existing = parseSessionHostManifest(await fsp.readFile(manifest, 'utf8').catch(() => ''));
    const present = new Set<string>();
    for (const file of existing.flatMap((c) => c.files ?? [])) {
      if (await fsp.stat(file.path).then((s) => s.isFile(), () => false)) present.add(file.path);
    }
    const commands = mergeSessionHostApprovals({ argv, files }, existing,
      (c) => (c.files ?? []).every((f) => present.has(f.path)));
    const temp = `${manifest}.tmp-${process.pid}`;
    await fsp.writeFile(temp, buildSessionHostManifest(commands), { mode: 0o600 });
    await fsp.chmod(temp, 0o600);
    await fsp.rename(temp, manifest);
  }, { timeoutMs: 15_000 });
}

/**
 * For the deploy (scripts/dev-prod.sh, through `walnut __session-host-approve`):
 * approve `argv` under Walnut.app and return the host executable to put in
 * front of it, or the reason it cannot run there. Unlike the daemon's launch
 * this takes no ephemeral or isolated-dir rule: the deploy decides which server
 * it launches, and a rehearsal's server borrows the grant the user already gave
 * Walnut without asking for a new one.
 *
 * Why the server goes through the host (2026-11-04): a server launchd starts
 * straight from the compiled file is its own program to macOS Local Network
 * privacy, and macOS keys an unbundled program's choice on its path and Mach-O
 * UUID, so every deploy's new stage directory asked "Allow walnut-darwin-arm64
 * to find devices on local networks?" again. Under the host the responsible
 * program is Walnut.app, whose one choice holds for every build.
 */
export async function approveUnderSessionHost(argv: readonly string[]): Promise<
  { ok: true; executable: string; app: string } | { ok: false; reason: SessionHostUnavailable | 'bad_argv'; detail?: string }
> {
  if (argv.length === 0 || !path.isAbsolute(argv[0]!)) return { ok: false, reason: 'bad_argv', detail: 'argv[0] must be an absolute path' };
  if (process.platform !== 'darwin') return { ok: false, reason: 'not_macos' };
  if (CLOUD_MODE) return { ok: false, reason: 'cloud' };
  if (process.env.WALNUT_SESSION_HOST === '0') return { ok: false, reason: 'disabled' };
  const home = realHome();
  if (!home) return { ok: false, reason: 'not_installed', detail: 'no passwd home for this user' };
  const installed = findDesktopApp();
  if (!installed) return { ok: false, reason: 'not_installed', detail: 'no Walnut.app on this machine' };
  if (!(await findDesktopAppWith(SESSION_HOST_FLAG))) {
    return { ok: false, reason: 'unsupported_app', detail: `${installed.app} predates ${SESSION_HOST_FLAG}` };
  }
  try {
    await approveSessionHostCommand(sessionHostManifestPath(home), argv);
  } catch (err) {
    return { ok: false, reason: 'unsupported_app', detail: `could not approve the launch: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, executable: installed.executable, app: installed.app };
}

/** What the host says it is. Null when it could not be asked or did not answer. */
export async function readSessionHostIdentity(executable: string): Promise<SessionHostIdentity | null> {
  return new Promise((resolve) => {
    const child = spawn(executable, [SESSION_HOST_FLAG, '--identity'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    let settled = false;
    const done = (value: SessionHostIdentity | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(null); }, 10_000);
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.on('error', () => done(null));
    child.on('close', (code) => done(code === 0 ? parseSessionHostIdentity(stdout) : null));
  });
}

/** Why this process may not run the host for that daemon dir (null: it may), read once from its environment. */
function blockedHere(input: { daemonDir: string; prodDaemonDir: string }): SessionHostUnavailable | null {
  return sessionHostUnavailableReason({
    platform: process.platform,
    cloudMode: CLOUD_MODE,
    ephemeral: IS_EPHEMERAL,
    daemonDir: input.daemonDir,
    prodDaemonDir: input.prodDaemonDir,
    optedOut: process.env.WALNUT_SESSION_HOST === '0',
  });
}

export interface SessionHostInspection {
  /** The app that would supervise the daemon, or null when there is none usable. */
  app: string | null;
  /** Why not, when `app` is null. */
  reason?: SessionHostUnavailable;
  detail?: string;
}

/**
 * What the identity WOULD be, without changing anything.
 *
 * Separate from resolveSessionHostLaunch because that one approves a command,
 * and the Settings panel polls: a read-only question must never rewrite the
 * manifest out from under the running daemon's approval.
 */
export async function inspectSessionHost(input: {
  daemonDir: string;
  prodDaemonDir: string;
}): Promise<SessionHostInspection> {
  const blocked = blockedHere(input);
  if (blocked) return { app: null, reason: blocked };
  if (!realHome()) return { app: null, reason: 'not_installed', detail: 'no passwd home for this user' };
  const installed = findDesktopApp();
  if (!installed) return { app: null, reason: 'not_installed', detail: 'no Walnut.app on this machine' };
  if (!(await findDesktopAppWith(SESSION_HOST_FLAG))) {
    return { app: null, reason: 'unsupported_app', detail: `${installed.app} predates ${SESSION_HOST_FLAG}` };
  }
  return { app: installed.app };
}

export type SessionHostResolution =
  | { available: true; argv: string[]; executable: string; app: string; manifest: string }
  | { available: false; reason: SessionHostUnavailable; detail?: string };

/**
 * Resolve the argv that runs `program args…` under Walnut's identity.
 *
 * Callers treat `available: false` as "spawn it directly" — see the degradation
 * rule in this file's header.
 */
export async function resolveSessionHostLaunch(input: {
  program: string;
  args: readonly string[];
  daemonDir: string;
  prodDaemonDir: string;
}): Promise<SessionHostResolution> {
  const blocked = blockedHere(input);
  if (blocked) return { available: false, reason: blocked };

  const home = realHome();
  if (!home) return { available: false, reason: 'not_installed', detail: 'no passwd home for this user' };

  const installed = findDesktopApp();
  if (!installed) {
    return {
      available: false,
      reason: 'not_installed',
      detail: 'no Walnut.app found; sessions run under the plain node identity',
    };
  }
  const { app, executable } = installed;
  if (!(await findDesktopAppWith(SESSION_HOST_FLAG))) {
    // `desktop/build.sh`, NOT build-release.sh: the release script ad-hoc signs
    // when the box has no Developer ID Application certificate, and an ad-hoc
    // signature gives tccd a CONTENT-HASH identity that changes on every rebuild.
    // Installing one of those over a certificate-signed app would throw away the
    // grant the user already gave Walnut, which is the exact failure this feature
    // exists to end.
    return {
      available: false,
      reason: 'unsupported_app',
      detail: `${app} does not know ${SESSION_HOST_FLAG}; rebuild with desktop/build.sh and copy it over ${app}`,
    };
  }

  const argv = [input.program, ...input.args];
  const manifest = sessionHostManifestPath(home);
  try {
    await approveSessionHostCommand(manifest, argv);
  } catch (err) {
    return {
      available: false,
      reason: 'unsupported_app',
      detail: `could not approve the launch: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  log.session.info('daemon will run under the Walnut app identity', { app, program: input.program });
  return { available: true, argv: sessionHostArgv(executable, input.program, input.args), executable, app, manifest };
}
