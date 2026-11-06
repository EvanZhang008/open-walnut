/**
 * The ONE status the user sees for a task (2026-10-25, the user: "I don't even know what
 * needs me, what not, and what exactly it is waiting for"). Five states, the same on the
 * Board, the Org page, the task list and the phone:
 *
 *   needs    Needs you: the task's phase is NEED_ACTION (or a live prompt blocks on the user).
 *            Always says what to do: the prompt, the letter, the Board choice, the failure, or
 *            the session's own ask.
 *   read     To read: nothing is asked, only something to read (ToRead): it finished and its
 *            result is there, or its turn answered the user's message (2026-11-02, the user:
 *            these sat under Waiting wearing the needs ring, "this is not waiting").
 *   working  Working: a turn runs, or the task's own work goes on without one (its build, test
 *            run, CI run, deploy or land, which wakes it: ownWork), or its session's own work runs
 *            on after its turn (a background subagent or command, a team, a wakeup or a /loop:
 *            sessions/outliving-work.ts). 2026-11-02, the user: "it is not finish it is working
 *            right, the implementaiton is working, then why it is waiting".
 *   waiting  Waiting: really blocked outside its own work (a person's review or reply, another
 *            task, its lead, a set time, this machine, not started yet), or snoozed;
 *            `stuck` when it was in progress and nothing will wake it.
 *   done     Done: COMPLETE.
 *
 * The state is the task's own phase, never a guess that can contradict it (2026-10-26: one
 * surface counted 5 "need you" while the tasks' phases said 1, from letters, Board choices and
 * reports read on their own). The task keeps its phase right itself: its turn's own report moves
 * it (session-hooks/builtins.ts), a standing routine goes back to WAITING at its turn's end
 * (phase.ts), its leader or the user may set it, and an answer is a message, which starts a turn.
 * The facts and the session's report (`task.status_report`) only give the words.
 *
 * Pure and browser-safe: the server (org counts, API payloads) and the web app import it.
 */

import { infraStopCause } from './session-error-kind.js';
import { endpointGaveUpWords, endpointWords } from './sessions/endpoint-unreachable.js';
import type { SessionEndpointWait } from './types.js';
import { startDateMs } from './snooze.js';
import { cutEnd } from './text-cut.js';
import type { ThreadCounts } from './org/thread-view.js';
import { outlivingLine, type OutlivingSource } from './sessions/outliving-work.js';
import type { SameAskFold } from './same-ask.js';

export type UserState = 'needs' | 'read' | 'working' | 'waiting' | 'done';

/**
 * On what a waiting task waits. `outside`: a review, a reply, a pipeline someone else runs, from
 * outside Walnut. `own` is a report's word only (FOR_USER_WAITING_ON own:): the task's own build,
 * test run, CI run, deploy or land runs and wakes it, which reads Working, never Waiting (ownWork).
 */
export type WaitKind = 'task' | 'time' | 'machine' | 'outside' | 'own' | 'you' | 'lead' | 'not-started' | 'stuck' | 'other';

/** In the order every surface draws them: what needs the user first, finished work last. */
export const USER_STATES: readonly UserState[] = ['needs', 'read', 'working', 'waiting', 'done'];

/**
 * A state an older reader knows (an iOS build or a companion from before To read): To read was
 * Waiting with `toRead` set there. Pure; for a writer that must keep an older client's shape.
 */
export function legacyUserState(state: UserState): Exclude<UserState, 'read'> {
  return state === 'read' ? 'waiting' : state;
}

/** The state a stored status reads as: a To read an older server stored as Waiting with `toRead`
 *  (and no snooze) is To read. Every reader of a stored status reads it through this. Pure. */
export function storedUserState(s: Pick<UserStatus, 'state' | 'toRead' | 'snoozed'>): UserState {
  return s.state === 'waiting' && s.toRead && !s.snoozed ? 'read' : s.state;
}

/** The report kinds that name a wait outside the user by themselves (sessions/outside-wait.ts):
 *  `own` too, its own work that wakes it, which may park it on a trigger and reads Working. */
export const OUTSIDE_WAIT_KINDS: ReadonlySet<WaitKind> = new Set<WaitKind>(['task', 'lead', 'machine', 'outside', 'own']);

