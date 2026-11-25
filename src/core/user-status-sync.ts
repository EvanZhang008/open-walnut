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
import { experimentalEnabled } from './experimental.js';
import { workerStatus } from './worker-status.js';
import { currentLastWords } from './sessions/last-words.js';
import { personMarkedNeeds } from './sessions/person-needs.js';
import { bus, EventNames } from './event-bus.js';
import { log } from '../logging/index.js';
import { bootPolicy } from './boot-policy.js';
import { routineRunToClose } from './routines/run-close.js';
import { createLateGather } from './session-channel/late-gather.js';
import { deriveUserStatus, fallbackUserState, reportIsCurrent, rollUpAsks, TURN_TO_READ, type UserStatus, type UserStatusInput } from './user-status.js';
import { answeredAbove, answerContextOf, answerFor, answersOf, askKey, foldSameAsk, withdrawnAtOf, type RelativeAsk } from './same-ask.js';
import { isSignInAsk, readSignInState, signInStateStamp, signInWaitWords, type SignInState } from './sign-in-ask.js';
import { relativeAsksIndex, treeAround } from './same-ask-tree.js';
import { sameTaskArea } from './router/same-area.js';
import { askMatter, matterIndex, matterNamedIn, sharedMatter, type MatterIndex } from './ask-matter.js';
import { resolveDecisionOwner } from './decision-owner.js';
import { isReportPending, onReportPendingChange } from './sessions/report-pending.js';
import { isProgramRunTask, type Task } from './types.js';
import type { ThreadCounts } from './org/thread-view.js';
import { holderThreadsOf, holdsOnThread, type HolderThreads } from './org/thread-held-decision.js';
import type { OutlivingSource } from './sessions/outliving-work.js';
import { snoozedUntil } from './snooze.js';
import { isQuietTurn } from './sessions/quiet-turn.js';
import { workspaceHoldAsk } from './workspaces/decisions.js';
import { orgEnabledCached } from './org/org-enabled.js';
import { decisionAnswered } from './human-inbox/open-decision.js';
import { allEndedAtMs, ownWorkInFlight, sessionWorkEndedAtMs, triggerWatchesOwnWork } from './task-wait-wake.js';
import { keepsThreads, threadsForEveryTask } from './org/keeps-threads.js';
import { heldLetterIds, holdsLettersNow, isLetterThread, lettersAsThreadsNow } from './human-inbox/letter-threads.js';
import { briefOffNow, setBriefOff } from './org/brief-off.js';
import { threadsPopUpNow as popUpNow } from './org/thread-popup-rules.js';
import { oneIdNow, setThreadsOneId } from './org/thread-one-id.js';
import { isChoiceThread } from './boards/choice-threads.js';
import { applyActions, type ActionItem } from './action-needed.js';
import { taskLines } from './task-lines.js';
import { approvalItemsByTask, letterItem, promptItem } from './action-needed-facts.js';

const SUBSCRIBER = 'user-status-sync';
const OWN_SOURCE = 'user-status';
const DEBOUNCE_MS = 1_500;
/**
 * The wait of the fast lane: a change someone made by hand (a task written through the API, a
 * thread acted on) is derived after this, not after DEBOUNCE_MS, and never queued behind a pass
 * of every task. The debounce exists for the events sessions emit on every turn; a click has no
 * burst to fold, and the dot or pill it moves is read on every surface (2026-11-19: a thread
 * acted on in the Org page kept its node's red dot for 20 to 35 s, 1.5 s of debounce queued
 * behind passes of every task that took 2 to 11 s).
 */
const FAST_MS = 25;
/** A pass slower than this is logged with where its time went (walnut-logs.sh, `user-status: slow pass`). */
const SLOW_PASS_MS = 1_000;
/** Event sources whose task writes are a hand's, not a session's turn (the fast lane). */
const FAST_SOURCES: ReadonlySet<string> = new Set(['api', 'org-threads']);
const SWEEP_MS = 60_000;
/** After start, when the lost turn-end reports are asked for again (sessions attach first). */
const MISSED_REPORTS_DELAY_MS = 45_000;
let missedReportsTimer: ReturnType<typeof setTimeout> | null = null;
/** Emitted by human-inbox/letter-ops.ts when a letter is answered (or withdrawn). */
const LETTER_ANSWERED = 'human-inbox:answered';
/** Emitted by human-inbox/store.ts setLetterState: a letter read, archived or pinned. */
const LETTER_STATE = 'human-inbox:state';
/** An approval asked, answered, expired or withdrawn (approvals/store.ts APPROVAL_CHANGED). */
const APPROVAL_CHANGED = 'approval:changed';

let dirty = new Set<string>();
let all = false;
let fast = new Set<string>();
let fastTimer: ReturnType<typeof setTimeout> | null = null;
let fastRunning: Promise<void> | null = null;
/**
 * Marks are numbered, and a pass remembers the number it began at: a task marked again while a
 * pass was reading is not written by that pass (its facts may predate the change) and is derived
 * by the pass its mark queued. That is what lets the fast lane run beside a pass of every task
 * without the slower one writing an older answer over the newer.
 */
let passSeq = 0;
const derivedBy = new Map<string, number>();
/**
 * The passes that are running, by number. A pass that leaves a task to a later pass (derivedBy)
 * waits for that pass before it returns, so whoever awaited it reads the task derived (2026-11-20:
 * a pass of every task returned while the fast pass that had claimed one row was still writing it,
 * and its caller read the row with no status at all).
 */
const passes = new Map<number, Promise<void>>();
let timer: ReturnType<typeof setTimeout> | null = null;
let sweep: ReturnType<typeof setInterval> | null = null;
let running: Promise<void> | null = null;
let live = false;

/** The facts every task in one pass is derived from, each store read once. */
/** A session's facts in one pass (StatusFacts.sessions). */
export type SessionStatusFacts = StatusFacts['sessions'] extends Map<string, infer V> ? V : never;

export interface StatusFacts {
  followWorkers?: boolean;
  /** How long each fact source took to read in this pass (ms; the slow-pass line names the heavy ones). */
  readMs?: Record<string, number>;
  /** Per session id: what its record says. */
  sessions: Map<string, {
    processStatus?: string; errorMessage?: string; errorReason?: string; statusSince?: string;
    errorKind?: string; restartLoss?: { state: string; cause?: string };
    endpointWait?: UserStatusInput['endpointWait'];
    usageLimit?: UserStatusInput['usageLimit'];
    /** Its process runs (or ran) on this host, and nothing reaches the host now. */
    hostDown?: string;
    pendingTool?: string; taskId?: string; archived?: boolean; startedAt?: string;
    /** Its live prompt as an Action needed item (action-needed-facts.ts promptItem). */
    prompt?: ActionItem;
    /** When a person last sent it a message (SessionRecord.humanInputAt). */
    humanInputAt?: string;
    /** Its own work that runs on after its turn (sessions/outliving-work.ts), from the live runner. */
    outliving?: OutlivingSource[];
    /** Walnut retries its failed turn by itself at this time (session-auto-continue.ts, ISO). */
    autoRetryAt?: string;
    /** When it last did work (task-wait-wake.ts sessionWorkEndedAtMs, ms; Infinity while a turn
     *  runs), for an own-work watch's idle mark. Absent when its record says nothing. */
    workEndedAt?: number;
  }>;
  /** Task id -> subject of its newest unanswered action_required letter. */
  letters: Map<string, string>;
  /** Task id -> every open decision letter it sent, as Action needed items (read with `letters`).
   *  Optional: an older caller's facts carry none. */
  letterItems?: Map<string, ActionItem[]>;
  /** Task id -> the approvals its sessions asked for that wait on the user (action-needed-facts.ts). */
  approvals?: Map<string, ActionItem[]>;
  /** Task id -> subject of its newest open review letter (read with `letters`). Optional: an older
   *  caller's facts carry none. */
  reviews?: Map<string, string>;
  /** Task id -> the unanswered Board choices about it, in Board order: its title, the Board it is
   *  on and its id, and when it was last written there (board-store.ts choice_at; absent: never). */
  choices: Map<string, ChoiceFact[]>;
  /** Session id -> target task ids it waits on for a reply. */
  requestsFrom: Map<string, string[]>;
  /** Task id -> armed triggers that deliver into it; `fires` and `firedAtMs` (its newest fire) where read;
   *  `lastCheck.idle` when a watch of its own work last said nothing is in flight (ownWorkInFlight). */
  triggers: Map<string, { id: string; name: string; fires?: number; firedAtMs?: number; ownWork?: true; lastCheck?: { idle: true; atMs: number } }[]>;
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
  /** The org is on and has an open Main, who takes a failure with no lead and no VP above it. */
  hasMain?: boolean;
  /** Every task by id, for what a task takes from its ancestors (a snooze, snooze.ts). */
  tasksById?: ReadonlyMap<string, Task>;
  /** A task's teammates' open asks beside it (same-ask-tree.ts relativeAsksIndex), for a same-ask fold. */
  relativeAsks?: (task: Task) => RelativeAsk[];
  /** Task id -> when a person last wrote to its sessions (ISO), for the tasks a same-ask fold names (readFoldEvidence). */
  personInputAt?: Map<string, string>;
  /** Every open sign-in ask shown as Needs you now, whatever team (sign-in-ask.ts; completeStatusFacts). */
  signInAsks?: RelativeAsk[];
  /** Every task's matter (ask-matter.ts) and the asks shown now, for a fold across teams by matter. */
  matter?: MatterIndex;
  shownAsks?: Task[];
  /** The user's login command words (config ssh_login_hint), and the live sign-in state (readFoldEvidence). */
  loginWords?: string[];
  signIn?: SignInState;
  /** Session id -> its newest parked message (never delivered): why, and when it was parked. */
  undelivered?: Map<string, { reason: string; at: string }>;
  /** Main, a lead or a task with Threads on -> what its Threads hold for the user (org/thread-groups.ts threadCounts). */
  threads?: Map<string, ThreadCounts>;
  /** threads_reply_tag: what a fold's holder's threads carry (org/thread-held-decision.ts; readFoldEvidence). */
  holderThreads?: Map<string, HolderThreads>;
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Run and await `work`, adding its wall time to `took[what]` (ms), its synchronous start included. */
async function timedRead<T>(took: Record<string, number>, what: string, work: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try { return await work(); } finally { took[what] = (took[what] ?? 0) + (performance.now() - start); }
}

async function safely<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch (err) {
    log.task.debug('user-status: a fact source was unreadable, deriving without it', { source: what, error: errText(err) });
    return fallback;
  }
}

