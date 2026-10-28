/**
 * Whether this server loads the embedding model (the semantic search lane).
 *
 * The model is the largest thing a Walnut server holds: one worker lane of the
 * default model measured +2.2 GB of footprint (2026-10-02), and on a fresh data
 * home the first use also downloads it (614 MB). That is right for the user's
 * own server and wrong for every throwaway one an agent or a test starts: a
 * `dev:ephemeral` server rebuilds its index from the copied data (SQLite files
 * are not copied), so it re-embedded the whole corpus and loaded the model next
 * to the production server on the same Mac, which is exactly the memory the
 * production server's freezes were short of.
 *
 * So the lane is on by default only for a real install. An isolated server
 * (the test runner, an `--_ephemeral-child`, any server whose data home sits in
 * a temp directory or a Walnut task directory, or one started with a HOME that
 * is not the account's own) keeps keyword search and skips the model unless
 * asked: WALNUT_SEARCH_V2_SEMANTIC=1 opts in, =0 opts out anywhere. The STT
 * auto-setup reads the same decision (src/core/stt/auto-setup.ts).
 *
 * Task dirs and a fake HOME since 2026-10-26: git work moved out of /tmp into
 * task directories, so throwaway servers stopped looking like temp homes, and
 * one started with HOME inside a slice clone downloaded a 2.3 GB speech model
 * into that fake HOME.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { taskDirRoot } from '../../lib/task-dir.js';

export type SemanticLaneReason = 'opt-in' | 'opt-out' | 'test-runner' | 'ephemeral' | 'temp-home' | 'task-dir' | 'fake-home' | 'default';

export interface SemanticLaneDecision {
  on: boolean;
  reason: SemanticLaneReason;
}

export interface SemanticLaneInputs {
  env: NodeJS.ProcessEnv;
  /** This process is an `--_ephemeral-child` (src/constants.ts IS_EPHEMERAL). */
  isEphemeral: boolean;
  /** The data home this server runs on (WALNUT_HOME). */
  walnutHome: string;
  /** Temp roots; a data home inside one is a throwaway server. */
  tmpRoots?: string[];
  /** Walnut task-dir roots; a data home inside one is a throwaway server. Default: from env and the account home. */
  taskDirRoots?: string[];
  /** The account's own home (os.userInfo), against which env.HOME is compared. */
  accountHome?: string;
}

// realpath answers are memoized: the decision is read on status requests, and
// the paths it resolves (the data home, the temp roots) are fixed per process.
const realpaths = new Map<string, string>();
function realpathOnce(p: string): string {
  let r = realpaths.get(p);
  if (r === undefined) {
    try { r = fs.realpathSync(p); } catch { r = p; /* absent (yet) */ }
    realpaths.set(p, r);
  }
  return r;
}

/** The OS temp dir and /tmp, each also through its realpath (macOS /tmp is /private/tmp). */
export function defaultTmpRoots(): string[] {
  const roots = new Set<string>();
  for (const r of [os.tmpdir(), '/tmp']) {
    roots.add(path.resolve(r));
    roots.add(realpathOnce(r));
  }
  return [...roots];
}

/**
 * Home directory field of a passwd entry (`name:pw:uid:gid:...`): field 6 in the
 * getent form, field 9 in the macOS `id -P` form (class, change, expire added).
 */
export function passwdHome(line: string, platform: NodeJS.Platform): string | null {
  const f = line.trim().split(':');
  const home = platform === 'darwin' ? f[8] : f[5];
  return home && path.isAbsolute(home) ? home : null;
}

let accountHomeCache: string | null | undefined;
/**
 * The account's home from the user database, never from $HOME. Bun's
 * os.userInfo().homedir returns $HOME (Node reads the passwd entry), so in the
 * Bun-built release a fake HOME looked like the account's own and the voice
 * model was downloaded into it (2026-10-27, release rehearsal).
 */
function accountHomeDir(): string | null {
  if (accountHomeCache !== undefined) return accountHomeCache;
  let home: string | null = null;
  try {
    const out = process.platform === 'darwin'
      ? execFileSync('/usr/bin/id', ['-P'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
      : process.platform === 'linux'
        ? execFileSync('getent', ['passwd', String(os.userInfo().uid)], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
        : '';
    home = passwdHome(out, process.platform);
  } catch { /* fall back below */ }
  if (!home) {
    try { home = os.userInfo().homedir || null; } catch { home = null; }
  }
  accountHomeCache = home;
  return home;
}

/** The task-dir root for this env and for the account home, plus this session's own task dir. */
export function defaultTaskDirRoots(env: NodeJS.ProcessEnv, accountHome: string | null): string[] {
  const roots = new Set<string>();
  if (accountHome) roots.add(taskDirRoot(env, accountHome));
  if (env.WALNUT_TASK_DIR && path.isAbsolute(env.WALNUT_TASK_DIR)) roots.add(path.resolve(env.WALNUT_TASK_DIR));
  return [...roots];
}

function inside(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export function semanticLaneDecision(inputs: SemanticLaneInputs): SemanticLaneDecision {
  const flag = inputs.env.WALNUT_SEARCH_V2_SEMANTIC;
  if (flag === '1') return { on: true, reason: 'opt-in' };
  if (flag === '0') return { on: false, reason: 'opt-out' };
  if (inputs.env.VITEST || inputs.env.VITEST_WORKER_ID || inputs.env.NODE_ENV === 'test') {
    return { on: false, reason: 'test-runner' };
  }
  if (inputs.isEphemeral) return { on: false, reason: 'ephemeral' };
  const home = path.resolve(inputs.walnutHome);
  const real = realpathOnce(home);
  for (const root of inputs.tmpRoots ?? defaultTmpRoots()) {
    if (inside(home, root) || inside(real, root)) return { on: false, reason: 'temp-home' };
  }
  const accountHome = inputs.accountHome ?? accountHomeDir();
  for (const root of inputs.taskDirRoots ?? defaultTaskDirRoots(inputs.env, accountHome)) {
    const r = path.resolve(root);
    if (inside(home, r) || inside(real, r) || inside(real, realpathOnce(r))) return { on: false, reason: 'task-dir' };
  }
  const envHome = inputs.env.HOME;
  if (envHome && accountHome && realpathOnce(path.resolve(envHome)) !== realpathOnce(path.resolve(accountHome))) {
    return { on: false, reason: 'fake-home' };
  }
  return { on: true, reason: 'default' };
}
