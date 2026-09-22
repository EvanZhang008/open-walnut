/**
 * Inbox Triage's letter budget: ONE summary plus THREE decisions per run, and the
 * withdrawal of a decision a later run has taken over.
 *
 * WHY A SERVER-SIDE BACKSTOP AT ALL. The skill and the run instructions state the
 * budget, and a well-behaved run keeps it. A badly-behaved one buries the human:
 * every letter badges the bell AND pushes to the phone (letter pushes are
 * deliberately independent of the "is a browser open" gate — see
 * core/push/letter-push.ts), so a run that sends one letter per item turns a quiet
 * batch into twenty banners. That is the same argument `chargeLetterQuota` makes
 * for plugins (core/plugins/server-api.ts), and this is its per-RUN twin.
 *
 * WHY THE SESSION IS THE KEY. A triage run is a NEW task and a NEW session every
 * time (decision D2), so "per run" and "per session" are the same window and the
 * counter resets by construction — there is no run id to invent, no reset to
 * schedule, and a crashed run leaves nothing to clean up.
 *
 * WHY IT CANNOT LIVE IN src/ops/human-inbox.ts. That module DECLARES the op; the
 * executor turns its `bind` into an HTTP call from the CALLER's own process
 * (src/ops/executor.ts), so a check there would run inside the session's CLI and
 * be advisory. The refusal belongs at the one place the server creates a letter
 * from a caller's session id — `sendLetterAsCaller` — which is shared by the HTTP
 * route and the cloud replica's relay, so both edges get it from one hook.
 *
 * WHAT IT MUST NOT DO. Touch any other agent's letters. A sender with no task, or
 * a task that is not stamped `agent_id: 'triage'`, is not tallied at all: the
 * guard answers `undefined` and the send proceeds exactly as before.
 */

import { log } from '../../logging/index.js';
import { TRIAGE_AGENT_ID } from '../triage/types.js';
import { LetterError } from './store.js';
import type { LetterRecord, LetterSender } from './types.js';

/** Summary letters a run may send. The run's ONE document for the human to read. */
export const TRIAGE_SUMMARY_LETTERS_PER_RUN = 1;

/**
 * `action_required` letters a run may send. Three is what fits on a phone before
 * the inbox stops being a decision list and starts being a feed.
 */
export const TRIAGE_DECISION_LETTERS_PER_RUN = 3;

/**
 * A letter is either the run's summary or one of its decisions.
 *
 * Every non-`action_required` type counts as the SUMMARY, not just info/review.
 * The budget's unit is "documents the human has to read", and letting a run send
 * a second one by calling it `completion` would be a hole in a rule the human
 * feels rather than reads.
 */
export type TriageLetterKind = 'summary' | 'decision';

export function triageLetterKind(type: unknown): TriageLetterKind {
  return type === 'action_required' ? 'decision' : 'summary';
}

/** What one run has spent so far. */
export interface TriageLetterTally {
  summary: number;
  decision: number;
  /** The summary letter's id, so the refusal can name the thread to continue. */
  summaryLetterId?: string;
}

export type TriageQuotaRefusalReason = 'summary-spent' | 'decisions-spent' | 'no-actions';

export type TriageQuotaVerdict =
  | { allowed: true; kind: TriageLetterKind }
  | { allowed: false; kind: TriageLetterKind; reason: TriageQuotaRefusalReason; message: string };

/**
 * Is one more letter allowed, and if not, what should the model do instead?
 *
 * Pure, and the refusal text is part of the answer rather than a caller's
 * paraphrase: a model that hits a wall has to be told the next move in the same
 * breath, or it retries the same call until the run dies (the failure mode the
 * plan calls out for this slice).
 */
