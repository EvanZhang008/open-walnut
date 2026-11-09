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
import { WALNUT_HOME } from '../../constants.js';
import { isSupersededSession } from '../sessions/engine-switch-marker.js';
import { isMainAgentTask } from '../org/main-stays-active.js';
import { MIN_EVERY_MS, clampTimeoutSeconds } from '../../providers/trigger-check-core.js';
import type { TriggersTestResult } from '../../providers/trigger-check-core.js';
import { requireTriggerDaemon, triggerHost } from './trigger-daemon.js';
import { createRoutine } from './routines-core.js';
import type { CronJob } from '../cron/types.js';
import { HOST_TRIGGER_ID_RE } from './host-trigger-id.js';
import { createTriggerLabel } from './trigger-label.js';
import { ANSWER_MARGIN_MS, startTestRun, waitTestRun, type TestRunWait } from './trigger-test-run.js';
import {
  createLimitWarning, isTimeLimitError, killedAtLimitText, limitUse, limitUseLine, limitWarning, recentTestRun,
  rememberTestRun, TEST_RETRY_RELINK_MS, testRunDeadlineMs, timeLimitSeconds,
} from '../cron/trigger-time-limit.js';
import { assertCheckHostAllowed, checkCallerOrigin } from './check-host-policy.js';
import {
  TriggerTemplateError, exemptTemplateRun, parseTemplateRun, templateOriginRefusal, prepareTemplate, requireTriggerTemplate, templateRun,
} from './trigger-templates.js';

const LOCAL_HOST = '__local__';

/** "every 15 minutes", "every hour", "every 30 seconds". */
export function cadencePhrase(everyMs: number): string {
  const unit = (n: number, one: string) => (n === 1 ? `every ${one}` : `every ${n} ${one}s`);
  if (everyMs % 3_600_000 === 0) return unit(everyMs / 3_600_000, 'hour');
  if (everyMs % 60_000 === 0) return unit(everyMs / 60_000, 'minute');
  return unit(Math.round(everyMs / 1000), 'second');
}

/** What a template contributes to a trigger: its command and the words it is shown with. */
async function templateTrigger(name: string, rawParams: unknown, host: string, rawEvery: unknown, origin?: string): Promise<{
  run: string; prompt: string; description: string; label: string; every: string;
  maxFiresPerDay?: number; template: { id: string; params: Record<string, string>; label: string };
}> {
  if (host && triggerHost(host) !== LOCAL_HOST) {
    throw new SessionControlError('a template trigger runs on this machine; leave host out', 400);
  }
  try {
    const record = requireTriggerTemplate(name);
    const refusal = templateOriginRefusal(record, checkCallerOrigin(origin));
    if (refusal) throw new SessionControlError(refusal, 403);
    const prepared = await prepareTemplate(record, rawParams);
    const every = record.every || '5m';
    // The interval the user picked, not the template's default: the template's own words never name it.
    const everyMs = parseEveryMs(rawEvery ?? every);
    const cadence = everyMs ? ` Checks ${cadencePhrase(everyMs)}.` : '';
    return {
      run: templateRun(record.name, prepared.params),
      prompt: prepared.prompt,
      description: `${prepared.description.replace(/[.\s]*$/, '.')}${cadence}`.slice(0, TRIGGER_DESCRIPTION_MAX),
      label: prepared.label,
      every,
      ...(typeof record.maxFiresPerDay === 'number' ? { maxFiresPerDay: record.maxFiresPerDay } : {}),
      template: { id: record.name, params: prepared.params, label: prepared.label },
    };
  } catch (err) {
    if (err instanceof TriggerTemplateError) throw new SessionControlError(err.message, err.status === 404 ? 400 : err.status);
    throw err;
  }
}


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
 *
 * An omitted host is the calling session's, as for `trigger_create`: the script
 * was written on that session's host. `origin` is who asks (check-host-policy.ts),
 * checked before any daemon is looked up.
 */
