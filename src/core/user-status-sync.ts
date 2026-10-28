/**
 * Keeps `task.user_status` (src/core/user-status.ts) current on the leader, so every surface
 * (web REST and WS, the iOS v1 projection, the Org page, the Board) reads ONE stored value
 * instead of each deriving its own from the phase (2026-10-25: the same team read "0 needs
 * you" on a Board tile, "1 needs you" on a section and "11 handed back" on the Org page).
 *
 * The facts live in several stores, none keyed by task: the session records (running, a
 * prompt, an error), the inbox (an unanswered action_required letter), the Boards (an
 * unanswered choice), the reply requests and the triggers. A pass reads each store ONCE and
 * derives every open task it was asked about; a write happens only when the derived value
 * changed, through updateTaskRaw (one row, no sync push), so it never loops: its own
 * task:updated carries source 'user-status' and is ignored here.
 *
 * Passes run on the events that move a status (a task write, a session status or prompt,
 * a letter, a Board, a trigger), debounced, and on a minute sweep that catches what has no
 * event (a reply request opening or settling, a clock passing, words turning a day old).
 *
 * The Mac derives (boot-policy row 'user-status'); a replica reads the rows it copies, so
 * while the Mac is away the stored statuses stay as it left them until it is back.
 */
import { bus, EventNames } from './event-bus.js';
import { log } from '../logging/index.js';
import { bootPolicy } from './boot-policy.js';
import { deriveUserStatus, type UserStatus, type UserStatusInput } from './user-status.js';
import { isReportPending, onReportPendingChange } from './sessions/report-pending.js';
import type { Task } from './types.js';

const SUBSCRIBER = 'user-status-sync';
const OWN_SOURCE = 'user-status';
const DEBOUNCE_MS = 1_500;
const SWEEP_MS = 60_000;
/** After start, when the lost turn-end reports are asked for again (sessions attach first). */
const MISSED_REPORTS_DELAY_MS = 45_000;
let missedReportsTimer: ReturnType<typeof setTimeout> | null = null;
/** Emitted by human-inbox/letter-ops.ts when a letter is answered (or withdrawn). */
const LETTER_ANSWERED = 'human-inbox:answered';
/** Emitted by human-inbox/store.ts setLetterState: a letter read, archived or pinned. */
const LETTER_STATE = 'human-inbox:state';

let dirty = new Set<string>();
let all = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let sweep: ReturnType<typeof setInterval> | null = null;
let running: Promise<void> | null = null;
let live = false;

/** The facts every task in one pass is derived from, each store read once. */
export interface StatusFacts {
  /** Per session id: what its record says. */
  sessions: Map<string, {
    processStatus?: string; errorMessage?: string; errorReason?: string; statusSince?: string;
    errorKind?: string; restartLoss?: { state: string; cause?: string };
    pendingTool?: string; taskId?: string; archived?: boolean; startedAt?: string;
  }>;
  /** Task id -> subject of its newest unanswered action_required letter. */
  letters: Map<string, string>;
  /** Task id -> title of an unanswered Board choice about it. */
  choices: Map<string, string>;
  /** Session id -> target task ids it waits on for a reply. */
  requestsFrom: Map<string, string[]>;
  /** Task id -> names of armed triggers that deliver into it. */
  triggers: Map<string, string[]>;
  /** Task id -> enabled scheduled routines that run in its session, with their next run. */
  schedules: Map<string, { name: string; nextAt?: string }[]>;
  /** Task id -> title, for naming the tasks a reply is awaited from. */
  titles: Map<string, string>;
  /** Task id -> the ids of the sessions linked to it (its slot, its history, records naming it). */
  sessionsOf: Map<string, string[]>;
  /** Task id -> how many of its direct subtasks are open (filled by syncUserStatuses). */
  openWorkers?: Map<string, number>;
  /** Project keys (trimmed, lower case) that have an open lead (filled by syncUserStatuses). */
  projectLeads?: Set<string>;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function safely<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch (err) {
    log.task.debug('user-status: a fact source was unreadable, deriving without it', { source: what, error: errText(err) });
    return fallback;
  }
}