const SLOW_SOURCES = ['letters', 'choices', 'triggers', 'schedules', 'checks', 'approvals'] as const;
type SlowSource = typeof SLOW_SOURCES[number];

/**
 * The sources that cost a lock or a parse of every Board (the inbox index, the Boards, the
 * cron store), kept between passes and dropped on their own events and on every sweep. The
 * session records and the reply requests are read on every pass: they move with each turn.
 */
const slow: Partial<Record<SlowSource, Map<string, any>>> = {};

function dropSlow(...kinds: SlowSource[]): void {
  if (!kinds.length || kinds.includes('letters')) signInKept = null;
  for (const k of kinds.length ? kinds : SLOW_SOURCES) { delete slow[k]; delete slowReading[k]; slowGen[k] += 1; }
  // A snooze of a thread runs out on its own clock: every pass counts the kept rows again with the
  // time now (readNodeThreads), so the sweep re-reads the files themselves only every
  // THREADS_REREAD_MS, a safety net for a change no event named.
  if (!kinds.length) {
    boardChoices.clear();
    if (Date.now() - threadsReadAllAt >= THREADS_REREAD_MS) { threadsChanged(); threadsReadAllAt = Date.now(); }
  }
}

/** Every node's Threads file is read again at most this often. Reading all of them each minute
 *  (about 240 nodes) was the heaviest fact source of a pass: up to 3.7 s, 12.5 s in 14 slow passes
 *  (2026-11-20), and a brief_write waits for a pass of its own. */
const THREADS_REREAD_MS = 10 * 60_000;
let threadsReadAllAt = Date.now();

let threadFileReads = 0;
/** Tests: what the minute sweep drops; every node's Threads dropped (a change no event named); the files read so far. */
export function _sweepFactSourcesForTesting(): void { dropSlow(); }
export function _dropNodeThreadsForTesting(): void { threadsChanged(); }
export function _threadFileReadsForTesting(): number { return threadFileReads; }

/** Per org node: its Threads file as read, kept until its Threads change; each pass joins them
 *  with the task asks they point at (withTaskAsks: the tasks as they are now, and his word to them)
 *  and counts them with the time now. A change bumps the node's generation, so a read begun before
 *  it is never cached over it. */
type NodeThreadRows = Awaited<ReturnType<typeof import('./org/threads-store.js').readThreads>>['threads'];
const nodeThreads = new Map<string, NodeThreadRows>();
const threadsGen = new Map<string, number>();
const threadOwners = new Map<string, Set<string>>();
let threadsGenAll = 0;

/** A derived owner status changes its linked nodes too, including this sync's own accepted writes. */
function ownerThreadsChanged(taskId: string, lane: (id: string) => void = mark): void {
  for (const [node, owners] of threadOwners) if (owners.has(taskId)) { threadsChanged(node); lane(node); }
}

function threadsChanged(taskId?: string): void {
  if (taskId) { nodeThreads.delete(taskId); threadsGen.set(taskId, (threadsGen.get(taskId) ?? 0) + 1); }
  else { nodeThreads.clear(); threadsGenAll++; }
}

/** Per org node: its Threads joined with the task asks they point at (withTaskAsks), kept while
 *  the same rows point at tasks that read the same (askPointerSignature) and for at most
 *  JOINED_ASKS_MS, the time his word to one of those tasks may take to count (the join reads the
 *  session records; the minute sweep re-joined them as often before). */
type NodeView = Awaited<ReturnType<typeof import('./org/threads-store.js').nodeView<NodeThreadRows[number]>>>;
const joined = new Map<string, { rows: NodeThreadRows; sig: string; at: number; out: NodeView }>();
const JOINED_ASKS_MS = 60_000;

async function joinedAsks(nodeId: string, rows: NodeThreadRows, all: readonly Task[], now: number, carry: boolean): Promise<NodeView> {
  const [{ nodeView }, { askPointerSignature }] = await Promise.all([import('./org/threads-store.js'), import('./org/thread-task-ask.js')]);
  const sig = askPointerSignature(rows, all as never, { carry });
  // No thread waits on him: nothing to join.
  if (!sig) { joined.delete(nodeId); return { threads: rows, carried: [] }; }
  const hit = joined.get(nodeId);
  if (hit && hit.rows === rows && hit.sig === sig && now - hit.at < JOINED_ASKS_MS) return hit.out;
  const out = await nodeView(nodeId, rows, all);
  joined.set(nodeId, { rows, sig, at: now, out });
  return out;
}

async function readNodeThreads(tasks: readonly Task[], everything?: readonly Task[]): Promise<Map<string, ThreadCounts>> {
  const out = new Map<string, ThreadCounts>();
  const nodes = tasks.filter((t) => keepsThreads(t) && t.phase !== 'COMPLETE');
  if (!nodes.length) return out;
  const { readThreads } = await import('./org/threads-store.js');
  const { threadCounts } = await import('./org/thread-groups.js');
  const { carriedRows, poppedIndex } = await import('./org/thread-popup.js');
  // threads_pop_up: one read of every owner for the whole pass, never one per node (org/thread-popup.ts).
  let below: ReturnType<typeof poppedIndex> | undefined;
  const { handedIndex, handedRows } = await import('./org/thread-one-id-view.js');
  let handedBy: ReturnType<typeof handedIndex> | undefined;
  // A targeted status pass may contain only the lead. Its linked owners still belong in the read:
  // the pass's own list of every task when it has one (a copy of the board each pass otherwise,
  // about one a second, 2026-11-24 taskCopiesBy).
  let all: readonly Task[] | undefined = everything;
  const now = Date.now();
  for (const t of nodes) {
    let rows = nodeThreads.get(t.id);
    if (!rows) {
      const gen = `${threadsGenAll}:${threadsGen.get(t.id) ?? 0}`;
      const read = await safely('threads', async () => {
        threadFileReads += 1;
        const threads = (await readThreads(t.id)).threads;
        const owners = new Set(threads.flatMap((row) => [...(row.tasks ?? []), ...(row.askOwner ? [row.askOwner.task] : [])]));
        // A thread holding the task's own ask reads by that task's status: its own change recounts it.
        if (threads.some((row) => row.reportAsk)) owners.add(t.id);
        threadOwners.set(t.id, owners);
        // An ask an older build left beside the threads goes on its thread once (org/thread-report-ask.ts).
        void import('./org/thread-report-ask.js').then((m) => m.keepAskOnThread(t, threads)).catch(() => {});
        return threads;
      }, null);
      // An unreadable file is not cached (the next pass tries again), nor a read a change overtook.
      if (read && gen === `${threadsGenAll}:${threadsGen.get(t.id) ?? 0}`) nodeThreads.set(t.id, read);
      rows = read ?? undefined;
    }
    if (!rows) continue;
    const threads = rows;
    const counts = await safely('threads', async () => {
      // The tasks as they are now: one read a pass, shared by every node.
      all ??= await (await import('./task-manager.js')).taskStoreSnapshot();
      const popUp = popUpNow();
      const view = await joinedAsks(t.id, threads, all, now, popUp);
      // threads_one_id: the threads it handed to tasks count here as those tasks' cards (org/thread-one-id.ts).
      const handed = oneIdNow() ? await handedRows(t.id, threads, { all, index: await (handedBy ??= handedIndex({ all })) }) : null;
      if (!popUp && !handed?.holders.length) return threadCounts(view.threads, now);
      // What waits on him below counts here too, never as this task's Needs you (thread-groups.ts
      // threadCounts), and a result below on the subject of one of its own threads (carriedRows).
      const popped = popUp ? (await (below ??= poppedIndex({ all }))).byViewer.get(t.id) ?? [] : [];
      const ids = new Set(handed?.rows.map((h) => h.id));
      const listed = [...(view.carried.length ? [...popped, ...await carriedRows(view.carried, popped)] : popped).filter((p) => !ids.has(p.id)), ...handed?.rows ?? []];
      const owners = threadOwners.get(t.id) ?? new Set<string>();
      for (const p of listed) owners.add(p.owner.task_id);
      for (const h of handed?.holders ?? []) owners.add(h);
      threadOwners.set(t.id, owners);
      return threadCounts([...view.threads.filter((x) => !handed?.ids.has(x.id)), ...listed], now);
    }, null);
    if (counts && counts.shown > 0) out.set(t.id, counts);
  }
  return out;
}

export interface ChoiceFact { title: string; board: string; id: string; at?: string }

/** Per Board owner: its unanswered choices, so one Board's write re-reads that Board alone. */
const boardChoices = new Map<string, { ref?: string; title: string; id: string; at?: string }[]>();

/** One read of a slow source at a time, and a read that a drop overtook is not kept. */
const slowReading: Partial<Record<SlowSource, Promise<Map<string, any>>>> = {};
const slowGen = Object.fromEntries(SLOW_SOURCES.map((k) => [k, 0])) as Record<SlowSource, number>;

async function cachedSlow<K extends SlowSource>(kind: K, allIds: readonly string[]): Promise<NonNullable<StatusFacts[K]>> {
  const hit = slow[kind];
  if (hit) return hit as NonNullable<StatusFacts[K]>;
  // The ordinary and the fast lane can both miss: they share the one read.
  const reading = slowReading[kind];
  if (reading) return reading as Promise<NonNullable<StatusFacts[K]>>;
  const gen = slowGen[kind];
  const read = (async () => {
    const built = kind === 'letters' ? await readLetters()
      : kind === 'approvals' ? await readApprovalItems()
      : kind === 'choices' ? await readChoices(allIds)
      : await readRoutines(kind as 'triggers' | 'schedules' | 'checks');
    if (slowGen[kind] === gen) slow[kind] = built;
    return built as Map<string, any>;
  })().finally(() => { if (slowReading[kind] === read) delete slowReading[kind]; });
  slowReading[kind] = read;
  return read as Promise<NonNullable<StatusFacts[K]>>;
}

