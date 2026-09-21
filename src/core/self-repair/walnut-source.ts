/**
 * Where is Walnut's own source, so a repair session has something to edit?
 *
 * Three installs exist and the answer differs for each:
 *   - a git checkout run in place (`npm run dev:prod`, contributors): the code
 *     the server runs from IS the source → WALNUT_INSTALL_DIR.
 *   - an npm install (`npm i -g open-walnut`): dist only, no sources, no .git.
 *     The user may keep a clone elsewhere (config `self_repair.source_dir` or
 *     env WALNUT_SOURCE_DIR); otherwise Walnut clones upstream into
 *     `~/open-walnut` the first time a repair is asked for and reuses it.
 *   - a cloud replica: never edits code; repairs start on the primary console.
 *
 * The clone lands OUTSIDE the data dir on purpose: ~/.open-walnut is itself a
 * git repo synced between machines, and a nested repository inside it would be
 * both huge and treated as an embedded repo by every sync commit.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { gitChildEnv } from '../../lib/git-env.js';
import { CLOUD_MODE, WALNUT_INSTALL_DIR, WALNUT_REPO_URL } from '../../constants.js';
import { getConfig } from '../config-manager.js';
import { log } from '../../logging/index.js';

export type WalnutSourceKind =
  /** The checkout the running server was built from. */
  | 'running'
  /** A checkout the user pointed at (config or env). */
  | 'configured'
  /** The default clone dir (`~/open-walnut`), whoever created it. */
  | 'clone';

export interface WalnutSource {
  dir: string;
  kind: WalnutSourceKind;
}

export type SelfRepairUnavailableReason = 'cloud' | 'no-git' | 'clone-dir-occupied';

export interface SelfRepairStatus {
  /** A repair session can start here (a source exists, or one can be cloned). */
  available: boolean;
  source: WalnutSource | null;
  /** Where the first repair would clone when `source` is null. */
  cloneDir: string;
  repoUrl: string;
  reason?: SelfRepairUnavailableReason;
}

/** `~/open-walnut` unless WALNUT_SELF_REPAIR_CLONE_DIR points elsewhere (tests, odd homes). */
export function defaultCloneDir(): string {
  const override = process.env.WALNUT_SELF_REPAIR_CLONE_DIR?.trim();
  return override ? expandHome(override) : path.join(os.homedir(), 'open-walnut');
}

/** Clone budget. A full clone is ~70 MB; slow links need minutes, not seconds. */
export const CLONE_TIMEOUT_MS = 300_000;

export class WalnutSourceError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'WalnutSourceError';
  }
}

/** package.json naming open-walnut next to a .git (dir, or the file a worktree has). */
export function isWalnutCheckout(dir: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string };
    return pkg.name === 'open-walnut' && fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

async function configuredSourceDir(): Promise<string | null> {
  const fromEnv = process.env.WALNUT_SOURCE_DIR?.trim();
  if (fromEnv) return expandHome(fromEnv);
  try {
    const fromConfig = (await getConfig()).self_repair?.source_dir?.trim();
    return fromConfig ? expandHome(fromConfig) : null;
  } catch {
    return null;
  }
}

/** The source to repair in, or null when none exists yet (a clone may still be possible). */
export async function resolveWalnutSource(): Promise<WalnutSource | null> {
  if (WALNUT_INSTALL_DIR) return { dir: WALNUT_INSTALL_DIR, kind: 'running' };
  const configured = await configuredSourceDir();
  if (configured) {
    if (isWalnutCheckout(configured)) return { dir: configured, kind: 'configured' };
    log.notif.warn('self-repair: configured source_dir is not a Walnut checkout — ignoring', { dir: configured });
  }
  const cloneDir = defaultCloneDir();
  if (isWalnutCheckout(cloneDir)) return { dir: cloneDir, kind: 'clone' };
  return null;
}

let gitProbe: Promise<boolean> | null = null;
/** A negative answer is re-asked after this long: git can be installed while the
 *  server runs, and /api/config asks on every load, so neither "forever" nor
 *  "every call" is right. A positive answer is kept for the process lifetime. */
const NO_GIT_RETRY_MS = 60_000;
/** Is a `git` on PATH? Same caching shape as git-sync's isGitAvailableAsync. */
export function hasGit(): Promise<boolean> {
  gitProbe ??= new Promise<boolean>((resolve) => {
    execFile('git', ['--version'], { timeout: 10_000 }, (err) => resolve(!err));
  }).then((ok) => {
    if (!ok) setTimeout(() => { gitProbe = null; }, NO_GIT_RETRY_MS).unref();
    return ok;
  });
  return gitProbe;
}

