/**
 * open-walnut wait <task-id | rq-id> [...] — block until tasks settle or reply
 * requests resolve. Hub-side twin of the in-session `walnut wait` (wn-cli.ts):
 * the SERVER never holds a request open, so the waiting is a client-side poll
 * of readonly ops (task_get / request_get), 5s cadence, exit 7 on timeout.
 * Several ids wait for ALL by default, or for the first with --any; one id
 * prints the same shape it always did.
 */
import { executeOp } from '../ops/index.js';
import { outputJson } from '../utils/json-output.js';
import { WAIT_MAX_IDS, evaluateWaitResult, waitManyVerdict } from '../providers/wn-cli.js';
import type { GlobalOptions } from '../core/types.js';

const POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_SECS = 1_800;

interface WaitOptions { timeout?: string; any?: boolean }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function print(body: Record<string, unknown>, globals: GlobalOptions): void {
  if (globals.json) outputJson(body);
  else console.log(JSON.stringify(body, null, 2));
}

export async function runWait(idArg: string | string[], options: WaitOptions, globals: GlobalOptions): Promise<void> {
  const ids = [...new Set(Array.isArray(idArg) ? idArg : [idArg])];
  if (ids.length > WAIT_MAX_IDS) {
    console.error(`wait takes at most ${WAIT_MAX_IDS} ids`);
    process.exitCode = 2;
    return;
  }
  const timeoutSecs = Math.max(1, Number(options.timeout ?? DEFAULT_TIMEOUT_SECS) || DEFAULT_TIMEOUT_SECS);
  const deadline = Date.now() + timeoutSecs * 1000;
  const latest = new Map<string, Record<string, unknown>>();
  const settled = new Set<string>();

  for (;;) {
    for (const id of ids) {
      if (settled.has(id)) continue;
      const r = await executeOp(id.startsWith('rq-') ? 'request_get' : 'task_get', { id });
      if (!r.ok) {
        // A definite answer (unknown id, server down) — stop, don't spin.
        const message = ids.length > 1 ? `${id}: ${r.message}` : r.message;
        if (globals.json) outputJson({ error: message });
        else console.error(message);
        process.exitCode = 1;
        return;
      }
      const { done, summary } = evaluateWaitResult(id, (r.result ?? {}) as Record<string, unknown>);
      latest.set(id, summary);
      if (done) settled.add(id);
    }
    if (ids.length === 1) {
      const summary = latest.get(ids[0]) ?? {};
      if (settled.has(ids[0])) { print({ done: true, ...summary }, globals); return; }
      if (Date.now() >= deadline) {
        print({ done: false, timeout: true, waitedSecs: timeoutSecs, ...summary }, globals);
        process.exitCode = 7;
        return;
      }
    } else {
      const verdict = waitManyVerdict(ids, latest, settled, options.any ? 'any' : 'all');
      if (verdict.done) { print(verdict.body, globals); return; }
      if (Date.now() >= deadline) {
        print({ ...verdict.body, timeout: true, waitedSecs: timeoutSecs }, globals);
        process.exitCode = 7;
        return;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
}
