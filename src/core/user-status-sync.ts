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
import { currentLastWords } from './sessions/last-words.js';
import { personMarkedNeeds } from './sessions/person-needs.js';
import { bus, EventNames } from './event-bus.js';
import { log } from '../logging/index.js';
import { bootPolicy } from './boot-policy.js';
import { routineRunToClose } from './routines/run-close.js';
import { deriveUserStatus, reportIsCurrent, rollUpAsks, TURN_TO_READ, type UserStatus, type UserStatusInput } from './user-status.js';
import { answeredAbove, answerFor, answersOf, askKey, foldSameAsk, type RelativeAsk } from './same-ask.js';
import { isSignInAsk, signInWaitWords, type SignInState } from './sign-in-ask.js';
import { relativeAsksIndex } from './same-ask-tree.js';
import { isReportPending, onReportPendingChange } from './sessions/report-pending.js';
import type { Task } from './types.js';
import type { ThreadCounts } from './org/thread-view.js';
import type { OutlivingSource } from './sessions/outliving-work.js';
import { snoozedUntil } from './snooze.js';
import { isQuietTurn } from './sessions/quiet-turn.js';
import { workspaceHoldAsk } from './workspaces/decisions.js';

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
    endpointWait?: UserStatusInput['endpointWait'];
    usageLimit?: UserStatusInput['usageLimit'];
    /** Its process runs (or ran) on this host, and nothing reaches the host now. */
    hostDown?: string;
    pendingTool?: string; taskId?: string; archived?: boolean; startedAt?: string;
    /** Its own work that runs on after its turn (sessions/outliving-work.ts), from the live runner. */
    outliving?: OutlivingSource[];
  }>;
  /** Task id -> subject of its newest unanswered action_required letter. */
  letters: Map<string, string>;
  /** Task id -> subject of its newest open review letter (read with `letters`). Optional: an older
   *  caller's facts carry none. */
  reviews?: Map<string, string>;
  /** Task id -> the unanswered Board choices about it, in Board order: its title, the Board it is
   *  on and its id, and when it was last written there (board-store.ts choice_at; absent: never). */
  choices: Map<string, ChoiceFact[]>;
  /** Session id -> target task ids it waits on for a reply. */
  requestsFrom: Map<string, string[]>;
  /** Task id -> armed triggers that deliver into it. */
  triggers: Map<string, { id: string; name: string }[]>;
  /** Task id -> enabled scheduled routines that run in its session, with their next run. */
  schedules: Map<string, { name: string; nextAt?: string }[]>;
  /** Task id -> when an armed trigger of it last ran its check (ISO, to CHECK_STAMP_MS), absent
   *  while none has. Optional: an older caller's facts carry none. */
  checks?: Map<string, string>;
  /** Task id -> title, for naming the tasks a reply is awaited from. */
  titles: Map<string, string>;
  /** Task id -> the ids of the sessions linked to it (its slot, its history, records naming it). */
  sessionsOf: Map<string, string[]>;
  /** Task id -> how many of its direct subtasks are open (filled by syncUserStatuses). */
  openWorkers?: Map<string, number>;
  /** Task id -> the titles of its direct subtasks at work (in progress or parked on a wait of their own). */
  workersAtWork?: Map<string, string[]>;
  /** Task id -> when the team stop that holds it was made (Task.team_stop members, filled by syncUserStatuses). */
  teamStopped?: Map<string, string>;
  /** Project keys (trimmed, lower case) that have an open lead (filled by syncUserStatuses). */
  projectLeads?: Set<string>;
  /** Every task by id, for what a task takes from its ancestors (a snooze, snooze.ts). */
  tasksById?: ReadonlyMap<string, Task>;
  /** A task's teammates' open asks beside it (same-ask-tree.ts relativeAsksIndex), for a same-ask fold. */
  relativeAsks?: (task: Task) => RelativeAsk[];
  /** Task id -> when a person last wrote to its sessions (ISO), for the tasks a same-ask fold names (readFoldEvidence). */
  personInputAt?: Map<string, string>;
  /** Every open sign-in ask shown as Needs you now, whatever team (sign-in-ask.ts; completeStatusFacts). */
  signInAsks?: RelativeAsk[];
  /** The user's login command words (config ssh_login_hint), and the live sign-in state (readFoldEvidence). */
  loginWords?: string[];
  signIn?: SignInState;
  /** Session id -> its newest parked message (never delivered): why, and when it was parked. */
  undelivered?: Map<string, { reason: string; at: string }>;
  /** Main or a lead -> what its Threads hold for the user (org/thread-view.ts threadCounts). */
  threads?: Map<string, ThreadCounts>;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function safely<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch (err) {
    log.task.debug('user-status: a fact source was unreadable, deriving without it', { source: what, error: errText(err) });
    return fallback;
  }
}

type SlowSource = 'letters' | 'choices' | 'triggers' | 'schedules' | 'checks';

/**
 * The sources that cost a lock or a parse of every Board (the inbox index, the Boards, the
 * cron store), kept between passes and dropped on their own events and on every sweep. The
 * session records and the reply requests are read on every pass: they move with each turn.
 */
const slow: Partial<Record<SlowSource, Map<string, any>>> = {};