/** The open review letters, read in the same pass as the decision letters (readLetters). */
let reviewLetters: Map<string, string> = new Map();
/** Every open decision letter per task as Action needed items, read in the same pass (readLetters). */
let letterItemsNow: Map<string, ActionItem[]> = new Map();

/** The approvals waiting on the user, per asking task (Action needed). Leader only: a replica keeps none. */
async function readApprovalItems(): Promise<Map<string, ActionItem[]>> {
  return safely('approvals', async () => {
    const { listApprovals } = await import('./approvals/store.js');
    return approvalItemsByTask(await listApprovals({ status: 'pending' }));
  }, new Map<string, ActionItem[]>());
}

async function readLetters(): Promise<StatusFacts['letters']> {
  const out: StatusFacts['letters'] = new Map();
  const reviews = new Map<string, string>();
  const items = new Map<string, ActionItem[]>();
  await safely('inbox', async () => {
    const { listLetters } = await import('./human-inbox/store.js');
    const { letters: list } = await listLetters({ archived: false });
    const now = Date.now();
    const open = [...list].sort((a, b) => a.createdAt - b.createdAt).filter((l) => {
      // A decision is answered by a pick or by words written back (open-decision.ts); a review by its pick.
      const done = l.type === 'review' ? !!l.answered : decisionAnswered(l);
      // A letter the user read a while ago is no news, as for a decision.
      return !done && !l.archived && !!l.sender?.taskId && !(l.read && !(typeof l.readAt === 'number' && now < l.readAt + DECISION_SEEN_GRACE_MS));
    });
    // letters_as_threads: a decision its thread holds is counted and answered there, once (letter-threads.ts).
    const held = await heldLetterIds(open.filter((l) => l.type === 'action_required'));
    // Oldest first, so the newest letter of a task is the one kept.
    for (const l of open) {
      const tid = l.sender.taskId!;
      if (l.type === 'review') reviews.set(tid, l.subject);
      if (l.type !== 'action_required' || held.has(l.id)) continue;
      out.set(tid, l.subject);
      items.set(tid, [...(items.get(tid) ?? []), letterItem(l)]);
    }
  }, undefined);
  // Swapped in whole once read (an unreadable inbox leaves none): a pass beside this read never
  // sees a half-filled list.
  reviewLetters = reviews;
  letterItemsNow = items;
  return out;
}