export function triageQuotaVerdict(
  tally: TriageLetterTally,
  letter: { type?: unknown; actions?: unknown },
): TriageQuotaVerdict {
  const kind = triageLetterKind(letter.type);
  if (kind === 'decision') {
    const actions = Array.isArray(letter.actions) ? letter.actions : [];
    if (actions.length === 0) {
      return {
        allowed: false,
        kind,
        reason: 'no-actions',
        message:
          'An action_required letter from Inbox Triage needs at least one button in `actions` — '
          + 'the button is what the human taps and what comes back into this run. Give it the '
          + 'options you can actually carry out (for example "Make a task", "Reply for me", '
          + '"Unsubscribe", "Ignore"), or send it as `review` if the user only needs to read it.',
      };
    }
    if (tally.decision >= TRIAGE_DECISION_LETTERS_PER_RUN) {
      return {
        allowed: false,
        kind,
        reason: 'decisions-spent',
        message:
          `Inbox Triage sends at most ${TRIAGE_DECISION_LETTERS_PER_RUN} decision letters `
          + `(type=action_required) per run, and this run already sent ${tally.decision}. Do not `
          + 'retry: fold the rest into the summary letter — name how many items still need the '
          + 'user, say what each one is waiting for, and say they will be offered next run.'
          + (tally.summaryLetterId
            ? ` The summary letter for this run is ${tally.summaryLetterId}; add to it with `
              + `human_inbox_reply {"letter":"${tally.summaryLetterId}"}.`
            : ' Send the summary letter (type=review) once, at the end, with that list in it.'),
      };
    }
    return { allowed: true, kind };
  }
  if (tally.summary >= TRIAGE_SUMMARY_LETTERS_PER_RUN) {
    return {
      allowed: false,
      kind,
      reason: 'summary-spent',
      message:
        'Inbox Triage sends ONE summary letter per run'
        + (tally.summaryLetterId ? `, and this run already sent ${tally.summaryLetterId}` : '')
        + '. Do not send a second one: put what you were going to say into that letter with '
        + (tally.summaryLetterId
          ? `human_inbox_reply {"letter":"${tally.summaryLetterId}","text":"..."}`
          : 'human_inbox_reply on that letter')
        + '. If it is a decision the user has to make, send it as type=action_required with '
        + 'buttons instead (up to '
        + `${TRIAGE_DECISION_LETTERS_PER_RUN} per run).`,
    };
  }
  return { allowed: true, kind };
}

// ── The per-run tallies (bounded; a run is a session) ──

interface RunEntry extends TriageLetterTally {
  /** Last touch, for eviction. A run is minutes long; this map is not a store. */
  at: number;
}

/**
 * Bounded on purpose. Every entry is a few numbers, but the process is long-lived
 * and a run is created every interval forever, so an unbounded map is a slow leak
 * that nothing would ever notice.
 */
const MAX_TRACKED_RUNS = 200;
const RUN_ENTRY_TTL_MS = 24 * 60 * 60 * 1000;

const runs = new Map<string, RunEntry>();

/**
 * Whether a task is a triage run's task, cached. `agent_id` is stamped at task
 * creation and never changes, so the answer is permanent for a given id; only the
 * map's SIZE needs bounding.
 *
 * ONLY REAL ANSWERS GO IN HERE. See `isTriageSender`: a lookup that timed out or
 * threw never writes, because this cache is read first and never re-checked.
 */
const MAX_TRACKED_TASKS = 500;
const triageTasks = new Map<string, boolean>();

function prune(now: number): void {
  for (const [key, entry] of runs) {
    if (now - entry.at > RUN_ENTRY_TTL_MS) runs.delete(key);
  }
  // Insertion order is oldest-first; drop from the front until we are back under.
  while (runs.size > MAX_TRACKED_RUNS) {
    const oldest = runs.keys().next();
    if (oldest.done) break;
    runs.delete(oldest.value);
  }
}

/** The tally for one run, for tests and for a caller that wants to report it. */
export function triageLetterTally(sessionId: string): TriageLetterTally {
  const entry = runs.get(sessionId);
  return {
    summary: entry?.summary ?? 0,
    decision: entry?.decision ?? 0,
    ...(entry?.summaryLetterId ? { summaryLetterId: entry.summaryLetterId } : {}),
  };
}

/**
 * Drop a finished run's tally. Optional — the TTL and the size cap already bound
 * the map — and offered so the runner can be tidy when it sees `session:result`.
 */
export function forgetTriageRun(sessionId: string): void {
  runs.delete(sessionId);
}

/** Test seam: forget every run and every cached task stamp. */
export function _resetTriageLetterQuotaForTesting(): void {
  runs.clear();
  triageTasks.clear();
}

// ── Identity: is this caller a triage run? ──

export interface TriageLetterDeps {
  /** Resolve whether a task is a triage run's task. Default: its `agent_id` stamp. */
  isTriageTask?: (taskId: string) => Promise<boolean>;
  now?: () => number;
}

/** A task read must never be what pins the letter route. */
const TASK_STAMP_TIMEOUT_MS = 2_000;

/**
 * Deliberately NOT `stampedAgentId` (sessions/ask-agent.ts), even though that
 * helper now lets a store failure through too: its `undefined` still means BOTH
 * "no stamp" and "no such task", and here those are answers about different
 * questions. Reading the task directly keeps one meaning per outcome: a stamp, no
 * stamp, or a throw that `isTriageSender` treats as no answer and never caches.
 */
async function defaultIsTriageTask(taskId: string): Promise<boolean> {
  const { getTask } = await import('../task-manager.js');
  return (await getTask(taskId)).agent_id === TRIAGE_AGENT_ID;
}

/** A lookup that neither answered nor threw in time. NOT the answer `false`. */
const NO_ANSWER = Symbol('triage-stamp-no-answer');