export async function testRoutineCheck(
  body: unknown,
  origin?: string,
  callerSid?: string,
  /** The caller's deadline (answer-by.ts): a run still going then is answered `pending`. */
  answerBy?: number,
): Promise<TestCheckAnswer> {
  const b = record(body) ?? {};
  // A caller may name its own wait (the web form, which must not hold one of the browser's few
  // connections for minutes): the earlier of that and its answer-by deadline.
  const within = typeof b.answerWithinMs === 'number' && Number.isFinite(b.answerWithinMs)
    ? Date.now() + Math.min(60_000, Math.max(1_000 + ANSWER_MARGIN_MS, Math.floor(b.answerWithinMs) + ANSWER_MARGIN_MS))
    : undefined;
  if (within !== undefined) answerBy = answerBy === undefined ? within : Math.min(answerBy, within);
  const testId = str(b.testId);
  if (testId) {
    // A run an earlier call left running (trigger-test-run.ts): wait on it again.
    const waited = await waitTestRun<FinishedTest>(testId, answerBy);
    if (!waited) {
      throw new SessionControlError(
        `no test run ${testId} here: it finished over 15 minutes ago, or the server restarted since; run trigger_test again`,
        404,
      );
    }
    return answerOf(waited);
  }
  const rawCheck = record(b.check);
  if (!rawCheck) throw new SessionControlError('check is required', 400);
  const run = str(rawCheck.run);
  if (!run) throw new SessionControlError('check.run is required', 400);
  const templateCheck = parseTemplateRun(run) !== null;
  const caller = await callerSessionPlace(callerSid);
  const host = templateCheck ? triggerHost(str(rawCheck.host) || LOCAL_HOST) : triggerHost(str(rawCheck.host) || caller.host);
  // The directory trigger_create would arm it in (the calling session's, when it names none), so the
  // test runs where the trigger will, and its time is remembered under the same check.
  const cwd = str(rawCheck.cwd) || (templateCheck ? '' : caller.cwd);
  if (!exemptTemplateRun({ run, cwd, host }, checkCallerOrigin(origin))) assertCheckHostAllowed(host, origin);
  const conn = await requireTriggerDaemon(host);
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
  const started = startTestRun<FinishedTest>(
    { host, limitSeconds: check.timeoutSeconds, startedAt: Date.now() },
    () => runTestOnce(host, conn, { check, ...(id ? { triggerId: id } : {}), home: WALNUT_HOME }),
  );
  return answerOf((await waitTestRun<FinishedTest>(started, answerBy))!);
}

type FinishedTest = { result: TriggersTestResult; timeLimit: TestTimeLimit };

/** A test run that is still going when its caller must be answered. */
export interface TestPending {
  testId: string;
  host: string;
  limitSeconds: number;
  startedAt: string;
  runningForMs: number;
}

export type TestCheckAnswer = FinishedTest | { pending: TestPending };

function answerOf(waited: TestRunWait<FinishedTest>): TestCheckAnswer {
  if (waited.done) return waited.value;
  const { info } = waited;
  return {
    pending: {
      testId: waited.testId, host: info.host, limitSeconds: info.limitSeconds,
      startedAt: new Date(info.startedAt).toISOString(), runningForMs: Math.max(0, Date.now() - info.startedAt),
    },
  };
}