async function readChoices(allIds: readonly string[]): Promise<StatusFacts['choices']> {
  const out: StatusFacts['choices'] = new Map();
  await safely('boards', async () => {
    const { listBoardTaskIds, getBoardView } = await import('./boards/board-store.js');
    const { choiceSpecs } = await import('./boards/board-html.js');
    const { resolveChoiceRef } = await import('./boards/open-choice.js');
    for (const owner of await listBoardTaskIds()) {
      let open = boardChoices.get(owner);
      if (!open) {
        open = [];
        const board = await getBoardView(owner).catch(() => null);
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
    // brief_off: a choice its leader's thread holds is counted and answered there, once (boards/choice-threads.ts).
    if (briefOffNow() && out.size) {
      const { heldChoiceKeys } = await import('./boards/choice-threads.js');
      const held = await heldChoiceKeys([...out.values()].flat());
      if (held.size) for (const [tid, list] of out) {
        const left = list.filter((c) => !held.has(`${c.board}/${c.id}`));
        if (left.length) out.set(tid, left); else out.delete(tid);
      }
    }
  }, undefined);
  return out;
}

/** A check's time is kept to this step, so a trigger checking every minute rewrites no status
 *  every minute: "checked 10 minutes ago" is all a reader needs. */
const CHECK_STAMP_MS = 10 * 60_000;

/** When a trigger last fired (ms): its newest fire in the audit trail, else its last check's. */
function lastFireAtMs(job: import('./cron/types.js').CronJob): number | undefined {
  const logged = job.state?.fireLog?.find((e) => e.outcome === 'fired')?.atMs;
  if (typeof logged === 'number') return logged;
  const check = job.state?.lastCheck;
  return check?.outcome === 'fired' && typeof check.atMs === 'number' ? check.atMs : undefined;
}

/** Slack between a fire's time (the daemon's clock) and the phase move its delivery makes (this server's). */
const FIRE_CLOCK_SLACK_MS = 5_000;

/**
 * A trigger that already did its one job: it fired once, a turn of the task took that fire and
 * ended (the phase moved after it), and no report of the task's has spoken since. A wait the
 * task's status still claims on it is a claim from before the fire, and nothing new is coming
 * from it, so it no longer keeps the task from reading stopped or stuck (2026-11-13, the org
 * reflection: a worker whose watch fired acknowledged and stopped; its status kept saying its
 * tests ran and its lead heard nothing all night). A trigger that fired twice or more is a
 * standing watch (task-wait-resume.ts triggersStanding) and always counts; so does any trigger
 * once a report after its fire names the wait again.
 */
export function triggerSpent(
  t: { fires?: number; firedAtMs?: number },
  task: Pick<Task, 'phase_changed_at' | 'status_report'>,
): boolean {
  if (t.fires !== 1 || typeof t.firedAtMs !== 'number') return false;
  const moved = Date.parse(task.phase_changed_at ?? '');
  if (!Number.isFinite(moved) || moved < t.firedAtMs + FIRE_CLOCK_SLACK_MS) return false;
  const reported = Date.parse(task.status_report?.at ?? '');
  return !(Number.isFinite(reported) && reported >= t.firedAtMs);
}

/** The routines that run in a task's session: armed triggers (a check), or plain scheduled runs;
 *  `checks`: when an armed trigger of the task last ran its check. */
async function readRoutines(kind: 'triggers' | 'schedules' | 'checks'): Promise<Map<string, any>> {
  const schedules = kind === 'schedules';
  const { wakesTask, wakeWordsOf } = await import('./routines/routine-wake-target.js');
  const out = new Map<string, any>();
  await safely('triggers', async () => {
    const { listRoutines } = await import('./routines/routines-core.js');
    const { triggerRunState } = await import('./cron/trigger-run-state.js');
    // Never behind the store's lock: every recorded trigger check holds it (ops.listKept).
    const { jobs } = await listRoutines(true, { kept: true });
    for (const job of jobs as import('./cron/types.js').CronJob[]) {
      const target = (job.executor?.config as { target?: unknown } | undefined)?.target;
      // Every executor kind that wakes the task its config names (routine-wake-target.ts).
      if (!wakesTask(job) || typeof target !== 'string' || !job.enabled) continue;
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
        const firedAtMs = lastFireAtMs(job);
        list.push({ id: job.id, name: wakeWordsOf(job), fires: job.state?.fireCount ?? 0, ...(firedAtMs !== undefined ? { firedAtMs } : {}), ...(job.ownWork ? { ownWork: true as const } : {}), ...(job.ownWork && job.state?.lastCheck?.idle === true ? { lastCheck: { idle: true as const, atMs: job.state.lastCheck.atMs } } : {}) });
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
 * The status facts of a session's turn (sessions/turn-run.ts): what Walnut continues it for, or what it
 * stopped continuing it for, each in the field its words come from (user-status.ts machineStop). A
 * restart loss speaks only for the CURRENT death: one recovery still holds (queued, sent), or one it
 * gave up on with no status change since. Total over the reasons: a new one needs its words here.
 */
export function turnWaitFacts(run: import('./sessions/turn-run.js').TurnRun, rec: Pick<import('./types.js').SessionRecord, 'process_status'>): Pick<SessionStatusFacts, 'endpointWait' | 'usageLimit' | 'restartLoss' | 'autoRetryAt'> {
  const out: ReturnType<typeof turnWaitFacts> = {};
  // A running turn speaks for itself; a restart loss is judged against liveness by machineStop.
  const idle = rec.process_status !== 'running';
  for (const w of [...run.waits, ...run.stops]) {
    switch (w.reason) {
      case 'usage_limit': if (idle) out.usageLimit ??= w.usageLimit; break;
      case 'endpoint_wait': if (idle) out.endpointWait ??= w.endpointWait; break;
      case 'restart_recovery': if (w.loss) out.restartLoss ??= w.loss; break;
      case 'auto_continue': if (idle) out.autoRetryAt ??= w.retryAt; break;
      // The phase holds while these work on the session: the task reads its phase.
      case 'safeguard_switch': case 'context_recovery': break;
      default: { const never: never = w; void never; }
    }
  }
  return out;
}

/** Task id -> the armed triggers that deliver into it (the status pass's cached read; org/thread-recheck.ts). */
export function armedTriggersByTask(): Promise<StatusFacts['triggers']> {
  return cachedSlow('triggers', []);
}

/** One armed trigger of a task, as the status facts hold it. */
export type TriggerFact = NonNullable<ReturnType<StatusFacts['triggers']['get']>>[number];

/**
 * A task's armed triggers that still stand: not a watch of its own ask (Task.recheck_watch, a wait
 * on the user), and not one that already did its one job while no turn runs (triggerSpent). Pure.
 */
export function standingTriggers(
  task: Pick<Task, 'recheck_watch' | 'phase_changed_at' | 'status_report'>, list: readonly TriggerFact[], anyRunning: boolean,
): TriggerFact[] {
  return list
    .filter((t) => !(task.recheck_watch ?? []).some((w) => w.trigger === t.id))
    .filter((t) => anyRunning || !triggerSpent(t, task));
}

/** The standing triggers that watch something outside the task: every one but a watch of its own work. Pure. */
export function outsideTriggers(live: readonly TriggerFact[]): TriggerFact[] {
  return live.filter((t) => !triggerWatchesOwnWork(t));
}

/**
 * The triggers that will really wake the task: its standing outside watches, and a watch of its own
 * work only while that work is in flight (ownWorkInFlight: the Mac queue's watch stays armed until
 * the task completes). `workEndedMs`: when its sessions last worked (allEndedAtMs). Pure.
 */
export function wakingTriggers(
  task: Pick<Task, 'recheck_watch' | 'phase_changed_at' | 'status_report'>, list: readonly TriggerFact[],
  s: { anyRunning: boolean; workEndedMs: number | undefined },
): TriggerFact[] {
  const live = standingTriggers(task, list, s.anyRunning);
  return [...outsideTriggers(live), ...live.filter((t) => ownWorkInFlight(t, s.workEndedMs))];
}

/** Read every fact source (the slow ones from the cache). Never throws: a store that cannot be
 *  read contributes nothing. `allIds` resolves a Board choice's task prefix; `everything`, the
 *  pass's list of every task, read as it is. */
export async function readStatusFacts(tasks: readonly Task[], allIds: readonly string[] = tasks.map((t) => t.id), followWorkersChoice?: boolean, everything?: readonly Task[]): Promise<StatusFacts> {
  const took: Record<string, number> = {};
  const taskIds = new Set(tasks.map((t) => t.id));
  const sessionIds = new Set<string>();
  for (const t of tasks) {
    if (t.session_id) sessionIds.add(t.session_id);
    for (const sid of t.session_ids ?? []) sessionIds.add(sid);
  }

  const sessions: StatusFacts['sessions'] = new Map();
  await timedRead(took, 'sessions', () => safely('sessions', async () => {
    const { listSessionsForTasks } = await import('./session-tracker.js');
    const runner = await import('../providers/claude-code-session.js').then((m) => m.sessionRunner).catch(() => null);
    const turns = await import('./sessions/turn-run.js');
    await turns.loadTurnRetriers();
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
      // What Walnut continues its turn for, or stopped continuing it for (sessions/turn-run.ts).
      const turn = turnWaitFacts(turns.turnRunNow(rec, { failed: true }), rec);
      sessions.set(rec.claudeSessionId, {
        ...(outliving.length ? { outliving } : {}),
        ...(hostDown ? { hostDown } : {}),
        // A quiet turn (Walnut's idle compaction, sessions/quiet-turn.ts) is no running work.
        processStatus: rec.process_status === 'running' && isQuietTurn(rec.claudeSessionId) ? 'idle' : rec.process_status,
        errorMessage: rec.errorMessage,
        errorReason: rec.status_reason, statusSince: rec.statusUpdatedAt || rec.last_status_change || rec.lastActiveAt,
        errorKind: rec.errorKind,
        ...turn,
        pendingTool: rec.pendingPermission ? (rec.pendingPermission.toolName ?? 'permission') : undefined,
        ...(rec.pendingPermission?.requestId ? { prompt: promptItem(rec.claudeSessionId, rec.pendingPermission) } : {}),
        taskId: rec.taskId, archived: rec.archived, startedAt: rec.startedAt,
        ...(rec.humanInputAt ? { humanInputAt: rec.humanInputAt } : {}),
        ...(sessionWorkEndedAtMs(rec) !== undefined ? { workEndedAt: sessionWorkEndedAtMs(rec) } : {}),
      });
    }
  }, undefined));

  const undelivered: NonNullable<StatusFacts['undelivered']> = new Map();
  await timedRead(took, 'undelivered', () => safely('undelivered', async () => {
    const { getQueue } = await import('./session-message-queue.js');
    const { parkMeansNeverRan } = await import('./sessions/undelivered-requests.js');
    const { waitsForFolderNow, noteToldUndelivered } = await import('./sessions/folder-wait.js');
    for (const sid of new Set([...sessionIds, ...sessions.keys()])) {
      for (const m of await getQueue(sid)) {
        // Only a park that proves the message never ran: a Stop's park is the user's choice. One that
        // waits on its gone folder goes by itself once the folder is back (folder-wait.ts): no failure.
        if (m.status !== 'parked' || !m.parkedAt || !parkMeansNeverRan(m.parkedReason)) continue;
        if (await waitsForFolderNow(m)) continue;
        // Shown to the user as not delivered: it never goes by itself after (he may type it again).
        await noteToldUndelivered(m);
        const prev = undelivered.get(sid);
        if (!prev || prev.at < m.parkedAt) undelivered.set(sid, { reason: m.parkedReason || 'it could not be delivered', at: m.parkedAt });
      }
    }
  }, undefined));

  const letters = await timedRead(took, 'letters', () => cachedSlow('letters', allIds));
  const reviews = reviewLetters;
  const letterItems = letterItemsNow;
  const approvals = await timedRead(took, 'approvals', () => cachedSlow('approvals', allIds));
  const choices = await timedRead(took, 'choices', () => cachedSlow('choices', allIds));

  const requestsFrom: StatusFacts['requestsFrom'] = new Map();
  await timedRead(took, 'requests', () => safely('requests', async () => {
    const { listPendingRequests } = await import('./session-requests.js');
    for (const r of await listPendingRequests()) {
      if (!r.toTaskId) continue;
      const list = requestsFrom.get(r.fromSessionId) ?? [];
      list.push(r.toTaskId);
      requestsFrom.set(r.fromSessionId, list);
    }
  }, undefined));

  const triggers = await timedRead(took, 'triggers', () => cachedSlow('triggers', allIds));
  const schedules = await timedRead(took, 'schedules', () => cachedSlow('schedules', allIds));
  const checks = await timedRead(took, 'checks', () => cachedSlow('checks', allIds));

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
  const threads = await timedRead(took, 'threads', () => readNodeThreads(tasks, everything));
  const { getConfig } = await import('./config-manager.js');
  const followWorkers = followWorkersChoice ?? experimentalEnabled((await getConfig()).experimental, 'leader_status_follows_workers');
  return { readMs: took, followWorkers, sessions, letters, letterItems, approvals, reviews, choices, requestsFrom, triggers, schedules, checks, titles, sessionsOf, undelivered, threads };
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

const openLeader = (t: Task): boolean => t.phase !== 'COMPLETE' && t.status !== 'done';

/** The input deriveUserStatus takes for one task, from the facts. Exported for tests. */
/** What a session's close left for the user, still open (sessions/owed-to-user.ts). */
function openOwedHold(task: Task): { ask: string; at: string } | null {
  const o = task.result_report?.owed;
  // A hold a lead's close made is that lead's to settle, never the user's Needs you.
  return o?.items?.length && !o.settled && !o.toCloser ? { ask: o.ask, at: o.at } : null;
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
  const liveTriggers = standingTriggers(task, facts.triggers.get(task.id) ?? [], anyRunning);
  return {
    phase: task.phase,
    status: task.status,
    hasSession: own.length > 0 || !!task.session_id,
    ...(task.last_start?.state === 'starting' || main?.errorReason === 'awaiting_spawn' ? { startInFlight: true } : {}),
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
    hasMain: !!facts.hasMain,
    autoRetryAt: main?.autoRetryAt ?? null,
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
    // Nor a trigger that already did its one job (triggerSpent) while no turn runs: the wait it
    // carried is over, and the task reads stopped or stuck, so its lead hears (org/lead-waits.ts).
    triggers: outsideTriggers(liveTriggers).map((t) => t.name),
    // A watch of its own work (watches:"own") is that work going on: Working, never "A watch" to wait on.
    // Only while the work is in flight: one whose latest check said nothing is (`"idle": true`) is
    // in neither list, no work of its own and no wait outside (ownWorkInFlight).
    // The idle mark counts only from a check after its sessions last worked (ownWorkInFlight).
    ownWorkTriggers: liveTriggers.filter((t) => ownWorkInFlight(t, allEndedAtMs(own.map(([, s]) => s.workEndedAt)))).map((t) => t.name),
    schedules: facts.schedules.get(task.id) ?? [],
    waitUntil: task.wait_until ?? null,
    hasLeader: !!task.parent_task_id,
    // A leader that completed hears nothing more from its subtasks: a failure goes past it.
    ...(task.parent_task_id && facts.tasksById?.has(task.parent_task_id) ? { leaderOpen: openLeader(facts.tasksById.get(task.parent_task_id)!) } : {}),
    openWorkers: facts.openWorkers?.get(task.id) ?? 0,
    workersAtWork: facts.workersAtWork?.get(task.id) ?? [],
    isMain: task.org_role === 'main',
    phaseChangedAt: task.phase_changed_at ?? null,
    owedHold: openOwedHold(task),
    workspaceHold: heldStart(task, own.map(([, s]) => s.startedAt)),
    report: task.status_report ?? null,
    lastWords: currentLastWords(task),
    markedByPerson: personMarkedNeeds(task),
    ...(isProgramRunTask(task) ? { programRun: true } : {}),
    personSpokeAt: own.map(([, s]) => s.humanInputAt).filter((at): at is string => !!at).sort().pop() ?? null,
    // The task's own session when it has one: an older session's pending report says nothing of this turn.
    reportPending: task.session_id ? isReportPending(task.session_id) : own.some(([sid]) => isReportPending(sid)),
    // The Router is an org node beside the VPs: its questions stay in its chat, as a lead's do.
    isLead: task.org_role === 'lead' || task.org_role === 'router',
    dueDate: task.due_date ?? null,
    checkRanAt: facts.checks?.get(task.id) ?? null,
    askCheckedAt: askCheckedAtOf(task, facts.checks, task.status_report?.state === 'needs' ? task.status_report.ask : null, task.status_report?.state === 'needs' ? task.status_report.ask_id : undefined, task.status_report?.state === 'needs' ? task.status_report.ask_legacy_key : undefined),
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
  facts.matter = matterIndex(everything);
  facts.shownAsks = everything.filter((t) => t.phase !== 'COMPLETE' && t.status !== 'done' && !t.plugin_only && !t.org_role
    && t.user_status?.state === 'needs' && !!t.user_status.ask && (t.user_status.source === 'session' || t.user_status.source === 'choice'));
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
  // With the org off no VP or Main hears a task (status-push.ts followContext), so none takes its failure.
  const orgOn = orgEnabledCached();
  facts.hasMain = orgOn && everything.some((t) => t.org_role === 'main' && t.phase !== 'COMPLETE' && t.status !== 'done');
  for (const t of everything) {
    if (!orgOn || t.org_role !== 'lead' || t.phase === 'COMPLETE' || t.status === 'done') continue;
    for (const p of [t.project, ...(t.org_leads ?? [])]) {
      const key = (p ?? '').trim().toLowerCase();
      if (key) facts.projectLeads.add(key);
    }
  }
}

/**
 * The sign-in state, kept SIGN_IN_KEEP_MS: reading it opens the inbox index and three files, the
 * dearest step of a pass of one task (0.2 to 1.3 s measured), and every pass asked again. Its
 * writers are the sign-in letters, whose events drop it, and a checker that runs every few minutes
 * and writes a file no event announces: the kept state is re-read when those files' stamp moved
 * (signInStateStamp, three stats), so the checker's word counts the moment it is written.
 */
const SIGN_IN_KEEP_MS = 30_000;
let signInKept: { at: number; stamp: string; state: NonNullable<StatusFacts['signIn']> } | null = null;
async function readSignInCached(): Promise<NonNullable<StatusFacts['signIn']>> {
  const stamp = await signInStateStamp();
  if (signInKept && signInKept.stamp === stamp && Date.now() - signInKept.at < SIGN_IN_KEEP_MS) return signInKept.state;
  const state = await readSignInState();
  signInKept = { at: Date.now(), stamp, state };
  return state;
}

/**
 * When a person last wrote to each task a stored same-ask fold names (same-ask.ts): the evidence
 * that the user answered the deeper task, so its ancestor's fold may stay once that task asks no more.
 * And to each task holding an ask the user withdrew: writing there after it lifts the withdrawal.
 */
export async function readFoldEvidence(facts: StatusFacts, targets: readonly Task[]): Promise<void> {
  const took = (facts.readMs ??= {});
  // One sign-in is one ask (sign-in-ask.ts): the user's login command words, every task's sign-in
  // ask shown now, and what Walnut knows of the sign-in itself.
  facts.loginWords = await timedRead(took, 'login-words', () => safely('login-words', async () => {
    const { getConfig } = await import('./config-manager.js');
    return (await import('./sign-in-ask.js')).loginCommandWords((await getConfig()).ssh_login_hint);
  }, []));
  facts.signInAsks = [...(facts.tasksById?.values() ?? [])]
    .filter((t) => t.phase !== 'COMPLETE' && t.status !== 'done' && t.user_status?.state === 'needs' && t.user_status.source === 'session'
      && isSignInAsk(t.user_status.ask, facts.loginWords ?? []))
    .map((t) => ({ id: t.id, title: t.title, ask: t.user_status!.ask!, createdAt: t.created_at }));
  facts.signIn = await timedRead(took, 'sign-in-state', () => safely('sign-in-state', readSignInCached, {}));
  const ids = new Set(targets.map((t) => t.user_status?.sameAsk?.id).filter((id): id is string => !!id));
  // A task holding a withdrawal too: a person writing in it after it lifts it (same-ask.ts answerHolds).
  for (const t of targets) if (answersOf(t).some((a) => a.withdrawn)) ids.add(t.id);
  facts.personInputAt = new Map();
  // threads_reply_tag: a holder whose decision is on a needs thread of its own still holds it, and his
  // message there is his word to it (org/thread-held-decision.ts). Empty with the experiment off.
  const named = new Set([...ids, ...targets.flatMap((t) => (t.status_report?.decision_owner ? [t.status_report.decision_owner.taskId] : []))]);
  facts.holderThreads = await timedRead(took, 'holder-threads', () => holderThreadsOf([...named].map((id) => facts.tasksById?.get(id))));
  for (const [id, h] of facts.holderThreads) if (h.heAt) facts.personInputAt.set(id, h.heAt);
  if (!ids.size) return;
  await timedRead(took, 'fold-evidence', () => safely('fold-evidence', async () => {
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
  }, undefined));
}

/** A task's own word on sameness (FOR_USER_ASK_SAME), only while its shown ask is that report's. */
function declaredOf(t: Task | undefined): Pick<NonNullable<Task['status_report']>, 'same_as' | 'ask_distinct' | 'decision_owner'> | null {
  const r = t?.status_report;
  if (!t || !r || t.user_status?.source !== 'session') return null;
  return reportIsCurrent({ report: r, phaseChangedAt: t.phase_changed_at }) ? r : null;
}

/**
 * Whether a task still holds `ask` while it is not shown as Needs you: its current report still
 * asks it (a turn runs on it), its report is on the way, or it is snoozed with it (same-ask.ts).
 */
function stillAsksOf(t: Task | undefined, ask: string, nowMs = Date.now(), held?: HolderThreads): boolean {
  if (!t || t.phase === 'COMPLETE' || t.status === 'done') return false;
  const key = askKey(ask);
  // Answered there for the user (a lead, VP or Main, or the answer reached its own holder): it no
  // longer holds it, and the fold reads answered.
  if (answerFor(answersOf(t), ask, nowMs, answerContextOf(t.status_report)) || answeredThereOf(t)) return false;
  // On a needs thread of its own, where he answers it (org/thread-held-decision.ts).
  if (holdsOnThread(t, held, ask)) return true;
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
export function askCheckedAtOf(task: Pick<Task, 'recheck_watch'>, checks: ReadonlyMap<string, string> | undefined, ask: string | null | undefined, decisionId?: string, legacyKey?: string): string | null {
  const key = askKey(ask);
  if (!key) return null;
  let best: string | null = null;
  for (const w of task.recheck_watch ?? []) {
    // Only a watch armed for this very ask (2026-11-04 review: one armed for an old ask stamped every
    // later one): its decision (ask-decision.ts), so the same ask reworded keeps its watch, else its words,
    // or the words it had when an older Walnut armed the watch before the decision had an id.
    if (w.watches !== 'ask' || (w.key !== key && !(decisionId && w.key === decisionId) && !(legacyKey && w.key === legacyKey))) continue;
    const at = checks?.get(`trigger:${w.trigger}`);
    if (at && (!best || at > best)) best = at;
  }
  return best;
}

/** When a lead, VP or Main answered `ask` of that task for the user (Task.ask_answered), or null. */
function answeredAtOf(t: Task | undefined, ask: string, nowMs = Date.now()): string | null {
  return (t && answerFor(answersOf(t), ask, nowMs, answerContextOf(t.status_report))?.at) ?? null;
}

/** Its open subtasks by parent id, for statusOf. */
export function childrenByParent(everything: readonly Task[]): Map<string, Task[]> {
  const childrenOf = new Map<string, Task[]>();
  for (const t of everything) if (t.parent_task_id) (childrenOf.get(t.parent_task_id) ?? childrenOf.set(t.parent_task_id, []).get(t.parent_task_id)!).push(t);
  return childrenOf;
}

/** One list per pass's task map, so the tree of every org node in the pass is read off one index
 *  (same-ask-tree.ts treeIndexOf) instead of a fresh copy of the board per node. */
const tasksLists = new WeakMap<ReadonlyMap<string, Task>, Task[]>();
function tasksListOf(byId: ReadonlyMap<string, Task>): Task[] {
  let list = tasksLists.get(byId);
  if (!list || list.length !== byId.size) tasksLists.set(byId, list = [...byId.values()]);
  return list;
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
): { input: UserStatusInput; status: UserStatus; own?: UserStatus } {
  const input = statusInputOf(task, facts, nowMs);
  const derived = deriveUserStatus(input, nowMs);
  const children = (childrenOf.get(task.id) ?? []).filter((child) => child.router_area_id === task.router_area_id);
  const asks = task.org_role ? [] : rollUpAsks(children, task.id);
  const withAsks = asks.length ? { ...derived, asks } : derived;
  // Org nodes keep their question in chat, not Needs you. It is still the same decision when
  // an owning worker already asks it, so turn that chat question into a pointer too.
  const forFold: UserStatus = task.org_role && derived.chatAsk && !derived.chatAskFrom
    ? { ...withAsks, state: 'needs', source: 'session', ask: derived.chatAsk } : withAsks;
  const nodeAsks = task.org_role && facts.tasksById
    ? treeAround(task.id, tasksListOf(facts.tasksById)).flatMap(({ task: t }) => t.user_status?.state === 'needs' && t.user_status.ask && (t.user_status.source === 'session' || t.user_status.source === 'choice')
      ? [{ id: t.id, title: t.title, ask: t.user_status.ask, ...(t.user_status.decision ? { decision: t.user_status.decision } : {}) }] : []) : asks;
  const foldedChat = foldSameAsk(task.id, forFold, nodeAsks, {
    report: reportIsCurrent(input) ? task.status_report?.decision_owner && !explicitDecisionOwner(task, facts)
      ? { ...task.status_report, same_as: undefined } : task.status_report ?? null : null,
    prev: task.user_status ?? null,
    decisionOwner: explicitDecisionOwner(task, facts),
    declared: (id) => declaredOf(facts.tasksById?.get(id)),
    personInputAt: (id) => facts.personInputAt?.get(id),
    stillAsks: (id, ask) => stillAsksOf(facts.tasksById?.get(id), ask, nowMs, facts.holderThreads?.get(id)),
    nowIso: new Date(nowMs).toISOString(),
    relatives: relativesWithSignIn(task, facts, withAsks),
    selfCreatedAt: task.created_at,
    answeredAt: (id, ask) => answeredAtOf(facts.tasksById?.get(id), ask, nowMs),
    answeredThere: (id) => answeredThereOf(facts.tasksById?.get(id)),
    withdrawnAt: (id, ask) => withdrawnAtOf(facts.tasksById?.get(id)?.asks_withdrawn, ask),
    signIn: (ask) => isSignInAsk(ask, facts.loginWords ?? []),
  });
  const folded = task.org_role && foldedChat.sameAsk
    ? (() => { const { chatAsk: _ask, chatAskFrom: _from, ...rest } = derived; return { ...rest, sameAsk: foldedChat.sameAsk, kind: 'task' as const, waitingOn: foldedChat.waitingOn }; })()
    : task.org_role ? withAsks : foldedChat;
  const owned = explicitDecisionOwner(task, facts);
  const canonical = owned && folded.sameAsk?.id === owned.id
    ? { ...folded, asks: (folded.asks ?? []).filter((a) => a.id !== task.id && (!derived.decision?.id || a.decision?.id !== derived.decision.id)) } : folded;
  const own = signInHeld(answeredAbove(canonical, answersOf(task), nowMs, facts.personInputAt?.get(task.id)), facts);
  // The experiment: a leader's status follows its workers (worker-status.ts). Main and a VP keep
  // their own rule (orgNodeNeverNeeds, their Threads); a worker not derived yet reads its phase.
  if (!facts.followWorkers || task.org_role || !children.length) return { input, status: withActions(task, facts, own, nowMs, input) };
  const workers = children.map((c): UserStatus => c.phase === 'COMPLETE' || c.status === 'done'
    ? { state: 'done' } : c.user_status ?? { state: fallbackUserState(c.phase, c.status) });
  return { input, status: withActions(task, facts, workerStatus(own, workers, { hasLeader: !!task.parent_task_id }), nowMs, input), own };
}

/** The live Action needed items of a task (action-needed.ts): its pending approvals, its sessions'
 *  live prompts and its open decision letters. Its own ask and Board choice come from its status. */
export function actionItemsOf(task: Task, facts: StatusFacts): ActionItem[] {
  const prompts = (facts.sessionsOf.get(task.id) ?? [])
    .map((sid) => facts.sessions.get(sid))
    .flatMap((s) => (s && !s.archived && s.prompt ? [s.prompt] : []));
  return [...prompts, ...(facts.approvals?.get(task.id) ?? []), ...(facts.letterItems?.get(task.id) ?? [])];
}

function withActions(task: Task, facts: StatusFacts, status: UserStatus, nowMs: number, input: UserStatusInput): UserStatus {
  // A team the user stopped, or a task he snoozed by its start date (a working one carries no
  // `snoozed` mark): its items ride along and raise nothing until it is resumed or wakes.
  const held = facts.teamStopped?.has(task.id) || !!snoozedUntil(task, facts.tasksById, nowMs);
  const out = applyActions(status, actionItemsOf(task, facts), task.action_snoozes, { orgNode: !!task.org_role, held, sessionId: task.session_id, nowMs });
  // Its lines (task-lines.ts), only with two or more: one line is what its row already says. Under
  // the experiment task_threads every line is a thread of the task's own (org/line-threads.ts), so
  // one is kept too.
  if (task.org_role) return out;
  const lines = taskLines(input, out, nowMs);
  return lines.length > (threadsForEveryTask() && keepsThreads(task) ? 0 : 1) ? { ...out, lines } : out;
}

function explicitDecisionOwner(task: Task, facts: StatusFacts): RelativeAsk | undefined {
  const ref = task.status_report?.decision_owner;
  if (!reportIsCurrent({ report: task.status_report, phaseChangedAt: task.phase_changed_at })) return undefined;
  if (!ref || !facts.tasksById) return undefined;
  return resolveDecisionOwner(task, ref.taskId, tasksListOf(facts.tasksById), ref, (id) => facts.holderThreads?.get(id));
}

/** Every task's sign-in asks beside its teammates', when its own ask is one (one sign-in is one ask). */
function relativesWithSignIn(task: Task, facts: StatusFacts, derived: UserStatus): RelativeAsk[] {
  const team = facts.relativeAsks?.(task) ?? [];
  if (derived.state !== 'needs' || !derived.ask || (derived.source !== 'session' && derived.source !== 'choice')) return team;
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
  const apart = (id: string) => !seen.has(id) && !above.has(id) && !chain(id).has(task.id);
  const out = [...team];
  if (derived.source === 'session' && isSignInAsk(derived.ask, facts.loginWords ?? [])) {
    for (const r of facts.signInAsks ?? []) if (apart(r.id)) { out.push(r); seen.add(r.id); }
  }
  // Another team's ask about the same matter (the ticket both name) is the same ask: the older shows it.
  // Session asks only: a Board choice passed its own check when it was put up, and a task's id
  // (a pointer) is for the write check, never a fold.
  if (facts.matter && !task.org_role && derived.source === 'session') {
    const index = facts.matter;
    const keys = new Set([...askMatter(task.id, derived.ask, index)].filter((k) => !index.isTaskId(k)));
    for (const t of keys.size ? facts.shownAsks ?? [] : []) {
      if (t.user_status!.source !== 'session' || !apart(t.id) || !sameTaskArea(task, t)) continue;
      const matter = sharedMatter(keys, index.own(t.id)) ?? matterNamedIn(keys, t.user_status!.ask);
      if (!matter) continue;
      out.push({ id: t.id, title: t.title, ask: t.user_status!.ask!, createdAt: t.created_at, matter, ...(t.user_status!.decision ? { decision: t.user_status!.decision } : {}) });
      seen.add(t.id);
    }
  }
  return out;
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

/** `ids` and every ancestor of each, stopping at a cycle. */
function withAncestors(ids: ReadonlySet<string>, tasks: readonly Task[]): Set<string> {
  const parentOf = new Map(tasks.map((t) => [t.id, t.parent_task_id] as const));
  const out = new Set(ids);
  for (const id of ids) {
    let parent = parentOf.get(id);
    while (parent && !out.has(parent)) { out.add(parent); parent = parentOf.get(parent); }
  }
  return out;
}

/** Children before parents, once each, even when imported data contains a cycle. */
function childrenFirst(tasks: readonly Task[], children: ReadonlyMap<string, readonly Task[]>): Task[] {
  const wanted = new Set(tasks.map((t) => t.id));
  const seen = new Set<string>();
  const out: Task[] = [];
  const visit = (t: Task) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    for (const c of children.get(t.id) ?? []) if (wanted.has(c.id)) visit(c);
    out.push(t);
  };
  for (const t of tasks) visit(t);
  return out;
}

/**
 * Derive and store the status of the given open tasks (all of them when `ids` is null).
 * Returns how many changed. A finished task is never written: every reader reads COMPLETE
 * as Done first, and a write to a COMPLETE row would announce it as completed again
 * (updateTaskRaw names the event by the phase), waking every completion listener.
 */
/** How long a write that answers a caller (brief_write, an action snooze) waits for the status pass
 *  it starts; the pass runs on past it. A pass on a busy Mac took 2 to 18 s (2026-11-20). */
export const STATUS_ANSWER_WAIT_MS = 2_000;

export async function syncUserStatuses(
  ids: ReadonlySet<string> | null, nowMs = Date.now(),
  /** How the tasks a change reaches next (its leader, a node linked to it, a same ask) are queued:
   *  the lane this pass ran in, so a hand's change stays fast for every hop. */
  follow: (id: string) => void = mark,
): Promise<number> {
  // The one writer of a task's user status, where the boot policy says statuses are written (the
  // leader): a replica stores none of its own (a host's copy reads only; the companion's would be a
  // second copy that disagrees), it derives for its readers instead (deriveUserStatuses).
  if (!bootPolicy('user-status')) return 0;
  const pass = ++passSeq;
  const leftTo = new Set<number>();
  let ended!: () => void;
  passes.set(pass, new Promise<void>((r) => { ended = r; }));
  try {
    return await derivePass(pass, ids, nowMs, follow, leftTo);
  } finally {
    passes.delete(pass);
    ended();
    // A task this pass left to a later one is written by that one: this pass returns only once it
    // has (a later pass never waits on an earlier one, so the waits never form a cycle).
    await Promise.all([...leftTo].map((p) => passes.get(p)).filter((p) => p !== undefined));
  }
}

/** What one pass derives from: every task, the ones it derives, and their facts read once. */
interface PassInputs {
  everything: Task[]; targets: Task[]; facts: StatusFacts; childrenOf: Map<string, Task[]>;
  ms: { t0: number; t1: number; t2: number; t2b: number; t3: number };
}

/** Read what a pass derives `ids` (null: every open task) from; null when none is open. */
async function readPass(ids: ReadonlySet<string> | null): Promise<PassInputs | null> {
  const { taskStoreForReplica } = await import('./task-manager.js');
  const t0 = Date.now();
  // The store's own rows (a write replaces a row, never edits it): the pass copies only the tasks
  // it derives, which it may write a status onto. A copy of the whole board per pass was about 480
  // copies of 8k tasks in ten minutes after a restart (2026-11-24, the taskCopiesBy note).
  const view = (await taskStoreForReplica()).tasks;
  const { getConfig } = await import('./config-manager.js');
  const followWorkers = experimentalEnabled((await getConfig()).experimental, 'leader_status_follows_workers');
  // While the experiment is on, a changed task's open ancestors are derived in the same pass,
  // children first (childrenFirst below), so a nested change reaches the top in one pass.
  const wanted = ids && followWorkers ? withAncestors(ids, view) : ids;
  const targetIds = new Set(view.filter((t) => (wanted ? wanted.has(t.id) : true) && openLeader(t)).map((t) => t.id));
  if (!targetIds.size) return null;
  const everything: Task[] = view.map((t) => (targetIds.has(t.id) ? { ...t } : t));
  const targets = everything.filter((t) => targetIds.has(t.id));
  const t1 = Date.now();
  const facts = await readStatusFacts(targets, everything.map((t) => t.id), followWorkers, everything);
  const t2 = Date.now();
  completeStatusFacts(facts, everything);
  const t2b = Date.now();
  await readFoldEvidence(facts, targets);
  const t3 = Date.now();
  return { everything, targets, facts, childrenOf: childrenByParent(everything), ms: { t0, t1, t2, t2b, t3 } };
}

/**
 * The status each of these open tasks has now, derived exactly as a pass derives it and written
 * nowhere: what a replica shows its readers for the tasks whose facts it holds newer than the
 * leader's stored copy (replica/away-status.ts; the plan's one source of the user status). A
 * finished task is not in the answer (it reads Done).
 */
export async function deriveUserStatuses(ids: ReadonlySet<string>, nowMs = Date.now()): Promise<Map<string, UserStatus>> {
  const out = new Map<string, UserStatus>();
  if (!ids.size) return out;
  const inputs = await readPass(ids);
  if (!inputs) return out;
  for (const task of inputs.targets) {
    if (ids.has(task.id)) out.set(task.id, statusOf(task, inputs.facts, inputs.childrenOf, nowMs).status);
  }
  return out;
}

async function derivePass(
  pass: number, ids: ReadonlySet<string> | null, nowMs: number, follow: (id: string) => void,
  /** The later passes this one left a task to. */
  leftTo: Set<number>,
): Promise<number> {
  const { updateTaskRaw } = await import('./task-manager.js');
  const inputs = await readPass(ids);
  if (!inputs) return 0;
  const { everything, targets, facts, childrenOf, ms: { t0, t1, t2, t2b, t3 } } = inputs;
  let changed = 0;
  const toClose: { task: Task; status: UserStatus }[] = [];
  const ordered = facts.followWorkers ? childrenFirst(targets, childrenOf) : targets;
  for (const task of ordered) {
    const { input, status: next, own } = statusOf(task, facts, childrenOf, nowMs);
    const settlesAt = handBackSettlesAt(task, next, nowMs, !!input.hasSession);
    // A routine run that ended with nothing for the user closes itself (routines/run-close.ts).
    // A candidate here (a triage run's `turn` too); closeRoutineRun decides with the triage check.
    // Judged on the task's own status: the worker rule only changes what is shown.
    if (settlesAt === null && routineRunToClose(task, own ?? next, true)) toClose.push({ task, status: own ?? next });
    // A pass that began later has derived it from newer facts (the fast lane beside a whole
    // pass): this one's answer is the older, and writing it would put a stale status back.
    const later = derivedBy.get(task.id) ?? 0;
    if (later > pass) { leftTo.add(later); continue; }
    derivedBy.set(task.id, pass);
    if (sameStatus(task.user_status, next)) continue;
    if (settlesAt !== null) {
      if (!settleTimers.has(task.id)) log.task.info('user-status: hand-back held', { taskId: task.id, untilMs: settlesAt });
      recheckAt(task.id, settlesAt);
      continue;
    }
    if (holdWrite) await holdWrite(task.id, pass);
    const res = await updateTaskRaw(task.id, { user_status: next }, {
      emitEvent: true, source: OWN_SOURCE,
      // Completed while its facts were read: it reads Done, and the write would announce it again.
      shouldUpdate: (cur) => cur.phase !== 'COMPLETE' && cur.status !== 'done' && (derivedBy.get(task.id) ?? 0) <= pass,
    }).catch((err) => {
      log.task.debug('user-status: write skipped', { taskId: task.id, error: errText(err) });
      return { changed: false };
    });
    // A later pass claimed it while this write waited for the lock (shouldUpdate refused it): that
    // pass writes it, and this one returns only once it has, like a task it skipped.
    const claimed = derivedBy.get(task.id) ?? 0;
    if (claimed > pass) leftTo.add(claimed);
    if (res.changed) {
      const prior = task.user_status;
      // With the experiment on, a parent later in this pass reads the accepted child status.
      if (facts.followWorkers) task.user_status = next;
      changed += 1;
      ownerThreadsChanged(task.id, follow);
      // Its ask, newly shown, goes on its thread when no thread holds it yet (org/thread-report-ask.ts).
      if (next.state === 'needs' || next.actions?.length) {
        void import('./org/thread-report-ask.js').then((m) => m.keepAskOnThread({ ...task, user_status: next })).catch(() => {});
      }
      // Its leader carries its questions (rollUpAsks): re-derived in the next pass, one level each.
      if (task.parent_task_id) follow(task.parent_task_id);
      // The tasks whose same ask waits on it (same-ask.ts) read its new status in the next pass.
      for (const t of everything) if (t.user_status?.sameAsk?.id === task.id) follow(t.id);
      // A teammate folded under another whose ask was just answered there is told once.
      if (next.sameAsk?.answered && next.sameAsk.team && !prior?.sameAsk?.answered) {
        void import('./sessions/ask-answer.js').then((m) => m.tellFoldAnswered(task, next.sameAsk!)).catch(() => {});
      }
      // Into Needs you: the line `walnut-logs.sh flips` pairs with the phase moves.
      if (next.state === 'needs' && prior?.state !== 'needs') {
        log.task.info('user-status: now needs you', { taskId: task.id, source: next.source });
      }
    }
  }
  // After the pass, never inside it: a close is a phase write that marks the task again.
  if (toClose.length) {
    const { closeRoutineRun } = await import('./routines/run-close.js');
    for (const c of toClose) await closeRoutineRun(c.task, c.status);
  }
  const totalMs = Date.now() - t0;
  if (totalMs >= SLOW_PASS_MS) {
    log.task.info('user-status: slow pass', {
      scope: ids ? ids.size : 'all', targets: targets.length, changed,
      listMs: t1 - t0, factsMs: t2 - t1, completeMs: t2b - t2, evidenceMs: t3 - t2b, deriveWriteMs: Date.now() - t3, totalMs,
      // The sources that took 50 ms or more, heaviest first.
      readMs: Object.fromEntries(Object.entries(facts.readMs ?? {}).filter(([, ms]) => ms >= 50).sort((a, b) => b[1] - a[1]).map(([k, ms]) => [k, Math.round(ms)])),
    });
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

let fastRestUntil = 0;
/** The longest the fast lane rests after a pass, however long that pass ran. */
const FAST_REST_MAX_MS = 1_000;

/** The fast lane (FAST_MS): a hand's change, derived at once and beside any pass that is running. */
function markNow(taskId: unknown): void {
  if (typeof taskId !== 'string' || !taskId) return;
  fast.add(taskId);
  scheduleFast();
}

function scheduleFast(): void {
  if (!live || fastTimer) return;
  // It rests as long as its last pass ran, so a stream of API writes (agents' ops are the API
  // too) never keeps it running back to back beside the ordinary lane.
  fastTimer = setTimeout(() => {
    fastTimer = null;
    void runFastPass();
  }, Math.max(FAST_MS, fastRestUntil - Date.now()));
  fastTimer.unref?.();
}

async function runFastPass(): Promise<void> {
  // One fast pass at a time: marks made meanwhile wait for it and run right after.
  if (fastRunning) { await fastRunning; if (fast.size) scheduleFast(); return; }
  const ids = fast;
  fast = new Set();
  if (!ids.size) return;
  const began = Date.now();
  fastRunning = syncUserStatuses(ids, began, markNow)
    .then((n) => { if (n) log.task.debug('user-status: statuses updated', { changed: n, scope: ids.size, lane: 'fast' }); })
    .catch((err) => {
      // Never lost: the ordinary lane derives them at its next pass.
      for (const id of ids) mark(id);
      log.task.warn('user-status: fast pass failed', { error: errText(err) });
    })
    .finally(() => {
      fastRunning = null;
      const now = Date.now();
      fastRestUntil = now + Math.min(now - began, FAST_REST_MAX_MS);
      if (fast.size) scheduleFast();
    });
  await fastRunning;
}

/** A session event names its session, not its task (the status snapshot has no taskId): look it up. */
function markSession(sessionId: unknown, lane: (taskId: unknown) => void = mark): void {
  if (typeof sessionId !== 'string' || !sessionId) { markAll(); return; }
  import('./session-tracker.js')
    .then(({ getSessionByClaudeId }) => getSessionByClaudeId(sessionId))
    .then((rec) => { if (rec?.taskId) lane(rec.taskId); else markAll(); })
    .catch(() => markAll());
}

/** A session event whose status no later write of the turn corrects: a turn that runs now, a
 *  prompt opened or answered, a session started (onEvent's fast lane). */
export function sessionMovesNow(name: string, d: Record<string, any>): boolean {
  if (name === EventNames.SESSION_PERMISSION_REQUEST || name === EventNames.SESSION_PERMISSION_RESOLVED || name === EventNames.SESSION_STARTED) return true;
  return name === EventNames.SESSION_STATUS_CHANGED && (d.process_status ?? d.status?.process_status) === 'running';
}

/** Each host's link as the last host:status frame said it (up or not), so only a change re-derives. */
const hostUp = new Map<string, boolean>();

function markAll(): void {
  all = true;
  schedule();
}

/** The experiment's value as of the last config change seen (undefined: none seen yet). */
let followWorkersSeen: boolean | undefined;
let popUpSeen: boolean | undefined;
let threadsSeen: boolean | undefined;
let lettersAsThreadsSeen: boolean | undefined;
let oneCardSeen: boolean | undefined;
let briefOffSeen: boolean | undefined;
let oneIdSeen: boolean | undefined;

async function experimentSwitched(): Promise<boolean> {
  const { getConfig } = await import('./config-manager.js');
  const flags = (await getConfig()).experimental;
  const now = experimentalEnabled(flags, 'leader_status_follows_workers');
  const moved = followWorkersSeen !== undefined && followWorkersSeen !== now;
  followWorkersSeen = now;
  // Threads for every task (keeps-threads.ts): a switch moves which tasks read their threads here.
  const { setThreadsForEveryTask } = await import('./org/keeps-threads.js');
  const every = experimentalEnabled(flags, 'task_threads');
  // Its own record of the value (from off at boot): a prompt build may have read the switch first (prompt-inputs.ts).
  const threadsMoved = (threadsSeen ?? false) !== every;
  threadsSeen = every;
  setThreadsForEveryTask(every);
  // Threads pop up (org/thread-popup.ts): a switch moves every node's counts. Its own record of
  // the value, since a route's read of the config sets the shared one too.
  const { setThreadsPopUp } = await import('./org/thread-popup.js');
  const popUp = experimentalEnabled(flags, 'threads_pop_up');
  const popMoved = popUpSeen !== undefined && popUpSeen !== popUp;
  popUpSeen = popUp;
  setThreadsPopUp(popUp);
  if (popMoved) threadsChanged();
  // One card (org/one-card.ts): a task's own ask on its thread moves what its threads count.
  const { setOneCard } = await import('./org/one-card.js');
  const oneCard = experimentalEnabled(flags, 'threads_one_card');
  const oneCardMoved = oneCardSeen !== undefined && oneCardSeen !== oneCard;
  oneCardSeen = oneCard;
  setOneCard(oneCard);
  if (oneCardMoved) threadsChanged();
  // One thread across a hand-off (org/thread-one-id.ts): a switch moves which handed threads count on the node that handed them.
  const oneId = experimentalEnabled(flags, 'threads_one_id');
  const oneIdMoved = oneIdSeen !== undefined && oneIdSeen !== oneId;
  if (oneIdMoved) threadsChanged();
  oneIdSeen = oneId;
  setThreadsOneId(oneId);
  // Walnut keeps the Threads (org/threads-kept.ts): read by the prompt, the hints and the status question.
  const { setThreadsKept } = await import('./org/threads-kept.js');
  setThreadsKept(experimentalEnabled(flags, 'threads_kept_by_walnut'));
  // A reply is its thread's reply (org/reply-card-switch.ts): read by the prompt, the hint and the status question.
  (await import('./org/reply-card-switch.js')).setReplyTag(experimentalEnabled(flags, 'threads_reply_tag'));
  // Decision letters as threads (human-inbox/letter-threads.ts): a switch moves which letters count.
  const asThreads = experimentalEnabled(flags, 'letters_as_threads');
  const lettersMoved = lettersAsThreadsSeen !== undefined && lettersAsThreadsSeen !== asThreads;
  lettersAsThreadsSeen = asThreads;
  // Which tasks keep Threads moved too: a letter their thread held counts again, or no more.
  if (lettersMoved || (threadsMoved && asThreads)) dropSlow('letters');
  // The Brief off (org/brief-off.ts): a Board choice its thread holds counts there, or on its task again.
  const briefOff = experimentalEnabled(flags, 'brief_off');
  const briefOffMoved = briefOffSeen !== undefined && briefOffSeen !== briefOff;
  briefOffSeen = briefOff;
  setBriefOff(briefOff);
  if (briefOffMoved || (threadsMoved && briefOff)) dropSlow('choices');
  return moved || threadsMoved || popMoved || lettersMoved || oneCardMoved || briefOffMoved || oneIdMoved;
}

/**
 * A host's facts read back long after they happened (a leader that was away, BusEvent.late): the
 * whole backlog's tasks are derived once, after it has gone quiet, in the ordinary lane; never the
 * fast lane, and never once per fact (session-channel/late-gather.ts).
 */
const lateTasks = createLateGather((ids) => { for (const id of ids) mark(id); });
const markLate = (taskId: unknown): void => { if (typeof taskId === 'string') lateTasks.add(taskId); };

function onEvent(event: { name: string; data: unknown; source?: string; late?: true }): void {
  // Its own writes, and the activity stamp a session writes on every event, move nothing here.
  if (event.source === OWN_SOURCE || event.source === 'session-touch') return;
  const d = (event.data ?? {}) as Record<string, any>;
  switch (event.name) {
    case EventNames.TASK_CREATED:
    case EventNames.TASK_UPDATED:
    case EventNames.TASK_COMPLETED: {
      // A write through the API is a hand's (a person's click, an agent's op): the fast lane.
      const lane = event.source && FAST_SOURCES.has(event.source) ? markNow : mark;
      lane(d.task?.id);
      // A finished or moved subtask's question leaves its leader's list (rollUpAsks); the event
      // names only the new parent, so a former one drops it at the minute sweep.
      lane(d.task?.parent_task_id);
      // Thread ask pointers depend on linked task decisions, not only thread-file writes.
      if (typeof d.task?.id === 'string') ownerThreadsChanged(d.task.id, lane);
      // letters_as_threads: a task whose thread holds a letter stopped keeping Threads or finished: the letter counts again.
      if (typeof d.task?.id === 'string' && lettersAsThreadsNow() && holdsLettersNow(d.task.id)) dropSlow('letters');
      return;
    }
    case EventNames.CONFIG_CHANGED:
      // Every status is derived again only when the experiment was switched (worker-status.ts).
      void experimentSwitched().then((moved) => { if (moved) markAll(); }).catch(() => {});
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
    {
      // A turn that starts (an answer the user gave reaching its session) or a prompt that opens or
      // is answered: the fast lane, for its task alone. A page predicts Working for an answer on its
      // way and holds that until this lands (OrgPage answers.start); behind the debounce and a pass
      // of every task it lapsed first (2026-11-19: the row went back to Needs you, then to Working).
      // A running turn reads Working whatever the phase, so nothing later corrects it. A turn that
      // ends keeps the debounce: its report and phase write follow it and fold into one pass.
      // Status events come only on a change, and the lane rests as long as its last pass ran.
      const lane = event.late ? markLate : sessionMovesNow(event.name, d) ? markNow : mark;
      if (d.taskId) lane(d.taskId); else markSession(d.sessionId, lane);
      return;
    }
    case APPROVAL_CHANGED: {
      // Its asking task gains or loses an Action needed item.
      dropSlow('approvals');
      const tid = d.approval?.requester?.taskId;
      if (typeof tid === 'string') mark(tid); else markAll();
      return;
    }
    case EventNames.HUMAN_INBOX_LETTER:
    case LETTER_ANSWERED:
    case LETTER_STATE:
      // A pin moves no status.
      if (event.name === LETTER_STATE && d.field === 'pinned') return;
      dropSlow('letters');
      // Answered, read or archived by hand: its sender's task alone, now. An event that names
      // no task (an older emitter, a plugin's letter) is a whole pass.
      if (typeof d.taskId === 'string' && d.taskId) markNow(d.taskId); else markAll();
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
      // Acted on by hand (the Org page, the phone, a node's own op): the fast lane, its dot moves now.
      // (threads_pop_up: the nodes above a task hear its change as their own: org/thread-reply.ts.)
      if (typeof d.taskId === 'string') { threadsChanged(d.taskId); markNow(d.taskId); } else { threadsChanged(); markAll(); }
      // A node whose thread names that task may list its result (org/thread-subject-pairs.ts carried).
      if (typeof d.taskId === 'string' && (popUpNow() || oneIdNow())) ownerThreadsChanged(d.taskId, mark);
      // letters_as_threads: whether a thread still holds a letter decides whether the letter counts.
      if (lettersAsThreadsNow() && (typeof d.threadId !== 'string' || isLetterThread(d.threadId))) dropSlow('letters');
      // brief_off: whether a thread still holds a Board choice decides whether the choice counts.
      if (briefOffNow() && (typeof d.threadId !== 'string' || isChoiceThread(d.threadId))) dropSlow('choices');
      return;
  }
}

let stopRetryFollow: (() => void) | null = null;

export function startUserStatusSync(): void {
  if (!bootPolicy('user-status') || live) return;
  live = true;
  void experimentSwitched().catch(() => {});
  bus.subscribe(SUBSCRIBER, onEvent as never, {
    global: true,
    interest: [
      EventNames.TASK_CREATED, EventNames.TASK_UPDATED, EventNames.TASK_COMPLETED,
      EventNames.SESSION_STATUS_CHANGED, EventNames.SESSION_PERMISSION_REQUEST, EventNames.SESSION_PERMISSION_RESOLVED,
      EventNames.SESSION_ENDED, EventNames.SESSION_STARTED, EventNames.SESSION_USAGE_LIMIT,
      EventNames.HUMAN_INBOX_LETTER, LETTER_ANSWERED, LETTER_STATE, APPROVAL_CHANGED, EventNames.BOARD_CHANGED,
      EventNames.CRON_JOB_ADDED, EventNames.CRON_JOB_UPDATED, EventNames.CRON_JOB_REMOVED,
      EventNames.ORG_THREADS_CHANGED, EventNames.HOST_STATUS, EventNames.CONFIG_CHANGED,
    ],
  });
  // A turn-end report armed, asked or settled changes what the task waits on (user-status.ts).
  onReportPendingChange((sid) => markSession(sid));
  // Walnut's own retry of a failed turn armed, fired or cancelled: the task waits on it, or no more.
  void import('./session-auto-continue.js').then(({ onAutoRetryChange }) => {
    if (live) stopRetryFollow = onAutoRetryChange((sid) => markSession(sid));
  })
    .catch((err) => log.task.warn('user-status: auto-retry changes not followed', { error: errText(err) }));
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

/** Tests only: awaited before each status write, to hold one pass's write while another runs. */
let holdWrite: ((taskId: string, pass: number) => Promise<void>) | null = null;
export function holdStatusWritesForTest(fn: typeof holdWrite): void { holdWrite = fn; }

/**
 * Run what is pending now and wait until no pass is queued or running, so a test that watches
 * events from a point on starts after the statuses its setup moved were written, not inside
 * the debounce window (2026-10-26: an SSE "no replay" check read a late status write as one).
 */
export async function settleUserStatusSync(): Promise<void> {
  lateTasks.flush();
  for (let i = 0; i < 8; i++) {
    if (fastTimer) { clearTimeout(fastTimer); fastTimer = null; void runFastPass(); }
    if (fastRunning) { await fastRunning; continue; }
    if (timer) { clearTimeout(timer); timer = null; void runPass(); }
    if (running) { await running; continue; }
    if (!timer && !fastTimer) return;
  }
}

export function stopUserStatusSync(): void {
  bus.unsubscribe(SUBSCRIBER);
  lateTasks.stop();
  onReportPendingChange(null);
  stopRetryFollow?.();
  stopRetryFollow = null;
  if (missedReportsTimer) clearTimeout(missedReportsTimer);
  missedReportsTimer = null;
  live = false;
  if (timer) clearTimeout(timer);
  if (fastTimer) clearTimeout(fastTimer);
  if (sweep) clearInterval(sweep);
  timer = null;
  fastTimer = null;
  sweep = null;
  dirty = new Set();
  fast = new Set();
  derivedBy.clear();
  all = false;
  for (const t of settleTimers.values()) clearTimeout(t);
  settleTimers.clear();
  threadOwners.clear();
  dropSlow();
  threadsChanged();
  joined.clear();
  threadsReadAllAt = Date.now();
}
