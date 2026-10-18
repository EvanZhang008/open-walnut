/**
 * Note merges off the server's event loop (docs/plan/walnut-replica-servers-impl.md
 * section 6): the Mac's drain of notes written while it was away merges in a worker
 * thread with a deadline. A diff of a long note rewritten on both sides takes seconds,
 * and the event loop serves every route (CLAUDE.md, tests/core/event-loop-blocking-ratchet.test.ts).
 *
 * A merge that runs past NOTE_MERGE_DEADLINE_MS is the over-budget row: the whole note
 * is one conflict region, the newest side kept in the note and every other version
 * given in full. So the outcome depends on the inputs and the times, never on the
 * machine's speed (a merge the diff budget stops gives the same answer).
 *
 * The worker runs the library's own factory (`createThreeWayMerge`, self-contained) by
 * its source, with the diff library it loads. Only merges that need no diff (at most one
 * version differs from the base) answer on the calling thread.
 */

import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import {
  createThreeWayMerge, mergeVersions, INLINE_BUDGET, INLINE_MAX_LINE, MAX_EDIT_LENGTH,
  type MergeVersion, type VersionsOptions, type VersionsResult,
} from '../../lib/three-way-merge.js';

/** How long one note merge may take off the loop; past it, the over-budget row. */
export const NOTE_MERGE_DEADLINE_MS = 2_000;

/** The helper a name-keeping loader (tsx, esbuild keepNames) makes a named inner function call. */
const NAME_HELPER = "function __name(target, value) { return Object.defineProperty(target, 'name', { value: value, configurable: true }); }";

const WORKER_SOURCE = `${NAME_HELPER}
const { parentPort, workerData } = require('node:worker_threads');
const lib = require(workerData.diffPath);
const merger = (${createThreeWayMerge.toString()})(lib, workerData.limits);
parentPort.postMessage(merger.mergeVersions(workerData.base, workerData.versions, workerData.opts));
`;

let diffPath: string | undefined;

/** Versions that differ from the base, by text with CRLF folded (what the merge compares). */
function changedCount(base: string, versions: MergeVersion[]): number {
  const fold = (s: string): string => s.replace(/\r\n/g, '\n');
  const b = fold(base);
  return new Set(versions.map((v) => fold(v.text)).filter((t) => t !== b)).size;
}

export type NoteMerge = (base: string, versions: MergeVersion[], opts?: VersionsOptions) => Promise<VersionsResult & { timedOut?: true }>;

/**
 * `mergeVersions` off the event loop with a deadline: the merge, or the over-budget row
 * (`timedOut`) when the worker did not answer in time (the worker is stopped).
 */
export const mergeNoteOffLoop: NoteMerge = async (base, versions, opts = {}) => {
  // Nothing to diff: the library answers without one (identical versions, one side changed).
  if (changedCount(base, versions) <= 1) return mergeVersions(base, versions, opts);
  return runWorker(base, versions, opts, NOTE_MERGE_DEADLINE_MS);
};

/** The worker run itself, with an explicit deadline (tests stretch or shrink it). */
export async function runWorker(
  base: string, versions: MergeVersion[], opts: VersionsOptions, deadlineMs: number,
): Promise<VersionsResult & { timedOut?: true }> {
  diffPath ??= createRequire(import.meta.url).resolve('diff');
  const limits = { maxEditLength: opts.maxEditLength ?? MAX_EDIT_LENGTH, inlineMaxLine: INLINE_MAX_LINE, inlineBudget: INLINE_BUDGET };
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { diffPath, limits, base, versions, opts } });
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      fn();
    };
    // The deadline's answer is the diff budget's: one region over the whole note.
    const timer = setTimeout(() => finish(() => resolve({ ...mergeVersions(base, versions, { ...opts, wholeNote: true }), timedOut: true })), deadlineMs);
    worker.once('message', (r: VersionsResult) => finish(() => resolve(r)));
    worker.once('error', (err) => finish(() => reject(err)));
    worker.once('exit', (code) => finish(() => reject(new Error(`the note merge worker exited (${code}) without an answer`))));
  });
}