/** The words a wait on the user starts with: "you: ...", "the user to paste ...", "your call". */
const ON_USER_RE = /^\s*(?:(?:waiting\s+)?(?:on|for)\s+)?(?:you|your|user|the user)(?:'s)?(?![\w-])/i;
/** The kind prefix alone ("you: ...", "user: ..."): what overrides a kind that names an outside wait. */
const ON_USER_PREFIX_RE = /^\s*(?:you|user|the user)\s*[:\uff1a]/i;

/**
 * Whether wait words say the wait is on the user. Pure. `strict`: only the "you:" / "user:"
 * prefix counts, for words under a kind that names an outside wait ("outside: your PR's CI run").
 */
export function waitWordsNameUser(words: string | null | undefined, strict = false): boolean {
  return (strict ? ON_USER_PREFIX_RE : ON_USER_RE).test(words ?? '');
}

/** Someone other than the user is above it: its leader, or for Main and a lead their teams' side. */
function hasAbove(input: Pick<UserStatusInput, 'hasLeader' | 'isMain' | 'isLead'>): boolean {
  return !!(input.hasLeader || input.isMain || input.isLead);
}

/** A waiting report whose wait is the user's to end: on them, or on nothing it names outside. A
 *  wait on its lead by a task with none is the user's too (they are the one above it). */
function waitIsUsers(report: StatusReport | null | undefined, hasLeader: boolean): boolean {
  if (report?.state !== 'waiting') return false;
  // An ask that named no kind of the user's own is no ask of theirs (readStatusReport).
  if (report.kindless_ask) return false;
  const kind = report.waiting_kind;
  if (kind === 'lead' && !hasLeader) return true;
  if (kind && OUTSIDE_WAIT_KINDS.has(kind)) return waitWordsNameUser(report.waiting_on, true);
  return true;
}

/** The names a person reads, the same on every surface (2026-10-30, the user: "we make the
 *  whole system's naming clear ... the same everywhere ... four small tabs"; To read joined them
 *  2026-11-02). No other words for them: not "need you", "needs me", "handed back" or "stuck" as a state. */
export const USER_STATE_LABELS: Record<UserState, string> = {
  needs: 'Needs you', read: 'To read', working: 'Working', waiting: 'Waiting / snoozed', done: 'Completed',
};

/**
 * The one word for a state in text an agent reads about one task (a status push, the subtask
 * count): "Snoozed" or "Waiting", never the people's tab name "Waiting / snoozed".
 */
export function stateWord(state: UserState, snoozed = false): string {
  if (state !== 'waiting') return USER_STATE_LABELS[state];
  return snoozed ? 'Snoozed' : 'Waiting';
}

/** What each name means, in one plain line (shown where a surface explains its tabs). */
export const USER_STATE_MEANINGS: Record<UserState, string> = {
  needs: 'The next move is yours (an answer, a review, a decision), and it is not snoozed.',
  read: 'Nothing is asked of you: it finished, or answered you, and there is something to read.',
  working: 'A turn is running, or its own work goes on (its build, test run, deploy) and wakes it.',
  waiting: 'It is blocked on something outside its own work (a person\'s review or reply, another task, a set time), or you snoozed it; until when is shown.',
  done: 'Finished.',
};

/** A count in those names: "3 Needs you", "2 To read", "8 Working", "2 Waiting / snoozed", "5 Completed". */
export function stateCountLabel(state: UserState, n: number): string {
  return `${n} ${USER_STATE_LABELS[state]}`;
}

/** The session's own report of its last turn, in the user's words (self-report FOR_USER_*). */
export interface StatusReport {
  state?: UserState;
  /** needs: the one thing the user must decide or do. */
  ask?: string;
  waiting_kind?: WaitKind;
  /** waiting: on what exactly. */
  waiting_on?: string;
  /** Where the work stands, one sentence. */
  now?: string;
  /** Who does what next, one sentence. */
  next?: string;
  /** When the session wrote it (ISO). */
  at: string;
  /** When the turn it reports on ended (ISO); absent on a report an older Walnut stored. */
  turn_ended_at?: string;
  /** The turn it reports on answered a message a person sent (sessions/report-phase.ts
   *  answeredPerson): its words are for the user to read, so it never parks the task. */
  answered_person?: boolean;
  /** needs: how the user answers (AskForm.kind); left out = text. */
  ask_kind?: AskKind;
  /** needs, single or multi: the few options worth showing. */
  ask_options?: AskOption[];
  /** needs: the detail behind the ask, shown under More. */
  ask_more?: string;
  /** needs: which of the user's own kinds the ask is, and why (org/user-kind.ts). */
  ask_own?: { kind: string; why: string };
  /**
   * The report named an ask but no kind of the user's own (2026-11-02, the user: "why ask me, just go"):
   * the ask is no ask of the user, so it reads as a report to its lead (waiting_kind lead, its words in
   * waiting_on), and a task with no lead above it reads as finished, to read and close.
   */
  kindless_ask?: true;
  /** The status rules it was asked under (STATUS_RULE_VERSION); absent = before 2026-11-02, when a
   *  task's own build read as a wait (status-reconcile.ts asks such a wait again once). */
  rule?: number;
  /** Who wrote it when not the task's own session (sessions/report-set.ts): its lead, VP or Main
   *  (`task:<id>`), or a person. The task's next own report replaces it. */
  by?: StatusLineBy;
  /** The setter task's title, for display. */
  by_name?: string;
  /** needs: the session said its ask is the same decision as the open ask of this task in its tree
   *  (FOR_USER_ASK_SAME, same-ask.ts): the user sees it once, from the deeper of the two. */
  same_as?: string;
  /** needs: the session said its ask is a different decision from the ones its tree asks
   *  (FOR_USER_ASK_SAME: different): Walnut's word test never folds it. */
  ask_distinct?: true;
}

/** The status rules a report is asked under: 2 = the task's own build, test run, deploy or land is
 *  working, not waiting (2026-11-02). */
export const STATUS_RULE_VERSION = 2;

/** How the user answers an ask: yes or no, one of a few options, several of them, or their own words. */
export type AskKind = 'yes_no' | 'single' | 'multi' | 'text';
export interface AskOption { id: string; label: string; recommended?: boolean }
export const ASK_KINDS: readonly AskKind[] = ['yes_no', 'single', 'multi', 'text'];
export const ASK_SUMMARY_MAX = 120;
export const ASK_MORE_MAX = 2000;
export const ASK_OPTIONS_MAX = 5;

/**
 * A session's ask in a shape a person answers in one click (2026-10-31, the user: "don't put too many
 * options to just occupied space, put actually valuable one, they can just yes and no, or single or
 * multiple choice, or text right, ideally prefer non text, and show the summary of the issue very
 * clear, with potentially a more section"). `ask` stays its plain text for older readers. Yes / No
 * carry no options (ids `yes`, `no`); single and multi carry 2 to 5; text none.
 */
export interface AskForm {
  summary: string;
  more?: string;
  kind: AskKind;
  options?: AskOption[];
}

/** Who wrote a task's own line: the task itself, another task, or a person. */
export type StatusLineBy = 'self' | 'human' | `task:${string}`;

/**
 * The task's own words for where it stands (2026-10-31, the user: "each task shoud be giving the what
 * is waiting next ... vp can chaneg it but each task mange it self"): the concrete ask when it needs
 * the user, on whom or what it waits when waiting, its next step when working. From its current report
 * (its turn-end self-report, or a change its lead, VP, Main or a person made), only while that report
 * says the state the facts give.
 */
export interface StatusLine {
  text: string;
  by: StatusLineBy;
  byName?: string;
  at: string;
}

/** The facts a status is derived from. Everything optional: a missing fact never invents a state. */
export interface UserStatusInput {
  phase?: string;
  /** Legacy `status: 'done'` rows. */
  status?: string;
  /** The task has (or had) a session. */
  hasSession?: boolean;
  /** Its start waits for a free slot on a host (Task.start_queue, sessions/start-queue.ts). */
  startQueue?: { host?: string; reason?: string } | null;
  /** Its last start was refused or failed and no session ran since: why ("Did not start: ..."). */
  startFailed?: string | null;
  /** Its session's process status (running / idle / stopped / error). */
  processStatus?: string;
  /** Its session's own work that runs on after its turn (sessions/outliving-work.ts): a background
   *  command or subagent, its agent team, a wakeup or a /loop it armed. Read only with a live process. */
  outliving?: readonly OutlivingSource[];
  errorMessage?: string | null;
  /** Why its session stopped (SessionRecord.status_reason): a lost host is Walnut's to recover. */
  errorReason?: string | null;
  /** Its session's error class (SessionRecord.errorKind): 'infra' = the machine's, not the work's. */
  errorKind?: string | null;
  /** A restart killed its session (SessionRecord.restartLoss): only a loss of its current death
   *  that recovery still holds (queued, sent) or gave up on; the sync drops every other. */
  restartLoss?: { state: string; cause?: string } | null;
  /** Its last turn could not reach the model endpoint (SessionRecord.endpointWait): Walnut waits for
   *  it and continues the turn (sessions/endpoint-wait.ts), so it waits on its machine, not the user,
   *  until the wait gives up. The sync passes it only while no turn runs. */
  endpointWait?: Pick<SessionEndpointWait, 'state' | 'url' | 'where' | 'since' | 'resumes' | 'gaveUpWhy' | 'probeError'> | null;
  /** Its project has an open lead (a VP), who restarts what Walnut could not. */
  projectLead?: boolean;
  /** A message to its session was parked, never delivered, since the phase last moved: the reason. */
  undeliveredMessage?: string | null;
  /** When its session's status last moved (ISO). */
  statusSince?: string | null;
  /** A live permission prompt or question the session is blocked on. */
  pendingPermissionTool?: string | null;
  /** An unanswered action_required letter this task sent (its subject). */
  openLetter?: string | null;
  /** An open review letter this task sent (its subject): only names what the user does (category). */
  openReview?: string | null;
  /** Main or a lead: its Threads, the user's own requests to it (org/thread-view.ts threadCounts). */
  threads?: ThreadCounts | null;
  /** An unanswered Board choice about this task (its title). */
  openChoice?: string | null;
  /** When that choice was last written on its Board (ISO); null = no time recorded (older Board). */
  openChoiceAt?: string | null;
  /** The Board it is on (its owner task) and its id, for the re-check (sessions/needs-recheck.ts). */
  openChoiceRef?: { board: string; id: string } | null;
  /** Titles of tasks this task's session waits on for a reply. */
  waitingOnTasks?: readonly string[];
  /** Armed triggers that will wake this task (their names). */
  triggers?: readonly string[];
  /** Enabled scheduled routines that run in this task's session, with their next run (ISO). */
  schedules?: readonly { name: string; nextAt?: string | null }[];
  waitUntil?: string | null;
  /** The task has a leader (a parent task). */
  hasLeader?: boolean;
  /** Its open subtasks: their news (a completion, an error) wakes it. */
  openWorkers?: number;
  /** Main (org_role 'main'): the user's next message or a team's news wakes it, never a timer. */
  isMain?: boolean;
  /** Its last message since its latest hand-back (sessions/last-words.ts), for a turn that left no report. */
  lastWords?: string | null;
  /** A person set its current NEED_ACTION themself (sessions/person-needs.ts): their own ask. */
  markedByPerson?: boolean;
  /** A lead (org_role 'lead'): like Main, never closed. */
  isLead?: boolean;
  /** A session's close left these for the user (result_report.owed, sessions/owed-to-user.ts):
   *  Needs you until they are settled, whatever its later turns report. */
  owedHold?: { ask: string; at: string } | null;
  /** When the phase last moved (a turn's end, a park). A report older than this was written
   *  before the latest turn and only lends its words, never the state. */
  phaseChangedAt?: string | null;
  report?: StatusReport | null;
  /** Its session's turn-end report is still to come (sessions/report-pending.ts). */
  reportPending?: boolean;
  /** Task.due_date: a date (YYYY-MM-DD, the end of that day here) or a full ISO time. */
  dueDate?: string | null;
  /** When its team was stopped in one step, not resumed since (Task.team_stop on its team's root). */
  teamStoppedAt?: string | null;
  /** When an armed trigger of the task last ran its check (ISO): shown, never counted as a check. */
  checkRanAt?: string | null;
  /** When a trigger armed to watch this task's ask of the user (watches:"ask") last checked it
   *  without an error (ISO, to 10 minutes): that run confirms the ask, so it counts as a check. */
  askCheckedAt?: string | null;
  /** The start date it is snoozed until, while that is still to come (snooze.ts snoozedUntil). */
  snoozedUntil?: string | null;
}

/** 2026-10-27, the user: "If the task is closed, mostly close by me means I already verified ...
 *  this is generic rules". Every agent-facing text that lists or reports tasks says it. */
/** The ask of a task handed back only because its turn ended, with nothing asked of its own
 *  (user-status-sync.ts holds it a moment: the next turn often starts within seconds). */
/** The ask an older build stored for a bare hand-back: read only to recognise a stored status. */
export const HANDED_BACK_ASK = 'Its turn ended and handed the task back to you: read it and reply.';

/**
 * Nothing is asked of the user, only something to read (2026-11-02, the user through Main: "only a
 * real ask reaches Needs you"; two finished triage runs, a finished Interview task and a Q&A answer
 * sat in Needs you on Walnut's own sentences). `result`: its own report says it finished and no lead
 * checks it. `answer`: its turn answered the user's message. `turn`: its turn ended with no report
 * asking anything (its last words, sessions/last-words.ts, once read). Each reads To read with these
 * words in `waitingOn` (2026-11-02, the user: under Waiting they looked like they waited on him),
 * while its phase keeps it on the user's list; a routine run's `result` (and a triage run's `turn`)
 * closes itself (routines/run-close.ts).
 */
export type ToRead = 'result' | 'answer' | 'turn';
export const RESULT_TO_READ = 'The result is ready';
export const ANSWER_TO_READ = 'It answered your question';
export const TURN_TO_READ = 'Its turn ended without asking you anything';
const LAST_WORDS_LEAD = `${TURN_TO_READ}; its last words: "`;
/** A hand-back's line with the words its last turn ended with (sessions/last-words.ts). Pure. */
export function turnToReadLine(lastWords: string | null | undefined): string {
  return lastWords ? `${LAST_WORDS_LEAD}${lastWords}"` : TURN_TO_READ;
}
/** The last words a hand-back's line carries ({@link turnToReadLine}), or '' for a line without them. Pure. */
export function lastWordsOfStatus(s: Pick<UserStatus, 'toRead' | 'waitingOn'> | null | undefined): string {
  const w = s?.toRead === 'turn' ? s.waitingOn ?? '' : '';
  return w.startsWith(LAST_WORDS_LEAD) && w.endsWith('"') ? w.slice(LAST_WORDS_LEAD.length, -1).trim() : '';
}
/** A task with no session that a person or a lead set to NEED_ACTION by hand. */
export const MARKED_ASK = 'It was set to need you by hand: open it.';
export const COMPLETE_IS_VERIFIED = 'A COMPLETE task counts as verified by the user: write it as done, never as waiting on their check or test, and never remind them of it.';

export interface UserStatus {
  state: UserState;
  /** waiting only. */
  kind?: WaitKind;
  /** needs: what the user must do. */
  ask?: string;
  /** needs from a Board choice: the Board it is on (its owner task) and the choice's id. */
  choice?: { board: string; id: string };
  /** needs: where the ask lives, so a surface can take the user there: a prompt in the
   *  session, a letter in the inbox, a choice on the Board, a failed session, or the
   *  session's own question at the end of its turn. */
  /** 'thread': a node's Thread, as Walnut stored it from 2026-11-03 until the same day; no longer made. */
  source?: 'prompt' | 'letter' | 'choice' | 'error' | 'session' | 'thread';
  /** Main or a lead: what its Threads hold for the user (shown, waiting on him, the newest's title).
   *  The Org page shows them as threads; the node itself is never Needs you (orgNodeNeverNeeds). */
  threads?: ThreadCounts;
  /** waiting: on whom or what, in words. read: what there is to read. */
  waitingOn?: string;
  now?: string;
  next?: string;
  /** waiting: when it next checks by itself (its wait_until, ISO), for the UI to format. */
  until?: string;
  /** When `now`/`next` were written (ISO). */
  at?: string;
  /** The words are a day or more old while the task is not running. */
  stale?: boolean;
  /** The machine stopped it (a lost host, a restart, a dead process), not its work: Walnut
   *  resumes it, its lead restarts it when Walnut cannot (machineStop). */
  stoppedBy?: 'machine';
  /** Its due date has passed (`overdue`) or comes within a day (`soon`); absent otherwise
   *  (2026-10-28, the Grok Bot study: deadlines in the status). `at` is the due date as set. */
  due?: { at: string; state: 'overdue' | 'soon' };
  /** needs from its own session: when the ask was last confirmed (ISO): by the session at a turn
   *  end (`checkedBy` session), or by a trigger it armed to watch that ask (`check`, watches:"ask").
   *  Every other needs is Walnut's live record (a prompt, a letter, a choice, an error) and
   *  carries none. */
  checkedAt?: string;
  checkedBy?: 'session' | 'check';
  /** When an armed trigger of the task last ran (ISO, to 10 minutes): it watches the task, which
   *  is not proof this ask still holds, so it never counts as a check. */
  watchedAt?: string;
  /** needs from its session, confirmed by the session longer ago than UNVERIFIED_AFTER_MS:
   *  the user may have done it outside Walnut, so it reads "not verified", never as fact
   *  (2026-10-28, the user: "I've already resolved some of these. You should at least verify"). */
  unverified?: boolean;
  /** Between a turn's end and its report (sessions/report-pending.ts): the report decides the
   *  status in a moment, so a change into this is no news (sessions/status-push.ts). */
  transient?: boolean;
  /** Snoozed by its start date (snooze.ts): `until` as set, and the ask it would make of the user
   *  now, which no surface raises until then. Absent on a task that is not snoozed. */
  snoozed?: { until: string; ask?: string };
  /** The task's own line (StatusLine); absent when no current report gives words for its state. */
  line?: StatusLine;
  /** needs from its own report: the ask in a one-click shape (AskForm). */
  askForm?: AskForm;
  /** read: nothing is asked of the user, only this to read (ToRead). */
  toRead?: ToRead;
  /** needs or read: what the user does with it, the head of its line under Needs you (NeedsCategory). */
  category?: NeedsCategory;
  /** working with no turn running: its own work goes on and wakes it (ownWork): a live process
   *  that carries on, an armed watch on it, or its wait clock. */
  carriesOn?: 'process' | 'watch' | 'clock';
  /** The questions its subtasks ask the user, rolled up through each leader (rollUpAsks): origin
   *  named, its options kept, never a snoozed or a finished subtask's. Its own ask is `ask`. Read
   *  by agents (task_get, task_list rows), so a VP or Main sees every ask below a direct report
   *  without walking its tree; the Org page groups by topLevelOf from the same statuses. */
  asks?: RolledAsk[];
  /** A task whose own ask a task below it already asks (same-ask.ts foldSameAsk): it reads Waiting
   *  on that task (kind task), so the user sees the decision once, from the deepest task. Kept while
   *  it holds the same report, so answering the deeper task settles both. */
  sameAsk?: SameAskFold;
  /** A task whose own question a lead, VP or Main answered for the user (same-ask.ts answeredAbove):
   *  it reads Waiting on itself to act on that answer, never Needs you, while it asks the same. */
  answeredFor?: { by: string; byTitle: string; at: string; ask: string };
}

/** One question a subtask asks the user, as its leader carries it up (2026-10-31, the user: asks
 *  roll up level by level; answering it at the leader answers the task that asked). */
export interface RolledAsk {
  /** The task that asks (answering it answers this task). */
  id: string;
  title: string;
  ask: string;
  form?: AskForm;
  /** When the asking task last checked it. Its age (unverified) is read at the asking task: kept
   *  off the rolled copy, so a clock passing rewrites no leader's status. */
  checkedAt?: string;
  /** The direct subtask it came up through, when that is not the asking task itself. */
  via?: string;
}

/** At most this many questions ride one task's status. */
export const ROLLED_ASKS_MAX = 12;

/**
 * The questions under a task: each direct subtask's own ask (when it asks the user and is not
 * snoozed), then the ones it carries itself, never one twice and never a finished one. Pure.
 */
export function rollUpAsks(
  children: ReadonlyArray<{ id: string; title: string; phase?: string; status?: string; user_status?: UserStatus }>,
  selfId?: string,
): RolledAsk[] {
  const out: RolledAsk[] = [];
  // Its own ask is its own `ask`, never one it carries (a parent loop would bring it back up).
  const seen = new Set<string>(selfId ? [selfId] : []);
  const push = (a: RolledAsk) => { if (!seen.has(a.id) && out.length < ROLLED_ASKS_MAX) { seen.add(a.id); out.push(a); } };
  for (const c of children) {
    const s = c.user_status;
    if (c.phase === 'COMPLETE' || c.status === 'done' || !s || s.snoozed) continue;
    if (s.state === 'needs' && s.ask) {
      push({
        id: c.id, title: c.title, ask: s.ask, ...(s.askForm ? { form: s.askForm } : {}),
        ...(s.checkedAt ? { checkedAt: s.checkedAt } : {}),
      });
    }
    for (const a of s.asks ?? []) push({ ...a, via: c.id });
  }
  return out;
}

/** "2 hours ago", "3 days ago". */
export function agoWords(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hour${h === 1 ? '' : 's'} ago` : `${Math.round(h / 24)} days ago`;
}

/** The words every surface prints under a session's or a Board choice's "needs you": when it was
 *  last checked, or that it is not verified. Null for Walnut's own live records (a prompt, a letter). */
export function checkedLine(s: Pick<UserStatus, 'state' | 'source' | 'checkedAt' | 'watchedAt' | 'unverified'> | null | undefined, nowMs: number = Date.now()): { text: string; unverified: boolean } | null {
  if (s?.state !== 'needs' || (s.source !== 'session' && s.source !== 'choice')) return null;
  const at = Date.parse(s.checkedAt ?? '');
  // A Board choice with no recorded time was never checked (stampChoiceChecked).
  if (!Number.isFinite(at)) return s.source === 'choice' && s.unverified ? { text: 'Not verified: no check recorded, may be done already', unverified: true } : null;
  const ran = Date.parse(s.watchedAt ?? '');
  const watched = Number.isFinite(ran) ? `; its trigger ran ${agoWords(nowMs - ran)}` : '';
  if (s.unverified) return { text: `Not verified: last checked ${agoWords(nowMs - at)}, may be done already${watched}`, unverified: true };
  return { text: `Checked ${agoWords(nowMs - at)}${watched}`, unverified: false };
}

/** A session's "needs you" is asked again after this (sessions/needs-recheck.ts). A test server
 *  shortens it with WALNUT_NEEDS_RECHECK_MS (a minute at least); the browser reads none. */
const recheckEnv = typeof process !== 'undefined' ? Number(process.env?.WALNUT_NEEDS_RECHECK_MS) : NaN;
export const NEEDS_RECHECK_MS = Number.isFinite(recheckEnv) && recheckEnv >= 60_000 ? recheckEnv : 4 * 60 * 60_000;
/** ...and reads as not verified once it went this long unconfirmed (the re-check had its turn). */
export const UNVERIFIED_AFTER_MS = NEEDS_RECHECK_MS + Math.min(30 * 60_000, NEEDS_RECHECK_MS / 8);

/** A due date's deadline in ms: a bare date means the end of that day, in this process's zone. */
export function dueAtMs(due: string | null | undefined): number {
  const v = (due ?? '').trim();
  if (!v) return NaN;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T23:59:59.999`) : Date.parse(v);
}

