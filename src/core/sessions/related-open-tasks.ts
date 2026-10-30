/**
 * Before a SESSION creates a task, Walnut lists the related OPEN tasks and creates
 * nothing until the session confirms its work is a new deliverable.
 *
 * Why (2026-10-26): Main and a lead opened three new tasks in one day, each beside an
 * open task already doing related work. The rule was in the prompt (the task routing
 * contract) and agents skipped it, and the team list a create returns
 * (`placement.open_subtasks`) arrives after the task exists. So the check is the
 * server's, on the create itself:
 *
 *   session create, no confirm ──► related open tasks? ── none ──► create as before
 *                                         │
 *                                        yes ──► 409 related_open_tasks {candidates, hint}
 *                                                  nothing created
 *   retry with confirm_new + new_reason ──► create; the reason is kept in the description
 *
 * Who: every session caller (a worker, a Personal AI ask, a session with no task).
 * Humans (no `x-walnut-caller-sid`: the web console, the phone), a cloud replica (no
 * session registry: `unknown`), plugins and sync (in-process, no header) never meet it.
 *
 * Paths a session can still create through, unchecked, and why:
 *   - the cloud companion while it leads (the Mac away): a session's task_create goes
 *     to the replica's leader ops (src/core/leader/backup-gateway.ts), where every
 *     caller is `unknown` because a replica keeps no session registry. Its open-task
 *     copy is partial and the create is drained to the Mac later, where refusing it
 *     would remove a task its session was told exists;
 *   - the human launchers (POST /api/v1/sessions, /api/sessions/quick-start) reached
 *     through the generic `api` op: they make a task for a new session, read no caller
 *     header and skip every other session rule too (placement, project_reason, the
 *     title brake). No named op leads there;
 *   - the offline drain (offline-merge/apply-v2.ts): the task already exists for its
 *     caller, so a refusal there would lose it.
 *
 * Cost: the deadline (RELATED_CHECK_DEADLINE_MS) bounds the waits, not the CPU, so the
 * synchronous part is kept small instead: the open rows only, filtered before any copy
 * (listOpenTaskViews), at most RELATED_MAX_ROWS of them, ranked in chunks of RANK_CHUNK
 * rows with a yield to the event loop between chunks; a timed-out run stops at the next
 * chunk. On the real board (110 open of 5,117) one ranking is a few ms per chunk.
 * It FAILS OPEN: on a timeout or any error the create goes ahead as before and the
 * reason is logged.
 */

import { log } from '../../logging/index.js';
import type { CallerPlacement, PlacementDecision } from './caller-placement.js';
import { rankSteps, blockingOnly, withoutNamedPartners, type RankableTask } from './related-open-rank.js';

/** How long the lookup may take before the create goes ahead without it. */
export const RELATED_CHECK_DEADLINE_MS = 300;
/** A reason long enough to say something. */
export const NEW_REASON_MIN = 10;
export const RELATED_OPEN_TASKS_CODE = 'related_open_tasks';
/** The most recently updated open tasks ranked; older open rows past this are not read. */
export const RELATED_MAX_ROWS = 1000;
/** The caller's ancestors walked (the subtask depth cap is 3, so this is slack). */
const MAX_ANCESTORS = 10;

export interface RelatedCandidate {
  id: string;
  title: string;
  project: string;
  folder?: string;
  phase: string;
  /** The status the user reads (user-status.ts), when Walnut has derived one. */
  user_status?: string;
  /** A live session process on it (running a turn, or alive between turns). */
  session_running: boolean;
  updated_at?: string;
  /** Why it was listed: the shared words, and the same folder or project. */
  reason: string;
  /** The caller's own subtask. */
  your_subtask?: boolean;
}

export type RelatedGate =
  | { kind: 'proceed'; footer?: string; skipped?: 'timeout' | 'error' | 'disabled' }
  | { kind: 'bad_request'; message: string }
  | { kind: 'refuse'; message: string; candidates: RelatedCandidate[]; hint: string };

type Lookup = (input: LookupInput, stop: { stopped: boolean }) => Promise<RelatedCandidate[]>;

interface LookupInput {
  title: string;
  description?: string;
  project?: string;
  groupId?: string;
  callerTaskId?: string;
  excludeIds: string[];
}

let injectedLookup: Lookup | null = null;
/** Tests: replace the lookup (a failure or a hang proves the fail-open path). */
export function _injectRelatedLookupForTesting(fn: Lookup | null): void { injectedLookup = fn; }