type SlowSource = 'letters' | 'choices' | 'triggers' | 'schedules';

/**
 * The sources that cost a lock or a parse of every Board (the inbox index, the Boards, the
 * cron store), kept between passes and dropped on their own events and on every sweep. The
 * session records and the reply requests are read on every pass: they move with each turn.
 */
const slow: Partial<Record<SlowSource, Map<string, any>>> = {};

function dropSlow(...kinds: SlowSource[]): void {
  for (const k of kinds.length ? kinds : (['letters', 'choices', 'triggers', 'schedules'] as const)) delete slow[k];
  if (!kinds.length) boardChoices.clear();
}

/** Per Board owner: its unanswered choices, so one Board's write re-reads that Board alone. */
const boardChoices = new Map<string, { ref?: string; title: string }[]>();

async function cachedSlow<K extends SlowSource>(kind: K, allIds: readonly string[]): Promise<StatusFacts[K]> {
  const hit = slow[kind];
  if (hit) return hit as StatusFacts[K];
  const built = kind === 'letters' ? await readLetters()
    : kind === 'choices' ? await readChoices(allIds)
    : await readRoutines(kind === 'schedules');
  slow[kind] = built;
  return built as StatusFacts[K];
}

async function readLetters(): Promise<StatusFacts['letters']> {
  const out: StatusFacts['letters'] = new Map();
  await safely('inbox', async () => {
    const { listLetters } = await import('./human-inbox/store.js');
    const { letters: list } = await listLetters({ archived: false });
    // Oldest first, so the newest letter of a task is the one kept.
    const now = Date.now();
    for (const l of [...list].sort((a, b) => a.createdAt - b.createdAt)) {
      const tid = l.sender?.taskId;
      if (l.type !== 'action_required' || l.answered || l.archived || !tid) continue;
      if (l.read && !(typeof l.readAt === 'number' && now < l.readAt + DECISION_SEEN_GRACE_MS)) continue;
      out.set(tid, l.subject);
    }
  }, undefined);
  return out;
}

async function readChoices(allIds: readonly string[]): Promise<StatusFacts['choices']> {
  const out: StatusFacts['choices'] = new Map();
  await safely('boards', async () => {
    const { listBoardTaskIds, getBoard } = await import('./boards/board-store.js');
    const { choiceSpecs } = await import('./boards/board-html.js');
    const { resolveChoiceRef } = await import('./boards/open-choice.js');
    for (const owner of await listBoardTaskIds()) {
      let open = boardChoices.get(owner);
      if (!open) {
        open = [];
        const board = await getBoard(owner).catch(() => null);
        for (const [id, spec] of Object.entries(board?.html ? choiceSpecs(board.html) : {})) {
          if (board?.choices?.[id]) continue; // answered
          open.push({ ref: spec.task?.trim() || undefined, title: spec.title?.trim() || 'Answer the choice on its Board.' });
        }
        boardChoices.set(owner, open);
      }
      for (const c of open) {
        // A choice names its task by id or an unambiguous id prefix (4+ characters, as
        // board-v1 resolves refs); one that names none is the owner's. The Org page's Answer
        // finds it by the same rule (boards/open-choice.ts).
        const tid = c.ref ? resolveChoiceRef(c.ref, allIds) : owner;
        if (tid && !out.has(tid)) out.set(tid, c.title);
      }
    }
  }, undefined);
  return out;
}