/** Within this much of its due date a task reads "due soon". */
export const DUE_SOON_MS = 24 * 60 * 60_000;

/** Overdue, due soon, or nothing to say. */
export function dueStatus(due: string | null | undefined, nowMs: number): UserStatus['due'] | undefined {
  const at = dueAtMs(due);
  if (!Number.isFinite(at)) return undefined;
  if (at < nowMs) return { at: due!.trim(), state: 'overdue' };
  if (at - nowMs <= DUE_SOON_MS) return { at: due!.trim(), state: 'soon' };
  return undefined;
}

/** What a restart that killed a session was, in words. */
const RESTART_WORDS: Record<string, string> = {
  machine_reboot: 'this computer restarted', server_restart: 'Walnut restarted', host_restart: 'its host restarted',
  start_died: 'its process stopped before it read its first message',
};

/**
 * Stopped by the machine, not by the work (2026-10-28: a full disk, a restart and an SSH drop put
 * tasks under "Needs the user now"). Walnut resumes such a task itself once the cause clears, and
 * its lead restarts it when Walnut cannot; only what neither can fix reaches the user. Read from
 * the session record's structured facts only (errorKind, status_reason, restartLoss), never text.
 */
function machineStop(input: UserStatusInput, w: ReturnType<typeof words>, nowMs: number): UserStatus | null {
  // The sync passes only a loss of the session's CURRENT death (user-status-sync.ts liveRestartLoss).
  // Its turn never reached the model endpoint: Walnut continues it once the endpoint answers, and
  // only a wait that gave up is the user's (2026-11-03: eight sessions read Needs you over a proxy
  // that went down with the Mac's login session).
  const ew = input.endpointWait;
  if (ew && input.processStatus !== 'running') {
    if (ew.state === 'gave_up') return strip<UserStatus>({ state: 'needs', source: 'error', ask: endpointGaveUpWords(ew), ...w, stoppedBy: 'machine' });
    const what = ew.probeError === 'host offline' ? ew.where : endpointWords(ew);
    const until = ew.probeError === 'host offline' ? 'to connect again' : 'to answer again';
    return strip<UserStatus>({ state: 'waiting', kind: 'machine', waitingOn: `${what.charAt(0).toUpperCase()}${what.slice(1)}, ${until}: Walnut continues the turn by itself when it does`, ...w, stoppedBy: 'machine' });
  }
  const loss = input.restartLoss;
  const live = input.processStatus === 'running' || input.processStatus === 'idle';
  const owner = input.hasLeader || input.projectLead;
  const parked = input.phase === 'WAITING';
  if (loss && !live) {
    const after = RESTART_WORDS[loss.cause ?? ''] ?? 'a restart';
    if (loss.state === 'queued' || loss.state === 'sent') {
      return strip<UserStatus>({ state: 'waiting', kind: 'machine', waitingOn: `Walnut, resuming it after ${after}`, ...w, stoppedBy: 'machine' });
    }
    if (loss.state === 'gave_up') {
      return owner
        ? strip<UserStatus>({ state: 'waiting', kind: 'lead', waitingOn: `Its lead, to restart it: Walnut could not resume it after ${after}`, ...w, stoppedBy: 'machine' })
        : strip<UserStatus>({ state: 'needs', source: 'error', ask: `Walnut could not resume it after ${after}. Restart it or open it.`, ...w, stoppedBy: 'machine' });
    }
  }
  const cause = infraStopCause(input);
  // A parked task needs no process: only a lost host (whose daemon runs its watches) stops its wait.
  if (!cause || (parked && cause !== 'host')) return null;
  // A day gone is no longer a blip Walnut rides out: its lead, else the user, looks at it.
  const since = input.statusSince ? Date.parse(input.statusSince) : NaN;
  if (Number.isFinite(since) && nowMs - since >= MACHINE_STOP_ESCALATE_MS) {
    const what = cause === 'host' ? 'Its host has been unreachable' : 'It has been stopped by the machine';
    return owner
      ? strip<UserStatus>({ state: 'waiting', kind: 'lead', waitingOn: `Its lead, to check it: ${what.toLowerCase()} for a day`, ...w, stoppedBy: 'machine' })
      : strip<UserStatus>({ state: 'needs', source: 'error', ask: `${what} for a day. Check the host, or restart it elsewhere.`, ...w, stoppedBy: 'machine' });
  }
  const who = owner ? ', and its lead restarts it if that fails' : '';
  const waitingOn = cause === 'host' ? `Its host to come back: Walnut reconnects and resumes it by itself${who}`
    : cause === 'restart' ? `Walnut, resuming it after Walnut restarted${who}`
      : `Walnut, resuming it after its process stopped under it${who}`;
  return strip<UserStatus>({ state: 'waiting', kind: 'machine', waitingOn, ...w, stoppedBy: 'machine' });
}

