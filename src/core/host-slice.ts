/**
 * The read copy a host's daemon keeps for when this server is away
 * (docs/plan/daemon-first-hosts.md, `host.slice`).
 *
 * Per host: this Walnut's sessions there, their tasks with parents and
 * children, and the pending reply requests whose asker and target both run
 * there. The daemon answers task_get / task_list / session_list from it, and
 * uses it to deliver same-host task_send while no server is connected. Slim
 * rows only: the copy is for a session reading its own neighbourhood, not a
 * second board.
 */

import { createHash } from 'node:crypto';
import { WALNUT_HOME } from '../constants.js';
import { log } from '../logging/index.js';
import { cutEnd } from './text-cut.js';
import type { HostSlice, OfflineSliceTask } from '../providers/offline-host-core.js';
import type { OfflineSliceBoard } from '../providers/offline-board-core.js';
import type { SessionRecord, Task } from './types.js';
import { isInfraSessionError } from './session-error-kind.js';
import { engineCaps } from './agents/engine-registry.js';
import { instructionNoticeForHost } from './sessions/instruction-notice.js';
import { hostReplyTail } from './hints/hint-send.js';

/** Newest sessions kept per host; the daemon intersects with what it runs. */
const MAX_SESSIONS = 200;
/** Tasks in one copy (session tasks first, then parents, then children). */
const MAX_TASKS = 500;
/** A session silent this long is not worth a row. */
const SESSION_RECENCY_MS = 7 * 24 * 60 * 60 * 1000;
const DESCRIPTION_MAX = 2000;
/** Levels of subtasks below a session's task kept in the copy (the server's own cap is 3). */
const TEAM_DEPTH = 3;
/** Board html in one copy, all boards together; the boards of the newest sessions go first. */
const BOARDS_MAX_CHARS = 4 * 1024 * 1024;
/** Newest messages kept per board thread. */
const THREAD_TAIL = 40;

/**
 * The team Boards of this host's session tasks (offline-board-core.ts): each
 * task's board owner (its own board, else the nearest leader's, else its
 * tree's root, where a first board_set would make one), and the boards that
 * exist among them.
 */
async function teamBoards(sessionTaskIds: string[]): Promise<{ boards: OfflineSliceBoard[]; boardOf: Record<string, string> }> {
  const [{ resolveTeamBoardTask }, { getBoard }] = await Promise.all([
    import('./boards/board-team.js'),
    import('./boards/board-store.js'),
  ]);
  const boardOf: Record<string, string> = {};
  const owners: string[] = [];
  for (const id of sessionTaskIds) {
    try {
      const owner = await resolveTeamBoardTask(id);
      boardOf[id] = owner.taskId;
      if (owner.hasBoard && !owners.includes(owner.taskId)) owners.push(owner.taskId);
    } catch { /* the task is gone */ }
  }
  const boards: OfflineSliceBoard[] = [];
  let chars = 0;
  for (const id of owners) {
    const b = await getBoard(id).catch(() => null);
    if (!b) continue;
    chars += b.html.length;
    if (chars > BOARDS_MAX_CHARS) break;
    boards.push({
      taskId: id,
      html: b.html,
      version: b.version,
      updated_at: b.updated_at,
      updated_by: b.updated_by,
      threads: Object.fromEntries(Object.entries(b.threads ?? {}).map(([k, list]) => [k, list.slice(-THREAD_TAIL)])),
      marks: Object.fromEntries(Object.entries(b.marks ?? {}).map(([k, m]) => [k, { ...(m.state ? { state: m.state } : {}), ...(m.note ? { note: m.note } : {}) }])),
      projects: b.projects as unknown as Record<string, Record<string, unknown>>,
      choices: b.choices as unknown as Record<string, Record<string, unknown>>,
    });
  }
  return { boards, boardOf };
}

/** '__local__', 'local' and '' all mean this machine. */
export function normalizeHostKey(host: string | undefined | null): string {
  return !host || host === 'local' || host === '__local__' ? '__local__' : host;
}