/** The routines that run in a task's session: armed triggers (a check), or plain scheduled runs. */
async function readRoutines(schedules: boolean): Promise<Map<string, any>> {
  const out = new Map<string, any[]>();
  await safely('triggers', async () => {
    const { listRoutines } = await import('./routines/routines-core.js');
    const { triggerRunState } = await import('./cron/trigger-run-state.js');
    const { jobs } = await listRoutines(true);
    for (const job of jobs as import('./cron/types.js').CronJob[]) {
      const target = (job.executor?.config as { target?: unknown } | undefined)?.target;
      if (job.executor?.type !== 'session' || typeof target !== 'string' || !job.enabled) continue;
      const list = out.get(target) ?? [];
      if (schedules && !job.check) {
        const next = job.state?.nextRunAtMs;
        list.push({ name: job.name, ...(typeof next === 'number' ? { nextAt: new Date(next).toISOString() } : {}) });
      } else if (!schedules && job.check && triggerRunState(job) === 'armed') {
        list.push(job.name);
      } else continue;
      out.set(target, list);
    }
  }, undefined);
  return out;
}

/** An inbox decision still asks the user: the inbox's own rule (web/src/api/human-inbox.ts
 *  isOpenDecision), so a letter read and left for five minutes stops saying "Needs you" there and here. */
const DECISION_SEEN_GRACE_MS = 5 * 60 * 1000;

/**
 * A restart loss that speaks for the session's CURRENT death, else undefined: one recovery still
 * holds (queued, sent: the same test the hand-back uses, holdsHandBack), or one it gave up on
 * with no status change since. A loss stays on the record after it is decided, so an older one
 * must never paint a later life (a manual resume that failed for its own reasons).
 */
export function liveRestartLoss(
  rec: import('./types.js').SessionRecord,
  recovery: { holdsHandBack(record: import('./types.js').SessionRecord): boolean } | null | undefined,
): { state: string; cause?: string } | undefined {
  const loss = rec.restartLoss;
  if (!loss) return undefined;
  if (loss.state === 'gave_up') return loss.revision === rec.statusRevision ? { state: loss.state, cause: loss.cause } : undefined;
  if ((loss.state === 'queued' || loss.state === 'sent') && recovery?.holdsHandBack(rec)) return { state: loss.state, cause: loss.cause };
  return undefined;
}

/** Read every fact source (the slow ones from the cache). Never throws: a store that cannot be
 *  read contributes nothing. `allIds` resolves a Board choice's task prefix. */
export async function readStatusFacts(tasks: readonly Task[], allIds: readonly string[] = tasks.map((t) => t.id)): Promise<StatusFacts> {
  const taskIds = new Set(tasks.map((t) => t.id));
  const sessionIds = new Set<string>();
  for (const t of tasks) {
    if (t.session_id) sessionIds.add(t.session_id);
    for (const sid of t.session_ids ?? []) sessionIds.add(sid);
  }

  const sessions: StatusFacts['sessions'] = new Map();
  const { getSessionAutoRecover } = await import('./session-auto-recover.js');
  const recovery = getSessionAutoRecover();
  await safely('sessions', async () => {
    const { listSessionsForTasks } = await import('./session-tracker.js');
    for (const rec of await listSessionsForTasks(taskIds, sessionIds)) {
      if (rec.provider === 'embedded') continue;
      sessions.set(rec.claudeSessionId, {
        processStatus: rec.process_status, errorMessage: rec.errorMessage,
        errorReason: rec.status_reason, statusSince: rec.statusUpdatedAt || rec.last_status_change || rec.lastActiveAt,
        errorKind: rec.errorKind,
        restartLoss: liveRestartLoss(rec, recovery),
        pendingTool: rec.pendingPermission ? (rec.pendingPermission.toolName ?? 'permission') : undefined,
        taskId: rec.taskId, archived: rec.archived, startedAt: rec.startedAt,
      });
    }
  }, undefined);

  const letters = await cachedSlow('letters', allIds);
  const choices = await cachedSlow('choices', allIds);

  const requestsFrom: StatusFacts['requestsFrom'] = new Map();
  await safely('requests', async () => {
    const { listPendingRequests } = await import('./session-requests.js');
    for (const r of await listPendingRequests()) {
      if (!r.toTaskId) continue;
      const list = requestsFrom.get(r.fromSessionId) ?? [];
      list.push(r.toTaskId);
      requestsFrom.set(r.fromSessionId, list);
    }
  }, undefined);

  const triggers = await cachedSlow('triggers', allIds);
  const schedules = await cachedSlow('schedules', allIds);

  const titles = new Map(tasks.map((t) => [t.id, t.title] as const));
  const sessionsOf: StatusFacts['sessionsOf'] = new Map();
  const link = (tid: string, sid: string) => {
    const list = sessionsOf.get(tid) ?? [];
    if (!list.includes(sid)) list.push(sid);
    sessionsOf.set(tid, list);
  };
  for (const t of tasks) {
    if (t.session_id) link(t.id, t.session_id);
    for (const sid of t.session_ids ?? []) link(t.id, sid);
  }
  for (const [sid, s] of sessions) if (s.taskId && taskIds.has(s.taskId)) link(s.taskId, sid);
  return { sessions, letters, choices, requestsFrom, triggers, schedules, titles, sessionsOf };
}