/** A machine stop standing this long goes to its lead (or the user when it has none). */
export const MACHINE_STOP_ESCALATE_MS = 24 * 60 * 60_000;

/** A report older than this, on a task that is not running, is flagged as old. */
export const STALE_REPORT_MS = 24 * 60 * 60_000;

const clean = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
const none = (s: string | null | undefined): boolean => {
  const v = clean(s).toLowerCase();
  return !v || v === 'none' || v === 'n/a' || v === '-' || v === 'unchanged';
};

function words(report: StatusReport | null | undefined, nowMs: number, running: boolean) {
  if (!report) return {};
  const at = report.at;
  const age = nowMs - Date.parse(at);
  return {
    now: none(report.now) ? undefined : clean(report.now),
    next: none(report.next) ? undefined : clean(report.next),
    at,
    stale: !running && Number.isFinite(age) && age >= STALE_REPORT_MS ? true : undefined,
  };
}

/** A status with nothing asked of the user, only something to read (ToRead). */
function toRead(what: ToRead, waitingOn: string, w: Partial<UserStatus>): UserStatus {
  return strip<UserStatus>({ state: 'read', waitingOn, toRead: what, ...w });
}

/**
 * The task's own work goes on with no turn running (2026-11-02, the user: a task parked on its own
 * build "is working right, the implementaiton is working, then why it is waiting"): its current
 * report says so (FOR_USER_STATE working, or a wait of kind `own`: its build, test run, CI run,
 * deploy or land), and something brings it back when that work ends: its live process (a
 * background command), an armed watch, or its WAITING clock. Null otherwise: a claim of work with
 * nothing to wake it is a stop, which the caller reads as such.
 */
/** A reported wait on someone or something else, which a session's own watch does not turn into Working. */
const OTHERS_WAIT: ReadonlySet<WaitKind> = new Set<WaitKind>(['you', 'outside', 'task', 'lead', 'machine']);

function ownWork(input: UserStatusInput, report: StatusReport | null, w: ReturnType<typeof words>, nowMs: number): UserStatus | null {
  // Main and a lead wait on the user and their teams; a task the user snoozed sleeps under Waiting.
  if (input.isMain || input.isLead) return null;
  const snooze = startDateMs(clean(input.snoozedUntil));
  if (Number.isFinite(snooze) && snooze > nowMs) return null;
  // Its own work runs on after its turn (2026-11-03, the user's lead: a background subagent ran 84
  // minutes, the task read as stopped, and its lead nudged it): the process carries it and wakes the
  // session when it ends. Unless its current report asks the user or names a wait on someone else
  // (a /loop that re-checks a review is watching, not working).
  const outliving = input.outliving ?? [];
  const waitsOnOthers = report?.state === 'needs'
    || (report?.state === 'waiting' && !!report.waiting_kind && OTHERS_WAIT.has(report.waiting_kind));
  if (outliving.length && input.processStatus !== 'error' && !waitsOnOthers) {
    return strip<UserStatus>({ state: 'working', carriesOn: 'process', ...w, now: w.now ?? outlivingLine(outliving) });
  }
  if (!report) return null;
  const own = report.state === 'working' || (report.state === 'waiting' && report.waiting_kind === 'own');
  if (!own || input.processStatus === 'error') return null;
  const carriesOn: UserStatus['carriesOn'] | null = input.processStatus === 'idle' ? 'process'
    : (input.triggers ?? []).some((t) => clean(t)) ? 'watch'
      : input.phase === 'WAITING' && input.waitUntil && Date.parse(input.waitUntil) > nowMs ? 'clock' : null;
  if (!carriesOn) return null;
  const until = input.phase === 'WAITING' && input.waitUntil && Date.parse(input.waitUntil) > nowMs ? input.waitUntil : undefined;
  return strip<UserStatus>({ state: 'working', carriesOn, ...w, ...(until ? { until } : {}) });
}

function strip<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

/** Slack for clocks: the phase write and the report stamp come from different processes. */
const REPORT_CLOCK_SLACK_MS = 5_000;

/** Whether the stored report is of the latest turn: written after the phase last moved. */
export function reportIsCurrent(input: Pick<UserStatusInput, 'report' | 'phaseChangedAt'>): boolean {
  const r = input.report;
  if (!r) return false;
  const movedAt = input.phaseChangedAt ? Date.parse(input.phaseChangedAt) : NaN;
  return !Number.isFinite(movedAt) || Date.parse(r.at) >= movedAt - REPORT_CLOCK_SLACK_MS;
}

