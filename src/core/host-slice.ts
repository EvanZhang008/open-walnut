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
import type { Task } from './types.js';

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

export async function buildHostSlice(hostKey: string, now = Date.now()): Promise<HostSlice> {
  const key = normalizeHostKey(hostKey);
  const [{ listSessions, isListableSession }, { listTasksByIds }, requests] = await Promise.all([
    import('./session-tracker.js'),
    import('./task-manager.js'),
    import('./session-requests.js'),
  ]);

  const allSessions = await listSessions();
  const records = allSessions
    .filter((s) => !s.archived
      && s.provider !== 'embedded' && s.provider !== 'sdk'
      && normalizeHostKey(s.host) === key
      && now - Date.parse(s.lastActiveAt || s.startedAt || '') < SESSION_RECENCY_MS)
    .sort((a, b) => (b.lastActiveAt || '').localeCompare(a.lastActiveAt || ''))
    .slice(0, MAX_SESSIONS);

  const picked = new Map<string, OfflineSliceTask>();
  const add = (t: Task | undefined): void => {
    if (!t || picked.has(t.id) || picked.size >= MAX_TASKS) return;
    picked.set(t.id, {
      id: t.id,
      title: t.title,
      phase: t.phase,
      project: t.project || '',
      ...(t.group_id ? { group_id: t.group_id } : {}),
      ...(t.parent_task_id ? { parent_task_id: t.parent_task_id } : {}),
      ...(t.description ? { description: clip(t.description, DESCRIPTION_MAX) } : {}),
      ...(t.updated_at ? { updated_at: t.updated_at } : {}),
      ...(t.session_id ? { session_id: t.session_id } : {}),
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

  const body = {
    home: WALNUT_HOME,
    host: displayHost(key),
    sessions: records.map((s) => ({
      sid: s.claudeSessionId,
      ...(s.taskId ? { taskId: s.taskId } : {}),
      ...(s.title ? { title: s.title } : {}),
      // An environment or lane session: never a message's address by name, nor a
      // reply's (session-send-core.ts, reply-routing.ts), so the host leaves those to us.
      ...(isListableSession(s) ? {} : { aside: true }),
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

export function ensureHostSliceSync(): void {
  if (syncStarted) return;
  syncStarted = true;
  void import('./event-bus.js').then(({ bus }) => {
    bus.subscribe('host-slice', () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void import('../providers/daemon-connection.js')
          .then(({ pushHostSliceToAllHosts }) => pushHostSliceToAllHosts())
          .catch((err) => log.session.warn('host slice: re-push failed', { error: err instanceof Error ? err.message : String(err) }));
      }, PUSH_DEBOUNCE_MS);
      timer.unref?.();
    }, { global: true, interest: ['task:', 'session:started', 'session:status-changed', 'session:renamed', 'session-request:', 'board:changed'] });
  });
}
