/**
 * Main and every VP start their own session in the background (2026-11-03, the user: "when org
 * chat start why the VP tasks are not start, they should start from the behind instead of people
 * have to click start and jump to another window").
 *
 * An org node with no conversation yet is started here, with a short Walnut note that asks it to
 * read its teams and write its Brief: when it is made (a new VP or project on the Org page, a
 * lead a project move made or reopened), when the Org page shows one that has none (Main included),
 * once after the server starts, and when the user turns the org back on. A lead starts where its
 * project's tasks start (the task-start path, the project's default host); Main runs where every
 * Personal AI ask runs. Nothing navigates and nothing waits on the user. Making Main does not start
 * it: every caller that makes Main (the chat slot, the phone, a routine) starts it with the user's
 * message right after, and a second start would race that one.
 *
 * `task.org_start` tells the Org page how it went: `starting`, or `failed` with the error, which
 * the page shows with Retry in place. A lead's start is an automatic start, held to its host's
 * slots (sessions/host-admission.ts): with no room it fails, saying so, and the user's Retry starts
 * it at once (2026-11-06, the user: a start that did not start is an error). It is cleared once
 * the node has a session. Starts run one at a time. The org switch (org-enabled.ts) stops all of it.
 */

import { randomUUID } from 'node:crypto';
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import { isOrgEnabled, isOrgNode } from './org-enabled.js';

/** The start's source: framed as Walnut's own note in the session (send-frame.ts). */
export const ORG_START_SOURCE = 'org-autostart';

export type OrgStartWhy = 'created' | 'viewed' | 'boot' | 'enabled' | 'retry';

export interface OrgStartOutcome {
  started: boolean;
  /** Why nothing started: the org is off, the node has a session already, a start runs, it failed before (no retry). */
  skipped?: 'org_off' | 'not_org_node' | 'complete' | 'has_session' | 'starting' | 'failed_before' | 'test_run' | 'missing' | 'autostart_off';
  sessionId?: string;
  error?: string;
}

/** The first message: who started it and what to do first. Plain words, no ask of anyone. */
export function orgStartMessage(task: Pick<Task, 'org_role' | 'title' | 'org_name' | 'project'>, title: string): string {
  if (task.org_role === 'router') return 'Walnut opened your isolated router conversation. You are a router beside the VPs, not a VP or their subordinate. No incoming content has been supplied. Wait for a confirmed item in your own area; VP collaboration links do not grant data access.';
  const who = task.org_role === 'main' ? 'the CEO of the org' : `the ${title} in the org`;
  return [
    `Walnut started your session in the background: you are ${who}.`,
    'First read your teams with org_get, then write your Brief (brief_read, then brief_write) so the user sees where the work stands.',
    'Nobody waits on an answer to this note: when the Brief is written, end your turn. The user and your teams reach you here.',
  ].join(' ');
}

let chain: Promise<unknown> = Promise.resolve();
const queued = new Set<string>();
/** A start the queue waits for at most this long; it goes on by itself, the next one starts. */
const QUEUE_SLOT_MS = 150_000;
/** Starts that failed this many times in a row are not tried again by the boot or a turn-on, only by Retry. */
export const MAX_AUTO_ATTEMPTS = 3;

/** Queue a start (one at a time, each held at most QUEUE_SLOT_MS); never throws. */
export function startOrgNodeSoon(taskId: string, why: OrgStartWhy): void {
  if (why !== 'retry' && process.env.WALNUT_ORG_AUTOSTART === '0') return;
  if (queued.has(taskId)) return;
  queued.add(taskId);
  chain = chain.then(() => {
    const run = startOrgNode(taskId, why).finally(() => { queued.delete(taskId); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slot = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        log.task.warn('org start: still running, the queue goes on', { taskId, why });
        resolve();
      }, QUEUE_SLOT_MS);
      timer.unref?.();
    });
    return Promise.race([run, slot]).finally(() => clearTimeout(timer));
  }).catch((err) => {
    log.task.warn('org start: failed', { taskId, why, error: err instanceof Error ? err.message : String(err) });
  });
}

