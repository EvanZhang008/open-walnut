/**
 * Line-level three-way merge for a task's text fields (description, note, summary;
 * docs/plan/walnut-replica-servers-impl.md section 7). A step budget bounds the diff
 * (`maxEditLength`): a diff over it is one conflict over the whole text.
 *
 * Each side's change against the base becomes hunks `[baseStart, baseEnd) -> lines`.
 * Hunks of the two sides that touch different base lines both apply; hunks that
 * overlap (or insert at the same point) apply when they are equal and conflict when
 * not. Line endings are kept as written (each line carries its own end).
 *
 * The drain merges OFF the server's event loop (`mergeTextOffLoop`): a diff of a long
 * text rewritten on both sides takes seconds (12,000 lines: about 14 s per diff), and
 * the drain runs inside the task store's write lock. A worker thread runs it with a
 * deadline (TEXT_MERGE_DEADLINE_MS); one that runs over is the over-budget row: one
 * conflict over the whole text, the newer side kept (task-fields.ts). Short texts merge
 * inline (a few ms at most).
 */

import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { diffArrays } from 'diff';

/** Edit steps one side's diff may take; beyond it the whole text is one conflict. */
export const TEXT_MERGE_MAX_EDITS = 50_000;
/** How long a merge off the loop may take; over it the merge is over budget (newer side kept). */
export const TEXT_MERGE_DEADLINE_MS = 2_000;
/** Below this many characters (the three texts together) a merge runs inline. */
export const TEXT_MERGE_INLINE_MAX = 8_000;

export type TextMergeResult =
  | { clean: true; text: string }
  | { clean: false; conflicts: number; overBudget: boolean; timedOut?: true };

/**
 * The merge, self-contained: its only free names are its two parameters, so the worker
 * runs this very function (its source, `toString()`) with the diff library it loads.
 */
function textMergeCore(diff: typeof diffArrays, maxEdits: number): (base: string, mac: string, replica: string) => TextMergeResult {
  type Hunk = { start: number; end: number; lines: string[] };

  /** Split keeping each line's own end ("\n" or "\r\n"); the last line may have none. */
  function splitLines(text: string): string[] {
    if (!text) return [];
    const out: string[] = [];
    let at = 0;
    for (;;) {
      const nl = text.indexOf('\n', at);
      if (nl === -1) { if (at < text.length) out.push(text.slice(at)); break; }
      out.push(text.slice(at, nl + 1));
      at = nl + 1;
    }
    return out;
  }

  function hunks(base: string[], other: string[]): Hunk[] | null {
    const changes = diff(base, other, { maxEditLength: maxEdits });
    if (!changes) return null;
    const out: Hunk[] = [];
    let pos = 0;
    let cur: Hunk | null = null;
    for (const c of changes) {
      const n = c.count ?? c.value.length;
      if (!c.added && !c.removed) {
        if (cur) { out.push(cur); cur = null; }
        pos += n;
        continue;
      }
      cur ??= { start: pos, end: pos, lines: [] };
      if (c.removed) { cur.end += n; pos += n; } else cur.lines.push(...c.value);
    }
    if (cur) out.push(cur);
    return out;
  }

  const sameLines = (a: string[], b: string[]): boolean => a.length === b.length && a.every((l, i) => l === b[i]);

  /** merge3(base, mac, replica): the clean result, or how many regions conflict. */
  function mergeText(base: string, mac: string, replica: string): TextMergeResult {
    if (mac === replica) return { clean: true, text: mac };
    if (mac === base) return { clean: true, text: replica };
    if (replica === base) return { clean: true, text: mac };
    const b = splitLines(base);
    const ha = hunks(b, splitLines(mac));
    const hb = hunks(b, splitLines(replica));
    if (!ha || !hb) return { clean: false, conflicts: 1, overBudget: true };
    const out: string[] = [];
    let pos = 0;
    let i = 0;
    let j = 0;
    let conflicts = 0;
    const overlaps = (x: Hunk, y: Hunk): boolean =>
      (x.start < y.end && y.start < x.end) || x.start === y.start || (x.start === x.end && x.start > y.start && x.start < y.end) || (y.start === y.end && y.start > x.start && y.start < x.end);
    while (i < ha.length || j < hb.length) {
      const x = ha[i];
      const y = hb[j];
      if (x && y && overlaps(x, y)) {
        // Grow the region while further hunks of either side overlap it.
        const start = Math.min(x.start, y.start);
        let end = Math.max(x.end, y.end);
        const ga: Hunk[] = [x];
        const gb: Hunk[] = [y];
        i++; j++;
        for (;;) {
          if (i < ha.length && ha[i].start < end) { end = Math.max(end, ha[i].end); ga.push(ha[i++]); continue; }
          if (j < hb.length && hb[j].start < end) { end = Math.max(end, hb[j].end); gb.push(hb[j++]); continue; }
          break;
        }
        const side = (g: Hunk[]): string[] => {
          const lines: string[] = [];
          let p = start;
          for (const h of g) { lines.push(...b.slice(p, h.start), ...h.lines); p = h.end; }
          lines.push(...b.slice(p, end));
          return lines;
        };
        const la = side(ga);
        const lb = side(gb);
        out.push(...b.slice(pos, start));
        if (sameLines(la, lb)) out.push(...la); else conflicts++;
        pos = end;
        continue;
      }
      const take: Hunk = !y || (x && x.start <= y.start) ? ha[i++] : hb[j++];
      out.push(...b.slice(pos, take.start), ...take.lines);
      pos = take.end;
    }
    if (conflicts) return { clean: false, conflicts, overBudget: false };
    out.push(...b.slice(pos));
    return { clean: true, text: out.join('') };
  }
  return mergeText;
}

