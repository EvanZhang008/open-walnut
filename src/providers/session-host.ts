/**
 * Walnut Sessions host — build, install, approve, launch.
 *
 * The macOS side effects for src/providers/session-host-core.ts. What this buys
 * and what it deliberately does not is documented at the top of
 * src/data/walnut-sessions.swift; the short version is that the daemon (and
 * therefore every `claude` CLI and tool under it) becomes attributed to one
 * stable signed bundle instead of to whichever `node` started Walnut.
 *
 * Three rules this file encodes:
 *
 *  - An unchanged source is NEVER rebuilt. The installed bundle's code identity
 *    is what a TCC grant is remembered against, so a pointless rebuild would hand
 *    the user an identical-looking host that lost the permission they granted
 *    (the same trap src/core/helper-build.ts documents for the helpers).
 *  - A broken host degrades to the plain spawn. Local sessions are the product;
 *    an identity improvement must never be able to take them down. It is logged at
 *    error level and reported as "not isolated" rather than quietly pretended.
 *  - It installs under the REAL user's home (the passwd entry, not `$HOME`), so a
 *    sandbox or test process with a fake HOME can never install a granted identity
 *    into a throwaway directory — nor find one there and think it is missing.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CLOUD_MODE, IS_EPHEMERAL } from '../constants.js';
import { helperSourcePath, signNativeTarget } from '../core/helper-build.js';
import { log } from '../logging/index.js';
import {
  buildSessionHostManifest,
  parseSessionHostIdentity,
  renderSessionHostInfoPlist,
  sessionHostArgv,
  sessionHostPaths,
  sessionHostUnavailableReason,
  SESSION_HOST_BUNDLE_ID,
  SESSION_HOST_EXECUTABLE_NAME,
  type SessionHostFile,
  type SessionHostIdentity,
  type SessionHostPaths,
  type SessionHostUnavailable,
} from './session-host-core.js';

const SWIFT_SOURCE = 'walnut-sessions.swift';

/** Inputs that decide the installed bytes. Not a version number: there is none. */
function sourceFingerprint(sourcePath: string): string | null {
  let source: Buffer;
  try {
    source = fs.readFileSync(sourcePath);
  } catch {
    return null;
  }
  return createHash('sha256')
    .update(source)
    .update('\n--\n')
    .update(SESSION_HOST_BUNDLE_ID)
    .update('\n--\n')
    .update(renderSessionHostInfoPlist())
    .digest('hex');
}

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

interface CommandResult { ok: boolean; code: number | null; stdout: string; stderr: string }

function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ ok: false, code: null, stdout, stderr: `${stderr} (timed out)` });
    }, timeoutMs);
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('error', (err) => done({ ok: false, code: null, stdout, stderr: err.message }));
    child.on('close', (code) => done({ ok: code === 0, code, stdout, stderr }));
  });
}

export interface SessionHostBuildResult {
  ok: boolean;
  reason?: SessionHostUnavailable;
  detail?: string;
  /** True when the bundle already matched its fingerprint and was left alone. */
  reused?: boolean;
}

/**
 * Put a signed bundle at `paths.app`, or explain why not.
 *
 * `sign` exists for tests: signing reaches the login keychain, which a test must
 * not do. Production always signs — an ad-hoc bundle still works, it just has a
 * content-hash identity that resets on every rebuild.
 */