/** The input deriveUserStatus takes for one task, from the facts. Exported for tests. */
export function statusInputOf(task: Task, facts: StatusFacts): UserStatusInput {
  const own = (facts.sessionsOf.get(task.id) ?? [])
    .map((sid) => [sid, facts.sessions.get(sid)] as const)
    .filter((e): e is readonly [string, NonNullable<ReturnType<typeof facts.sessions.get>>] => !!e[1] && !e[1].archived);
  // The task's session: its slot first, else the newest live one linked to it.
  const slot = task.session_id ? facts.sessions.get(task.session_id) : undefined;
  const main = slot && !slot.archived ? slot
    : own.map(([, s]) => s).sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))[0];
  const prompt = own.map(([, s]) => s.pendingTool).find(Boolean) ?? null;
  const anyRunning = own.some(([, s]) => s.processStatus === 'running');
  const waitingOnTasks = own.flatMap(([sid]) => facts.requestsFrom.get(sid) ?? [])
    .filter((id) => id !== task.id)
    .map((id) => facts.titles.get(id) ?? 'another task');
  return {
    phase: task.phase,
    status: task.status,
    hasSession: own.length > 0 || !!task.session_id,
    processStatus: anyRunning ? 'running' : main?.processStatus,
    errorMessage: main?.errorMessage ?? null,
    errorReason: main?.errorReason ?? null,
    errorKind: main?.errorKind ?? null,
    restartLoss: main?.restartLoss ?? null,
    projectLead: !!facts.projectLeads?.has((task.project ?? '').trim().toLowerCase()) && task.org_role !== 'lead',
    statusSince: main?.statusSince ?? null,
    pendingPermissionTool: prompt,
    openLetter: facts.letters.get(task.id) ?? null,
    openChoice: facts.choices.get(task.id) ?? null,
    waitingOnTasks: [...new Set(waitingOnTasks)],
    triggers: facts.triggers.get(task.id) ?? [],
    schedules: facts.schedules.get(task.id) ?? [],
    waitUntil: task.wait_until ?? null,
    hasLeader: !!task.parent_task_id,
    openWorkers: facts.openWorkers?.get(task.id) ?? 0,
    isMain: task.org_role === 'main',
    phaseChangedAt: task.phase_changed_at ?? null,
    report: task.status_report ?? null,
    // The task's own session when it has one: an older session's pending report says nothing of this turn.
    reportPending: task.session_id ? isReportPending(task.session_id) : own.some(([sid]) => isReportPending(sid)),
    isLead: task.org_role === 'lead',
  };
}

const sameStatus = (a: UserStatus | undefined, b: UserStatus): boolean => JSON.stringify(a ?? null) === JSON.stringify(b);

/**
 * Derive and store the status of the given open tasks (all of them when `ids` is null).
 * Returns how many changed. A finished task is never written: every reader reads COMPLETE
 * as Done first, and a write to a COMPLETE row would announce it as completed again
 * (updateTaskRaw names the event by the phase), waking every completion listener.
 */