const isSession = (caller: CallerPlacement): caller is Extract<CallerPlacement, { session: unknown }> => 'session' in caller;

/** The confirm fields as the body sent them: a 400 message, or what they say. */
export function readConfirm(body: { confirm_new?: unknown; new_reason?: unknown }): { error: string } | { confirm: boolean; reason: string } {
  const { confirm_new: confirm, new_reason: reason } = body;
  if (confirm !== undefined && typeof confirm !== 'boolean') return { error: 'confirm_new must be a boolean' };
  if (reason !== undefined && typeof reason !== 'string') return { error: 'new_reason must be a string' };
  const text = typeof reason === 'string' ? reason.replace(/\s+/g, ' ').trim() : '';
  if (confirm === true && text.length < NEW_REASON_MIN) {
    return { error: `confirm_new needs new_reason: at least ${NEW_REASON_MIN} characters saying why this is a new deliverable and not one of the related open tasks` };
  }
  return { confirm: confirm === true, reason: text };
}

/** The line a confirmed create keeps in its description, so a person sees why it is separate. */
export function newReasonFooter(reason: string): string {
  return `Created as new work, not an existing open task: ${reason}`;
}

/**
 * The gate the create routes run for a caller. `decision` is the caller placement's
 * (the project and folder the task will land in); `idempotentId` the id an
 * idempotency key maps to, whose existing row means this is a retry of a create that
 * already happened (never refused: the original is reused as before).
 */