export async function buildSessionHostBundle(
  paths: SessionHostPaths,
  options: { sign?: boolean } = {},
): Promise<SessionHostBuildResult> {
  const source = helperSourcePath(SWIFT_SOURCE);
  const fingerprint = sourceFingerprint(source);
  if (fingerprint === null) {
    return { ok: false, reason: 'build_failed', detail: `native source missing at ${source}` };
  }

  // Reuse before anything else. Rewriting an unchanged bundle is the one silently
  // destructive thing this function could do.
  let installed: string | null = null;
  try { installed = (await fsp.readFile(paths.fingerprint, 'utf8')).trim() || null; } catch { installed = null; }
  if (installed === fingerprint && fs.existsSync(paths.executable)) {
    return { ok: true, reused: true };
  }

  await fsp.mkdir(paths.root, { recursive: true, mode: 0o700 });
  // Staging beside the target: same filesystem, so the swap below cannot EXDEV,
  // and a compile killed halfway can never leave a half-built bundle installed.
  const staging = path.join(paths.root, `.session-host-staging-${process.pid}`);
  await fsp.rm(staging, { recursive: true, force: true });
  const stagedApp = path.join(staging, path.basename(paths.app));
  const stagedMacOS = path.join(stagedApp, 'Contents', 'MacOS');
  try {
    await fsp.mkdir(stagedMacOS, { recursive: true });
    await fsp.writeFile(path.join(stagedApp, 'Contents', 'Info.plist'), renderSessionHostInfoPlist());
    const stagedExecutable = path.join(stagedMacOS, SESSION_HOST_EXECUTABLE_NAME);
    const compiled = await run('nice', ['-n', '10', 'xcrun', 'swiftc', '-O', '-o', stagedExecutable, source]);
    if (!compiled.ok) {
      // "No compiler on this box" is an install step for the user; "our source
      // will not build" is our bug. They must not collapse into one message.
      const missing = compiled.code === null || compiled.code === 127
        || /xcrun: error|unable to find utility|command not found|no developer tools/i.test(compiled.stderr);
      return {
        ok: false,
        reason: missing ? 'not_installed' : 'build_failed',
        detail: compiled.stderr.slice(0, 400),
      };
    }
    await fsp.chmod(stagedExecutable, 0o755);
    if (options.sign !== false) {
      // The BUNDLE is signed as a unit (that is what gives the user a named row in
      // System Settings), but the exec probe has to name the Mach-O inside it.
      await signNativeTarget({
        path: stagedApp,
        execProbe: stagedExecutable,
        identifier: SESSION_HOST_BUNDLE_ID,
        label: 'walnut-sessions',
      });
    }

    // Swap. A directory cannot be renamed over a non-empty one, so the old bundle
    // goes first. Deleting it is safe for a RUNNING host: macOS keeps the mapped
    // image alive, so a live daemon under the previous bundle is unaffected.
    await fsp.rm(paths.fingerprint, { force: true });
    await fsp.rm(paths.app, { recursive: true, force: true });
    await fsp.rename(stagedApp, paths.app);
    // Written only after the bundle is in place: a fingerprint without its bundle
    // would make the next boot skip a build it still has to do.
    await fsp.writeFile(paths.fingerprint, `${fingerprint}\n`);
    return { ok: true, reused: false };
  } catch (err) {
    return { ok: false, reason: 'build_failed', detail: err instanceof Error ? err.message : String(err) };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Record the one command the host may run, with the hash of every payload file.
 *
 * Rewritten (not appended to) on every launch, so a stale approval can never
 * accumulate. 0600 because the file names what this identity will execute.
 */
export async function approveSessionHostCommand(
  paths: SessionHostPaths,
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
  const manifest = buildSessionHostManifest([{ argv, files }]);
  const temp = `${paths.manifest}.tmp-${process.pid}`;
  await fsp.writeFile(temp, manifest, { mode: 0o600 });
  await fsp.chmod(temp, 0o600);
  await fsp.rename(temp, paths.manifest);
}

/** What the host says it is. Null when it could not be asked or did not answer. */
export async function readSessionHostIdentity(executable: string): Promise<SessionHostIdentity | null> {
  const result = await run(executable, ['--identity'], 10_000);
  if (!result.ok) return null;
  return parseSessionHostIdentity(result.stdout);
}

let buildOnce: Promise<SessionHostBuildResult> | null = null;
let cachedPaths: SessionHostPaths | null = null;

/** Reset the memoized build (tests). */
export function resetSessionHostForTest(): void {
  buildOnce = null;
  cachedPaths = null;
}

/**
 * The REAL user's home, from the passwd entry rather than `$HOME`.
 *
 * Never os.homedir(): it IS `$HOME`, and Walnut deliberately runs with a fake
 * HOME in sandbox/onboarding modes. Installing a granted identity into a
 * throwaway home would be worse than not installing one, because the next real
 * run would find nothing there and build a SECOND identity the user has to grant
 * all over again.
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
  | { available: true; argv: string[]; executable: string; paths: SessionHostPaths }
  | { available: false; reason: SessionHostUnavailable; detail?: string };

/**
 * Resolve the argv that runs `program args…` under the Walnut Sessions identity,
 * building and approving as needed.
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
  const resolved = sessionHostPaths(home);
  if (!cachedPaths || cachedPaths.root !== resolved.root) {
    // A different location is a different bundle; a memoized build for the old one
    // says nothing about this one.
    cachedPaths = resolved;
    buildOnce = null;
  }
  const paths = cachedPaths;

  if (!buildOnce) buildOnce = buildSessionHostBundle(paths);
  const built = await buildOnce;
  if (!built.ok) {
    // A failed build is retried on the next daemon spawn: the usual cause is a
    // missing compiler, which the user can install without restarting Walnut.
    buildOnce = null;
    return { available: false, reason: built.reason ?? 'build_failed', detail: built.detail };
  }

  const argv = [input.program, ...input.args];
  try {
    await approveSessionHostCommand(paths, argv);
  } catch (err) {
    return {
      available: false,
      reason: 'build_failed',
      detail: `could not approve the launch: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  log.session.info('daemon will run under the Walnut Sessions identity', {
    host: paths.app,
    program: input.program,
    reused: built.reused === true,
  });
  return {
    available: true,
    argv: sessionHostArgv(paths.executable, input.program, input.args),
    executable: paths.executable,
    paths,
  };
}