export async function syncUserStatuses(ids: ReadonlySet<string> | null, nowMs = Date.now()): Promise<number> {
  const { listTasks, updateTaskRaw } = await import('./task-manager.js');
  const everything = await listTasks();
  const targets = everything.filter((t) => (ids ? ids.has(t.id) : true) && t.phase !== 'COMPLETE' && t.status !== 'done');
  if (!targets.length) return 0;
  const facts = await readStatusFacts(targets, everything.map((t) => t.id));
  // Name the task a reply is awaited from even when it is not in this pass.
  for (const t of everything) if (!facts.titles.has(t.id)) facts.titles.set(t.id, t.title);
  facts.openWorkers = new Map();
  for (const t of everything) {
    if (!t.parent_task_id || t.phase === 'COMPLETE' || t.status === 'done') continue;
    facts.openWorkers.set(t.parent_task_id, (facts.openWorkers.get(t.parent_task_id) ?? 0) + 1);
  }
  facts.projectLeads = new Set();
  for (const t of everything) {
    if (t.org_role !== 'lead' || t.phase === 'COMPLETE' || t.status === 'done') continue;
    for (const p of [t.project, ...(t.org_leads ?? [])]) {
      const key = (p ?? '').trim().toLowerCase();
      if (key) facts.projectLeads.add(key);
    }
  }
  let changed = 0;
  for (const task of targets) {
    const next = deriveUserStatus(statusInputOf(task, facts), nowMs);
    if (sameStatus(task.user_status, next)) continue;
    const res = await updateTaskRaw(task.id, { user_status: next }, {
      emitEvent: true, source: OWN_SOURCE,
      // Completed while its facts were read: it reads Done, and the write would announce it again.
      shouldUpdate: (cur) => cur.phase !== 'COMPLETE' && cur.status !== 'done',
    }).catch((err) => {
      log.task.debug('user-status: write skipped', { taskId: task.id, error: errText(err) });
      return { changed: false };
    });
    if (res.changed) changed += 1;
  }
  return changed;
}

function schedule(): void {
  if (!live || timer) return;
  timer = setTimeout(() => {
    timer = null;
    void runPass();
  }, DEBOUNCE_MS);
  timer.unref?.();
}

async function runPass(): Promise<void> {
  if (running) { schedule(); return; }
  const ids = all ? null : dirty;
  all = false;
  dirty = new Set();
  if (ids && !ids.size) return;
  running = syncUserStatuses(ids)
    .then((n) => { if (n) log.task.debug('user-status: statuses updated', { changed: n, scope: ids ? ids.size : 'all' }); })
    .catch((err) => log.task.warn('user-status: pass failed', { error: errText(err) }))
    .finally(() => { running = null; });
  await running;
}

function mark(taskId: unknown): void {
  if (typeof taskId !== 'string' || !taskId) return;
  dirty.add(taskId);
  schedule();
}

/** A session event names its session, not its task (the status snapshot has no taskId): look it up. */
function markSession(sessionId: unknown): void {
  if (typeof sessionId !== 'string' || !sessionId) { markAll(); return; }
  import('./session-tracker.js')
    .then(({ getSessionByClaudeId }) => getSessionByClaudeId(sessionId))
    .then((rec) => { if (rec?.taskId) mark(rec.taskId); else markAll(); })
    .catch(() => markAll());
}

function markAll(): void {
  all = true;
  schedule();
}