/**
 * Is this sender a triage run? Keyed on the task's `agent_id` stamp — the thing
 * the executor writes — and never on a title or a project name, because a user is
 * free to rename either and a renamed project must not switch the budget off.
 *
 * A FAILED READ IS NOT AN ANSWER, so the verdict for the letter IN HAND and the
 * verdict written to the CACHE deliberately differ when the lookup fails:
 *
 *  - in hand: `false`, i.e. no tally and no refusal. The quota is the BACKSTOP and
 *    the skill is the primary rule, so a store hiccup must lose the backstop
 *    rather than refuse a letter the human is waiting for.
 *  - cached: nothing. The cache is consulted first and never re-checked, so
 *    remembering a timeout would classify a REAL triage run as "not triage" for
 *    the rest of that run, and every later letter in it would bypass the
 *    1-summary + 3-decision budget — one bell badge and one phone push per item,
 *    the exact outcome this module exists to prevent. The next letter asks again.
 *
 * The `external` sender is the same shape: letter-ops.ts answers it both for a
 * genuine plugin letter AND when it could not resolve the caller's session, so it
 * too is answered permissively and remembered nowhere (there is no task id to
 * remember it under).
 */
async function isTriageSender(sender: LetterSender, deps: TriageLetterDeps): Promise<boolean> {
  const taskId = sender.taskId?.trim();
  const sid = sender.sessionId?.trim();
  if (!taskId || !sid || sid === 'external') return false;
  const cached = triageTasks.get(taskId);
  if (cached !== undefined) return cached;
  const resolve = deps.isTriageTask ?? defaultIsTriageTask;
  let timer: NodeJS.Timeout | undefined;
  let answer: boolean | typeof NO_ANSWER = NO_ANSWER;
  try {
    answer = await Promise.race<boolean | typeof NO_ANSWER>([
      resolve(taskId),
      new Promise<typeof NO_ANSWER>((resolvePromise) => {
        timer = setTimeout(() => {
          log.notif.warn(
            'human-inbox: triage stamp lookup timed out — letter not counted, verdict NOT cached',
            { taskId },
          );
          resolvePromise(NO_ANSWER);
        }, TASK_STAMP_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch (err) {
    log.notif.warn('human-inbox: triage stamp lookup failed — letter not counted, verdict NOT cached', {
      taskId, error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (answer === NO_ANSWER) return false;
  if (triageTasks.size >= MAX_TRACKED_TASKS) {
    const oldest = triageTasks.keys().next();
    if (!oldest.done) triageTasks.delete(oldest.value);
  }
  triageTasks.set(taskId, answer);
  return answer;
}

// ── The hook ──

/**
 * A slot this run has taken. `commit` names the letter that filled it; `release`
 * gives it back when the letter never came into existence.
 */
export interface TriageLetterCharge {
  commit(letterId: string): void;
  release(): void;
}

/**
 * Charge a triage run's letter budget, or refuse with a sentence it can act on.
 *
 * Returns `undefined` for every caller that is not a triage run — no bookkeeping,
 * no behaviour change.
 *
 * The slot is taken HERE, before the letter is written, and released if the write
 * fails. Counting on the way out instead would let two concurrent sends (a model
 * can issue parallel tool calls) both read "two decisions spent" and both go
 * through, which is exactly the overshoot the budget exists to prevent; and a
 * letter the store REJECTS (an oversize field, a duplicate action id) must not
 * cost a slot the run can never get back, hence `release`.
 *
 * Throws a `LetterError` on refusal, which is what makes the route answer the
 * sentence verbatim: `guard()` in routes/human-inbox-v1.ts turns a LetterError
 * into the frozen v1 error shape, and the ops executor renders that as
 * `Walnut API error (bad_request): <sentence>` in the model's tool result.
 */
export async function guardTriageLetter(
  input: { type?: unknown; actions?: unknown },
  sender: LetterSender,
  deps: TriageLetterDeps = {},
): Promise<TriageLetterCharge | undefined> {
  if (!await isTriageSender(sender, deps)) return undefined;
  const now = deps.now ?? Date.now;
  const sid = sender.sessionId;
  const tally = triageLetterTally(sid);
  const verdict = triageQuotaVerdict(tally, input);
  if (!verdict.allowed) {
    log.notif.warn('human-inbox: triage letter refused by the per-run budget', {
      sessionId: sid,
      taskId: sender.taskId,
      kind: verdict.kind,
      reason: verdict.reason,
      summarySent: tally.summary,
      decisionsSent: tally.decision,
    });
    throw new LetterError(verdict.message, 'invalid', 400);
  }

  const at = now();
  const entry = runs.get(sid) ?? { summary: 0, decision: 0, at };
  if (verdict.kind === 'decision') entry.decision += 1;
  else entry.summary += 1;
  entry.at = at;
  // Re-set so the map's insertion order stays "least recently touched first".
  runs.delete(sid);
  runs.set(sid, entry);
  prune(at);

  return {
    commit(letterId: string) {
      // The id is recorded only now, so a reservation that failed never names a
      // letter the refusal would tell the model to reply to.
      if (verdict.kind === 'summary') entry.summaryLetterId ??= letterId;
      log.notif.info('human-inbox: triage letter counted against the run budget', {
        sessionId: sid, letterId, kind: verdict.kind,
        summarySent: entry.summary, decisionsSent: entry.decision,
      });
    },
    release() {
      if (verdict.kind === 'decision') entry.decision = Math.max(0, entry.decision - 1);
      else entry.summary = Math.max(0, entry.summary - 1);
      log.notif.info('human-inbox: triage letter slot released — the letter was not written', {
        sessionId: sid, kind: verdict.kind,
        summarySent: entry.summary, decisionsSent: entry.decision,
      });
    },
  };
}

// ── Withdrawal: a decision a later run has taken over ──

/** The note a withdrawn triage decision carries when the caller names none. */
export const TRIAGE_SUPERSEDED_NOTE =
  'A later Inbox Triage run looked at the same items, so this decision is out of date. '
  + 'Nothing was done on your behalf; the current run\'s letters are the live ones.';

export interface WithdrawSupersededOptions {
  /**
   * The run doing the superseding. Its OWN letters are kept — a run must not
   * withdraw the decisions it just sent.
   */
  keepSessionId?: string;
  /** Extra letter ids to keep whatever their sender (a decision still in play). */
  keepLetterIds?: readonly string[];
  /** Why, in the thread. Defaults to TRIAGE_SUPERSEDED_NOTE. */
  note?: string;
  /** Injectable for tests; defaults to the real letter store + letter-ops. */
  listLetters?: () => Promise<{ letters: LetterRecord[] }>;
  withdraw?: (id: string, input: { note: string }) => Promise<unknown>;
  isTriageTask?: (taskId: string) => Promise<boolean>;
}

export interface WithdrawSupersededResult {
  /** Letter ids this call retired. */
  withdrawn: string[];
  /** Triage decisions left alone (this run's own, or explicitly kept). */
  kept: number;
  /** Withdrawals that threw; the sweep never fails the run that asked for it. */
  failed: number;
}

/**
 * Retire the unanswered decision letters that EARLIER triage runs left in the
 * inbox. THE HELPER S13's runner calls (`src/core/triage/runs.ts`) — it runs at
 * the start or the end of a run, whichever the runner prefers, passing the current
 * run's session id as `keepSessionId`.
 *
 * Why a sweep and not a stored list: a run's letters are already identified by
 * their sender (the run's session + task), so the inbox IS the list. A side record
 * of "letters this run sent" would be a second truth that goes stale the moment a
 * human archives one.
 *
 * Only `action_required` and only UNANSWERED: an answered letter is a decision the
 * human already made, and `withdrawLetter` is idempotent on one anyway. Archived
 * letters are out of scope — the human filed them away themselves.
 */
export async function withdrawSupersededTriageLetters(
  options: WithdrawSupersededOptions = {},
): Promise<WithdrawSupersededResult> {
  const list = options.listLetters ?? (async () => {
    const { listLetters } = await import('./store.js');
    return await listLetters({ archived: false });
  });
  const withdraw = options.withdraw ?? (async (id: string, input: { note: string }) => {
    const { withdrawLetterAndAnnounce } = await import('./letter-ops.js');
    return await withdrawLetterAndAnnounce(id, input);
  });
  const note = options.note?.trim() || TRIAGE_SUPERSEDED_NOTE;
  const keepIds = new Set(options.keepLetterIds ?? []);
  const deps: TriageLetterDeps = options.isTriageTask ? { isTriageTask: options.isTriageTask } : {};

  const result: WithdrawSupersededResult = { withdrawn: [], kept: 0, failed: 0 };
  const { letters } = await list();
  for (const letter of letters) {
    if (letter.type !== 'action_required' || letter.answered) continue;
    // Cheap shape checks first; the task-stamp lookup only runs for a letter that
    // could plausibly be one of ours.
    if (!await isTriageSender(letter.sender, deps)) continue;
    if (keepIds.has(letter.id) || letter.sender.sessionId === options.keepSessionId) {
      result.kept += 1;
      continue;
    }
    try {
      await withdraw(letter.id, { note });
      result.withdrawn.push(letter.id);
    } catch (err) {
      result.failed += 1;
      log.notif.warn('human-inbox: could not withdraw a superseded triage decision', {
        letterId: letter.id, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (result.withdrawn.length > 0 || result.failed > 0) {
    log.notif.info('human-inbox: superseded triage decisions withdrawn', {
      withdrawn: result.withdrawn.length, kept: result.kept, failed: result.failed,
      keepSessionId: options.keepSessionId,
    });
  }
  return result;
}
