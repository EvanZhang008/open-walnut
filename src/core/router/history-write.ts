/**
 * The area history rule at the stores' own write points (task-manager.ts, session-tracker.ts): sync,
 * reading only the other store's open handle, so it holds inside the writer's transaction after its
 * last await (a quick start that read its task before an areas PUT marked it cannot land there).
 */
import type { Database } from '../../lib/sqlite.js';
import { OrgError } from '../org/org-store.js';
import { getDb as getSessionDb, rowToSession } from '../session-db.js';
import { getDb as getTaskDb, rowToTask } from '../task-db.js';
import { isRouterAreaSession, type RouterAreaRole } from './session-policy.js';
import type { RouterArea } from './areas.js';
import type { SessionRecord, Task } from '../types.js';

const LOCAL_HOST = '__local__';

/** The session fields this rule reads: what it may run as, its task, and where its history came from. */
export type SessionHistoryFields = Pick<SessionRecord, 'claudeSessionId' | 'taskId' | 'profile' | 'host' | 'engine'>
  & Partial<Pick<SessionRecord, 'legacyTaskId' | 'fromPlanSessionId' | 'forkedFromSessionId' | 'rewoundAtMessageUuid' | 'engineSwitch' | 'resumedBySwitch'>>;

type HistoryTask = Pick<Task, 'id' | 'source' | 'org_role' | 'router_area_id' | 'session_ids' | 'session_id'
  | 'plan_session_id' | 'exec_session_id' | 'legacy_session_ids'>;

const ORIGIN_KEYS = ['legacyTaskId', 'fromPlanSessionId', 'forkedFromSessionId', 'rewoundAtMessageUuid', 'engineSwitch', 'resumedBySwitch'] as const;

/** Key-order independent JSON, so a profile that only round-tripped through the payload reads unchanged. */
function stable(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const hostOf = (r: SessionHistoryFields) => r.host || LOCAL_HOST;
const engineOf = (r: SessionHistoryFields) => r.engine || 'claude';
const originOf = (r: SessionHistoryFields | undefined) => (r ? ORIGIN_KEYS.map((k) => stable(r[k])).join('|') : ORIGIN_KEYS.map(() => '').join('|'));
const hasOrigin = (r: SessionHistoryFields) => ORIGIN_KEYS.some((k) => r[k] !== undefined && r[k] !== null && r[k] !== '');

/**
 * Only a router's own conversation is isolated (2026-11-14): a receiver profile ('work') an older
 * build left on routed work reads as none, so that work and its history are ordinary again.
 */
function hasAreaProfile(record: Pick<SessionRecord, 'profile'> | undefined): boolean {
  const p = record?.profile;
  return !!p && p.areaRole !== 'work' && (p.areaId !== undefined || p.areaRole !== undefined || p.areaPolicyVersion !== undefined);
}

/** A router's area mark; the mark an older build wrote on routed work is not read. */
const markOf = (t: Partial<Pick<Task, 'router_area_id' | 'org_role'>> | undefined) =>
  (t?.org_role === 'router' && typeof t.router_area_id === 'string' ? t.router_area_id.trim() : '');
const roleOf = (_t: Pick<Task, 'org_role'>): RouterAreaRole => 'router';
const areaMarked = (t: Pick<Task, 'org_role' | 'router_area_id'>) => t.org_role === 'router';
const areaFor = (id: string) => ({ id, host: LOCAL_HOST }) as RouterArea;

function refuse(message: string): never {
  throw new OrgError('router_history_not_isolated', 409, `${message} Nothing was written.`);
}

function unreadable(what: string, error: unknown): never {
  throw new OrgError('router_history_unreadable', 503,
    `${what} could not be read (${error instanceof Error ? error.message : String(error)}), so the area history rule could not be checked. Nothing was written; retry.`);
}

/** True for this rule's own refusal (a 409), never for an unreadable store. */
export function isHistoryRefusal(error: unknown): boolean {
  return error instanceof OrgError && error.code === 'router_history_not_isolated';
}

/** The shared task store handle, opened once by task-db.ts; a failed open refuses. */
export function taskDbHandle(): Database {
  try {
    const db = getTaskDb();
    if (db) return db;
    throw new Error('the task database is not open');
  } catch (error) {
    if (error instanceof OrgError) throw error;
    unreadable('The task store', error);
  }
}

/** The shared session store handle, opened once by session-db.ts; a failed open refuses. */
export function sessionDbHandle(): Database {
  try {
    const db = getSessionDb();
    if (db) return db;
    throw new Error('the session database is not open');
  } catch (error) {
    if (error instanceof OrgError) throw error;
    unreadable('The session store', error);
  }
}

function assertReadablePayload(payload: unknown): void {
  if (payload === undefined || payload === null || payload === '') return;
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The stored policy payload is not an object');
}

export function assertTaskHistoryRowReadable(row: Record<string, unknown>): void {
  try { assertReadablePayload(row.payload); } catch (error) { unreadable(`Task ${String(row.id)}'s policy`, error); }
}

function readTask(taskDb: Database, id: string): Task | undefined {
  try {
    const row = taskDb.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, any> | undefined;
    if (row) assertReadablePayload(row.payload);
    return row ? rowToTask(row) : undefined;
  } catch (error) {
    unreadable(`Task ${id}`, error);
  }
}

/** Every session id the task names in a slot or its history lists. */
function namedSessionIds(task: Partial<HistoryTask>): string[] {
  const ids = [task.session_id, task.exec_session_id, task.plan_session_id, ...(task.session_ids ?? []), ...(task.legacy_session_ids ?? [])];
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && !!id.trim()))];
}