/** Whether a start for this node is queued or running here. */
export function orgStartQueued(taskId: string): boolean {
  return queued.has(taskId);
}

async function hasConversation(task: Task): Promise<boolean> {
  if (task.session_id || task.exec_session_id) return true;
  const { taskConversation } = await import('../sessions/task-session-claim.js');
  return !!(await taskConversation(task.id));
}

async function writeStart(taskId: string, value: Task['org_start'] | null): Promise<void> {
  const { updateTaskRaw } = await import('../task-manager.js');
  // null clears the payload field (normalizeNullClears).
  await updateTaskRaw(taskId, { org_start: value as Task['org_start'] }, { emitEvent: true, source: 'api' })
    .catch((err) => log.task.warn('org start: state not recorded', { taskId, error: err instanceof Error ? err.message : String(err) }));
}

/**
 * Why this node would not be started now, or undefined when it would. Reads only. `retry` (the
 * Org page's Retry or Start, which the user clicked) also starts one whose last start failed, and
 * a test run's node; every automatic path skips those, so a broken start is not retried forever
 * and a test window on the real Walnut runs no CLI.
 */
export async function orgStartSkip(task: Task | null, why: OrgStartWhy): Promise<OrgStartOutcome['skipped']> {
  if (!(await isOrgEnabled())) return 'org_off';
  if (!task) return 'missing';
  if (!isOrgNode(task)) return 'not_org_node';
  if (task.phase === 'COMPLETE') return 'complete';
  if (await hasConversation(task)) return 'has_session';
  const { isTaskStarting } = await import('../sessions/task-start.js');
  if (isTaskStarting(task.id)) return 'starting';
  const asked = why === 'retry';
  // WALNUT_ORG_AUTOSTART=0 (the test setup) leaves every start to a person's Retry or first message.
  if (!asked && process.env.WALNUT_ORG_AUTOSTART === '0') return 'autostart_off';
  if (!asked && task.org_start?.state === 'failed'
    && (why !== 'boot' && why !== 'enabled' || (task.org_start.attempts ?? 1) >= MAX_AUTO_ATTEMPTS)) return 'failed_before';
  const { isTestRunTask } = await import('../test-run.js');
  if (!asked && isTestRunTask(task)) return 'test_run';
  return undefined;
}

