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
 * (the test runner, an `--_ephemeral-child`, or any server whose data home sits
 * in a temp directory) keeps keyword search and skips the model unless asked:
 * WALNUT_SEARCH_V2_SEMANTIC=1 opts in, =0 opts out anywhere.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SemanticLaneReason = 'opt-in' | 'opt-out' | 'test-runner' | 'ephemeral' | 'temp-home' | 'default';

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
  return { on: true, reason: 'default' };
}