function dropSlow(...kinds: SlowSource[]): void {
  for (const k of kinds.length ? kinds : (['letters', 'choices', 'triggers', 'schedules', 'checks'] as const)) delete slow[k];
  // A snooze of a thread runs out on its own clock: every sweep counts the Threads again.
  if (!kinds.length) { boardChoices.clear(); threadsChanged(); }
}

/** Per org node: its Threads' counts, read once and dropped when its Threads change. A change
 *  bumps the node's generation, so a read begun before it is never cached over it. */
const nodeThreads = new Map<string, ThreadCounts>();
const threadsGen = new Map<string, number>();
let threadsGenAll = 0;

function threadsChanged(taskId?: string): void {
  if (taskId) { nodeThreads.delete(taskId); threadsGen.set(taskId, (threadsGen.get(taskId) ?? 0) + 1); }
  else { nodeThreads.clear(); threadsGenAll++; }
}

async function readNodeThreads(tasks: readonly Task[]): Promise<Map<string, ThreadCounts>> {
  const out = new Map<string, ThreadCounts>();
  const nodes = tasks.filter((t) => (t.org_role === 'main' || t.org_role === 'lead') && t.phase !== 'COMPLETE');
  if (!nodes.length) return out;
  const { readThreads } = await import('./org/threads-store.js');
  const { threadCounts } = await import('./org/thread-view.js');
  for (const t of nodes) {
    let hit = nodeThreads.get(t.id);
    if (!hit) {
      const gen = `${threadsGenAll}:${threadsGen.get(t.id) ?? 0}`;
      const read = await safely('threads', async () => threadCounts((await readThreads(t.id)).threads), null);
      // An unreadable file is not cached (the next pass tries again), nor a read a change overtook.
      if (read && gen === `${threadsGenAll}:${threadsGen.get(t.id) ?? 0}`) nodeThreads.set(t.id, read);
      hit = read ?? undefined;
    }
    if (hit && hit.shown > 0) out.set(t.id, hit);
  }
  return out;
}

export interface ChoiceFact { title: string; board: string; id: string; at?: string }

/** Per Board owner: its unanswered choices, so one Board's write re-reads that Board alone. */
const boardChoices = new Map<string, { ref?: string; title: string; id: string; at?: string }[]>();

async function cachedSlow<K extends SlowSource>(kind: K, allIds: readonly string[]): Promise<NonNullable<StatusFacts[K]>> {
  const hit = slow[kind];
  if (hit) return hit as NonNullable<StatusFacts[K]>;
  const built = kind === 'letters' ? await readLetters()
    : kind === 'choices' ? await readChoices(allIds)
    : await readRoutines(kind as 'triggers' | 'schedules' | 'checks');
  slow[kind] = built;
  return built as NonNullable<StatusFacts[K]>;
}

/** The open review letters, read in the same pass as the decision letters (readLetters). */
let reviewLetters: Map<string, string> = new Map();

async function readLetters(): Promise<StatusFacts['letters']> {
  const out: StatusFacts['letters'] = new Map();
  // Replaced at once, so an unreadable inbox leaves no older review behind.
  const reviews = new Map<string, string>();
  reviewLetters = reviews;
  await safely('inbox', async () => {
    const { listLetters } = await import('./human-inbox/store.js');
    const { letters: list } = await listLetters({ archived: false });
    // Oldest first, so the newest letter of a task is the one kept.
    const now = Date.now();
    for (const l of [...list].sort((a, b) => a.createdAt - b.createdAt)) {
      const tid = l.sender?.taskId;
      if (l.answered || l.archived || !tid) continue;
      // A letter the user read a while ago is no news, as for a decision.
      if (l.read && !(typeof l.readAt === 'number' && now < l.readAt + DECISION_SEEN_GRACE_MS)) continue;
      if (l.type === 'review') reviews.set(tid, l.subject);
      if (l.type !== 'action_required') continue;
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
          const at = board?.choice_at?.[id]?.at;
          open.push({ ref: spec.task?.trim() || undefined, title: spec.title?.trim() || 'Answer the choice on its Board.', id, ...(at ? { at } : {}) });
        }
        boardChoices.set(owner, open);
      }
      for (const c of open) {
        // A choice names its task by id or an unambiguous id prefix (4+ characters, as
        // board-v1 resolves refs); one that names none is the owner's. The Org page's Answer
        // finds it by the same rule (boards/open-choice.ts).
        const tid = c.ref ? resolveChoiceRef(c.ref, allIds) : owner;
        if (!tid) continue;
        const list = out.get(tid) ?? [];
        list.push({ title: c.title, board: owner, id: c.id, ...(c.at ? { at: c.at } : {}) });
        out.set(tid, list);
      }
    }
  }, undefined);
  return out;
}

/** A check's time is kept to this step, so a trigger checking every minute rewrites no status
 *  every minute: "checked 10 minutes ago" is all a reader needs. */
const CHECK_STAMP_MS = 10 * 60_000;

/** The routines that run in a task's session: armed triggers (a check), or plain scheduled runs;
 *  `checks`: when an armed trigger of the task last ran its check. */
