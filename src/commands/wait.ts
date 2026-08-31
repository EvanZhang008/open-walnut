/**
 * open-walnut wait <task-id | rq-id> — block until a task settles or a reply
 * request resolves. Hub-side twin of the in-session `walnut wait` (wn-cli.ts):
 * the SERVER never holds a request open, so the waiting is a client-side poll
 * of readonly ops (task_get / request_get), 5s cadence, exit 7 on timeout.
 */
import { executeOp } from '../ops/index.js';
import { outputJson } from '../utils/json-output.js';
import type { GlobalOptions } from '../core/types.js';

const POLL_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_SECS = 1_800;
const DONE_PHASES = new Set(['AGENT_COMPLETE', 'COMPLETE']);

interface WaitOptions { timeout?: string }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWait(id: string, options: WaitOptions, globals: GlobalOptions): Promise<void> {
  const timeoutSecs = Math.max(1, Number(options.timeout ?? DEFAULT_TIMEOUT_SECS) || DEFAULT_TIMEOUT_SECS);
  const opName = id.startsWith('rq-') ? 'request_get' : 'task_get';
  const deadline = Date.now() + timeoutSecs * 1000;

  for (;;) {
    const r = await executeOp(opName, { id });
    if (!r.ok) {
      // A definite answer (unknown id, server down) — stop, don't spin.
      if (globals.json) outputJson({ error: r.message });
      else console.error(r.message);
      process.exitCode = 1;
      return;
    }
    const result = (r.result ?? {}) as Record<string, unknown>;
    let done: boolean;
    let summary: Record<string, unknown>;
    if (id.startsWith('rq-')) {
      const request = (result.request ?? result) as { status?: string; outcome?: string };
      done = !!request.status && request.status !== 'pending';
      summary = { request: id, status: request.status, ...(request.outcome ? { outcome: request.outcome } : {}) };
    } else {
      const task = (result.task ?? result) as { id?: string; title?: string; phase?: string };
      done = DONE_PHASES.has(String(task.phase));
      summary = { task: task.id ?? id, title: task.title, phase: task.phase };
    }
    if (done) {
      if (globals.json) outputJson({ done: true, ...summary });
      else console.log(JSON.stringify({ done: true, ...summary }, null, 2));
      return;
    }
    if (Date.now() >= deadline) {
      const timedOut = { done: false, timeout: true, waitedSecs: timeoutSecs, ...summary };
      if (globals.json) outputJson(timedOut);
      else console.log(JSON.stringify(timedOut, null, 2));
      process.exitCode = 7;
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}