const mergeInline = textMergeCore(diffArrays, TEXT_MERGE_MAX_EDITS);

/** merge3(base, mac, replica) on the calling thread: the clean result, or how many regions conflict. */
export function mergeText(base: string, mac: string, replica: string): TextMergeResult {
  return mergeInline(base, mac, replica);
}

/** The helper a name-keeping loader (tsx, esbuild keepNames) makes a named inner function call. */
const NAME_HELPER = "function __name(target, value) { return Object.defineProperty(target, 'name', { value: value, configurable: true }); }";

const WORKER_SOURCE = `${NAME_HELPER}
const { parentPort, workerData } = require('node:worker_threads');
const { diffArrays } = require(workerData.diffPath);
const merge = (${textMergeCore.toString()})(diffArrays, workerData.maxEdits);
parentPort.postMessage(merge(workerData.base, workerData.mac, workerData.replica));
`;

let diffPath: string | undefined;

/** The deadline's answer: as a merge over its step budget (task-fields.ts keeps the newer side and lists one conflict). */
const TIMED_OUT: TextMergeResult = { clean: false, conflicts: 1, overBudget: true, timedOut: true };

/**
 * merge3 off the event loop: a worker thread with a deadline (over it: TIMED_OUT, and
 * the worker is stopped). The trivial cases and short texts answer inline.
 */
export async function mergeTextOffLoop(
  base: string, mac: string, replica: string, deadlineMs = TEXT_MERGE_DEADLINE_MS,
): Promise<TextMergeResult> {
  if (mac === replica || mac === base || replica === base || base.length + mac.length + replica.length <= TEXT_MERGE_INLINE_MAX) {
    return mergeInline(base, mac, replica);
  }
  diffPath ??= createRequire(import.meta.url).resolve('diff');
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { diffPath, maxEdits: TEXT_MERGE_MAX_EDITS, base, mac, replica } });
  return new Promise<TextMergeResult>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      fn();
    };
    const timer = setTimeout(() => finish(() => resolve(TIMED_OUT)), deadlineMs);
    worker.once('message', (r: TextMergeResult) => finish(() => resolve(r)));
    worker.once('error', (err) => finish(() => reject(err)));
    worker.once('exit', (code) => finish(() => reject(new Error(`the text merge worker exited (${code}) without an answer`))));
  });
}