/** One test run to its end: the daemon's result, its time against the limit, remembered for trigger_create. */
async function runTestOnce(
  host: string,
  conn: Awaited<ReturnType<typeof requireTriggerDaemon>>,
  params: { check: { run: string; cwd?: string; timeoutSeconds: number }; triggerId?: string; home: string },
): Promise<FinishedTest> {
  const reply = await sendTestRun(host, conn, params);
  const payload = record(reply.result) ?? reply;
  if (!('wouldFire' in payload)) {
    throw new SessionControlError(
      typeof reply.error === 'string' && reply.error ? reply.error : `daemon on ${host} could not run the check`,
      502,
    );
  }
  const result = { ...(payload as unknown as TriggersTestResult) };
  // The run's time against its limit, and a deadline kill said as one (trigger-time-limit.ts).
  const limitS = params.check.timeoutSeconds;
  const killed = isTimeLimitError(result.error);
  if (killed) result.error = killedAtLimitText(limitS);
  const use = limitUse(result.durationMs, limitS, killed);
  if (use) {
    rememberTestRun({ run: params.check.run, host, cwd: params.check.cwd ?? '' }, {
      atMs: Date.now(), durationMs: use.durationMs, limitSeconds: limitS, killed,
    });
  }
  const warning = limitWarning(use, 'This test run');
  return {
    result,
    timeLimit: {
      seconds: limitS,
      ...(use ? { durationMs: use.durationMs, share: use.share, killed, line: limitUseLine(use) } : {}),
      ...(warning ? { warning } : {}),
    },
  };
}

/** A test run's time against the limit it ran under (trigger_test reads it). */
export interface TestTimeLimit {
  seconds: number;
  durationMs?: number;
  /** durationMs / the limit. */
  share?: number;
  killed?: boolean;
  /** "ran 34 s of its 120 s limit". */
  line?: string;
  /** Set when the run took over half the limit or was killed by it. */
  warning?: string;
}

/**
 * One test run on the host's daemon, waited for as long as the check may run (its limit, the
 * daemon's settle grace and the way back), never a fixed minute. A link that dropped while the
 * test ran (or that was not there when it was sent) is a transport failure, not the script's: the
 * test reads and writes no trigger state, so it is sent once more, on the link the host has then.
 * 2026-11-08: a host's daemon dropped the connection mid-test and the author read only "did not
 * answer the test", with no word whether the script or the link failed.
 */
async function sendTestRun(
  host: string,
  first: Awaited<ReturnType<typeof requireTriggerDaemon>>,
  params: { check: { run: string; cwd?: string; timeoutSeconds: number }; triggerId?: string; home: string },
): Promise<Record<string, unknown>> {
  const deadlineMs = testRunDeadlineMs(params.check.timeoutSeconds);
  const { linkFailureKind } = await import('../../providers/link-failure.js');
  let conn = first;
  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // `triggerId`, never `id`: send() spreads params into {id, cmd, ...params},
      // so an `id` param overwrites the RPC correlation id and the reply is lost.
      return await conn.send('triggers.test', params, deadlineMs) as Record<string, unknown>;
    } catch (err) {
      const kind = linkFailureKind(err);
      lastError = err instanceof Error ? err.message : String(err);
      if (kind === 'no-answer') {
        throw new SessionControlError(
          `the daemon on ${host} gave no answer within ${Math.round(deadlineMs / 1000)} s, though the check's limit is `
          + `${params.check.timeoutSeconds} s: the link may be stalled; try again (${lastError})`,
          503,
        );
      }
      if (kind !== 'lost' && kind !== 'no-link') {
        throw new SessionControlError(`daemon on ${host} did not answer the test: ${lastError}`, 503);
      }
      log.web.warn('trigger check test: link to the daemon dropped', { host, attempt, kind, error: lastError });
      if (attempt === 2) break;
      const next = await relinkTriggerDaemon(host);
      if (!next) break;
      conn = next;
    }
  }
  throw new SessionControlError(
    `transport failure: the connection to the daemon on ${host} dropped while the test ran, and the one retry `
    + `did not get through either (${lastError}). This is the link, not your script: run trigger_test again `
    + 'once the host is connected (host_list shows it).',
    503,
  );
}