export async function relatedOpenTasksGate(args: {
  caller: CallerPlacement;
  decision: PlacementDecision;
  title: string;
  description?: string;
  body: { confirm_new?: unknown; new_reason?: unknown };
  idempotentId?: string;
}): Promise<RelatedGate> {
  const confirm = readConfirm(args.body);
  if ('error' in confirm) return { kind: 'bad_request', message: confirm.error };
  if (!isSession(args.caller)) return { kind: 'proceed' };
  if (confirm.confirm) {
    log.web.info('related open tasks check: confirmed as new work', { callerSid: args.caller.session.id, newReason: confirm.reason });
    return { kind: 'proceed', footer: newReasonFooter(confirm.reason) };
  }
  if (process.env.WALNUT_RELATED_CHECK === '0') return { kind: 'proceed', skipped: 'disabled' };
  const caller = args.caller;
  const callerTask = 'task' in caller ? caller.task : undefined;
  const input: LookupInput = {
    title: args.title,
    ...(args.description ? { description: args.description } : {}),
    project: args.decision.project ?? (caller.kind === 'worker' ? caller.task.project : undefined),
    groupId: args.decision.group_id ?? (args.decision.placeBesideCaller && callerTask ? callerTask.group_id : undefined),
    ...(callerTask ? { callerTaskId: callerTask.id } : {}),
    excludeIds: args.idempotentId ? [args.idempotentId] : [],
  };
  const started = Date.now();
  const deadline = Number(process.env.WALNUT_RELATED_CHECK_DEADLINE_MS) || RELATED_CHECK_DEADLINE_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    if (args.idempotentId) {
      const { getTask } = await import('../task-manager.js');
      const existing = await getTask(args.idempotentId).catch(() => undefined);
      if (existing?.id === args.idempotentId) return { kind: 'proceed' };
    }
    const lookup = injectedLookup ?? findRelatedOpenTasks;
    const stop = { stopped: false };
    const result = await Promise.race([
      lookup(input, stop),
      new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), deadline); timer.unref?.(); }),
    ]);
    if (result === 'timeout') {
      stop.stopped = true;
      log.web.warn('related open tasks check timed out; creating without it', { callerSid: caller.session.id, deadlineMs: deadline });
      return { kind: 'proceed', skipped: 'timeout' };
    }
    log.web.info('related open tasks check', { callerSid: caller.session.id, candidates: result.length, ms: Date.now() - started });
    if (result.length === 0) return { kind: 'proceed' };
    return { kind: 'refuse', candidates: result, ...refusalText(args.title, result) };
  } catch (err) {
    log.web.warn('related open tasks check failed; creating without it', { error: err instanceof Error ? err.message : String(err) });
    return { kind: 'proceed', skipped: 'error' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The 409's message and hint: readable alone, by a session whose op help predates the check. */
export function refusalText(title: string, candidates: RelatedCandidate[]): { message: string; hint: string } {
  const lines = candidates.map((c, i) => {
    const where = c.folder ? `${c.project || 'Inbox'} / ${c.folder}` : (c.project || 'Inbox');
    const state = [c.user_status ?? c.phase, c.session_running ? 'session running' : 'no session running'].join(', ');
    return `${i + 1}. ${c.id} "${c.title}" (${where}; ${state}; ${c.reason})`;
  });
  const hint = 'If one of them already owns this work, send it there instead: '
    + `walnut tools call task_send '{"to":"<task id>","title":"...","text":"..."}' (it also reaches a task with no session). `
    + 'If yours is a separate deliverable, create it again with "confirm_new": true and "new_reason" '
    + `(at least ${NEW_REASON_MIN} characters saying why it is not one of them).`;
  const message = `Not created: "${title}" looks like work already open in ${candidates.length === 1 ? 'this task' : 'these tasks'}:\n`
    + `${lines.join('\n')}\n${hint}`;
  return { message, hint };
}

type OpenRow = RankableTask & { phase: string; parent_task_id?: string; updated_at?: string; user_status?: { state?: string } };

/** Let the event loop run between chunks of the ranking (setImmediate: after pending I/O). */
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The related open tasks, best first, at most 5. Throws on a store error (the gate fails open). */
export async function findRelatedOpenTasks(input: LookupInput, stop: { stopped: boolean } = { stopped: false }): Promise<RelatedCandidate[]> {
  const tm = await import('../task-manager.js');
  const { isAskTask } = await import('./caller-placement.js');
  // The caller and every task above it, COMPLETE ones included: the new task is filed
  // in their tree, so they are the work it serves, never a place to send it.
  const skip = new Set<string>(input.excludeIds);
  let id = input.callerTaskId;
  for (let depth = 0; id && !skip.has(id) && depth <= MAX_ANCESTORS; depth++) {
    skip.add(id);
    id = (await tm.getTask(id).catch(() => undefined))?.parent_task_id;
  }
  const rows = await tm.listOpenTaskViews(RELATED_MAX_ROWS);
  const open: OpenRow[] = [];
  for (const t of rows) {
    if (skip.has(t.id)) continue;
    // A conversation (an ask, Main) or a lead coordinates; it does not own a deliverable.
    // A plugin's own task (Task.plugin_only) is the plugin's, never a teammate to route to.
    if (isAskTask(t) || t.org_role || t.plugin_only) continue;
    open.push({
      id: t.id, title: t.title, description: t.description, project: t.project ?? '', phase: t.phase,
      ...(t.group_id ? { group_id: t.group_id } : {}),
      ...(t.parent_task_id ? { parent_task_id: t.parent_task_id } : {}),
      ...(t.updated_at ? { updated_at: t.updated_at } : {}),
      ...(t.user_status ? { user_status: t.user_status } : {}),
    });
  }
  const steps = rankSteps({ title: input.title, description: input.description },
    open, { project: input.project, groupId: input.groupId });
  let next = steps.next();
  while (!next.done) {
    await yieldToLoop();
    if (stop.stopped) return [];
    next = steps.next();
  }
  // A task the brief names by id as other work ("coordinate with X") is not listed back;
  // one it names under the new title's own words ("take over X") still is.
  const ranked = blockingOnly(withoutNamedPartners(input, next.value));
  if (ranked.length === 0) return [];
  const ids = new Set(ranked.map((r) => r.task.id));
  const { listSessionsForTasks } = await import('../session-tracker.js');
  const sessions = await listSessionsForTasks(ids).catch(() => []);
  const live = new Set(sessions
    .filter((s) => !s.archived && (s.process_status === 'running' || s.process_status === 'idle'))
    .map((s) => s.taskId));
  const labels = ranked.some((r) => r.task.group_id)
    ? await tm.listFolderLabels().catch(() => new Map<string, string>())
    : new Map<string, string>();
  return ranked.map(({ task, matched, sameFolder, sameProject }) => {
    const folder = task.group_id ? labels.get(task.group_id) : undefined;
    const why = [`shares ${matched.slice(0, 6).map((w) => `"${w}"`).join(', ')}`];
    if (sameFolder) why.push('same folder');
    else if (sameProject) why.push('same project');
    const mine = !!input.callerTaskId && task.parent_task_id === input.callerTaskId;
    if (mine) why.push('your subtask');
    return {
      id: task.id,
      title: task.title,
      project: task.project ?? '',
      ...(folder ? { folder } : {}),
      phase: task.phase,
      ...(task.user_status?.state ? { user_status: task.user_status.state } : {}),
      session_running: live.has(task.id),
      ...(task.updated_at ? { updated_at: task.updated_at } : {}),
      reason: why.join('; '),
      ...(mine ? { your_subtask: true } : {}),
    };
  });
}