async function readRoutines(kind: 'triggers' | 'schedules' | 'checks'): Promise<Map<string, any>> {
  const schedules = kind === 'schedules';
  const out = new Map<string, any>();
  await safely('triggers', async () => {
    const { listRoutines } = await import('./routines/routines-core.js');
    const { triggerRunState } = await import('./cron/trigger-run-state.js');
    const { jobs } = await listRoutines(true);
    for (const job of jobs as import('./cron/types.js').CronJob[]) {
      const target = (job.executor?.config as { target?: unknown } | undefined)?.target;
      if (job.executor?.type !== 'session' || typeof target !== 'string' || !job.enabled) continue;
      if (kind === 'checks') {
        const ran = job.state?.lastCheck?.atMs;
        if (!job.check || triggerRunState(job) !== 'armed' || typeof ran !== 'number') continue;
        const at = new Date(Math.floor(ran / CHECK_STAMP_MS) * CHECK_STAMP_MS).toISOString();
        if (!out.has(target) || out.get(target) < at) out.set(target, at);
        // Per trigger too (`trigger:<id>`), a check that ran without an error: a trigger the session
        // armed to watch its ask (Task.recheck_watch) checks that ask each time it runs.
        if (job.id && job.state?.lastCheck?.outcome !== 'error') out.set(`trigger:${job.id}`, at);
        continue;
      }
      const list = out.get(target) ?? [];
      if (schedules && !job.check) {
        const next = job.state?.nextRunAtMs;
        list.push({ name: job.name, ...(typeof next === 'number' ? { nextAt: new Date(next).toISOString() } : {}) });
      } else if (!schedules && job.check && triggerRunState(job) === 'armed') {
        list.push({ id: job.id, name: job.name });
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

/** A session's endpoint wait as the status reads it: its record's, or one its error text opens before
 *  the waiter has written it (the result and the status sync race at a turn end). */
function endpointWaitOf(
  rec: import('./types.js').SessionRecord,
  endpoint: typeof import('./sessions/endpoint-wait.js'),
): UserStatusInput['endpointWait'] {
  if (!endpoint.endpointWaitEnabled()) return undefined;
  // A continue whose turn ended cleanly is no wait any more, even before the waiter closes it.
  if (rec.endpointWait && (rec.endpointWait.state !== 'resumed' || endpoint.recordInEndpointWait(rec))) return rec.endpointWait;
  if (rec.endpointWait || !endpoint.recordInEndpointWait(rec)) return undefined;
  return {
    state: 'waiting', where: endpoint.machineWords(rec.host), since: rec.statusUpdatedAt || rec.last_status_change || new Date().toISOString(), resumes: 0,
    ...(endpoint.endpointWaitCause(rec.errorMessage) === 'dropped' ? { cause: 'dropped' as const } : {}),
  };
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
    const runner = await import('../providers/claude-code-session.js').then((m) => m.sessionRunner).catch(() => null);
    const endpoint = await import('./sessions/endpoint-wait.js').catch(() => null);
    const limits = await import('./sessions/usage-limit-wait.js').catch(() => null);
    const links = await import('../providers/daemon-connection.js').catch(() => null);
    // A link state that cannot be read is not "down".
    const linkDown = (host: string): boolean => { try { return links?.hostLinkDown(host) === true } catch { return false } };
    // A host's name in a sentence (its label), read once per pass.
    const names = new Map<string, Promise<string>>();
    const downHostName = (host: string): Promise<string> => {
      if (!names.has(host)) names.set(host, import('./hosts/host-display-name.js').then((m) => m.hostDisplayNameFor(host)).catch(() => host));
      return names.get(host)!;
    };
    for (const rec of await listSessionsForTasks(taskIds, sessionIds)) {
      if (rec.provider === 'embedded') continue;
      // Only a live process carries work on: a stopped one's runner state is its last word.
      const live = rec.process_status === 'running' || rec.process_status === 'idle';
      const outliving = live && runner ? runner.outlivingWorkOf(rec.claudeSessionId) : [];
      const hostDown = rec.host && !rec.archived && linkDown(rec.host) ? await downHostName(rec.host) : undefined;
      sessions.set(rec.claudeSessionId, {
        ...(outliving.length ? { outliving } : {}),
        ...(hostDown ? { hostDown } : {}),
        // A quiet turn (Walnut's idle compaction, sessions/quiet-turn.ts) is no running work.
        processStatus: rec.process_status === 'running' && isQuietTurn(rec.claudeSessionId) ? 'idle' : rec.process_status,
        errorMessage: rec.errorMessage,
        errorReason: rec.status_reason, statusSince: rec.statusUpdatedAt || rec.last_status_change || rec.lastActiveAt,
        errorKind: rec.errorKind,
        restartLoss: liveRestartLoss(rec, recovery),
        ...(endpoint && rec.process_status !== 'running' ? { endpointWait: endpointWaitOf(rec, endpoint) } : {}),
        ...(limits && rec.process_status !== 'running' ? { usageLimit: limits.usageLimitOfRecord(rec) } : {}),
        pendingTool: rec.pendingPermission ? (rec.pendingPermission.toolName ?? 'permission') : undefined,
        taskId: rec.taskId, archived: rec.archived, startedAt: rec.startedAt,
      });
    }
  }, undefined);

  const undelivered: NonNullable<StatusFacts['undelivered']> = new Map();
  await safely('undelivered', async () => {
    const { getQueue } = await import('./session-message-queue.js');
    const { parkMeansNeverRan } = await import('./sessions/undelivered-requests.js');
    for (const sid of new Set([...sessionIds, ...sessions.keys()])) {
      for (const m of await getQueue(sid)) {
        // Only a park that proves the message never ran: a Stop's park is the user's choice.
        if (m.status !== 'parked' || !m.parkedAt || !parkMeansNeverRan(m.parkedReason)) continue;
        const prev = undelivered.get(sid);
        if (!prev || prev.at < m.parkedAt) undelivered.set(sid, { reason: m.parkedReason || 'it could not be delivered', at: m.parkedAt });
      }
    }
  }, undefined);

  const letters = await cachedSlow('letters', allIds);
  const reviews = reviewLetters;
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
  const checks = await cachedSlow('checks', allIds);

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
  const threads = await readNodeThreads(tasks);
  return { sessions, letters, reviews, choices, requestsFrom, triggers, schedules, checks, titles, sessionsOf, undelivered, threads };
}

/**
 * The Board choice that asks the user about a task: the first unanswered one on a Board whose
 * owner is still open. A completed task's Board asks nothing more (2026-10-31: a COMPLETE leader's
 * old choice kept a Needs you card on its worker), as its letters leave the inbox at completion.
 */
function choiceInput(task: Task, facts: StatusFacts): Pick<UserStatusInput, 'openChoice' | 'openChoiceAt' | 'openChoiceRef'> {
  const open = (facts.choices.get(task.id) ?? []).find((c) => {
    const owner = c.board === task.id ? task : facts.tasksById?.get(c.board);
    return !(owner && (owner.phase === 'COMPLETE' || owner.status === 'done'));
  });
  if (!open) return { openChoice: null };
  return { openChoice: open.title, openChoiceAt: open.at ?? null, openChoiceRef: { board: open.board, id: open.id } };
}

/** A park lands just before the hand-back it causes; the two clocks are the same process's. */
const UNDELIVERED_SLACK_MS = 60_000;

/** The input deriveUserStatus takes for one task, from the facts. Exported for tests. */
/** What a session's close left for the user, still open (sessions/owed-to-user.ts). */
function openOwedHold(task: Task): { ask: string; at: string } | null {
  const o = task.result_report?.owed;
  return o?.items?.length && !o.settled ? { ask: o.ask, at: o.at } : null;
}

/** What the task's workspace asks the person about its waiting start, unless a session of it started since. */
function heldStart(task: Task, sessionStarts: ReadonlyArray<string | undefined>): string | null {
  const ask = workspaceHoldAsk(task.workspace)
  const at = Date.parse(task.workspace?.pending_start?.at ?? '')
  if (!ask) return null
  return Number.isFinite(at) && sessionStarts.some((s) => Date.parse(s ?? '') >= at) ? null : ask
}

export function statusInputOf(task: Task, facts: StatusFacts, nowMs = Date.now()): UserStatusInput {
  const own = (facts.sessionsOf.get(task.id) ?? [])
    .map((sid) => [sid, facts.sessions.get(sid)] as const)
    .filter((e): e is readonly [string, NonNullable<ReturnType<typeof facts.sessions.get>>] => !!e[1] && !e[1].archived);
  // The task's session: its slot first, else the newest live one linked to it.
  const slot = task.session_id ? facts.sessions.get(task.session_id) : undefined;
  const main = slot && !slot.archived ? slot
    : own.map(([, s]) => s).sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))[0];
  const prompt = own.map(([, s]) => s.pendingTool).find(Boolean) ?? null;
  const anyRunning = own.some(([, s]) => s.processStatus === 'running');
  // A message parked since the phase last moved: the hand-back is about it.
  const movedAt = task.phase_changed_at ? Date.parse(task.phase_changed_at) : NaN;
  // Not while a CLI is up (idle or running): that process just ran a real turn.
  const undelivered = Number.isFinite(movedAt) && !anyRunning && main?.processStatus !== 'idle'
    ? own.map(([sid]) => facts.undelivered?.get(sid))
      .filter((u): u is { reason: string; at: string } => !!u && Date.parse(u.at) >= movedAt - UNDELIVERED_SLACK_MS)
      .sort((a, b) => b.at.localeCompare(a.at))[0]
    : undefined;
  const waitingOnTasks = own.flatMap(([sid]) => facts.requestsFrom.get(sid) ?? [])
    .filter((id) => id !== task.id)
    .map((id) => facts.titles.get(id) ?? 'another task');
  return {
    phase: task.phase,
    status: task.status,
    hasSession: own.length > 0 || !!task.session_id,
    ...(task.start_queue ? { startQueue: { host: task.start_queue.host, reason: task.start_queue.reason } } : {}),
    ...(task.last_start?.state === 'failed' && task.last_start.error ? { startFailed: task.last_start.error } : {}),
    processStatus: anyRunning ? 'running' : main?.processStatus,
    outliving: [...new Set(own.flatMap(([, s]) => s.outliving ?? []))],
    errorMessage: main?.errorMessage ?? null,
    errorReason: main?.errorReason ?? null,
    errorKind: main?.errorKind ?? null,
    restartLoss: main?.restartLoss ?? null,
    endpointWait: main?.endpointWait ?? null,
    usageLimit: main?.usageLimit ?? null,
    hostDown: main?.hostDown ?? null,
    projectLead: !!facts.projectLeads?.has((task.project ?? '').trim().toLowerCase()) && task.org_role !== 'lead',
    undeliveredMessage: undelivered?.reason ?? null,
    statusSince: main?.statusSince ?? null,
    pendingPermissionTool: prompt,
    openLetter: facts.letters.get(task.id) ?? null,
    openReview: facts.reviews?.get(task.id) ?? null,
    threads: facts.threads?.get(task.id) ?? null,
    ...choiceInput(task, facts),
    waitingOnTasks: [...new Set(waitingOnTasks)],
    // A trigger on the user's own ask or letter (trigger_create `watches`) is no outside watch:
    // the task still needs the user (sessions/outside-wait.ts, 2026-10-30).
    triggers: (facts.triggers.get(task.id) ?? [])
      .filter((t) => !(task.recheck_watch ?? []).some((w) => w.trigger === t.id)).map((t) => t.name),
    schedules: facts.schedules.get(task.id) ?? [],
    waitUntil: task.wait_until ?? null,
    hasLeader: !!task.parent_task_id,
    openWorkers: facts.openWorkers?.get(task.id) ?? 0,
    workersAtWork: facts.workersAtWork?.get(task.id) ?? [],
    isMain: task.org_role === 'main',
    phaseChangedAt: task.phase_changed_at ?? null,
    owedHold: openOwedHold(task),
    workspaceHold: heldStart(task, own.map(([, s]) => s.startedAt)),
    report: task.status_report ?? null,
    lastWords: currentLastWords(task),
    markedByPerson: personMarkedNeeds(task),
    // The task's own session when it has one: an older session's pending report says nothing of this turn.
    reportPending: task.session_id ? isReportPending(task.session_id) : own.some(([sid]) => isReportPending(sid)),
    // The Router is an org node beside the VPs: its questions stay in its chat, as a lead's do.
    isLead: task.org_role === 'lead' || task.org_role === 'router',
    dueDate: task.due_date ?? null,
    checkRanAt: facts.checks?.get(task.id) ?? null,
    askCheckedAt: askCheckedAtOf(task, facts.checks, task.status_report?.state === 'needs' ? task.status_report.ask : null, task.status_report?.state === 'needs' ? task.status_report.ask_id : undefined),
    teamStoppedAt: facts.teamStopped?.get(task.id) ?? null,
    snoozedUntil: snoozedUntil(task, facts.tasksById, nowMs),
  };
}

const sameStatus = (a: UserStatus | undefined, b: UserStatus): boolean => JSON.stringify(a ?? null) === JSON.stringify(b);

/**
 * How long a hand-back with nothing asked waits before it is stored (ToRead `turn`). The phase moves at
 * once; the stored status the surfaces read keeps its last value meanwhile. On 2026-10-28, 134
 * of 519 moves into NEED_ACTION were undone by a new turn within 30 s (112 within 20 s): a turn
 * end right before the CLI's follow-up turn, or a message that woke the task at once. Each one
 * turned the task red for a few seconds on the Org page, the Board and the phone, and moved the
 * counts ("the ORG webpage is really flaky, flashing").
 */
export const HANDBACK_SETTLE_MS = 20_000;

/**
 * When a derived hand-back may be written (ms), or null when it may be written now. Only a task
 * with a session that read Working or Waiting is held: that is a turn end. A person or a lead
 * setting NEED_ACTION on a task that has not started, or has no session, reads Needs you at once.
 */
export function handBackSettlesAt(
  task: Pick<Task, 'phase_changed_at' | 'user_status'>, next: UserStatus, nowMs: number, hasSession: boolean,
): number | null {
  if (next.toRead !== 'turn' || next.waitingOn !== TURN_TO_READ) return null;
  const was = task.user_status;
  if (!hasSession || !was || (was.state !== 'working' && was.state !== 'waiting') || was.kind === 'not-started') return null;
  // It read "Limited" (or Walnut's continue after it): the turn that ended was the end of that wait,
  // so the row moves on at once rather than reading Limited for the hold.
  if (was.limit) return null;
  const movedAt = Date.parse(task.phase_changed_at ?? '');
  if (!Number.isFinite(movedAt)) return null;
  const at = movedAt + HANDBACK_SETTLE_MS;
  return at > nowMs ? at : null;
}

/** Task id -> the timer that derives it again once its hand-back has settled. */
const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
function recheckAt(taskId: string, atMs: number): void {
  if (!live || settleTimers.has(taskId)) return;
  const t = setTimeout(() => { settleTimers.delete(taskId); mark(taskId); }, Math.max(0, atMs - Date.now()) + 50);
  t.unref?.();
  settleTimers.set(taskId, t);
}

/** The facts a pass derives from the whole task list, beside the ones readStatusFacts reads:
 *  the tasks by id, their open workers, team stops and project leads. Exported for the standing
 *  check (status-consistency.ts), which derives exactly as a pass does. */
export function completeStatusFacts(facts: StatusFacts, everything: readonly Task[]): void {
  // Name the task a reply is awaited from even when it is not in this pass.
  for (const t of everything) if (!facts.titles.has(t.id)) facts.titles.set(t.id, t.title);
  facts.tasksById = new Map(everything.map((t) => [t.id, t] as const));
  facts.relativeAsks = relativeAsksIndex(everything);
  facts.openWorkers = new Map();
  facts.workersAtWork = new Map();
  for (const t of everything) {
    if (!t.parent_task_id || t.phase === 'COMPLETE' || t.status === 'done') continue;
    facts.openWorkers.set(t.parent_task_id, (facts.openWorkers.get(t.parent_task_id) ?? 0) + 1);
    // At work: running its own turn or parked on a wait of its own. One handed back (NEED_ACTION)
    // or not started (TODO) is its parent's to look at, never a wait of the parent's.
    if (t.phase === 'IN_PROGRESS' || t.phase === 'WAITING') {
      facts.workersAtWork.set(t.parent_task_id, [...(facts.workersAtWork.get(t.parent_task_id) ?? []), t.title]);
    }
  }
  facts.teamStopped = new Map();
  // A pause of the wake sources only (sessions:"keep") leaves the sessions running: not a stop to show.
  for (const t of everything) if (!t.team_stop?.keptSessions) for (const m of t.team_stop?.members ?? []) facts.teamStopped.set(m.id, t.team_stop!.at);
  facts.projectLeads = new Set();
  for (const t of everything) {
    if (t.org_role !== 'lead' || t.phase === 'COMPLETE' || t.status === 'done') continue;
    for (const p of [t.project, ...(t.org_leads ?? [])]) {
      const key = (p ?? '').trim().toLowerCase();
      if (key) facts.projectLeads.add(key);
    }
  }
}

/**
 * When a person last wrote to each task a stored same-ask fold names (same-ask.ts): the evidence
 * that the user answered the deeper task, so its ancestor's fold may stay once that task asks no more.
 */
export async function readFoldEvidence(facts: StatusFacts, targets: readonly Task[]): Promise<void> {
  // One sign-in is one ask (sign-in-ask.ts): the user's login command words, every task's sign-in
  // ask shown now, and what Walnut knows of the sign-in itself.
  facts.loginWords = await safely('login-words', async () => {
    const { getConfig } = await import('./config-manager.js');
    return (await import('./sign-in-ask.js')).loginCommandWords((await getConfig()).ssh_login_hint);
  }, []);
  facts.signInAsks = [...(facts.tasksById?.values() ?? [])]
    .filter((t) => t.phase !== 'COMPLETE' && t.status !== 'done' && t.user_status?.state === 'needs' && t.user_status.source === 'session'
      && isSignInAsk(t.user_status.ask, facts.loginWords ?? []))
    .map((t) => ({ id: t.id, title: t.title, ask: t.user_status!.ask!, createdAt: t.created_at }));
  facts.signIn = await safely('sign-in-state', async () => (await import('./sign-in-ask.js')).readSignInState(), {});
  const ids = new Set(targets.map((t) => t.user_status?.sameAsk?.id).filter((id): id is string => !!id));
  facts.personInputAt = new Map();
  if (!ids.size) return;
  await safely('fold-evidence', async () => {
    const { listSessionsForTasks } = await import('./session-tracker.js');
    const sids = new Set<string>();
    for (const id of ids) {
      const t = facts.tasksById?.get(id);
      if (t?.session_id) sids.add(t.session_id);
      for (const sid of t?.session_ids ?? []) sids.add(sid);
    }
    for (const rec of await listSessionsForTasks(ids, sids)) {
      const tid = rec.taskId && ids.has(rec.taskId) ? rec.taskId : [...ids].find((id) => facts.tasksById?.get(id)?.session_ids?.includes(rec.claudeSessionId));
      if (!tid || !rec.humanInputAt) continue;
      const cur = facts.personInputAt!.get(tid);
      if (!cur || rec.humanInputAt > cur) facts.personInputAt!.set(tid, rec.humanInputAt);
    }
  }, undefined);
}

/** A task's own word on sameness (FOR_USER_ASK_SAME), only while its shown ask is that report's. */
function declaredOf(t: Task | undefined): Pick<NonNullable<Task['status_report']>, 'same_as' | 'ask_distinct'> | null {
  const r = t?.status_report;
  if (!t || !r || t.user_status?.source !== 'session') return null;
  return reportIsCurrent({ report: r, phaseChangedAt: t.phase_changed_at }) ? r : null;
}

/**
 * Whether a task still holds `ask` while it is not shown as Needs you: its current report still
 * asks it (a turn runs on it), its report is on the way, or it is snoozed with it (same-ask.ts).
 */
function stillAsksOf(t: Task | undefined, ask: string, nowMs = Date.now()): boolean {
  if (!t || t.phase === 'COMPLETE' || t.status === 'done') return false;
  const key = askKey(ask);
  // Answered there for the user (a lead, VP or Main, or the answer reached its own holder): it no
  // longer holds it, and the fold reads answered.
  if (answerFor(answersOf(t), ask, nowMs) || answeredThereOf(t)) return false;
  const r = t.status_report;
  if (r?.state === 'needs' && askKey(r.ask) === key) {
    if (reportIsCurrent({ report: r, phaseChangedAt: t.phase_changed_at })) return true;
    // A turn runs on it: its report is still the newest word, and the turn's end says the next.
    if (t.user_status?.state === 'working') return true;
  }
  const us = t.user_status;
  return !!us?.transient || (!!us?.snoozed?.ask && askKey(us.snoozed.ask) === key);
}

/** Its own status reads its ask answered: a fold of its own that was answered, or an answer above it. */
function answeredThereOf(t: Task | undefined): boolean {
  return !!t?.user_status?.sameAsk?.answered || !!t?.user_status?.answeredFor;
}

/** When a trigger the session armed to watch its ask (trigger_create watches:"ask") last checked it
 *  without an error, while it is armed (needs-recheck.ts): a check of the ask, not only of the task. */
export function askCheckedAtOf(task: Pick<Task, 'recheck_watch'>, checks: ReadonlyMap<string, string> | undefined, ask: string | null | undefined, decisionId?: string): string | null {
  const key = askKey(ask);
  if (!key) return null;
  let best: string | null = null;
  for (const w of task.recheck_watch ?? []) {
    // Only a watch armed for this very ask (2026-11-04 review: one armed for an old ask stamped every
    // later one): its decision (ask-decision.ts), so the same ask reworded keeps its watch, else its words.
    if (w.watches !== 'ask' || (w.key !== key && !(decisionId && w.key === decisionId))) continue;
    const at = checks?.get(`trigger:${w.trigger}`);
    if (at && (!best || at > best)) best = at;
  }
  return best;
}

/** When a lead, VP or Main answered `ask` of that task for the user (Task.ask_answered), or null. */
function answeredAtOf(t: Task | undefined, ask: string, nowMs = Date.now()): string | null {
  return (t && answerFor(answersOf(t), ask, nowMs)?.at) ?? null;
}

/** Its open subtasks by parent id, for statusOf. */
export function childrenByParent(everything: readonly Task[]): Map<string, Task[]> {
  const childrenOf = new Map<string, Task[]>();
  for (const t of everything) if (t.parent_task_id) (childrenOf.get(t.parent_task_id) ?? childrenOf.set(t.parent_task_id, []).get(t.parent_task_id)!).push(t);
  return childrenOf;
}

/**
 * The status one task shows: derived from its facts, with the questions its subtasks ask carried
 * up (rollUpAsks; Main and a VP show them on their top-level tasks, never as their own: Needs you is
 * only ever an individual task), and its own ask folded when a task below it, or a teammate beside it
 * that asked first, already asks the same (same-ask.ts: the user sees one decision once), or taken off
 * Needs you when a lead, VP or Main answered it for the user (answeredAbove). The one way a stored
 * status is made: the sync writes it, the consistency check compares against it.
 */
export function statusOf(
  task: Task, facts: StatusFacts, childrenOf: ReadonlyMap<string, readonly Task[]>, nowMs = Date.now(),
): { input: UserStatusInput; status: UserStatus } {
  const input = statusInputOf(task, facts, nowMs);
  const derived = deriveUserStatus(input, nowMs);
  const children = (childrenOf.get(task.id) ?? []).filter((child) => child.router_area_id === task.router_area_id);
  const asks = task.org_role ? [] : rollUpAsks(children, task.id);
  const withAsks = asks.length ? { ...derived, asks } : derived;
  const folded = foldSameAsk(task.id, withAsks, asks, {
    report: reportIsCurrent(input) ? task.status_report ?? null : null,
    prev: task.user_status ?? null,
    declared: (id) => declaredOf(facts.tasksById?.get(id)),
    personInputAt: (id) => facts.personInputAt?.get(id),
    stillAsks: (id, ask) => stillAsksOf(facts.tasksById?.get(id), ask, nowMs),
    nowIso: new Date(nowMs).toISOString(),
    relatives: relativesWithSignIn(task, facts, withAsks),
    selfCreatedAt: task.created_at,
    answeredAt: (id, ask) => answeredAtOf(facts.tasksById?.get(id), ask, nowMs),
    answeredThere: (id) => answeredThereOf(facts.tasksById?.get(id)),
    signIn: (ask) => isSignInAsk(ask, facts.loginWords ?? []),
  });
  return { input, status: signInHeld(answeredAbove(folded, answersOf(task), nowMs), facts) };
}

/** Every task's sign-in asks beside its teammates', when its own ask is one (one sign-in is one ask). */
function relativesWithSignIn(task: Task, facts: StatusFacts, derived: UserStatus): RelativeAsk[] {
  const team = facts.relativeAsks?.(task) ?? [];
  if (derived.state !== 'needs' || derived.source !== 'session' || !isSignInAsk(derived.ask, facts.loginWords ?? [])) return team;
  // Never one above or below it: those fold by depth (rollUpAsks), and a holder chosen across the
  // tree as well would let a parent and its subtask wait on each other.
  const byId = facts.tasksById;
  const chain = (id: string): Set<string> => {
    const out = new Set<string>();
    let cur = byId?.get(id)?.parent_task_id;
    for (let hops = 0; cur && hops < 12 && !out.has(cur); hops++) { out.add(cur); cur = byId?.get(cur)?.parent_task_id; }
    return out;
  };
  const above = chain(task.id);
  const seen = new Set([task.id, ...team.map((r) => r.id)]);
  return [...team, ...(facts.signInAsks ?? []).filter((r) => !seen.has(r.id) && !above.has(r.id) && !chain(r.id).has(task.id))];
}

/**
 * A sign-in ask while the live sign-in state is known (sign-in-ask.ts): it waits on the open
 * sign-in letter, the one place the user is asked, or on its own next step when sign-in works.
 * A fold of it under another task's sign-in ask stands as made. Any other status as given.
 */
function signInHeld(status: UserStatus, facts: StatusFacts): UserStatus {
  if (status.state !== 'needs' || status.source !== 'session' || !isSignInAsk(status.ask, facts.loginWords ?? [])) return status;
  const words = facts.signIn ? signInWaitWords(facts.signIn) : null;
  if (!words) return status;
  const { ask: _ask, source: _source, ...rest } = status;
  return { ...rest, state: 'waiting', kind: facts.signIn?.ok ? 'task' : 'outside', waitingOn: words };
}

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
  completeStatusFacts(facts, everything);
  await readFoldEvidence(facts, targets);
  let changed = 0;
  const toClose: { task: Task; status: UserStatus }[] = [];
  const childrenOf = childrenByParent(everything);
  for (const task of targets) {
    const { input, status: next } = statusOf(task, facts, childrenOf, nowMs);
    const settlesAt = handBackSettlesAt(task, next, nowMs, !!input.hasSession);
    // A routine run that ended with nothing for the user closes itself (routines/run-close.ts).
    // A candidate here (a triage run's `turn` too); closeRoutineRun decides with the triage check.
    if (settlesAt === null && routineRunToClose(task, next, true)) toClose.push({ task, status: next });
    if (sameStatus(task.user_status, next)) continue;
    if (settlesAt !== null) {
      if (!settleTimers.has(task.id)) log.task.info('user-status: hand-back held', { taskId: task.id, untilMs: settlesAt });
      recheckAt(task.id, settlesAt);
      continue;
    }
    const res = await updateTaskRaw(task.id, { user_status: next }, {
      emitEvent: true, source: OWN_SOURCE,
      // Completed while its facts were read: it reads Done, and the write would announce it again.
      shouldUpdate: (cur) => cur.phase !== 'COMPLETE' && cur.status !== 'done',
    }).catch((err) => {
      log.task.debug('user-status: write skipped', { taskId: task.id, error: errText(err) });
      return { changed: false };
    });
    if (res.changed) {
      changed += 1;
      // Its leader carries its questions (rollUpAsks): re-derived in the next pass, one level each.
      if (task.parent_task_id) mark(task.parent_task_id);
      // The tasks whose same ask waits on it (same-ask.ts) read its new status in the next pass.
      for (const t of everything) if (t.user_status?.sameAsk?.id === task.id) mark(t.id);
      // A teammate folded under another whose ask was just answered there is told once.
      if (next.sameAsk?.answered && next.sameAsk.team && !task.user_status?.sameAsk?.answered) {
        void import('./sessions/ask-answer.js').then((m) => m.tellFoldAnswered(task, next.sameAsk!)).catch(() => {});
      }
      // Into Needs you: the line `walnut-logs.sh flips` pairs with the phase moves.
      if (next.state === 'needs' && task.user_status?.state !== 'needs') {
        log.task.info('user-status: now needs you', { taskId: task.id, source: next.source });
      }
    }
  }
  // After the pass, never inside it: a close is a phase write that marks the task again.
  if (toClose.length) {
    const { closeRoutineRun } = await import('./routines/run-close.js');
    for (const c of toClose) await closeRoutineRun(c.task, c.status);
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

/** Each host's link as the last host:status frame said it (up or not), so only a change re-derives. */
const hostUp = new Map<string, boolean>();

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
      // A finished or moved subtask's question leaves its leader's list (rollUpAsks); the event
      // names only the new parent, so a former one drops it at the minute sweep.
      mark(d.task?.parent_task_id);
      return;
    case EventNames.HOST_STATUS: {
      // A host's link went down or came back: its tasks read Waiting on it, or no longer.
      const host = typeof d.host === 'string' ? d.host : '';
      const up = d.connected === true;
      if (!host || hostUp.get(host) === up) return;
      hostUp.set(host, up);
      markAll();
      return;
    }
    case EventNames.SESSION_STATUS_CHANGED:
    case EventNames.SESSION_PERMISSION_REQUEST:
    case EventNames.SESSION_PERMISSION_RESOLVED:
    case EventNames.SESSION_ENDED:
    case EventNames.SESSION_STARTED:
    case EventNames.SESSION_USAGE_LIMIT:
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
      dropSlow('triggers', 'schedules', 'checks');
      markAll();
      return;
    // A node's Threads moved: its own status (a thread waiting on the user is its Needs you).
    case EventNames.ORG_THREADS_CHANGED:
      if (typeof d.taskId === 'string') { threadsChanged(d.taskId); mark(d.taskId); } else { threadsChanged(); markAll(); }
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
      EventNames.SESSION_ENDED, EventNames.SESSION_STARTED, EventNames.SESSION_USAGE_LIMIT,
      EventNames.HUMAN_INBOX_LETTER, LETTER_ANSWERED, LETTER_STATE, EventNames.BOARD_CHANGED,
      EventNames.CRON_JOB_ADDED, EventNames.CRON_JOB_UPDATED, EventNames.CRON_JOB_REMOVED,
      EventNames.ORG_THREADS_CHANGED, EventNames.HOST_STATUS,
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
  for (const t of settleTimers.values()) clearTimeout(t);
  settleTimers.clear();
  dropSlow();
}