/** The host's daemon once its link is back, waited for briefly; null when it is not back. */
async function relinkTriggerDaemon(host: string): Promise<Awaited<ReturnType<typeof requireTriggerDaemon>> | null> {
  const { findTriggerDaemon } = await import('./trigger-daemon.js');
  const until = Date.now() + TEST_RETRY_RELINK_MS;
  for (;;) {
    const conn = await findTriggerDaemon(host).catch(() => null);
    if (conn) return conn;
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** The host and directory the calling session runs in, '' for each when there is no such session. */
async function callerSessionPlace(callerSid?: string): Promise<{ host: string; cwd: string }> {
  if (!callerSid) return { host: '', cwd: '' };
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const rec = await getSessionByClaudeId(callerSid).catch(() => null);
  return { host: rec?.host ?? '', cwd: rec?.cwd ?? '' };
}

/**
 * Resolve the task a fire should be delivered to. `own` = it is the calling
 * session's own task.
 */
async function resolveTarget(session: string, callerSid?: string): Promise<{
  target: string;
  own: boolean;
  host?: string;
  cwd?: string;
}> {
  if (session !== 'this') {
    const { getTask } = await import('../task-manager.js');
    const task = await getTask(session).catch(() => null);
    if (!task) {
      throw new SessionControlError(`no task ${session}: pass the id of a task that exists, or session: "this"`, 400);
    }
    let own = false;
    if (callerSid) {
      const { getSessionByClaudeId } = await import('../session-tracker.js');
      own = (await getSessionByClaudeId(callerSid).catch(() => null))?.taskId === task.id;
    }
    return { target: task.id, own, ...(task.cwd ? { cwd: task.cwd } : {}) };
  }
  if (!callerSid) {
    throw new SessionControlError('no calling session; pass session: <taskId>', 400);
  }
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const rec = await getSessionByClaudeId(callerSid).catch(() => null);
  if (!rec || !rec.taskId) {
    throw new SessionControlError('no calling session; pass session: <taskId>', 400);
  }
  if (isSupersededSession(rec)) {
    throw new SessionControlError('this session was replaced by an engine switch; its task continues in its new session', 409);
  }
  return {
    target: rec.taskId,
    own: true,
    ...(rec.host ? { host: rec.host } : {}),
    ...(rec.cwd ? { cwd: rec.cwd } : {}),
  };
}

/** What a trigger_create did to the task it delivers into. */
export interface TriggerWaitResult {
  parked: boolean;
  task_id: string;
  /** Why it was not parked: the caller passed wait:false, the trigger is for another task, or the task is complete. */
  reason?: 'wait_false' | 'other_task' | 'complete' | 'not_written' | 'main_stays_active' | 'watches_user';
  /** The clock the store now holds (null = no clock), when parked. */
  wait_until?: string | null;
  /** The task was already WAITING (its clock is kept unless wait_until was passed). */
  already_waiting?: boolean;
  error?: string;
}

/** Whether a trigger delivers into the main agent's task, which never parks. */
async function isMainTarget(taskId: string): Promise<boolean> {
  const { getTask } = await import('../task-manager.js');
  return isMainAgentTask(await getTask(taskId).catch(() => null));
}

/**
 * Park the task a new trigger delivers into: WAITING, with the caller's clock
 * or the store's default. No letter: a park is not news for the inbox. Never
 * throws: the trigger is already armed, so a park that fails is reported in the
 * result rather than undoing the create.
 */
async function parkForTrigger(taskId: string, opts: {
  waitUntil: string | undefined;
  callerSid: string | undefined;
}): Promise<TriggerWaitResult> {
  try {
    const { getTask, updateTask } = await import('../task-manager.js');
    const before = await getTask(taskId);
    if (before.phase === 'COMPLETE') return { parked: false, task_id: taskId, reason: 'complete' };
    // The main agent's task stays active and on the list (org/main-stays-active.ts).
    if (isMainAgentTask(before)) return { parked: false, task_id: taskId, reason: 'main_stays_active' };
    const { task } = await updateTask(taskId, {
      phase: 'WAITING',
      ...(opts.waitUntil !== undefined ? { wait_until: opts.waitUntil } : {}),
    }, { source: 'api', asyncPush: true, ...(opts.callerSid ? { actorSid: opts.callerSid } : {}) });
    if (task.phase !== 'WAITING') return { parked: false, task_id: taskId, reason: 'not_written' };
    return {
      parked: true, task_id: taskId, wait_until: task.wait_until ?? null,
      ...(before.phase === 'WAITING' ? { already_waiting: true } : {}),
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.web.warn('trigger park failed', { taskId, error });
    return { parked: false, task_id: taskId, reason: 'not_written', error };
  }
}

/** Every trigger's name is a short label, never the prompt's opening (trigger-label.ts). */
export const triggerLabels = createTriggerLabel();

/**
 * The longest `description` trigger_create accepts. It is shown in full on the
 * Routines card and clamped to three lines in the task's trigger flyout, so it is
 * meant to be one or two sentences, not the script explained line by line.
 */
export const TRIGGER_DESCRIPTION_MAX = 600;

export { HOST_TRIGGER_ID_RE } from './host-trigger-id.js';

/** What a trigger stands in for on its task (sessions/recheck-watch.ts). Never throws. */
async function recordWatch(taskId: string, jobId: string, watches: string): Promise<void> {
  const { updateTaskRaw } = await import('../task-manager.js');
  const { withWatch } = await import('../sessions/recheck-watch.js');
  const at = new Date().toISOString();
  const { askKey } = await import('../same-ask.js');
  // A watch of the ask remembers which ask: its decision (ask-decision.ts), kept across rewordings,
  // else its words' key. Its runs check that one, never a later ask.
  const askOf = (cur: { status_report?: { state?: string; ask?: string }; user_status?: { state?: string; ask?: string } }) =>
    (cur.status_report?.state === 'needs' ? cur.status_report.ask : undefined) ?? (cur.user_status?.state === 'needs' ? cur.user_status.ask : undefined);
  await updateTaskRaw(taskId, (cur) => {
    const decision = cur.status_report?.state === 'needs' ? cur.status_report.ask_id : undefined;
    const key = watches === 'ask' ? decision || askKey(askOf(cur)) : '';
    return { recheck_watch: withWatch(cur.recheck_watch, { trigger: jobId, watches, at, ...(key ? { key } : {}) }) };
  },
    { push: false, source: 'trigger-watch' }).catch((err) => log.web.warn('trigger watch not recorded', {
    target: taskId, jobId, error: err instanceof Error ? err.message : String(err),
  }));
}

/**
 * Create a trigger in one call: check + interval + prompt + description + where
 * to deliver.
 *
 * Everything the caller omits is taken from the session that is asking, which is
 * what makes `/walnut-trigger` a one-liner from inside a session. The description
 * is the exception: only the author knows what the script watches, and a card
 * that shows a name and `bash …/check.sh` does not tell the user what fires it.
 * `origin` is who asks (check-host-policy.ts); createRoutine checks it.
 */
export async function createTriggerRoutine(body: unknown, callerSid?: string, origin?: string): Promise<{
  job: unknown;
  host: string;
  /** Always null: the daemon owns the clock and reports the real next check. */
  nextCheckAt: null;
  /** What happened to the task it delivers into (parked only with wait:true). */
  wait: TriggerWaitResult;
  /** Absent only on a host's replay of a trigger already recorded. */
  timeLimit?: CreateTimeLimit;
}> {
  const b = record(body) ?? {};
  // A trigger a host created while this server was away comes back under its own id
  // (offline-handover.ts replays it): stored once, whether the replay runs once or again.
  const hostId = b.id === undefined || b.id === null ? '' : str(b.id);
  if (b.id !== undefined && b.id !== null && !HOST_TRIGGER_ID_RE.test(hostId)) {
    throw new SessionControlError('id is set only by a host that created this trigger while Walnut was away; leave it out', 400);
  }
  if (hostId && str(b.template)) throw new SessionControlError('a template trigger is never created on a host; leave id out', 400);
  const fromTemplate = str(b.template) ? await templateTrigger(str(b.template), b.params, str(b.host), b.every, origin) : null;
  const run = fromTemplate?.run ?? str(b.run);
  if (!run) throw new SessionControlError('run is required: the shell command that decides whether to fire (or pass template + params)', 400);
  // The user's words lead; a template's own prompt still follows, because it
  // says how to read its items ("read it with mail_read when the preview is not enough").
  const prompt = fromTemplate && str(b.prompt)
    ? `${str(b.prompt)}\n\nFrom the ${fromTemplate.label} trigger (the instruction above wins where they differ): ${fromTemplate.prompt}`
    : str(b.prompt) || fromTemplate?.prompt || '';
  if (!prompt) throw new SessionControlError('prompt is required: what the session should do when it fires', 400);
  const description = (str(b.description) || fromTemplate?.description || '').replace(/\s+/g, ' ');
  if (!description) {
    throw new SessionControlError(
      'description is required: one or two plain sentences saying what this watches, when it fires, '
      + 'and what the session does then',
      400,
    );
  }
  // What it stands in for: the task's ask of the user, or one of its letters (sessions/recheck-watch.ts).
  const { validWatch } = await import('../sessions/recheck-watch.js');
  const watches = b.watches === undefined || b.watches === null || b.watches === '' ? null : validWatch(b.watches);
  if (b.watches !== undefined && b.watches !== null && b.watches !== '' && !watches) {
    throw new SessionControlError('watches must be "ask" (your status\'s ask of the user) or a letter id (lt-...)', 400);
  }
  if (description.length > TRIGGER_DESCRIPTION_MAX) {
    throw new SessionControlError(
      `description is ${description.length} characters; the limit is ${TRIGGER_DESCRIPTION_MAX} (one or two sentences)`,
      400,
    );
  }
  const everyMs = parseEveryMs(b.every ?? fromTemplate?.every);
  if (everyMs === null) {
    throw new SessionControlError('every is required: milliseconds, or a duration like "30s" / "5m" / "1h"', 400);
  }
  if (everyMs < MIN_EVERY_MS) {
    throw new SessionControlError(`every must be at least ${MIN_EVERY_MS / 1000}s`, 400);
  }
  // The park is checked before anything is armed: a bad clock arms nothing.
  if (b.wait !== undefined && typeof b.wait !== 'boolean') {
    throw new SessionControlError('wait must be true or false', 400);
  }
  const { parseWaitUntil } = await import('../task-wait-clock.js');
  let waitUntil: string | undefined;
  try {
    waitUntil = parseWaitUntil(b.wait_until);
  } catch (err) {
    throw new SessionControlError(err instanceof Error ? err.message : String(err), 400);
  }

  const session = str(b.session) || 'this';
  const resolved = await resolveTarget(session, callerSid);
  // createRoutine asks check-host-policy with `origin` before any daemon lookup.
  // A template check calls this server, so it runs on this machine's daemon,
  // never in the caller's directory on another host.
  const host = fromTemplate ? LOCAL_HOST : triggerHost(str(b.host) || resolved.host);
  // A template's command runs with no directory (exemptTemplateRun), so it never
  // takes the caller's; one given explicitly still counts against it.
  const cwd = fromTemplate ? '' : str(b.cwd) || (parseTemplateRun(run) ? '' : resolved.cwd) || '';
  // A name an old host cut from the prompt (its replay) is relabelled too.
  // A template's label is its own, never a cut of the prompt.
  const name = !str(b.name) && fromTemplate?.label
    ? triggerLabels.label({ name: fromTemplate.label, description, run })
    : triggerLabels.label({ name: str(b.name), description, prompt, run });
  const maxFiresPerDay = b.maxFiresPerDay ?? fromTemplate?.maxFiresPerDay;

  if (hostId) {
    const { getRoutine } = await import('./routines-core.js');
    const prior = (await getRoutine(hostId).catch(() => null))?.job as CronJob | undefined;
    if (prior) {
      // The same trigger again (a replay after a drain that did not finish): nothing is armed twice.
      const target = (prior.executor?.config as { target?: unknown } | undefined)?.target;
      if (prior.check?.run === run && target === resolved.target) {
        log.web.info('trigger created on a host already recorded', { jobId: hostId, host, target: resolved.target });
        // A replay after a drain that stopped between the store and the watch writes the watch now.
        if (watches) await recordWatch(resolved.target, hostId, watches);
        return { job: prior, host, nextCheckAt: null, wait: { parked: false, task_id: resolved.target, reason: resolved.own ? 'wait_false' : 'other_task' } };
      }
      throw new SessionControlError(`a routine ${hostId} already exists and is not this trigger`, 409);
    }
  }

  const created = await createRoutine({
    name,
    description,
    schedule: { kind: 'every', everyMs },
    check: {
      run,
      ...(cwd ? { cwd } : {}),
      host,
      ...(b.timeoutSeconds !== undefined ? { timeoutSeconds: b.timeoutSeconds } : {}),
      ...(maxFiresPerDay !== undefined ? { maxFiresPerDay } : {}),
      ...(fromTemplate ? { template: fromTemplate.template } : {}),
    },
    executor: { type: 'session', config: { target: resolved.target, prompt } },
  }, origin, hostId ? { id: hostId } : undefined);

  if (watches) {
    const jobId = (created.job as { id?: string } | undefined)?.id;
    if (jobId) await recordWatch(resolved.target, jobId, watches);
  }

  // A trigger parks the task only when the caller asks with wait:true (2026-10-31, the user: "a
  // trigger does not always mean it goes into wait ... don't overuse wait"; a session that armed a
  // watch right after answering him took its answer off his list). Parking is the session's call,
  // made when only the outside wait is left and the user has nothing of its turn to read.
  // A trigger on the user's ask or letter (`watches`) is a wait on the user: the task stays
  // Needs you, whatever `wait` says (sessions/outside-wait.ts, 2026-10-30).
  const park = !watches && b.wait === true;
  const wait: TriggerWaitResult = park
    ? await parkForTrigger(resolved.target, { waitUntil, callerSid })
    : watches
      ? { parked: false, task_id: resolved.target, reason: 'watches_user' }
      : await isMainTarget(resolved.target)
      ? { parked: false, task_id: resolved.target, reason: 'main_stays_active' }
      : { parked: false, task_id: resolved.target, reason: b.wait === false || resolved.own ? 'wait_false' : 'other_task' };

  // A recent trigger_test of this script that came close to (or hit) the limit the trigger
  // now runs under: said at once, before the first real run is killed.
  const limitS = timeLimitSeconds({ timeoutSeconds: b.timeoutSeconds });
  const tested = fromTemplate ? null : recentTestRun({ run, host, cwd });
  const limitWarned = createLimitWarning(tested, limitS);
  const timeLimit: CreateTimeLimit = {
    seconds: limitS,
    ...(tested ? { tested: { durationMs: tested.durationMs, seconds: tested.limitSeconds, killed: tested.killed, at: new Date(tested.atMs).toISOString() } } : {}),
    ...(limitWarned ? { warning: limitWarned } : {}),
  };

  log.web.info('trigger created', {
    host, target: resolved.target, everyMs, ...(fromTemplate ? { template: fromTemplate.template.id } : {}),
    jobId: (created.job as { id?: string } | undefined)?.id,
    parked: wait.parked, ...(wait.reason ? { notParked: wait.reason } : {}),
  });
  return { job: created.job, host, nextCheckAt: null, wait, timeLimit };
}

/** The new trigger's time limit and what its last test run says about it (trigger_create reads it). */
export interface CreateTimeLimit {
  seconds: number;
  /** The newest trigger_test of the same run, host and cwd in the last hour. */
  tested?: { durationMs: number; seconds: number; killed: boolean; at: string };
  warning?: string;
}