export async function getSelfRepairStatus(): Promise<SelfRepairStatus> {
  const base = { cloneDir: defaultCloneDir(), repoUrl: WALNUT_REPO_URL };
  if (CLOUD_MODE) return { ...base, available: false, source: null, reason: 'cloud' };
  const source = await resolveWalnutSource();
  if (source) return { ...base, available: true, source };
  // Something else already lives at the clone path: never clone over it.
  if (fs.existsSync(base.cloneDir)) return { ...base, available: false, source: null, reason: 'clone-dir-occupied' };
  if (!(await hasGit())) return { ...base, available: false, source: null, reason: 'no-git' };
  return { ...base, available: true, source: null };
}

export function explainUnavailable(status: SelfRepairStatus): string {
  switch (status.reason) {
    case 'cloud':
      return 'Repairs start on the primary console, not on a cloud replica.';
    case 'no-git':
      return `No Walnut source checkout and git is not installed, so one cannot be cloned. Install git, or clone ${status.repoUrl} and set self_repair.source_dir in config.yaml.`;
    case 'clone-dir-occupied':
      return `${status.cloneDir} exists but is not a Walnut checkout. Point self_repair.source_dir (config.yaml) or WALNUT_SOURCE_DIR at your clone, or move that folder aside.`;
    default:
      return 'No Walnut source is available for a repair session.';
  }
}

let cloneInFlight: Promise<WalnutSource> | null = null;

/**
 * The source to repair in, cloning upstream into defaultCloneDir() when there
 * is none. Concurrent callers share one clone. Throws WalnutSourceError with an
 * HTTP-shaped status when nothing can be done.
 */
export async function ensureWalnutSource(opts: { timeoutMs?: number } = {}): Promise<{ source: WalnutSource; cloned: boolean }> {
  // Status first, source second: a replica deployed from a git clone HAS a
  // checkout, and must still be refused before that checkout is even looked at.
  const status = await getSelfRepairStatus();
  if (!status.available) throw new WalnutSourceError(explainUnavailable(status), status.reason === 'cloud' ? 409 : 503);
  if (status.source) return { source: status.source, cloned: false };
  cloneInFlight ??= cloneUpstream(opts.timeoutMs ?? CLONE_TIMEOUT_MS).finally(() => { cloneInFlight = null; });
  return { source: await cloneInFlight, cloned: true };
}

/**
 * Clone into a staging sibling and rename into place, so a killed or failed
 * clone never leaves a half-checkout that isWalnutCheckout would accept.
 */
async function cloneUpstream(timeoutMs: number): Promise<WalnutSource> {
  const target = defaultCloneDir();
  const staging = `${target}.cloning-${process.pid}`;
  await fsp.rm(staging, { recursive: true, force: true });
  log.notif.info('self-repair: cloning Walnut source', { repoUrl: WALNUT_REPO_URL, target });
  const startedAt = Date.now();
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        'git', ['clone', '--quiet', WALNUT_REPO_URL, staging],
        // No credential prompt can be answered here; fail fast instead of hanging.
        { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: gitChildEnv({ GIT_TERMINAL_PROMPT: '0' }) },
        (err, _stdout, stderr) => {
          if (!err) { resolve(); return; }
          const why = (typeof stderr === 'string' && stderr.trim()) || err.message;
          reject(new WalnutSourceError(
            `Cloning Walnut's source failed: ${why}. You can clone it yourself: git clone ${WALNUT_REPO_URL} ${target}`,
            502,
          ));
        },
      );
    });
    // The user may have cloned by hand while ours ran: theirs wins.
    if (isWalnutCheckout(target)) {
      await fsp.rm(staging, { recursive: true, force: true });
    } else {
      await fsp.rename(staging, target);
    }
    log.notif.info('self-repair: Walnut source cloned', { target, ms: Date.now() - startedAt });
    return { dir: target, kind: 'clone' };
  } catch (err) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    log.notif.warn('self-repair: clone failed', { error: err instanceof Error ? err.message : String(err), ms: Date.now() - startedAt });
    throw err;
  }
}

/** Test seam: forget the memoized git probe / in-flight clone. */
export function _resetSelfRepairForTesting(): void {
  gitProbe = null;
  cloneInFlight = null;
}