function onEvent(event: { name: string; data: unknown; source?: string }): void {
  // Its own writes, and the activity stamp a session writes on every event, move nothing here.
  if (event.source === OWN_SOURCE || event.source === 'session-touch') return;
  const d = (event.data ?? {}) as Record<string, any>;
  switch (event.name) {
    case EventNames.TASK_CREATED:
    case EventNames.TASK_UPDATED:
    case EventNames.TASK_COMPLETED:
      mark(d.task?.id);
      return;
    case EventNames.SESSION_STATUS_CHANGED:
    case EventNames.SESSION_PERMISSION_REQUEST:
    case EventNames.SESSION_PERMISSION_RESOLVED:
    case EventNames.SESSION_ENDED:
    case EventNames.SESSION_STARTED:
      if (d.taskId) mark(d.taskId); else markSession(d.sessionId);
      return;
    case EventNames.HUMAN_INBOX_LETTER:
    case LETTER_ANSWERED:
    case LETTER_STATE:
      // The event names the sender's session, not its task: a whole pass.
      dropSlow('letters');
      markAll();
      return;
    // A Board or a trigger can name any task of a team: a whole pass, still one read per store.
    case EventNames.BOARD_CHANGED:
      // Only a page write, an answer or a delete moves a choice; threads, marks and cards never do.
      if (d.kind && !['html', 'choice', 'deleted'].includes(d.kind)) return;
      if (typeof d.taskId === 'string') boardChoices.delete(d.taskId); else boardChoices.clear();
      dropSlow('choices');
      markAll();
      return;
    case EventNames.CRON_JOB_ADDED:
    case EventNames.CRON_JOB_UPDATED:
    case EventNames.CRON_JOB_REMOVED:
      dropSlow('triggers', 'schedules');
      markAll();
      return;
  }
}

export function startUserStatusSync(): void {
  if (!bootPolicy('user-status') || live) return;
  live = true;
  bus.subscribe(SUBSCRIBER, onEvent as never, {
    global: true,
    interest: [
      EventNames.TASK_CREATED, EventNames.TASK_UPDATED, EventNames.TASK_COMPLETED,
      EventNames.SESSION_STATUS_CHANGED, EventNames.SESSION_PERMISSION_REQUEST, EventNames.SESSION_PERMISSION_RESOLVED,
      EventNames.SESSION_ENDED, EventNames.SESSION_STARTED,
      EventNames.HUMAN_INBOX_LETTER, LETTER_ANSWERED, LETTER_STATE, EventNames.BOARD_CHANGED,
      EventNames.CRON_JOB_ADDED, EventNames.CRON_JOB_UPDATED, EventNames.CRON_JOB_REMOVED,
    ],
  });
  // A turn-end report armed, asked or settled changes what the task waits on (user-status.ts).
  onReportPendingChange((sid) => markSession(sid));
  markAll();
  void import('./sessions/report-phase.js').then(({ applyStoredReports }) => applyStoredReports())
    .catch((err) => log.task.warn('user-status: stored reports not applied', { error: errText(err) }));
  // Once the sessions are attached again: the reports a restart lost are asked for again.
  missedReportsTimer = setTimeout(() => {
    missedReportsTimer = null;
    void import('./sessions/report-phase.js').then(({ askMissedReports }) => askMissedReports())
      .catch((err) => log.task.warn('user-status: lost reports not asked again', { error: errText(err) }));
  }, MISSED_REPORTS_DELAY_MS);
  missedReportsTimer.unref?.();
  sweep = setInterval(() => { dropSlow(); markAll(); }, SWEEP_MS);
  sweep.unref?.();
  log.task.info('user-status: started');
}

/**
 * Run what is pending now and wait until no pass is queued or running, so a test that watches
 * events from a point on starts after the statuses its setup moved were written, not inside
 * the debounce window (2026-10-26: an SSE "no replay" check read a late status write as one).
 */
export async function settleUserStatusSync(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    if (timer) { clearTimeout(timer); timer = null; void runPass(); }
    if (running) { await running; continue; }
    if (!timer) return;
  }
}

export function stopUserStatusSync(): void {
  bus.unsubscribe(SUBSCRIBER);
  onReportPendingChange(null);
  if (missedReportsTimer) clearTimeout(missedReportsTimer);
  missedReportsTimer = null;
  live = false;
  if (timer) clearTimeout(timer);
  if (sweep) clearInterval(sweep);
  timer = null;
  sweep = null;
  dirty = new Set();
  all = false;
  dropSlow();
}