// ── Session writes ──────────────────────────────────────────────────────────

/** Only a new record or a change of task, profile, host, engine or history origin is checked. */
export function sessionHistoryWriteNeedsCheck(before: SessionHistoryFields | undefined, after: SessionHistoryFields): boolean {
  if (!before) return !!after.taskId || hasAreaProfile(after) || hasOrigin(after);
  return (before.taskId || '') !== (after.taskId || '') || hostOf(before) !== hostOf(after) || engineOf(before) !== engineOf(after)
    || stable(before.profile) !== stable(after.profile) || originOf(before) !== originOf(after);
}

/** 409 unless the record fits its task's area exactly; `before` undefined = a record with no history. */
export function assertSessionHistoryWrite(before: SessionHistoryFields | undefined, after: SessionHistoryFields, taskDb: Database): void {
  if (!sessionHistoryWriteNeedsCheck(before, after)) return;
  const sid = after.claudeSessionId;
  if (before && hasAreaProfile(before)) {
    if (before.taskId !== after.taskId) refuse(`Session ${sid} belongs to its original area task and cannot move to another task.`);
    const { areaId, areaRole } = before.profile!;
    if (typeof areaId !== 'string' || !areaId || areaRole !== 'router' || !isRouterAreaSession(after, areaFor(areaId))) {
      refuse(`Session ${sid} runs in area ${areaId}'s isolated profile; its profile, role, tools, host and engine never change.`);
    }
  } else if (before && hasAreaProfile(after)) {
    refuse(`Session ${sid} was not started in an area, so it can never take an area profile; start a fresh conversation.`);
  }
  if (hasAreaProfile(after) && originOf(after) !== originOf(before)) {
    refuse(`Session ${sid} carries history from another conversation, which an area conversation never does.`);
  }
  const task = after.taskId ? readTask(taskDb, after.taskId) : undefined;
  if (task && areaMarked(task)) {
    const mark = markOf(task);
    const role = roleOf(task);
    if (task.source !== 'local' || !hasAreaProfile(after) || after.profile!.areaRole !== role || !isRouterAreaSession(after, areaFor(mark))) {
      refuse(`Task ${task.id} belongs to router area ${mark || '(none)'}; session ${sid} is not that area's isolated `
        + `${role === 'router' ? 'router' : 'area work'} conversation on this machine.`);
    }
    return;
  }
  if (hasAreaProfile(after)) {
    refuse(task ? `Session ${sid} carries an area profile, but task ${task.id} is not in that area.`
      : `Session ${sid} carries an area profile but no task in that area.`);
  }
}

