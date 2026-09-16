/**
 * The two agent-facing trigger calls: "test this script" and "watch this for me".
 *
 * Both live next to routines-core (which owns storage + save-time validation)
 * rather than in the route, because the cloud REPLICA reaches them through the
 * control relay with exactly the same semantics.
 *
 * `trigger_create` resolving `session: 'this'` at CREATE time is the load-bearing
 * detail: the routine stores a TASK id, so the card shows what it points at, and
 * a fork or a rewind of the calling session cannot lose the target.
 */

import { SessionControlError } from '../sessions/session-controls.js';
import { log } from '../../logging/index.js';
import { MIN_EVERY_MS, clampTimeoutSeconds } from '../../providers/trigger-check-core.js';
import type { TriggersTestResult } from '../../providers/trigger-check-core.js';
import { requireTriggerDaemon, triggerHost } from './trigger-daemon.js';
import { createRoutine } from './routines-core.js';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * `every` accepts a number of ms or a short duration ("30s", "5m", "1h") — an
 * agent writes the second, a form posts the first.
 */
export function parseEveryMs(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.floor(raw);
  const text = str(raw).toLowerCase();
  if (!text) return null;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(text);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  const unit = match[2] ?? 'ms';
  const factor = unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return Math.floor(n * factor);
}

/**
 * Run a check ONCE on its host, reading and writing no state.
 *
 * The reply is the daemon's own TriggersTestResult. It is recognized by
 * `wouldFire` rather than by the frame's `ok` on purpose: the result carries its
 * own `ok` ("the script ran and parsed"), which would otherwise be confused with
 * the RPC frame's `ok` ("the daemon accepted the command").
 */
export async function testRoutineCheck(body: unknown): Promise<{ result: TriggersTestResult }> {
  const b = record(body) ?? {};
  const rawCheck = record(b.check);
  if (!rawCheck) throw new SessionControlError('check is required', 400);
  const run = str(rawCheck.run);
  if (!run) throw new SessionControlError('check.run is required', 400);
  const host = triggerHost(rawCheck.host);
  const conn = await requireTriggerDaemon(host);
  const cwd = str(rawCheck.cwd);
  const check = {
    run,
    ...(cwd ? { cwd } : {}),
    timeoutSeconds: clampTimeoutSeconds(rawCheck.timeoutSeconds),
  };
  const id = str(b.id);
  // The one synchronous "run a command on a host" the API offers: it leaves a
  // trace like every other execution path does (who asked is in the request log
  // by reqId; this line says what ran, where).
  log.web.info('trigger check test', { host, run: run.slice(0, 200), ...(cwd ? { cwd } : {}), ...(id ? { jobId: id } : {}) });
  let reply: Record<string, unknown>;
  try {
    // Mandatory deadline: a route that waits on a daemon must always answer.
    // `triggerId`, never `id`: send() spreads params into {id, cmd, ...params},
    // so an `id` param overwrites the RPC correlation id and the reply is lost.
    reply = await conn.send('triggers.test', { check, ...(id ? { triggerId: id } : {}) }, 60_000) as Record<string, unknown>;
  } catch (err) {
    throw new SessionControlError(
      `daemon on ${host} did not answer the test: ${err instanceof Error ? err.message : String(err)}`,
      503,
    );
  }
  const payload = record(reply.result) ?? reply;
  if (!('wouldFire' in payload)) {
    throw new SessionControlError(
      typeof reply.error === 'string' && reply.error ? reply.error : `daemon on ${host} could not run the check`,
      502,
    );
  }
  return { result: payload as unknown as TriggersTestResult };
}

/** Resolve the task a fire should be delivered to. */
async function resolveTarget(session: string, callerSid?: string): Promise<{
  target: string;
  host?: string;
  cwd?: string;
}> {
  if (session !== 'this') {
    const { getTask } = await import('../task-manager.js');
    const task = await getTask(session).catch(() => null);
    if (!task) {
      throw new SessionControlError(`no task ${session}: pass the id of a task that exists, or session: "this"`, 400);
    }
    return { target: task.id, ...(task.cwd ? { cwd: task.cwd } : {}) };
  }
  if (!callerSid) {
    throw new SessionControlError('no calling session; pass session: <taskId>', 400);
  }
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const rec = await getSessionByClaudeId(callerSid).catch(() => null);
  if (!rec || !rec.taskId) {
    throw new SessionControlError('no calling session; pass session: <taskId>', 400);
  }
  return {
    target: rec.taskId,
    ...(rec.host ? { host: rec.host } : {}),
    ...(rec.cwd ? { cwd: rec.cwd } : {}),
  };
}

/**
 * A name for a trigger the agent did not name: the prompt's opening, cut at a
 * word boundary. No "Trigger:" prefix: the Routines card carries a Trigger badge
 * and the session card says "Trigger fired", so the prefix only repeated itself
 * ("Trigger: Trigger: ...") once the name was printed inside those.
 */
export function defaultTriggerName(prompt: string, max = 60): string {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const atWord = cut.lastIndexOf(' ');
  return `${atWord > max / 2 ? cut.slice(0, atWord) : cut}...`;
}

/**
 * Create a trigger in one call: check + interval + prompt + where to deliver.
 *
 * Everything the caller omits is taken from the session that is asking, which is
 * what makes `/walnut-trigger` a one-liner from inside a session.
 */
export async function createTriggerRoutine(body: unknown, callerSid?: string): Promise<{
  job: unknown;
  host: string;
  /** Always null: the daemon owns the clock and reports the real next check. */
  nextCheckAt: null;
}> {
  const b = record(body) ?? {};
  const run = str(b.run);
  if (!run) throw new SessionControlError('run is required: the shell command that decides whether to fire', 400);
  const prompt = str(b.prompt);
  if (!prompt) throw new SessionControlError('prompt is required: what the session should do when it fires', 400);
  const everyMs = parseEveryMs(b.every);
  if (everyMs === null) {
    throw new SessionControlError('every is required: milliseconds, or a duration like "30s" / "5m" / "1h"', 400);
  }
  if (everyMs < MIN_EVERY_MS) {
    throw new SessionControlError(`every must be at least ${MIN_EVERY_MS / 1000}s`, 400);
  }

  const session = str(b.session) || 'this';
  const resolved = await resolveTarget(session, callerSid);
  const host = triggerHost(str(b.host) || resolved.host);
  const cwd = str(b.cwd) || resolved.cwd || '';
  const name = str(b.name) || defaultTriggerName(prompt);

  const created = await createRoutine({
    name,
    schedule: { kind: 'every', everyMs },
    check: {
      run,
      ...(cwd ? { cwd } : {}),
      host,
      ...(b.timeoutSeconds !== undefined ? { timeoutSeconds: b.timeoutSeconds } : {}),
      ...(b.maxFiresPerDay !== undefined ? { maxFiresPerDay: b.maxFiresPerDay } : {}),
    },
    executor: { type: 'session', config: { target: resolved.target, prompt } },
  });

  log.web.info('trigger created', {
    host, target: resolved.target, everyMs,
    jobId: (created.job as { id?: string } | undefined)?.id,
  });
  return { job: created.job, host, nextCheckAt: null };
}