/** The words of a start that waits for a free slot on a host. Pure. */
/** `text` cut to `max` characters at a word, with an ellipsis. */
function clipped(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, cutEnd(text, max - 1))}…` : text;
}

export function queuedWaitingOn(q: { host?: string; reason?: string }): string {
  const host = !q.host ? 'a host' : q.host === '__local__' ? 'this Mac' : q.host;
  // An older Walnut queued it; it is tried once more, then fails saying why (start-queue.ts).
  return `Queued by an older Walnut for room on ${host}${q.reason ? ` (${q.reason})` : ''}: Walnut tries it once more, then says why if it does not start`;
}

export function deriveUserStatus(input: UserStatusInput, nowMs: number = Date.now()): UserStatus {
  const derived = orgNodeNeverNeeds(derive(input, nowMs), input);
  // A thread's ask is the thread; the node's own report words are no line of it.
  const line = derived.source === 'thread' ? null : lineOf(input, derived);
  if (line) derived.line = line;
  const form = askFormOf(input, derived);
  if (form) derived.askForm = form;
  const out = snoozeOf(input, derived, nowMs) ?? derived;
  if (out.state !== 'done' && !out.snoozed) {
    const due = dueStatus(input.dueDate, nowMs);
    if (due) out.due = due;
  }
  // A waiting task names when it checks again by itself, whatever it waits on.
  if (out.state === 'waiting' && !out.until && input.waitUntil && Date.parse(input.waitUntil) > nowMs) out.until = input.waitUntil;
  // Only an ask the session itself wrote can be checked again; Walnut's own "its turn ended and
  // handed it back" is no claim about the world.
  if (out.state === 'needs' && out.source === 'session' && out.ask && out.ask === reportAsk(input.report, hasAbove(input))) stampChecked(out, input, nowMs);
  if (out.state === 'needs' && out.source === 'choice') stampChoiceChecked(out, input, nowMs);
  // A review letter names what to do with a result or the session's own ask, never with a prompt,
  // a choice or a decision letter (those are decisions).
  const review = !none(input.openReview) && (storedUserState(out) === 'read' || out.source === 'session');
  let category = needsCategoryOf(out, review);
  // An ask with no kind of the user's own reads as a result, but it asked something: never Can close.
  if (category === 'close' && input.report?.kindless_ask) category = 'look';
  if (category) out.category = category;
  return out;
}

/**
 * What the user does with a row under Needs you, from facts Walnut holds, never a model's guess
 * (2026-11-03, the user: "I think shoudl shoudlbe in need aciton but I love ur idea of give more
 * category, I guess, read, makde decison, review, see if can closed"):
 *   look    it answered the user's message, its turn ended, or it failed: take a look
 *   decide  a real ask: its own question, a Board choice, a decision letter, a permission prompt
 *   review  it sent a review letter that is still open
 *   close   it finished and asks nothing: read the result and close it
 */
export type NeedsCategory = 'look' | 'decide' | 'review' | 'close';
export const NEEDS_CATEGORY_LABELS: Record<NeedsCategory, string> = {
  look: 'Take a look', decide: 'Decide', review: 'Review', close: 'Can close',
};

/** A status's category (NeedsCategory), or undefined for one that is not under Needs you. Pure: the
 *  web reads it again for a status stored before the field. */
export function needsCategoryOf(s: Pick<UserStatus, 'state' | 'source' | 'toRead' | 'snoozed'>, openReview = false): NeedsCategory | undefined {
  const state = storedUserState(s);
  if (state !== 'needs' && state !== 'read') return undefined;
  if (openReview) return 'review';
  if (state === 'read') return s.toRead === 'result' ? 'close' : 'look';
  return s.source === 'error' ? 'look' : 'decide';
}

/** The group a state is drawn in for the user: To read sits under Needs you, its line saying what
 *  to do with it (2026-11-03, the user: "I dont wnat serpeate to read"). The stored state keeps
 *  `read` apart, so nothing re-checks or wakes a task for it. Pure. */
export function shownState<S extends UserState>(state: S): Exclude<S, 'read'> | 'needs' {
  return (state === 'read' ? 'needs' : state) as Exclude<S, 'read'> | 'needs';
}

/** The one line under a Needs you row's title: its category, then what it asks or what there is to
 *  read; null for a status with no category. */
export function needsLineOf(s: Pick<UserStatus, 'state' | 'source' | 'toRead' | 'snoozed' | 'ask' | 'waitingOn' | 'category'>): { category: NeedsCategory; text: string } | null {
  const category = s.category ?? needsCategoryOf(s);
  if (!category) return null;
  const words = storedUserState(s) === 'read' ? s.waitingOn : s.ask;
  return { category, text: (words ?? '').replace(/\s+/g, ' ').trim() };
}

/** needsLineOf as one string: "Can close: The result is ready", or the category word alone. */
export function needsLineText(s: Parameters<typeof needsLineOf>[0]): string {
  const line = needsLineOf(s);
  return line ? [NEEDS_CATEGORY_LABELS[line.category], line.text].filter(Boolean).join(': ') : '';
}

/** The ask of a current needs report in its one-click shape (AskForm), when the status is that ask. */
function askFormOf(input: UserStatusInput, s: UserStatus): AskForm | undefined {
  const r = reportIsCurrent(input) ? input.report : null;
  if (!r || s.state !== 'needs' || s.source !== 'session' || r.state !== 'needs' || none(r.ask)) return undefined;
  if (clean(r.ask) !== clean(s.ask)) return undefined;
  return askFormFrom(r.ask!, r.ask_kind, r.ask_options, r.ask_more);
}

/** An AskForm from loose parts, held to its limits: a choice with fewer than 2 options is text. Pure. */
export function askFormFrom(ask: string, kind?: string, options?: ReadonlyArray<AskOption | string>, more?: string): AskForm {
  const full = clean(ask);
  const summary = headOf(full, ASK_SUMMARY_MAX);
  const k: AskKind = (ASK_KINDS as readonly string[]).includes(kind ?? '') ? kind as AskKind : 'text';
  let seenRecommended = false;
  const opts = (options ?? []).map((o, i) => {
    const raw = clean(typeof o === 'string' ? o : o.label);
    const label = raw.slice(0, cutEnd(raw, 80));
    const id = (typeof o === 'string' ? '' : clean(o.id)) || `o${i + 1}`;
    // A single choice recommends one option at most: the first one marked.
    let recommended = typeof o !== 'string' && !!o.recommended;
    if (recommended && k === 'single' && seenRecommended) recommended = false;
    if (recommended) seenRecommended = true;
    return label ? strip<AskOption>({ id, label, recommended: recommended || undefined }) : null;
  }).filter((o): o is AskOption => !!o).slice(0, ASK_OPTIONS_MAX);
  const choice = k === 'single' || k === 'multi';
  const finalKind: AskKind = choice && opts.length < 2 ? 'text' : k;
  // A summary cut to its head keeps the whole ask under More when the writer gave no detail.
  const given = (more ?? '').trim() || (summary !== full ? full : '');
  const detail = given.slice(0, cutEnd(given, ASK_MORE_MAX));
  return strip<AskForm>({
    summary, kind: finalKind,
    more: detail || undefined,
    options: finalKind === 'single' || finalKind === 'multi' ? opts : undefined,
  });
}

/** At most `max` characters, cut at a word with an ellipsis when it had to be cut. */
function headOf(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, cutEnd(text, max - 1));
  const space = head.lastIndexOf(' ');
  return `${(space > max / 2 ? head.slice(0, space) : head).replace(/[\s,;:.]+$/, '')}\u2026`;
}

/**
 * The one message an answer to an AskForm sends into the task's session (2026-10-31: answers go back
 * as one message, the way a Board choice does): the summary, then the option(s) picked and the
 * person's own words. Pure; the web and the phone build the same text.
 */
export function askAnswerText(form: Pick<AskForm, 'summary' | 'kind' | 'options'>, answer: { picked?: string[]; words?: string }): string {
  const ids = answer.picked ?? [];
  const labels = form.kind === 'yes_no'
    ? ids.map((id) => (id === 'yes' ? 'Yes' : id === 'no' ? 'No' : '')).filter(Boolean)
    : ids.map((id) => form.options?.find((o) => o.id === id)?.label).filter((l): l is string => !!l);
  const words = (answer.words ?? '').trim();
  const parts = [labels.join(', '), words].filter(Boolean);
  return `Answer to "${form.summary}": ${parts.join('. ') || '(no answer)'}`;
}

/** The task's own line for the state it is in (StatusLine), from its current report. */
function lineOf(input: UserStatusInput, s: UserStatus): StatusLine | undefined {
  const r = reportIsCurrent(input) ? input.report : null;
  if (!r || s.state === 'done') return undefined;
  const text = s.state === 'needs'
    ? (r.state === 'needs' ? r.ask : waitIsUsers(r, hasAbove(input)) ? r.waiting_on : undefined)
    : s.state === 'waiting' ? (r.state === 'waiting' && !waitIsUsers(r, hasAbove(input)) ? r.waiting_on : undefined)
      : r.state === 'working' ? (r.next ?? r.now) : undefined;
  if (none(text)) return undefined;
  return strip<StatusLine>({ text: clean(text).slice(0, 300), by: r.by ?? 'self', byName: r.by_name, at: r.at });
}

/** Whether a snooze takes this status off the user until its date (snoozeOf): a Needs you or a wait
 *  on them, except a live prompt (it blocks a turn someone started now: the user answers it, snoozed
 *  or not) and Main (its Needs you is the user's turn to talk). The Org rail offers Snooze only here. */
export function snoozeTakesOff(s: Pick<UserStatus, 'state' | 'source' | 'kind'>, isMain = false): boolean {
  return !isMain && ((s.state === 'needs' && s.source !== 'prompt') || s.state === 'read' || (s.state === 'waiting' && s.kind === 'you'));
}

/**
 * A snoozed task asks nothing of the user until its start date (snooze.ts, 2026-10-30): a status that
 * would ask them (Needs you, To read, or a wait on them) reads Waiting until that date, keeping the ask for the
 * Brief's snoozed list; any other status only carries the mark. Working, Done and a live prompt are
 * as they are, and Main is never snoozed (its Needs you is the user's turn to talk). A session's own
 * report cannot undo it; only a letter with a stated reason raises the task (letter-ops.ts). Null
 * when not snoozed.
 */
function snoozeOf(input: UserStatusInput, s: UserStatus, nowMs: number): UserStatus | null {
  const until = clean(input.snoozedUntil);
  if (!until || s.state === 'done' || s.state === 'working' || input.isMain) return null;
  const startMs = startDateMs(until);
  if (!Number.isFinite(startMs) || startMs <= nowMs) return null;
  const onUser = snoozeTakesOff(s);
  if (!onUser) return { ...s, snoozed: { until } };
  const ask = s.state === 'needs' ? s.ask : s.state === 'read' ? undefined : s.waitingOn;
  return strip<UserStatus>({
    state: 'waiting', kind: 'time', waitingOn: `Snoozed until ${until}`, until: new Date(startMs).toISOString(),
    now: s.now, next: s.next, at: s.at, stale: s.stale,
    snoozed: { until, ...(ask && ask !== HANDED_BACK_ASK ? { ask } : {}) },
    // Its Threads still count on the Org page while it sleeps.
    ...(s.threads ? { threads: s.threads } : {}),
  });
}

/** The ask a report makes of the user, in the words derive() shows. */
function reportAsk(report: StatusReport | null | undefined, hasLeader: boolean): string | undefined {
  if (report?.state === 'needs' && !none(report.ask)) return clean(report.ask);
  if (waitIsUsers(report, hasLeader) && !none(report!.waiting_on)) return clean(report!.waiting_on);
  return undefined;
}

/**
 * A Board choice asks the user from when it was written there (2026-10-31: a choice nobody
 * re-checked read as Needs you for a day after the task had moved on and the user had answered
 * in its chat). Its written time is its check, and it goes unverified like a session's ask; one
 * from an older Board has no time and is not verified. Its owner confirms it by writing it again.
 */
function stampChoiceChecked(out: UserStatus, input: UserStatusInput, nowMs: number): void {
  const at = Date.parse(input.openChoiceAt ?? '');
  if (!Number.isFinite(at)) { out.unverified = true; return; }
  out.checkedAt = new Date(at).toISOString();
  if (nowMs - at > UNVERIFIED_AFTER_MS) out.unverified = true;
}

/** The task spoke after the choice was written: its own newer words say what it needs, not an
 *  older choice its Board owner never confirmed since. A choice with no recorded time is kept, read
 *  as not verified, and its owner is asked to confirm it (sessions/needs-recheck.ts). */
function choiceOverruled(input: UserStatusInput, report: StatusReport | null): boolean {
  const said = Date.parse(report?.at ?? '');
  const written = Date.parse(input.openChoiceAt ?? '');
  return Number.isFinite(said) && Number.isFinite(written) && said > written;
}

/** When a session's ask was last confirmed, by whom, and whether that is too long ago to be fact. */
function stampChecked(out: UserStatus, input: UserStatusInput, nowMs: number): void {
  // Its last word on it: the newest of its report and its last phase move (a turn's end).
  const at = Math.max(...[input.report?.at, input.phaseChangedAt].map((v) => Date.parse(v ?? '')).filter(Number.isFinite));
  if (!Number.isFinite(at)) return;
  // A trigger the session armed to watch this very ask (watches:"ask") checks it each run
  // (2026-11-04, Main's reflection: such asks read NOT VERIFIED for up to five days while their
  // trigger kept checking them, because only the session's own word counted).
  const watched = Date.parse(input.askCheckedAt ?? '');
  const last = Number.isFinite(watched) && watched > at ? watched : at;
  out.checkedAt = new Date(last).toISOString();
  out.checkedBy = last === at ? 'session' : 'check';
  // Any other trigger of the task watches the task, not necessarily this ask (2026-10-28: a
  // reminder to call someone carried a mail trigger): shown beside it, never a check of its own.
  const ran = Date.parse(input.checkRanAt ?? '');
  if (Number.isFinite(ran)) out.watchedAt = new Date(ran).toISOString();
  if (nowMs - last > UNVERIFIED_AFTER_MS) out.unverified = true;
}

/**
 * What will wake a task whose turn is over: an armed trigger of its own (a fire resumes a stopped
 * session), else, with `schedules`, a scheduled routine that runs in its session. Null when
 * nothing will. 2026-10-29: a task parked on two armed triggers read "stuck, nothing will wake
 * it" in the seconds between its turn's end and the phase write, and was pushed to Main so.
 */
function wakeSource(input: UserStatusInput, w: ReturnType<typeof words>, nowMs: number, schedules: boolean): UserStatus | null {
  const triggers = (input.triggers ?? []).map(clean).filter(Boolean);
  if (triggers.length) return strip<UserStatus>({ state: 'waiting', kind: 'other', waitingOn: `A watch: ${triggers.join(', ')}`, ...w });
  const runs = schedules ? (input.schedules ?? []).filter((r) => clean(r.name)) : [];
  if (!runs.length) return null;
  const next = runs.map((r) => r.nextAt).filter((t): t is string => !!t && Date.parse(t) > nowMs).sort()[0];
  return strip<UserStatus>({ state: 'waiting', kind: 'time', waitingOn: `Its next scheduled run (${runs.map((r) => clean(r.name)).join(', ')})`, ...(next ? { until: next } : {}), ...w });
}

/**
 * Needs you is only ever an individual task (2026-10-31, the user: a VP's copy of a task's ask, a
 * task he had snoozed, stood in Main's Needs you: "这个都是 individual task is needs you ... We can
 * choose talk to VP"). Main or a lead whose status would ask the user waits instead: on its teams,
 * with its question in its chat, where he talks to it. A decision that belongs to no task goes on a
 * task of its own. Its prompt or failure is in its chat too. His own requests to it are its Threads:
 * the node carries their counts (`threads`), and every Org surface shows them as threads ("3
 * threads" and the newest's title), never as a task's status (2026-11-03, the user, after a thread
 * waiting on him had made each VP read Needs you everywhere: "All replaced to Need Action which is
 * the same as the task status, is this right?"; before: "thread is better than need u").
 */
function orgNodeNeverNeeds(s: UserStatus, input: UserStatusInput): UserStatus {
  if (!(input.isMain || input.isLead)) return s;
  const th = input.threads && input.threads.shown > 0 ? input.threads : undefined;
  const out = asOrgNode(s);
  return th && out.state !== 'done' ? { ...out, threads: th } : out;
}

function asOrgNode(s: UserStatus): UserStatus {
  if (s.state !== 'needs') return s;
  const { ask, source, askForm: _form, checkedAt: _c, checkedBy: _b, unverified: _u, watchedAt: _wa, choice: _ch, ...rest } = s;
  const said = clean(ask);
  const waitingOn = source === 'prompt' ? `You, in its chat: ${said}`
    : source === 'error' ? `You or Walnut, in its chat: ${said}`
      : said && said !== HANDED_BACK_ASK ? `Its teams; its question to you is in its chat: "${said.slice(0, 200)}"`
        : 'Your next message, or news from its teams';
  // On the user, in its chat (status-push says "on you"), never a Needs you of its own.
  return { ...rest, state: 'waiting', kind: 'you', waitingOn };
}

function derive(input: UserStatusInput, nowMs: number): UserStatus {
  const anyReport = input.report ?? null;
  if (input.phase === 'COMPLETE' || input.status === 'done') return { state: 'done' };

  const running = input.processStatus === 'running' && !input.pendingPermissionTool;
  const w = words(anyReport, nowMs, running);
  // Only a report of the latest turn says what it is waiting on or asking.
  const report = reportIsCurrent(input) ? anyReport : null;
  // The machine stopped it: unless its own latest report asks the user something, it is Walnut's
  // and its lead's to bring back, not the user's.
  const asksUser = report?.state === 'needs' || (report?.state === 'waiting' && report.waiting_kind === 'you');
  const machine = asksUser ? null : machineStop(input, w, nowMs);

  // A live prompt blocks on the user (the session machine moves the phase to NEED_ACTION with it).
  if (input.pendingPermissionTool) {
    return strip({ state: 'needs', source: 'prompt', ask: `Answer the ${input.pendingPermissionTool} prompt in its session.`, ...w, stale: undefined });
  }
  // Working is a turn running right now, whatever its phase says (2026-10-31, the user: "working 就是
  // 他现在必须正在 working"), or its own work going on without one (ownWork, 2026-11-02, the user:
  // "if it is runnig it shoud be i progress right?"), read below once nothing asks the user.
  if (running) return strip({ state: 'working', ...w });
  // A close its session tried left something for the user (2026-11-02: a task closed with the user's
  // own resubmit step still in its Progress read Done). Its own later ask, when it has one, speaks.
  if (input.owedHold && !input.isMain && !input.isLead && !none(input.owedHold.ask)) {
    const heldAsk = report?.state === 'needs' && !none(report.ask) ? clean(report.ask) : clean(input.owedHold.ask);
    return strip({ state: 'needs', source: 'session', ask: heldAsk, ...w });
  }
  const own = ownWork(input, report, w, nowMs);
  // Its start waits for room on a host (sessions/start-queue.ts; a start clears it), whatever its
  // phase: a first start, a retry after a failed one, a parked task started again. A person's own
  // mark of Needs you still says so (review round 3, Sol).
  if (input.startQueue && !input.markedByPerson) {
    return strip({ state: 'waiting', kind: 'machine', waitingOn: queuedWaitingOn(input.startQueue), ...w });
  }
  // Its start did not happen (no host had room, the spawn failed) and nothing ran since: the row
  // says why, so its lead and the user see it (2026-11-06, the user: a start that did not start is
  // an error). A person's own mark of Needs you still says so.
  if (input.startFailed && !input.hasSession && !input.markedByPerson) {
    return strip({ state: 'waiting', kind: 'not-started', waitingOn: clipped(input.startFailed.startsWith('Did not start') ? input.startFailed : `Did not start: ${input.startFailed}`, 240), ...w });
  }

  // The state is the task's own phase (2026-10-26, the user: "this status need to be self updated
  // by task, can also be updated by leader ... task has status, we already have good task system").
  // The task sets it (its turn's own report moves it, session-hooks/builtins.ts), its leader or the
  // user may set it, and nothing here overrides it: what follows only says why, in words.
  if (input.phase === 'NEED_ACTION') {
    // The task's own words come first (2026-10-31, the user: what it needs is the task's to say; a
    // letter or a Board choice is a place he can answer, never what overrides it).
    if (report?.state === 'needs' && !none(report.ask)) return strip({ state: 'needs', source: 'session', ask: clean(report.ask), ...w });
    if (!none(input.openLetter)) return strip({ state: 'needs', source: 'letter', ask: clean(input.openLetter), ...w });
    if (!none(input.openChoice) && !choiceOverruled(input, anyReport)) {
      return strip({ state: 'needs', source: 'choice', ask: clean(input.openChoice), ...(input.openChoiceRef ? { choice: { ...input.openChoiceRef } } : {}), ...w });
    }
    // A message that never reached the session: the cause is what the user fixes,
    // not a session that "failed" or a turn that ended (2026-10-28).
    if (!none(input.undeliveredMessage)) {
      const raw = clean(input.undeliveredMessage);
      // The user's own terminal holds the session: say that, not "failed" (2026-10-28).
      const terminal = /has this session open in a terminal right now \(([^)]*)\)/.exec(raw);
      if (terminal) {
        return strip({ state: 'needs', source: 'error', ask: `The user (or someone) has its session open in a terminal right now (${terminal[1].slice(0, 80)}), so a message to it waits. The task is fine; Retry it once that terminal is closed.`, ...w });
      }
      const why = raw.replace(/^Not delivered( yet)?:\s*/i, '');
      return strip({ state: 'needs', source: 'error', ask: `A message to it was not delivered: ${why.slice(0, 220)}`, ...w });
    }
    if (machine) return machine;
    // A machine stop under a turn that asked the user something: the ask is what they answer.
    if (input.processStatus === 'error' && !infraStopCause(input)) {
    const why = clean(input.errorMessage);
    return strip({ state: 'needs', source: 'error', ask: why ? `Its session failed (${why.slice(0, 140)}). Retry it or open it.` : 'Its session failed. Retry it or open it.', ...w });
  }
    // Its team was stopped in one step (sessions/team-stop.ts) and it ran no turn since: it waits
    // for the resume or a message, and says so, rather than reading as a session that stopped for
    // no reason. A report written after the stop is a turn of its own and speaks for itself.
    const stoppedAt = Date.parse(input.teamStoppedAt ?? '');
    if (Number.isFinite(stoppedAt) && !running && !asksUser && !(anyReport && Date.parse(anyReport.at) > stoppedAt)) {
      return strip({ state: 'waiting', kind: input.hasLeader ? 'lead' : 'you', waitingOn: 'Its team was stopped: Resume the team, or a message to it, starts it again', ...w });
    }
    if (report?.state === 'needs' && !none(report.ask)) return strip({ state: 'needs', source: 'session', ask: clean(report.ask), ...w });
    // A wait that is the user's (2026-10-30: "other: the meeting notes") is their ask, in its words.
    if (waitIsUsers(report, hasAbove(input)) && !none(report!.waiting_on)) {
      return strip({ state: 'needs', source: 'session', ask: clean(report!.waiting_on), ...w });
    }
    // A person set it to need them: their own ask, whatever its turn said.
    if (input.markedByPerson) return strip({ state: 'needs', ask: MARKED_ASK, ...w });
    // It answered the user's message (2026-10-31, the user: "I have not even read it and it is put
    // into wait"): the answer is the user's to read first, so its phase keeps it on their list until
    // they write again or a turn of its own (a trigger it armed) parks it; it asks nothing, so it is
    // no Needs you (2026-11-02) and no 4-hour re-check (needs-recheck.ts reads only Needs you).
    if (report && report.answered_person && report.state !== 'done' && !input.isMain && !input.isLead) {
      const on = report.state === 'waiting' && !report.kindless_ask ? clean(report.waiting_on) : '';
      return toRead('answer', on ? `${ANSWER_TO_READ}; then it waits on: ${on.slice(0, 160)}` : ANSWER_TO_READ, w);
    }
    // An ask with no kind of the user's own and no lead above it: its result is there to read.
    if (report?.kindless_ask && !hasAbove(input)) return toRead('result', RESULT_TO_READ, w);
    // Its own report says done. A task with a leader moves to WAITING on that report
    // (report-phase.ts) for its lead to check. One with none is the user's to read and close, and a
    // wait on the user is Needs you, never Waiting (2026-11-01 org review, by the user's rule of
    // 2026-10-30: "You, to read the result and close it" sat parked for three days).
    if (report?.state === 'done') {
      // Main and a lead are never closed: they wait on the user's next message.
      if (input.isMain || input.isLead) return strip({ state: 'waiting', kind: 'you', waitingOn: 'Your next message, or news from its teams', ...w });
      if (input.hasLeader) return strip({ state: 'waiting', kind: 'lead', waitingOn: 'Its lead, to check the result and close it', ...w });
      return toRead('result', RESULT_TO_READ, w);
    }
    // It said its own work goes on (a build it started, a test run) and something wakes it: Working.
    if (own) return own;
    // Its own armed trigger wakes it (a fire resumes a stopped session): with no ask of its own and no
    // turn running (a NEED_ACTION set inside a turn waits for that turn's report), it waits on the watch.
    // Not Main or a lead: they are never closed, and their NEED_ACTION is the user's turn to talk.
    const watch = running || input.isMain || input.isLead ? null : wakeSource(input, w, nowMs, false);
    // A worker whose session stopped (Walnut's idle reap, a stop) with no report of its own saying it
    // needs the user: its lead is the one to look (2026-10-27: a worker reaped while its tests ran read
    // Needs you everywhere). The reap still hands it back, so a reply its lead waits for is settled.
    if (!watch && input.hasLeader && !input.isLead && !input.isMain && input.processStatus === 'stopped') {
      return strip({ state: 'waiting', kind: 'lead', waitingOn: 'Its lead, to look at it: its session stopped before it said it needs anything', ...w });
    }
    // Its turn just ended and its report is on the way: only that report can say it asks anything.
    if (input.reportPending) {
      return strip({ state: 'waiting', kind: 'other', waitingOn: 'Its report on the turn that just ended', ...w, transient: true });
    }
    if (watch) return watch;
    // No ask of its own (2026-10-31, the user on the CEO node's list: "u can show VP sure, but u need
    // to show what are actually waiting"): Needs you always carries a concrete ask. A worker whose
    // turn ended without one waits on its lead, idle or stopped; Main and a lead wait on the user's
    // next message (or their teams' news), and their node lists its tasks' asks, not itself.
    if (input.isMain || input.isLead) return strip({ state: 'waiting', kind: 'you', waitingOn: 'Your next message, or news from its teams', ...w });
    if (input.hasLeader) return strip({ state: 'waiting', kind: 'lead', waitingOn: 'Its lead, to look at it: its turn ended without asking you anything', ...w });
    // No session ever ran a turn here: a person or a lead set it to need the user by hand, which is
    // their word, not a turn's end.
    if (!input.hasSession) return strip({ state: 'needs', ask: MARKED_ASK, ...w });
    // Nothing asked: the words its turn ended with, once Walnut has read them, are there to read.
    return toRead('turn', turnToReadLine(input.lastWords), w);
  }

  if (input.phase === 'IN_PROGRESS') {
    // In progress with no turn running is Waiting, with its reason (Working is a running turn only).
    if (!input.hasSession) return strip({ state: 'waiting', kind: 'not-started', waitingOn: 'Marked in progress; no session runs it', ...w });
    if (machine) return machine;
    // It said its own work carries on (a background job, a build it watches) and something wakes it.
    if (own) return own;
    // In progress with nothing running: on whom it waits, so no one reads "working" on an idle session.
    if (input.isMain) return strip({ state: 'waiting', kind: 'you', waitingOn: 'Your next message, or news from its teams', ...w });
    if ((input.openWorkers ?? 0) > 0) {
      const n = input.openWorkers!;
      return strip({ state: 'waiting', kind: 'task', waitingOn: n === 1 ? 'Its worker (1 open)' : `Its workers (${n} open)`, ...w });
    }
    // Not stuck while its own armed trigger or scheduled routine will wake it; a failed session
    // is still read as stuck, a watch never hides it.
    const wake = input.processStatus === 'error' ? null : wakeSource(input, w, nowMs, true);
    if (wake) return wake;
    return strip({ state: 'waiting', kind: 'stuck', waitingOn: 'It stopped, and nothing will wake it', ...w });
  }

  if (input.phase === 'TODO') return strip({ state: 'waiting', kind: 'not-started', waitingOn: 'Not started yet', ...w });

  // WAITING (and any phase an older writer left): on what, from the facts first, then its words.
  const tasks = (input.waitingOnTasks ?? []).map(clean).filter(Boolean);
  const until = input.waitUntil && Date.parse(input.waitUntil) > nowMs ? input.waitUntil : null;
  const reported = report?.state === 'waiting' && !none(report.waiting_on) ? clean(report.waiting_on) : '';
  const reportedKind = report?.state === 'waiting' ? report.waiting_kind : undefined;
  if (machine) return machine;
  // Parked on its own work (its build, its test run, a deploy of its change): that is Working, not a
  // wait (2026-11-02, the user: "wait is not waintg wait is just acutally waitng").
  if (own && !tasks.length) return own;
  if (tasks.length) return strip({ state: 'waiting', kind: 'task', waitingOn: reported || `A reply from ${tasks.join(', ')}`, ...w });
  // Parked on the user (an older writer, a person's park): the user's ask, never a Waiting on them.
  // An ask with no kind of the user's own is no ask of theirs: with no lead above it, the task is a result to read and close.
  if (report?.kindless_ask && !hasAbove(input)) return toRead('result', RESULT_TO_READ, w);
  if (reported && (reportedKind === 'you' || (reportedKind === 'lead' && !hasAbove(input)))) return strip({ state: 'needs', source: 'session', ask: reported, ...w });
  if (reported && reportedKind && reportedKind !== 'stuck') return strip({ state: 'waiting', kind: reportedKind, waitingOn: reported, ...(until ? { until } : {}), ...w });
  // A standing routine: between fires it waits on the next one.
  const wake = wakeSource(input, w, nowMs, true);
  if (wake) return wake;
  if (report?.state === 'done') {
    if (input.isMain || input.isLead) return strip({ state: 'waiting', kind: 'you', waitingOn: 'Your next message, or news from its teams', ...w });
    if (input.hasLeader) return strip({ state: 'waiting', kind: 'lead', waitingOn: 'Its lead, to check the result and close it', ...w });
    return toRead('result', RESULT_TO_READ, w);
  }
  if (until) return strip({ state: 'waiting', kind: 'time', waitingOn: 'Its next check', until, ...w });
  if (input.phase === 'WAITING') return strip({ state: 'waiting', kind: 'other', waitingOn: 'A message (parked with no clock or watch)', ...w });
  return strip({ state: fallbackUserState(input.phase), ...w });
}

/** The state of a task the server has not derived yet (an older server, a row before the
 *  first pass): the phase alone, as an older Walnut meant it (NEED_ACTION was "handed back
 *  to you"), the same on every surface: the web task rows (taskNeedsAction), the Board's
 *  chips, the Org counts and iOS (TeamStatusModel.state, BoardModel.needsHuman). The
 *  server derives every open task within seconds of boot, so this rarely shows. */
export function fallbackUserState(phase: string | undefined, status?: string): UserState {
  if (phase === 'COMPLETE' || status === 'done') return 'done';
  if (phase === 'NEED_ACTION') return 'needs';
  return phase === 'IN_PROGRESS' ? 'working' : 'waiting';
}

/** The keys of the status every agent task read carries (agentStatusView). */
export const AGENT_STATUS_KEYS = ['state', 'ask', 'source', 'threads', 'kind', 'waitingOn', 'toRead', 'category', 'carriesOn', 'now', 'at', 'checkedAt', 'unverified', 'until', 'snoozed', 'sameAsk', 'answeredFor'] as const;

/**
 * The live status an agent reads beside a task in every list, bulk and single read (2026-11-02,
 * the user through Main: Main told the user two things waited on him that he had answered in the
 * task chats, because it read the task's `summary`, days old and about an earlier ask). The stored
 * user_status cut to what says whether it asks the user anything now, and since when: a completed
 * task is Done; one not derived yet reads its phase as an older Walnut meant it. Pure.
 */
export function agentStatusView(task: { phase?: unknown; status?: unknown; user_status?: unknown }): Partial<UserStatus> & { state: UserState } {
  const phase = typeof task.phase === 'string' ? task.phase : undefined;
  const status = typeof task.status === 'string' ? task.status : undefined;
  if (phase === 'COMPLETE' || status === 'done') return { state: 'done' };
  const us = task.user_status as Partial<UserStatus> | null | undefined;
  if (!us?.state) return { state: fallbackUserState(phase, status) };
  const out: Record<string, unknown> = {};
  for (const k of AGENT_STATUS_KEYS) if (us[k] !== undefined && us[k] !== null && us[k] !== '') out[k] = us[k];
  return out as Partial<UserStatus> & { state: UserState };
}

/** The words that say a task's summary is history, not its ask (every read that gives a summary). */
export const SUMMARY_IS_HISTORY = 'summary is the note\'s Executive Summary as of summary_at (absent: written before Walnut kept the time, so older still), often about an earlier turn: what the task asks the user now is user_status (state, ask, at, checkedAt), never the summary.';

/** When the task's summary was last written (its per-field change time), when known. Pure. */
export function summaryAt(task: { field_at?: unknown }): string | undefined {
  const at = (task.field_at as Record<string, unknown> | undefined)?.summary;
  return typeof at === 'string' && at ? at : undefined;
}

/** `read` is optional for a count an older server sent (it counted those under waiting). */
export interface UserStatusCounts { needs: number; read?: number; working: number; waiting: number; done: number }

export function countUserStates(statuses: Iterable<Pick<UserStatus, 'state'>>): Required<UserStatusCounts> {
  const c: Required<UserStatusCounts> = { needs: 0, read: 0, working: 0, waiting: 0, done: 0 };
  for (const s of statuses) c[s.state] = (c[s.state] ?? 0) + 1;
  return c;
}

/** "2 Needs you · 1 To read · 10 Working · 16 Waiting / snoozed · 12 Completed", the one line every
 *  surface prints; To read only when there is one. */
export function userStatusLine(c: UserStatusCounts, opts: { withDone?: boolean } = {}): string {
  // To read is counted under Needs you, where it is drawn (shownState).
  const parts = [stateCountLabel('needs', c.needs + (c.read ?? 0)), stateCountLabel('working', c.working), stateCountLabel('waiting', c.waiting)];
  if (opts.withDone !== false) parts.push(stateCountLabel('done', c.done));
  return parts.join(' · ');
}

// ── The Brief: Main's or a lead's short letter to the user (sessions/brief-write.ts) ──

/** What the session wrote, and when (Task.brief). */
export interface TaskBrief {
  text: string;
  at: string;
  /** The lines that break the Brief's rules (sessions/brief-rules.ts), as Walnut found them. */
  issues?: Array<{ kind: 'no_task' | 'no_vp' | 'several_things'; line: string; vp?: { id: string; title: string }; detail?: string }>;
  /** Each named task's status mark when it was written (sessions/brief-fresh.ts briefSnapshot):
   *  a line whose task's mark differs now moved since. Absent on a letter stored before. */
  marks?: Record<string, string>;
  /** The tasks that asked the user when it was written (a lead's team, Main's org). */
  asks?: string[];
}

/** The longest Brief kept: a dozen lines, not a document (Main's lines carry two task refs). */
export const BRIEF_MAX_CHARS = 4000;

/** The fields the Brief's team is read from. */
export interface BriefTask {
  id: string;
  title: string;
  phase: string;
  project?: string;
  parent_task_id?: string;
  org_role?: string;
  org_leads?: readonly string[];
  /** Kept to a plugin's own view (Task.plugin_only): never part of a team. */
  plugin_only?: string;
  phase_changed_at?: string;
}

/**
 * The work a Brief is about. A lead's: every task in the projects it leads and every task below
 * it. Main's: the leads and every task below Main. Never the owner itself.
 */
export function briefTeam<T extends BriefTask>(owner: BriefTask, tasks: readonly T[]): T[] {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const below = (t: T): boolean => {
    let cur: T | undefined = t;
    for (let hops = 0; cur?.parent_task_id && hops < 12; hops++) {
      if (cur.parent_task_id === owner.id) return true;
      cur = byId.get(cur.parent_task_id);
    }
    return false;
  };
  // Keyed as the Org tree keys projects (org-tree.ts projectKey); the Inbox ('') is no one's team.
  const key = (p: string | undefined) => (p ?? '').trim().toLowerCase();
  const projects = owner.org_role === 'lead'
    ? new Set([owner.project, ...(owner.org_leads ?? [])].map(key).filter(Boolean)) : null;
  // A plugin's own task (Task.plugin_only) is no one's team: the Brief never names it.
  return tasks.filter((t) => t.id !== owner.id && !t.plugin_only && (
    below(t)
    || (owner.org_role === 'main' ? t.org_role === 'lead' : !!projects && projects.has(key(t.project)) && t.org_role !== 'main')
  ));
}

// ── The Brief's three sections: what needs the user, what works, what waits ──

/**
 * Every Brief has these sections, in this order, under these headings (2026-10-30, the user:
 * "what is being done, what does not need me, what needs me ... this task itself actually has this
 * status ... we must put this whole structure in"). A task's line goes in the section of its own
 * live status (Task.user_status), whose Waiting covers a snoozed or parked task, and To read (2026-11-02)
 * a finished result or an answer with nothing asked. Done work has no section: it leaves the Brief. sessions/brief-structure.ts keeps every stored Brief in this shape.
 */
export const BRIEF_SECTIONS: ReadonlyArray<{ state: Exclude<UserState, 'done' | 'read'>; heading: string; optional?: true }> = [
  // A task with only something to read is under Needs you too (shownState, 2026-11-03).
  { state: 'needs', heading: 'Needs you' },
  { state: 'working', heading: 'Working' },
  { state: 'waiting', heading: 'Waiting / snoozed' },
];

/** A team task as the Brief's section lists read it. */
export interface BriefSectionTask extends BriefTask {
  status?: string;
  user_status?: UserStatus;
  /** Its latest result (peers/structured-reply.ts): Partial while not_done is set and unsettled. */
  result_report?: { not_done?: readonly string[]; settled?: unknown; at?: string };
}

export function resultIsPartial(r: BriefSectionTask['result_report']): boolean {
  return !!r?.not_done?.length && !r.settled;
}