function displayHost(hostKey: string): string {
  return hostKey === '__local__' ? 'local' : hostKey;
}

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, cutEnd(text, max))}…` : text;
}

/**
 * Children of these tasks, straight from SQLite (indexed on parent_task_id).
 * The copy is rebuilt on every task change, so it never materializes the whole
 * board: a cold full read measured 110-390ms of blocked event loop on ~6.5k tasks.
 */
async function childTasks(parentIds: string[]): Promise<Task[]> {
  if (parentIds.length === 0) return [];
  const { getDb, rowToTask } = await import('./task-db.js');
  const db = getDb();
  if (!db) return [];
  const out: Task[] = [];
  for (let i = 0; i < parentIds.length && out.length < MAX_TASKS; i += 500) {
    const chunk = parentIds.slice(i, i + 500);
    const rows = db.prepare(`SELECT * FROM tasks WHERE parent_task_id IN (${chunk.map(() => '?').join(',')}) LIMIT ${MAX_TASKS}`)
      .all(...chunk) as Record<string, unknown>[];
    for (const row of rows) out.push(rowToTask(row));
  }
  return out;
}

/**
 * Whether the session executor would resume this session for a trigger fire
 * (routines/session-target.ts): a Claude Code session that is stopped, or whose
 * error the infrastructure caused (the fire proves its host is up). An error of
 * the session's own making, and another agent's engine, never.
 */
function resumableForTrigger(s: SessionRecord): boolean {
  // The host replays the session's own CLI command with --resume: native runtimes only.
  if (engineCaps(s.engine).runtimeKind !== 'native') return false;
  if (s.provider && s.provider !== 'cli') return false;
  if (s.process_status === 'error') return isInfraSessionError(s);
  return true;
}

/** The queueable scalar fields a host copy carries. */
const SLICE_SCALARS = ['status', 'priority', 'due_date', 'start_date', 'end_date', 'sprint', 'focus_tier', 'wait_until'] as const;

/**
 * Every one is shipped, an unset one as its empty value: the host takes a field the copy
 * lacks as base 'unknown' (offline-host-core.ts taskFieldsRecord), so "no clock" must be
 * '' in the copy for an away park to carry a known base. pin_order is shipped when set.
 */
function sliceFields(t: Task): Partial<OfflineSliceTask> {
  const out: Record<string, unknown> = {};
  for (const f of SLICE_SCALARS) out[f] = typeof t[f] === 'string' ? t[f] : '';
  out.pinned = t.pinned === true;
  out.unread = t.unread === true;
  if (typeof t.pin_order === 'number' && Number.isFinite(t.pin_order)) out.pin_order = t.pin_order;
  out.tags = Array.isArray(t.tags) ? [...t.tags] : [];
  out.depends_on = Array.isArray(t.depends_on) ? [...t.depends_on] : [];
  if (t.field_at && Object.keys(t.field_at).length) out.field_at = { ...t.field_at };
  return out as Partial<OfflineSliceTask>;
}

/** Whether its host's copy lists this session (before the MAX_SESSIONS cap). */
function inHostCopy(s: SessionRecord, now: number): boolean {
  return !s.archived
    && s.provider !== 'embedded' && s.provider !== 'sdk'
    && now - Date.parse(s.lastActiveAt || s.startedAt || '') < SESSION_RECENCY_MS;
}

export async function buildHostSlice(hostKey: string, now = Date.now()): Promise<HostSlice> {
  const key = normalizeHostKey(hostKey);
  const [{ listSessions, isListableSession }, { listTasksByIds }, requests] = await Promise.all([
    import('./session-tracker.js'),
    import('./task-manager.js'),
    import('./session-requests.js'),
  ]);

  const allSessions = await listSessions();
  const records = allSessions
    .filter((s) => inHostCopy(s, now) && normalizeHostKey(s.host) === key)
    .sort((a, b) => (b.lastActiveAt || '').localeCompare(a.lastActiveAt || ''))
    .slice(0, MAX_SESSIONS);

  const picked = new Map<string, OfflineSliceTask>();
  const leads: Task[] = [];
  const add = (t: Task | undefined): void => {
    if (!t || picked.has(t.id) || picked.size >= MAX_TASKS) return;
    if (t.org_role === 'lead') leads.push(t);
    picked.set(t.id, {
      id: t.id,
      title: t.title,
      phase: t.phase,
      project: t.project || '',
      // An empty folder, parent or description is shipped as '': a field the copy lacks is
      // queued with base 'unknown', and an away write on it is then judged by time alone
      // (no merge, no conflict entry when it wins over a Mac edit made after this copy).
      group_id: t.group_id || '',
      parent_task_id: t.parent_task_id || '',
      description: t.description ? clip(t.description, DESCRIPTION_MAX) : '',
      ...(t.updated_at ? { updated_at: t.updated_at } : {}),
      // The other queueable fields and their per-field times (journal v2, section 7): an
      // away write's base is then the value the host showed, never 'unknown'. The long
      // texts (summary, note) stay out: a clipped copy would be a wrong base, and a
      // session's write cannot name them.
      ...sliceFields(t),
      // The session a message to the task goes to, as the server picks it (session-send-core.ts).
      ...((t.session_id || t.exec_session_id) ? { session_id: t.session_id || t.exec_session_id } : {}),
    });
  };
  // Session tasks first (newest session first), then their parents, then the
  // team around them: their subtasks (down to MAX_SUBTASK_DEPTH below), and
  // their parents' other subtasks, so a leader and its workers read each other.
  const sessionTaskIds = [...new Set(records.map((s) => s.taskId).filter((id): id is string => !!id))];
  const own = new Map((await listTasksByIds(sessionTaskIds)).map((t) => [t.id, t]));
  for (const id of sessionTaskIds) add(own.get(id));
  const parentIds = [...new Set([...own.values()].map((t) => t.parent_task_id).filter((id): id is string => !!id && !own.has(id)))];
  for (const t of await listTasksByIds(parentIds)) add(t);
  let level = sessionTaskIds;
  for (let depth = 0; depth < TEAM_DEPTH && level.length > 0 && picked.size < MAX_TASKS; depth++) {
    const next: string[] = [];
    for (const t of await childTasks(level)) {
      if (!picked.has(t.id)) next.push(t.id);
      add(t);
    }
    level = next;
  }
  for (const t of await childTasks(parentIds)) add(t);
  // A lead that handed its project over: the host refuses a session's message to it with the
  // lead that took over, as the server does (org/retired-lead.ts).
  if (leads.length > 0) {
    const [{ listTasks }, { successorOf }] = await Promise.all([import('./task-manager.js'), import('./org/org-tree.js')]);
    const all = await listTasks();
    for (const t of leads) {
      const now = successorOf(all, t);
      const row = picked.get(t.id);
      if (now && row) row.handed_over_to = { id: now.id, title: now.title, ...(now.phase ? { phase: now.phase } : {}) };
    }
  }

  // Pending requests with a party here. One whose other party runs elsewhere
  // names that host, so an answer can travel through the leader while this
  // server is away (docs/plan/walnut-control-plane.md).
  const sids = new Set(records.map((s) => s.claudeSessionId));
  const hostOf = new Map(allSessions.map((s) => [s.claudeSessionId, displayHost(normalizeHostKey(s.host))]));
  const pending = (await requests.listPendingRequests())
    .filter((r) => sids.has(r.fromSessionId) || (!!r.toSessionId && sids.has(r.toSessionId)))
    .map((r) => {
      const fromHost = sids.has(r.fromSessionId) ? undefined : hostOf.get(r.fromSessionId);
      const toHost = !r.toSessionId || sids.has(r.toSessionId) ? undefined : hostOf.get(r.toSessionId);
      return {
        id: r.id, fromSessionId: r.fromSessionId, toSessionId: r.toSessionId,
        ...(r.toTaskId ? { toTaskId: r.toTaskId } : {}),
        preview: r.preview, status: 'pending' as const, createdAt: r.createdAt, deadlineAt: r.deadlineAt,
        ...(fromHost ? { fromHost } : {}),
        ...(toHost ? { toHost } : {}),
      };
    });

  const { boards, boardOf } = await teamBoards(sessionTaskIds);
  // What the queue would append to a turn nobody typed; the host appends it to what it delivers itself.
  const config = await (await import('./config-manager.js')).getConfig().catch(() => null);

  const body = {
    home: WALNUT_HOME,
    host: displayHost(key),
    sessions: records.map((s) => ({
      sid: s.claudeSessionId,
      ...(() => {
        const task = s.taskId ? own.get(s.taskId) : undefined;
        // Only while due: the host adds it once and journals it as told.
        const routing = task ? instructionNoticeForHost(s, task) : null;
        return routing ? { taskRoutingPolicy: routing.policy, taskRoutingDue: routing.due } : {};
      })(),
      ...(() => {
        let tail: string | null = null;
        try { tail = hostReplyTail(s, config, s.taskId ? own.get(s.taskId) : undefined); } catch { tail = null; }
        return tail ? { replyTail: tail } : {};
      })(),
      ...(s.taskId ? { taskId: s.taskId } : {}),
      ...(s.title ? { title: s.title } : {}),
      // An environment or lane session: never a message's address by name, nor a
      // reply's (session-send-core.ts, reply-routing.ts), so the host leaves those to us.
      ...(isListableSession(s) ? {} : { aside: true }),
      // The host resumes a stopped session for a trigger fire only where we would.
      ...(resumableForTrigger(s) ? {} : { noResume: true }),
    })),
    tasks: [...picked.values()],
    requests: pending,
    boards,
    boardOf,
  };
  const hash = createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 16);
  return { v: 1, ...body, hash, asOf: now };
}

// ── keep the copy fresh: re-push on task/session/request changes ──

let syncStarted = false;
let timer: ReturnType<typeof setTimeout> | null = null;
/** Coalesce a burst (a task_update fires several events) into one push per host. */
const PUSH_DEBOUNCE_MS = 3_000;
/** Sessions a status change already checked, so one no copy lists (past its cap, say) costs one look, not one per change. */
const checkedForStatus = new Set<string>();

/**
 * A session's host learns about it at once, not after the debounce: the host answers
 * the session's `walnut` calls while this server is away only once its copy names the
 * session, and the Mac may go away right after the start (2026-10-23, tests/fleet).
 * A start that knows its session's id (task start, quick start, a lane, a rewind)
 * writes the record, host and task included, before `session:started`, and an ACP
 * start writes it on establish, before the event too, so the copy pushed then names
 * them. A CLI start without an id writes the record at the CLI's init line; the
 * session's first `session:status-changed` follows that write and pushes while no
 * copy names the session yet.
 */
async function pushStartingSession(event: { name: string; data: unknown }): Promise<void> {
  const d = (event.data ?? {}) as { sessionId?: string; claudeSessionId?: string; host?: string };
  const sid = d.claudeSessionId || d.sessionId;
  const started = event.name === 'session:started';
  if (!started && (!sid || checkedForStatus.has(sid))) return;
  const [{ getSessionByClaudeId }, { pushHostSliceToHost, hostSliceNamesSession }] = await Promise.all([
    import('./session-tracker.js'),
    import('../providers/daemon-connection.js'),
  ]);
  if (started) {
    // A CLI start names its host (none: this machine) and no id; an ACP start only its id.
    const host = d.host ?? (sid ? (await getSessionByClaudeId(sid))?.host : undefined);
    pushHostSliceToHost(normalizeHostKey(host));
    return;
  }
  if (!sid || hostSliceNamesSession(sid)) return;
  if (checkedForStatus.size >= 2_000) checkedForStatus.clear();
  checkedForStatus.add(sid);
  const record = await getSessionByClaudeId(sid);
  if (record && inHostCopy(record, Date.now())) pushHostSliceToHost(normalizeHostKey(record.host));
}

export function ensureHostSliceSync(): void {
  if (syncStarted) return;
  syncStarted = true;
  void import('./event-bus.js').then(({ bus }) => {
    bus.subscribe('host-slice', (event) => {
      if (event.name === 'session:started' || event.name === 'session:status-changed') {
        void pushStartingSession(event).catch((err) => log.session.warn('host slice: push for a starting session failed', { error: err instanceof Error ? err.message : String(err) }));
      }
      // The rest of the burst (the task's link, its phase) still rides the debounce.
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void import('../providers/daemon-connection.js')
          .then(({ pushHostSliceToAllHosts }) => pushHostSliceToAllHosts())
          .catch((err) => log.session.warn('host slice: re-push failed', { error: err instanceof Error ? err.message : String(err) }));
      }, PUSH_DEBOUNCE_MS);
      timer.unref?.();
    // config:changed: the every-message hints each session's replyTail carries.
    }, { global: true, interest: ['task:', 'session:started', 'session:status-changed', 'session:renamed', 'session-request:', 'board:changed', 'config:changed'] });
  });
}