/** Outside history (an imported transcript, a host's offline adoption) never joins an area. */
export function assertOutsideHistoryImport(record: Pick<SessionRecord, 'claudeSessionId' | 'taskId' | 'profile'>, taskDb: Database): void {
  if (hasAreaProfile(record)) refuse(`Session ${record.claudeSessionId} comes from outside Walnut's own start and cannot carry an area profile.`);
  const task = record.taskId ? readTask(taskDb, record.taskId) : undefined;
  if (task && areaMarked(task)) {
    refuse(`Task ${task.id} belongs to router area ${markOf(task) || '(none)'}; outside session ${record.claudeSessionId} cannot join it.`);
  }
}

// ── Task writes ─────────────────────────────────────────────────────────────

/** Whether a task write can change its area history: its mark or role, or a new session id it names. */
export function taskHistoryWriteNeedsCheck(before: Partial<HistoryTask> | undefined, after: HistoryTask): boolean {
  if (!before) return true;
  const beforeMark = markOf(before);
  if (beforeMark && markOf(after) !== beforeMark) return true;
  if (areaMarked(before) && !areaMarked(after)) return true;
  const had = new Set(namedSessionIds(before));
  if (namedSessionIds(after).some((id) => !had.has(id))) return true;
  if (!areaMarked(after)) return false;
  return markOf(before) !== markOf(after) || !areaMarked(before) || before.org_role !== after.org_role || before.source !== after.source;
}

function readTaskHistory(sessionDb: Database, task: HistoryTask): { records: SessionRecord[]; missing: string[] } {
  try {
    const byId = new Map<string, SessionRecord>();
    const linked = sessionDb.prepare('SELECT * FROM sessions WHERE task_id = ?').all(task.id) as Record<string, any>[];
    for (const row of linked) {
      assertReadablePayload(row.payload);
      byId.set(String(row.claude_session_id), rowToSession(row));
    }
    const one = sessionDb.prepare('SELECT * FROM sessions WHERE claude_session_id = ?');
    const missing: string[] = [];
    for (const id of namedSessionIds(task)) {
      if (byId.has(id)) continue;
      const row = one.get(id) as Record<string, any> | undefined;
      if (row) {
        assertReadablePayload(row.payload);
        byId.set(id, rowToSession(row));
      } else missing.push(id);
    }
    return { records: [...byId.values()], missing };
  } catch (error) {
    unreadable(`Task ${task.id}'s conversations`, error);
  }
}

/** 409 when the mark is cleared or moved, or a marked task keeps a conversation outside its area. */
export function assertTaskHistoryWrite(before: Partial<HistoryTask> | undefined, after: HistoryTask, sessionDb: Database): void {
  if (!taskHistoryWriteNeedsCheck(before, after)) return;
  if (!areaMarked(after) && !areaMarked(before ?? {})) {
    const { records } = readTaskHistory(sessionDb, after);
    if (records.some(hasAreaProfile)) refuse(`Task ${after.id} would attach isolated area history to ordinary work.`);
    return;
  }
  const beforeMark = markOf(before);
  if (beforeMark && markOf(after) !== beforeMark) {
    refuse(`Task ${after.id} belongs to router area ${beforeMark}; its area mark is never cleared or moved to another area.`);
  }
  if (before && areaMarked(before) && !areaMarked(after)) {
    refuse(`Task ${after.id} is a router; clearing its role cannot remove its area boundary.`);
  }
  if (after.source !== 'local') refuse(`Task ${after.id} belongs to a router area and cannot sync its content to an outside service.`);
  if (after.org_role === 'main' || after.org_role === 'lead') refuse(`Task ${after.id} belongs to a router area and cannot become a CEO or VP.`);
  const mark = markOf(after);
  const role = roleOf(after);
  const { records, missing } = readTaskHistory(sessionDb, after);
  const foreign = records
    .filter((r) => r.taskId !== after.id || hasOrigin(r) || !isRouterAreaSession(r, areaFor(mark)))
    .map((r) => r.claudeSessionId);
  const outside = [...foreign, ...missing];
  if (outside.length === 0) return;
  refuse(`Task ${after.id} would join router area ${mark || '(none)'} as ${role === 'router' ? 'its router' : 'area work'} with `
    + `${outside.length === 1 ? 'a conversation' : `${outside.length} conversations`} (${outside.join(', ')}) outside that area's isolated profile, `
    + 'or named but not on record. Use a fresh task with no conversation for this area.');
}
