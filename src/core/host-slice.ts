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
 *
 * A task kept local never rides it (replication/host-private.ts, the one filter of every
 * host copy): not its row, its Board, nor a request of its own, unless a session of the
 * task runs on this host (its CLI and transcript are there anyway).
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
import { hostNoticeActive, instructionNoticeForHost } from './sessions/instruction-notice.js';
import { noticeDelivering, noticeInFlight } from './sessions/instruction-notice-flight.js';
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
async function teamBoards(sessionTaskIds: string[], boardKept: (taskId: string) => boolean): Promise<{ boards: OfflineSliceBoard[]; boardOf: Record<string, string> }> {
  const [{ resolveTeamBoardTask }, { getBoardView }] = await Promise.all([
    import('./boards/board-team.js'),
    import('./boards/board-store.js'),
  ]);
  const boardOf: Record<string, string> = {};
  const owners: string[] = [];
  for (const id of sessionTaskIds) {
    try {
      const owner = await resolveTeamBoardTask(id);
      // A board of a task kept local is no board this host holds (BOARDS_KIND.owners).
      if (boardKept(owner.taskId)) continue;
      boardOf[id] = owner.taskId;
      if (owner.hasBoard && !owners.includes(owner.taskId)) owners.push(owner.taskId);
    } catch { /* the task is gone */ }
  }
  const boards: OfflineSliceBoard[] = [];
  let chars = 0;
  for (const id of owners) {
    const b = await getBoardView(id).catch(() => null);
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

/**
 * A session's row with its spawn prompt, per row: the store replaces a row on every write and
 * never edits one, so the same row object has the same prompt. Every build read each active
 * session's whole row from SQLite again (2026-11-25: a third of a build's loop CPU in a
 * production-sized home), and builds run every few seconds for every connected host.
 */
const heavyRows = new WeakMap<SessionRecord, SessionRecord>();
function heavyOf(row: SessionRecord, read: (r: SessionRecord) => SessionRecord): SessionRecord {
  let heavy = heavyRows.get(row);
  if (!heavy) heavyRows.set(row, heavy = read(row));
  return heavy;
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
 * Children of these tasks, from the store's own rows (read only, never copied). The copy is
 * rebuilt on every task change for every connected host: SQLite reads here parsed every child
 * row again per build (2026-11-24: about a tenth of the server's CPU in a memory burst after a
 * restart), and a whole-board copy was worse (a cold full read measured 110-390 ms).
 */
function childTasks(byParent: ReadonlyMap<string, readonly Task[]>, parentIds: readonly string[]): Task[] {
  const out: Task[] = [];
  for (const id of parentIds) {
    for (const t of byParent.get(id) ?? []) {
      if (out.length >= MAX_TASKS) return out;
      out.push(t);
    }
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

/**
 * What a host's copy says of a session beside its id, ONE rule for the copy this server sends
 * the host (below) and the host's own server reading its copies (replica/away-trigger-delivery.ts).
 * `listable` is session-tracker.ts isListableSession(s).
 */
export function hostSessionFlags(s: SessionRecord, listable: boolean): { aside?: boolean; noResume?: boolean; acp?: boolean } {
  return {
    // An environment or lane session: never a message's address by name, nor a
    // reply's (session-send-core.ts, reply-routing.ts), so the host leaves those to us.
    ...(listable ? {} : { aside: true }),
    // The host resumes a stopped session for a trigger fire only where we would.
    ...(resumableForTrigger(s) ? {} : { noResume: true }),
    // An ACP session runs in the server's ACP worker, never a CLI of this host's registry: a
    // message to it is the server's to deliver (2026-11-10: a stray Claude CLI on a Codex id took one).
    ...(engineCaps(s.engine).runtimeKind === 'native' ? {} : { acp: true }),
  };
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
export function inHostCopy(s: SessionRecord, now: number): boolean {
  return !s.archived
    && s.provider !== 'embedded' && s.provider !== 'sdk'
    && now - Date.parse(s.lastActiveAt || s.startedAt || '') < SESSION_RECENCY_MS;
}

/**
 * `hostKey`: one alias, or every alias of one daemon (daemon-twins.ts), the name it goes by first.
 * The daemon keeps one copy per Walnut, so the copy of a daemon reached by several aliases holds
 * all of their sessions, and every link to it sends the same one.
 */
export async function buildHostSlice(hostKey: string | readonly string[], now = Date.now()): Promise<HostSlice> {
  const list = (typeof hostKey === 'string' ? [hostKey] : hostKey).map(normalizeHostKey);
  const keys = new Set(list);
  const [{ sessionRowsForReplica, isListableSession, withPromptFields }, { taskStoreSnapshot }, { tasksByIdOf, tasksByParentOf }, requests] = await Promise.all([
    import('./session-tracker.js'),
    import('./task-manager.js'),
    import('./same-ask-tree.js'),
    import('./session-requests.js'),
  ]);

  // The store's own rows, read only (a write replaces a row, never edits it): the slice keeps a
  // few hundred of about 7.5k, and a copy of every row per build was 830 whole-table copies in ten
  // minutes after a restart (2026-11-24, the sessionCopiesBy note), most of the server's garbage.
  const allSessions = await sessionRowsForReplica();
  // A notice the server already has on its way into a session: the host must not add a second.
  const { getStore } = await import('./session-queue-store.js');
  const queues = (await getStore()).queues;
  // The host first: a string test, where inHostCopy parses a date for each of ~7.5k rows.
  const records = allSessions
    .filter((s) => keys.has(normalizeHostKey(s.host)) && inHostCopy(s, now))
    .sort((a, b) => (b.lastActiveAt || '').localeCompare(a.lastActiveAt || ''))
    .slice(0, MAX_SESSIONS);

  const sessionTaskIds = [...new Set(records.map((s) => s.taskId).filter((id): id is string => !!id))];
  // What this host never holds (host-private.ts): a task kept local and everything of it, unless
  // a session of that task runs here.
  const [{ keptOffHostNow, ownedRowKept }, { BOARDS_KIND }, { REQUESTS_KIND }] = await Promise.all([
    import('./replication/host-private.js'),
    import('./replication/kinds/boards.js'),
    import('./replication/kinds/requests.js'),
  ]);
  const { privacy, keptOff } = await keptOffHostNow(list, { sessions: allSessions, now });

  const picked = new Map<string, OfflineSliceTask>();
  const leads: Task[] = [];
  const add = (t: Task | undefined): void => {
    if (!t || picked.has(t.id) || picked.size >= MAX_TASKS || keptOff(t.id)) return;
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
      // A lead's reply deadline differs (send-rules.ts replyKindOf): the daemon's offline send reads it.
      ...(t.org_role ? { org_role: t.org_role } : {}),
    });
  };
  // Session tasks first (newest session first), then their parents, then the
  // team around them: their subtasks (down to MAX_SUBTASK_DEPTH below), and
  // their parents' other subtasks, so a leader and its workers read each other.
  // The store's rows, read only (a write replaces a row, never edits it), indexed once per change.
  const board = await taskStoreSnapshot();
  const byId = tasksByIdOf(board);
  const byParent = tasksByParentOf(board);
  const byIds = (ids: readonly string[]): Task[] => ids.map((id) => byId.get(id)).filter((t): t is Task => !!t);
  const own = new Map(byIds(sessionTaskIds).map((t) => [t.id, t]));
  for (const id of sessionTaskIds) add(own.get(id));
  const parentIds = [...new Set([...own.values()].map((t) => t.parent_task_id).filter((id): id is string => !!id && !own.has(id)))];
  for (const t of byIds(parentIds)) add(t);
  let level = sessionTaskIds;
  for (let depth = 0; depth < TEAM_DEPTH && level.length > 0 && picked.size < MAX_TASKS; depth++) {
    const next: string[] = [];
    for (const t of childTasks(byParent, level)) {
      if (!picked.has(t.id)) next.push(t.id);
      add(t);
    }
    level = next;
  }
  for (const t of childTasks(byParent, parentIds)) add(t);
  // A lead that handed its project over: the host refuses a session's message to it with the
  // lead that took over, as the server does (org/retired-lead.ts).
  if (leads.length > 0) {
    const { successorOf } = await import('./org/org-tree.js');
    for (const t of leads) {
      const now = successorOf(board, t);
      const row = picked.get(t.id);
      if (now && row && !keptOff(now.id)) row.handed_over_to = { id: now.id, title: now.title, ...(now.phase ? { phase: now.phase } : {}) };
    }
  }

  // Pending requests with a party here. One whose other party runs elsewhere
  // names that host, so an answer can travel through the leader while this
  // server is away (docs/plan/walnut-control-plane.md).
  const sids = new Set(records.map((s) => s.claudeSessionId));
  const hostOf = new Map(allSessions.map((s) => [s.claudeSessionId, displayHost(normalizeHostKey(s.host))]));
  const pending = (await requests.listPendingRequests())
    .filter((r) => sids.has(r.fromSessionId) || (!!r.toSessionId && sids.has(r.toSessionId)))
    // One of a task kept local, the same rule as its copy kind (REQUESTS_KIND.owners), whichever
    // host its sessions run on: only the task's row and its sessions ride along for its own session.
    .filter((r) => !ownedRowKept(REQUESTS_KIND, r, privacy))
    .map((r) => {
      const fromHost = sids.has(r.fromSessionId) ? undefined : hostOf.get(r.fromSessionId);
      const toHost = !r.toSessionId || sids.has(r.toSessionId) ? undefined : hostOf.get(r.toSessionId);
      return {
        id: r.id, fromSessionId: r.fromSessionId, toSessionId: r.toSessionId,
        ...(r.toTaskId ? { toTaskId: r.toTaskId } : {}),
        preview: r.preview, status: 'pending' as const, createdAt: r.createdAt, deadlineAt: r.deadlineAt,
        ...(fromHost ? { fromHost } : {}),
        ...(toHost ? { toHost } : {}),
        // Its answer may go past its asker (sessions/reply-handoff.ts): only the server can tell.
        ...(r.carries?.length ? { carries: true as const } : {}),
      };
    });

  const { boards, boardOf } = await teamBoards(sessionTaskIds, (id) => ownedRowKept(BOARDS_KIND, { task_id: id } as Parameters<typeof BOARDS_KIND.key>[0], privacy));
  // What the queue would append to a turn nobody typed; the host appends it to what it delivers itself.
  const config = await (await import('./config-manager.js')).getConfig().catch(() => null);
  // The instruction notice below compares against the user's profile as on disk now.
  await (await import('./sessions/prompt-inputs.js')).refreshPromptInputs();

  const body = {
    home: WALNUT_HOME,
    host: displayHost(list[0] ?? '__local__'),
    sessions: records.map((s) => ({
      sid: s.claudeSessionId,
      ...(() => {
        const task = s.taskId ? own.get(s.taskId) : undefined;
        // Only while due: the host adds it once and journals it as told.
        const sid = s.claudeSessionId;
        const busy = noticeDelivering(sid) || noticeInFlight(queues[sid] ?? []);
        // The notice reads the spawn prompt, which no listed row holds (withPromptFields reads it).
        // Its spawn prompt is a SQLite read and parse: only for a session that may take the notice.
        const routing = task && !busy && hostNoticeActive(s, now) ? instructionNoticeForHost(heavyOf(s, withPromptFields), task, now) : null;
        return routing ? { taskRoutingPolicy: routing.policy, taskRoutingDue: routing.due } : {};
      })(),
      ...(() => {
        let tail: string | null = null;
        try { tail = hostReplyTail(s, config, s.taskId ? own.get(s.taskId) : undefined); } catch { tail = null; }
        return tail ? { replyTail: tail } : {};
      })(),
      ...(s.taskId ? { taskId: s.taskId } : {}),
      ...(s.title ? { title: s.title } : {}),
      // An ACP session's `walnut` names itself by its worker's runtime id (acp-caller-sid.ts).
      ...(s.acpRuntimeId && s.acpRuntimeId !== s.claudeSessionId ? { runtimeId: s.acpRuntimeId } : {}),
      ...hostSessionFlags(s, isListableSession(s)),
    })),
    tasks: [...picked.values()],
    requests: pending,
    boards,
    boardOf,
  };
  const bodyJson = JSON.stringify(body);
  const hash = createHash('sha1').update(bodyJson).digest('hex').slice(0, 16);
  const slice: HostSlice = { v: 1, ...body, hash, asOf: now };
  // The wire text of this very object, from the text the hash already read (key order: v, the
  // body's keys, hash, asOf, as JSON.stringify(slice) writes them).
  sliceJson.set(slice, `{"v":1,${bodyJson.slice(1, -1)},"hash":${JSON.stringify(hash)},"asOf":${JSON.stringify(now)}}`);
  return slice;
}

/**
 * The slice as JSON: what the push sends and paces by. A copy is about 0.5 to 0.9 MB, and a
 * push wrote it out once for the hash and again for the send (2026-11-25: stringify was a sixth
 * of buildHostSlice's loop CPU in the live server's stall profiles).
 */
const sliceJson = new WeakMap<object, string>();
export function hostSliceJson(slice: HostSlice): string {
  return sliceJson.get(slice) ?? JSON.stringify(slice);
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
    // config:changed: the hints each session's replyTail carries.
    }, { global: true, interest: ['task:', 'session:started', 'session:status-changed', 'session:renamed', 'session-request:', 'board:changed', 'config:changed'] });
  });
}