export async function startOrgNode(taskId: string, why: OrgStartWhy): Promise<OrgStartOutcome> {
  const fields = { taskId, why };
  const { getTask } = await import('../task-manager.js');
  const task = await getTask(taskId).catch(() => null);
  const skipped = await orgStartSkip(task, why);
  if (skipped || !task) {
    if (skipped === 'has_session' && task?.org_start) await writeStart(task.id, null);
    return { started: false, skipped: skipped ?? 'missing' };
  }

  const { orgDisplayTitle } = await import('./org-tree.js');
  const message = orgStartMessage(task, orgDisplayTitle(task));
  const attempts = (task.org_start?.state === 'failed' && why !== 'retry' ? task.org_start.attempts ?? 1 : 0) + 1;
  await writeStart(task.id, { state: 'starting', at: new Date().toISOString(), attempts });
  log.task.info('org start: starting', fields);
  try {
    let sessionId: string | undefined;
    if (task.org_role === 'main') {
      // Main is a Personal AI ask: it runs where every ask runs, with the ask's persona. Its id is
      // minted here, so its record exists before the spawn and a second start sees it.
      const { quickStartSession, continuedSessionOf } = await import('../sessions/quick-start.js');
      const { ASK_LAUNCH_CWD } = await import('../sessions/ask-launch-plan.js');
      const { getConfig } = await import('../config-manager.js');
      const { resolveDefaultEngine } = await import('../agents/default-engine.js');
      const { isAcpEngine, normalizeEngine } = await import('../agents/engine-registry.js');
      const engine = normalizeEngine(resolveDefaultEngine(await getConfig()));
      const minted = isAcpEngine(engine) ? undefined : randomUUID();
      const started = await quickStartSession({
        message, existingTaskId: task.id, cwd: ASK_LAUNCH_CWD, walnutAgent: true, source: ORG_START_SOURCE, engine,
        ...(minted ? { preassignedSessionId: minted } : {}),
      });
      sessionId = continuedSessionOf(started) ?? minted ?? started.session_id ?? undefined;
    } else {
      // A lead starts where its project's tasks start, as org_send starts it.
      const { startSessionForTask } = await import('../sessions/task-start.js');
      const started = await startSessionForTask({
        taskIdPrefix: task.id, ...(task.org_role === 'router' ? { idle: true } : { message }),
        source: ORG_START_SOURCE, expectReply: false, awaitStart: true,
        // Retry is the user's own click: it starts at once wherever the node runs (review round 5).
        ...(why === 'retry' ? { byPerson: true } : {}),
      });
      sessionId = started.sessionId;
    }
    await writeStart(task.id, null);
    log.task.info('org start: started', { ...fields, sessionId });
    return { started: true, ...(sessionId ? { sessionId } : {}) };
  } catch (err) {
    const name = (err as { name?: string })?.name;
    const text = err instanceof Error ? err.message : String(err);
    // Someone else started it meanwhile (the user's own first message, an org_send): not a failure.
    // The one-session guard's refusal reaches here as is, or wrapped in the start's 502.
    if (name === 'SessionExistsError' || name === 'TaskSessionTakenError' || (err as { code?: string })?.code === 'task_has_session'
      || /already has its active session/.test(text)) {
      await writeStart(task.id, null);
      return { started: false, skipped: 'has_session' };
    }
    // No host had room: the user's words on the Org page, beside Retry (review round 6: it showed the agent's).
    const { HostsFullError } = await import('../sessions/host-admission.js');
    const error = err instanceof HostsFullError
      ? `${err.detail.label ?? err.detail.host} has no room (${err.detail.reason}). Retry starts it now.`
      : text.slice(0, 500);
    await writeStart(task.id, { state: 'failed', at: new Date().toISOString(), error, attempts });
    log.task.warn('org start: could not start', { ...fields, error });
    return { started: false, error };
  }
}

/** Every open org node with no conversation yet, started one at a time. Returns the ids queued. */
export async function sweepOrgStarts(why: OrgStartWhy): Promise<string[]> {
  if (process.env.WALNUT_ORG_AUTOSTART === '0' || !(await isOrgEnabled())) return [];
  const { orgTasks } = await import('./org-store.js');
  const { isTestRunTask } = await import('../test-run.js');
  const nodes = (await orgTasks()).filter((t) => isOrgNode(t) && t.phase !== 'COMPLETE' && !isTestRunTask(t)
    && !t.session_id && !t.exec_session_id && !(t.session_ids?.length));
  const ids: string[] = [];
  for (const t of nodes) {
    // Only the boot and a turn-on try a failed start again (a restart or a change may have fixed
    // it), and only a few times in a row.
    if (t.org_start?.state === 'failed' && (why !== 'boot' && why !== 'enabled' || (t.org_start.attempts ?? 1) >= MAX_AUTO_ATTEMPTS)) continue;
    startOrgNodeSoon(t.id, why);
    ids.push(t.id);
  }
  if (ids.length) log.task.info('org start: sweep', { why, nodes: ids });
  return ids;
}

/** On the primary, after the server is up: start the nodes that have none. */
export function startOrgAutostart(delayMs = 60_000, opts: { ephemeral?: boolean } = {}): { stop(): void } {
  // A test server's copy of the user's data starts no one by itself (a node it makes still starts).
  if (opts.ephemeral) return { stop: () => {} };
  const timer = setTimeout(() => {
    void sweepOrgStarts('boot').catch((err) => log.task.warn('org start: boot sweep failed', { error: err instanceof Error ? err.message : String(err) }));
  }, delayMs);
  timer.unref?.();
  return { stop: () => clearTimeout(timer) };
}

/** For tests: wait for the queued starts. */
export function _orgStartsSettled(): Promise<unknown> {
  return chain;
}
