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
import os from 'node:os';
import path from 'node:path';
import { CLOUD_MODE, IS_EPHEMERAL } from '../constants.js';
import { log } from '../logging/index.js';
import {
  buildSessionHostManifest,
  desktopAppCandidates,
  desktopAppExecutable,
  parseSessionHostIdentity,
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
 * Does this Walnut.app know `--session-host`?
 *
 * Answered by searching the Mach-O for the flag, NEVER by running it: an app that
 * does not know the flag would ignore it and start the GUI. Chunked with an
 * overlap so a match spanning two reads is still found.
 */
async function appSupportsSessionHost(executable: string): Promise<boolean> {
  const needle = Buffer.from(SESSION_HOST_FLAG, 'utf8');
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(executable, 'r');
  } catch {
    return false;
  }
  try {
    const chunk = 1 << 20;
    const overlap = needle.length - 1;
    const buffer = Buffer.allocUnsafe(chunk + overlap);
    let carried = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, carried, chunk, null);
      if (bytesRead === 0) return false;
      const filled = buffer.subarray(0, carried + bytesRead);
      if (filled.includes(needle)) return true;
      // Keep the tail so the next window can complete a straddling match.
      filled.subarray(filled.length - overlap).copy(buffer, 0);
      carried = Math.min(overlap, filled.length);
    }
  } finally {
    await handle.close();
  }
}

/**
 * Record the one command the host may run, with the hash of every payload file.
 *
 * Rewritten (not appended to) on every launch, so a stale approval can never
 * accumulate. 0600 because the file names what this identity will execute.
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
  const body = buildSessionHostManifest([{ argv, files }]);
  await fsp.mkdir(path.dirname(manifest), { recursive: true, mode: 0o700 });
  const temp = `${manifest}.tmp-${process.pid}`;
  await fsp.writeFile(temp, body, { mode: 0o600 });
  await fsp.chmod(temp, 0o600);
  await fsp.rename(temp, manifest);
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

/**
 * The REAL user's home, from the passwd entry rather than `$HOME`.
 *
 * Never os.homedir(): it IS `$HOME`, and Walnut deliberately runs with a fake
 * HOME in sandbox/onboarding modes. Looking for Walnut.app under a throwaway home
 * would report "not installed" on a machine that has it, and would write the
 * manifest somewhere the app will never read.
 */
function realHome(): string | null {
  try {
    const home = os.userInfo().homedir;
    return home && path.isAbsolute(home) ? home : null;
  } catch {
    return null;
  }
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
  const blocked = sessionHostUnavailableReason({
    platform: process.platform,
    cloudMode: CLOUD_MODE,
    ephemeral: IS_EPHEMERAL,
    daemonDir: input.daemonDir,
    prodDaemonDir: input.prodDaemonDir,
    optedOut: process.env.WALNUT_SESSION_HOST === '0',
  });
  if (blocked) return { available: false, reason: blocked };

  const home = realHome();
  if (!home) return { available: false, reason: 'not_installed', detail: 'no passwd home for this user' };

  const app = desktopAppCandidates(home).find((candidate) => fs.existsSync(desktopAppExecutable(candidate)));
  if (!app) {
    return {
      available: false,
      reason: 'not_installed',
      detail: 'no Walnut.app found; sessions run under the plain node identity',
    };
  }
  const executable = desktopAppExecutable(app);
  if (!(await appSupportsSessionHost(executable))) {
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
