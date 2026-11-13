/**
 * Session request registry — the "expect a reply" ledger behind session_send /
 * session_start.
 *
 * A sender that passes expect_reply gets a pending request row here. The row is
 * the TRUTH about whether the asker has been answered; every signal that could
 * end the wait (an explicit reply, the target's turn ending without one, the
 * deadline sweeper) settles the SAME row with an atomic check-and-set, so the
 * asker hears back exactly once no matter which signal fires first — and no
 * matter how flaky any single signal is (task phases flip on errors and
 * permission prompts too; the sweeper is the guarantee of last resort).
 *
 * Design lineage (see docs/plan): Claude Code's task-notification (`notified`
 * atomic mark, status settles BEFORE notification embellishment), one reference
 * client's "failure is also a completion event", another's phase gating. Storage follows
 * the notifications.json pattern: one bounded JSON file under WALNUT_HOME.
 */

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { WALNUT_HOME } from '../constants.js';
import { readJsonFile, updateJsonFile, writeJsonFile } from '../utils/fs.js';
import { buildWalnutMessage, sessionHandle } from './peers/walnut-message-tag.js';
import { createEnvelopeKit, type EnvelopeHandedOn } from './peers/envelope-kit.js';
import { isHeldElsewhereReason } from './sessions/undelivered-requests.js';
import { log } from '../logging/index.js';
// The cap and the retention prune keeps live beside how a copy reads them.
import { MAX_REQUESTS, SETTLED_RETENTION_MS } from './session-request-retention.js';

const REQUESTS_FILE = path.join(WALNUT_HOME, 'session-requests.json');

// The wording lives in peers/envelope-kit.ts: a host daemon answering while the
// server is away builds the same previews and envelopes, byte for byte.
const kit = createEnvelopeKit();

/** Default reply deadline when the sender EXPLICITLY asked for a reply and
 *  named no timeout. An explicit ask is an ask: an hour of silence is worth
 *  hearing about. */
export const DEFAULT_REPLY_TIMEOUT_SECS = 3_600;
/** Default deadline for an IMPLICIT request — one the expect_reply default
 *  created because the caller was a session and said nothing either way
 *  (2026-09-01). These are the common case now, and most of them are "tell me
 *  when you're done" rather than "answer me": a 1h fuse on every session→session
 *  message turns the reply loop into a notification firehose, which is the exact
 *  noise the bell-badge denoise work went after. Six hours still guarantees the
 *  asker eventually hears something, without narrating every quiet hand-off. */
export const IMPLICIT_REPLY_TIMEOUT_SECS = 6 * 60 * 60;
/** Deadline bounds — a sweep tick is 60s, so sub-minute deadlines are noise. */
export const MIN_REPLY_TIMEOUT_SECS = 60;
export const MAX_REPLY_TIMEOUT_SECS = 24 * 60 * 60;

/**
 * What kind of work a request asks for, which sets its default deadline (2026-11-04, the org
 * reflection: of 40 overdue notices a VP got in a day, most were 6h fuses on "read your task and
 * do it end to end" starts and on asks to leads, whose answers take a whole job or a team's round):
 *   - 'send': a message to a task about work it is doing (1h asked, 6h by default);
 *   - 'lead': a message to a lead or Main, whose answer waits on its teams;
 *   - 'start': starting a task, whose answer is the whole task done.
 */
export type ReplyKind = 'send' | 'lead' | 'start';
export const REPLY_TIMEOUT_BY_KIND: Readonly<Record<ReplyKind, { asked: number; implicit: number }>> = {
  send: { asked: DEFAULT_REPLY_TIMEOUT_SECS, implicit: IMPLICIT_REPLY_TIMEOUT_SECS },
  lead: { asked: 2 * 60 * 60, implicit: 12 * 60 * 60 },
  start: { asked: 12 * 60 * 60, implicit: 12 * 60 * 60 },
};

/**
 * An overdue request whose target is plainly at work (a turn running, an answer it just sent,
 * a report of working) waits one more of its own waits instead of telling its asker to check,
 * up to this many of its waits from the ask (and never past MAX_REPLY_TIMEOUT_SECS).
 */
export const ACTIVE_WAIT_FACTOR = 4;

export type SessionRequestStatus =
  | 'pending'
  /** The target session explicitly replied (session_send in_reply_to). */
  | 'replied'
  /** No reply, but Walnut notified the asker (turn end / target death). */
  | 'notified'
  /** No reply by the deadline; the asker was told to go look. */
  | 'expired'
  /** Nobody waits on it: the asker's task completed (withdrawRequest). Reopening restores it. */
  | 'withdrawn';

/** Why a 'notified' settle fired — rides into the notification wording. */
export type SessionRequestOutcome = 'completed' | 'error' | 'awaiting_human' | 'timeout';

export interface SessionRequest {
  /** `rq-<12 hex>` — the correlation id the target quotes in its reply. */
  id: string;
  /** Asker's session id — where the reply / fallback notification lands. */
  fromSessionId: string;
  /** Target session id (present once known; session_start stamps the preassigned id). */
  toSessionId?: string;
  /** Target task id — the stable handle phase events are keyed on. */
  toTaskId?: string;
  /** One-line clip of what was asked, for the notification wording. */
  preview: string;
  status: SessionRequestStatus;
  createdAt: string;
  /** Epoch ms the sweeper enforces. */
  deadlineAt: number;
  settledAt?: string;
  /** For status 'notified' | 'expired'. */
  outcome?: SessionRequestOutcome;
  /**
   * The work went on: its target handed it to another task (`hands_on` on its own ask,
   * pending request `id`, to `taskId`, at `at` ms), so this one waits for that answer
   * instead of reading as "ended without a reply" (linkHandoffs). Additive, 2026-10.
   */
  carriedBy?: { id: string; taskId?: string; at?: number }[];
  /** The other side: the requests its sender handed on with it. */
  carries?: string[];
  /**
   * Its answer went past its asker, as the answer to this carried request (sessions/reply-handoff.ts):
   * the asker read one line, not the answer. Additive, 2026-10.
   */
  forwardedTo?: string;
  /** The deadline the asker set, before a hand-off moved it (unlinkHandoff puts it back). */
  ownDeadlineAt?: number;
  /** The structured fields of the reply that settled it (peers/structured-reply.ts; additive, 2026-10). */
  reply?: import('./peers/structured-reply.js').StructuredReply;
  /**
   * An expired request is OVERDUE, STILL OPEN (2026-10-28, the tracking research: 34 lead
   * timeouts in 3 days, 19 never answered later, and each read as closed): it stays on
   * open_items and the Brief until a reply settles it (`lateFrom: 'expired'`), its asker's or
   * target's task completes, or it ages out with the settled rows. `remindedAt`: the one
   * reminder its asker got at twice the deadline.
   */
  remindedAt?: string;
  lateFrom?: 'expired';
  /** When this server's deadline sweep made it overdue (ISO). Only such a row is reminded:
   *  rows an older Walnut expired never are, so an upgrade does not send a burst of them. */
  overdueAt?: string;
  /** The target queue row (`qm-…`) the asked message went out as, so a read of the request can
   *  say whether it still waits to go in and a sender can send it now (additive, 2026-10). */
  messageId?: string;
  /** The wait it was asked with (ms), kept once an active target moved its deadline (waitWhileActive). */
  waitMs?: number;
  /** How many times its deadline moved because its target was at work, and the last reason. */
  activeWaits?: number;
  /**
   * Time Walnut was not running (stopped, or the Mac asleep) while it was pending (ms): its
   * deadline moved by as much (creditDowntime), and its own wait leaves it out.
   */
  pausedMs?: number;
  /** The same, while it was overdue and not reminded yet: its reminder moved by as much. */
  remindPausedMs?: number;
  activeWhy?: string;
  /**
   * The answer that settled it, as a fingerprint (answerDigest), and the asker session it was
   * delivered to: a later answer with the same words from the same task to the same asker is
   * the same answer, delivered once (2026-11-04: a worker answered its lead's two open requests
   * with one text each round, and the lead read every answer twice). Additive, 2026-11.
   */
  answerDigest?: string;
  deliveredTo?: string;
  /** When that answer went out (ISO): the window SAME_ANSWER_WINDOW_MS counts from it. */
  answeredAt?: string;
  /** Settled by an answer already delivered for this request (sameAnswerOf): its asker read it once. */
  sameAnswerAs?: string;
  /** When its asker was told its target showed nothing since the ask (once; session-request-notify.ts remindSilent). */
  silentToldAt?: string;
  /**
   * When the asked message last reached the target's CLI (ISO): Walnut's proof of delivery for its
   * queue row (`messageId`, session:messages-delivered), or a host's write into the target's live CLI
   * (offline-host-core.ts localSend). A delivery is a write, not the CLI's reading: while the queue
   * holds the row waiting to go out again (its process died unread), it proves nothing
   * (stillReached). Durable, so a server restart never forgets that the target has
   * the ask (2026-11-08: a restarted server told an asker a task had not taken the work 55
   * minutes into the turn that read it). Additive, 2026-11.
   */
  reachedAt?: string;
}

/** How long an answer already delivered makes the same words to the same asker a repeat: one
 *  round of answers (the 2026-11-04 pairs came seconds apart), not the same short words hours later. */
export const SAME_ANSWER_WINDOW_MS = 30 * 60 * 1000;

/** The fingerprint of an answer's words: spacing does not make two answers different. */
export function answerDigest(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 24);
}

/** An answer about to settle a request: its fingerprint, where it goes, and who gives it. */
export interface AnswerStamp {
  digest: string;
  deliveredTo: string;
  by: { sessionId: string; taskId?: string };
}

/**
 * The request an answer with these words already went to this asker for, from the same task,
 * within SAME_ANSWER_WINDOW_MS (the row itself counts: an answer repeated on one request).
 * Undefined when the answer is new.
 */
export function sameAnswerOf(rows: readonly SessionRequest[], stamp: AnswerStamp, now = Date.now()): SessionRequest | undefined {
  // Any status: a late answer to a request a turn end already settled (notified) went out too.
  return rows.find((r) => !r.forwardedTo && !r.sameAnswerAs
    && r.answerDigest === stamp.digest && r.deliveredTo === stamp.deliveredTo
    && (r.toSessionId === stamp.by.sessionId || (!!stamp.by.taskId && r.toTaskId === stamp.by.taskId))
    && !!r.answeredAt && now - Date.parse(r.answeredAt) <= SAME_ANSWER_WINDOW_MS);
}

/** After the work a request was handed on to comes back, the asker's wait lasts this much longer. */
export const HANDOFF_GRACE_MS = 10 * 60 * 1000;
/** At most this many tasks carry one request. */
export const MAX_CARRIERS = 8;

export interface HandoffSender {
  sessionId: string;
  taskId?: string;
  /** The task of an asker's session, for the requests handed on (a question back to it is no hand-off). */
  askerTaskOf?: (sessionId: string) => string | undefined;
}

/** Why a named request was not handed on. */
export interface HandOnRefusal {
  id: string;
  reason: 'unknown' | 'settled' | 'not_yours' | 'back_to_asker' | 'too_many';
}

/** A hand-off never moves a deadline past the longest wait an asker may name, counted from its ask. */
function extendDeadline(r: SessionRequest, until: number): SessionRequest {
  const created = Date.parse(r.createdAt);
  const cap = Number.isFinite(created) ? created + MAX_REPLY_TIMEOUT_SECS * 1000 : Infinity;
  const next = Math.max(r.deadlineAt, Math.min(until, cap));
  return next === r.deadlineAt ? r : { ...r, ownDeadlineAt: r.ownDeadlineAt ?? r.deadlineAt, deadlineAt: next };
}

/**
 * Link `asked` to the requests its sender handed on with it (`hands_on` on task_send or
 * task_start): each waits for this answer instead of hearing its target ended without a
 * reply (2026-10-27, Main's reflection: a lead passed Main's request to a worker, ended
 * its turn, and Main heard "WAITING without an explicit reply" every time). The sender
 * names the request: guessing it from timing linked unrelated work and silenced an asker
 * that was blocked (two reviews, 2026-10-27). A named request is handed on only when it
 * is still pending, the sender owes it (addressed to its session or task), the ask does
 * not go back to its asker, and fewer than MAX_CARRIERS tasks carry it. A moved deadline
 * moves the requests that wait on it too (a worker handing it on again). Links always run
 * from an older request to this new one, so they never loop. Mutates `rows`; returns the
 * refusals.
 */
export function linkHandoffs(rows: SessionRequest[], asked: SessionRequest, from: HandoffSender, ids: readonly string[]): HandOnRefusal[] {
  const refused: HandOnRefusal[] = [];
  if (asked.status !== 'pending' || !ids.length) return refused;
  const now = Date.parse(asked.createdAt) || Date.now();
  const index = (id: string) => rows.findIndex((r) => r.id === id);
  const carrier = { id: asked.id, ...(asked.toTaskId ? { taskId: asked.toTaskId } : {}), at: now };
  const held: string[] = [];
  for (const id of new Set(ids)) {
    const i = index(id);
    const r = i === -1 || id === asked.id ? undefined : rows[i]!;
    if (!r) { refused.push({ id, reason: 'unknown' }); continue; }
    if (r.status !== 'pending') { refused.push({ id, reason: 'settled' }); continue; }
    if (!(r.toSessionId === from.sessionId || (!!from.taskId && r.toTaskId === from.taskId))) { refused.push({ id, reason: 'not_yours' }); continue; }
    if ((asked.toSessionId && r.fromSessionId === asked.toSessionId) || (asked.toTaskId && from.askerTaskOf?.(r.fromSessionId) === asked.toTaskId)) {
      refused.push({ id, reason: 'back_to_asker' });
      continue;
    }
    if ((r.carriedBy?.length ?? 0) >= MAX_CARRIERS) { refused.push({ id, reason: 'too_many' }); continue; }
    rows[i] = extendDeadline({ ...r, carriedBy: [...(r.carriedBy ?? []).filter((c) => c.id !== asked.id), carrier] }, asked.deadlineAt + HANDOFF_GRACE_MS);
    held.push(r.id);
  }
  if (!held.length) return refused;
  const at = index(asked.id);
  const self = { ...(at !== -1 ? rows[at]! : asked), carries: [...new Set([...(asked.carries ?? []), ...held])] };
  if (at !== -1) rows[at] = self;
  else Object.assign(asked, self);
  // A request waiting on one whose deadline moved waits as long (a chain of hand-offs).
  const bump = (id: string, depth: number): void => {
    const until = (rows[index(id)]?.deadlineAt ?? 0) + HANDOFF_GRACE_MS;
    for (let i = 0; i < rows.length; i++) {
      const x = rows[i]!;
      if (x.status !== 'pending' || !x.carriedBy?.some((c) => c.id === id)) continue;
      const next = extendDeadline(x, until);
      if (next === x) continue;
      rows[i] = next;
      if (depth < 4) bump(x.id, depth + 1);
    }
  };
  for (const id of held) bump(id, 0);
  return refused;
}

/**
 * The work `id` carried is back (it was answered or stopped): a request that now waits on
 * nothing else waits only HANDOFF_GRACE_MS more for its target's own answer, or until its
 * own deadline when that is later, instead of as long as the hand-off moved it. Mutates `rows`.
 */
export function pullInBack(rows: SessionRequest[], id: string, nowMs = Date.now()): void {
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.status !== 'pending' || !r.carriedBy?.some((c) => c.id === id)) continue;
    if (r.carriedBy.some((c) => byId.get(c.id)?.status === 'pending')) continue;
    const until = Math.min(r.deadlineAt, Math.max(r.ownDeadlineAt ?? r.deadlineAt, nowMs + HANDOFF_GRACE_MS));
    if (until !== r.deadlineAt) rows[i] = { ...r, deadlineAt: until };
  }
}

/**
 * Undo a hand-off whose ask never left (deletePendingRequest after a failed send): the
 * requests it carried stop waiting for it, and one carried by nothing else gets back its
 * own deadline. Mutates `rows`.
 */
export function unlinkHandoff(rows: SessionRequest[], id: string): void {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (!r.carriedBy?.some((c) => c.id === id)) continue;
    const carriedBy = r.carriedBy.filter((c) => c.id !== id);
    if (carriedBy.length) { rows[i] = { ...r, carriedBy }; continue; }
    const { carriedBy: _c, ownDeadlineAt, ...rest } = r;
    rows[i] = { ...rest, ...(ownDeadlineAt !== undefined && r.status === 'pending' ? { deadlineAt: ownDeadlineAt } : {}) };
  }
}

/**
 * The tasks of the askers of the requests named as handed on, for linkHandoffs' "a question
 * back to the asker" rule. Never throws: without it a hand-off back to another session of
 * the asker's task links, which only holds its notice until that answer.
 */
async function askerTasksOf(ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  try {
    const named = (await readJsonFile<RequestStore>(REQUESTS_FILE, EMPTY)).requests?.filter((r) => ids.includes(r.id)) ?? [];
    const { getSessionByClaudeId } = await import('./session-tracker.js');
    for (const sid of new Set(named.map((r) => r.fromSessionId))) {
      const taskId = (await getSessionByClaudeId(sid).catch(() => undefined))?.taskId;
      if (taskId) out.set(sid, taskId);
    }
  } catch { /* the rule degrades, see above */ }
  return out;
}

/**
 * Where the work `r` was handed on to stands: 'none' (it was not), 'out' (an answer is
 * still owed to its target) or 'back' (every task it went to answered or stopped).
 */
export function carriedState(r: SessionRequest, rows: readonly SessionRequest[]): 'none' | 'out' | 'back' {
  if (!r.carriedBy?.length) return 'none';
  const byId = new Map(rows.map((x) => [x.id, x] as const));
  return r.carriedBy.some((c) => byId.get(c.id)?.status === 'pending') ? 'out' : 'back';
}

/** The tasks `r` was handed on to, and whether each answered (a reply) or only stopped. */
export function handedOnOf(r: SessionRequest, rows: readonly SessionRequest[]): { id: string; taskId?: string; status: SessionRequestStatus | 'gone' }[] {
  const byId = new Map(rows.map((x) => [x.id, x] as const));
  return (r.carriedBy ?? []).map((c) => ({ ...c, status: byId.get(c.id)?.status ?? 'gone' }));
}

interface RequestStore { requests: SessionRequest[] }

const EMPTY: RequestStore = { requests: [] };

// --- Writes, for the leader's requests copy (replication/kinds/requests.ts) ---
const writeListeners = new Set<() => void>();

/** Called after every write of the requests file by this process. Returns the stop. */
export function onSessionRequestsWritten(cb: () => void): () => void {
  writeListeners.add(cb);
  return () => { writeListeners.delete(cb); };
}

/** Every write of the file goes through here. */
async function updateRequests(fn: (store: RequestStore) => RequestStore | Promise<RequestStore> | undefined | Promise<undefined>): Promise<void> {
  await updateJsonFile<RequestStore>(REQUESTS_FILE, EMPTY, fn);
  for (const cb of writeListeners) {
    try { cb(); } catch { /* one listener never stops the others */ }
  }
}

/**
 * Every request as stored (the requests copy's leader rows). A read that
 * failed throws rather than answering no requests (utils/fs.ts readErrors), so
 * the copy round skips this kind instead of removing the host's copy.
 */
export async function listAllSessionRequests(): Promise<SessionRequest[]> {
  return [...((await readJsonFile<RequestStore>(REQUESTS_FILE, EMPTY, { readErrors: 'throw' })).requests ?? [])];
}

function prune(requests: SessionRequest[]): SessionRequest[] {
  const cutoff = Date.now() - SETTLED_RETENTION_MS;
  const kept = requests.filter(
    (r) => r.status === 'pending' || new Date(r.settledAt ?? r.createdAt).getTime() >= cutoff,
  );
  // Bound the file: evict the OLDEST settled rows first, never a pending one.
  if (kept.length > MAX_REQUESTS) {
    const pending = kept.filter((r) => r.status === 'pending');
    const settled = kept.filter((r) => r.status !== 'pending');
    return [...settled.slice(settled.length - Math.max(0, MAX_REQUESTS - pending.length)), ...pending];
  }
  return kept;
}

/**
 * `implicit` = this request exists only because the expect_reply DEFAULT fired,
 * not because anyone asked. It changes nothing but the fallback fuse; a caller
 * that names its own timeout is honoured either way.
 */
export function clampReplyTimeoutSecs(secs: number | undefined, implicit = false, kind: ReplyKind = 'send'): number {
  if (typeof secs !== 'number' || !Number.isFinite(secs)) {
    const by = REPLY_TIMEOUT_BY_KIND[kind] ?? REPLY_TIMEOUT_BY_KIND.send;
    return implicit ? by.implicit : by.asked;
  }
  return Math.min(MAX_REPLY_TIMEOUT_SECS, Math.max(MIN_REPLY_TIMEOUT_SECS, Math.floor(secs)));
}

export async function createSessionRequest(input: {
  fromSessionId: string;
  toSessionId?: string;
  toTaskId?: string;
  text: string;
  replyTimeoutSecs?: number;
  /** True when only the expect_reply default created this row — see
   *  clampReplyTimeoutSecs. Purely a deadline hint; the row is otherwise
   *  identical, so a reply settles it the same way. */
  implicit?: boolean;
  /** The asker's task: a request named in `handsOn` may be owed by any session of it. */
  fromTaskId?: string;
  /** Requests the asker owes and hands on with this one (`hands_on`, linkHandoffs). */
  handsOn?: readonly string[];
  /** What it asks for: sets the default deadline (REPLY_TIMEOUT_BY_KIND). */
  kind?: ReplyKind;
  /** The queue row the asked message will go out as, known before it is queued (markRequestsReached). */
  messageId?: string;
}): Promise<SessionRequest & { handOnRefused?: HandOnRefusal[] }> {
  const request: SessionRequest = {
    id: `rq-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    fromSessionId: input.fromSessionId,
    ...(input.toSessionId ? { toSessionId: input.toSessionId } : {}),
    ...(input.toTaskId ? { toTaskId: input.toTaskId } : {}),
    preview: kit.requestPreview(input.text),
    status: 'pending',
    createdAt: new Date().toISOString(),
    deadlineAt: Date.now() + clampReplyTimeoutSecs(input.replyTimeoutSecs, input.implicit, input.kind) * 1000,
    ...(input.messageId ? { messageId: input.messageId } : {}),
  };
  let stored = request;
  let refused: HandOnRefusal[] = [];
  const handsOn = input.handsOn ?? [];
  const askers = await askerTasksOf(handsOn);
  await updateRequests((store) => {
    const requests = [...prune(store.requests ?? []), request];
    refused = linkHandoffs(requests, request, {
      sessionId: input.fromSessionId, taskId: input.fromTaskId, askerTaskOf: (sid) => askers.get(sid),
    }, handsOn);
    stored = requests.find((r) => r.id === request.id) ?? request;
    return { requests };
  });
  if (handsOn.length) {
    log.session.info('request hands on', {
      requestId: request.id, fromSessionId: input.fromSessionId, toTaskId: input.toTaskId,
      handed: stored.carries ?? [], refused,
    });
  }
  return refused.length ? { ...stored, handOnRefused: refused } : stored;
}

export async function getSessionRequest(id: string): Promise<SessionRequest | undefined> {
  const store = await readJsonFile<RequestStore>(REQUESTS_FILE, EMPTY);
  return (store.requests ?? []).find((r) => r.id === id);
}

/**
 * Remove a request row outright. Used when the send that created it FAILED to
 * deliver: the row must not survive to make the sweeper fire a bogus "no reply
 * by your deadline" notice for a message that never left. Only touches a still
 * pending row — a row someone already settled is left alone.
 */
export async function deletePendingRequest(id: string): Promise<void> {
  await updateRequests((store) => {
    const requests = store.requests ?? [];
    const idx = requests.findIndex((r) => r.id === id && r.status === 'pending');
    if (idx === -1) return undefined;
    const rest = requests.filter((_, i) => i !== idx);
    // What it carried was never handed on: those stop waiting for it.
    unlinkHandoff(rest, id);
    return { requests: rest };
  });
}

/**
 * Atomic pending→settled transition. Returns the settled row, or null when the
 * row is missing or ALREADY settled — the caller must then stay silent, because
 * whoever won the race already spoke to the asker (exactly-once).
 */
async function settle(
  id: string,
  status: Exclude<SessionRequestStatus, 'pending'>,
  outcome?: SessionRequestOutcome,
  reply?: SessionRequest['reply'],
  forwardedTo?: string,
  answer?: AnswerStamp,
): Promise<SessionRequest | null> {
  let settled: SessionRequest | null = null;
  await updateRequests((store) => {
    const requests = [...(store.requests ?? [])];
    const idx = requests.findIndex((r) => r.id === id);
    if (idx === -1 || requests[idx].status !== 'pending') return undefined;
    settled = {
      ...requests[idx],
      status,
      settledAt: new Date().toISOString(),
      ...(outcome ? { outcome } : {}),
      ...(reply ? { reply } : {}),
      ...(forwardedTo ? { forwardedTo } : {}),
      ...(status === 'expired' ? { overdueAt: new Date().toISOString() } : {}),
      ...stampAnswer(requests, id, answer),
    };
    requests[idx] = settled;
    // A request this one carried has its work back: its wait shrinks to its target's own answer.
    if (settled.carries?.length) pullInBack(requests, id);
    return { requests };
  });
  return settled;
}

/** The answer fields of a row it settles: its fingerprint, and the earlier request it repeats, checked in the same write. */
function stampAnswer(requests: readonly SessionRequest[], id: string, answer: AnswerStamp | undefined): Partial<SessionRequest> {
  if (!answer) return {};
  const same = sameAnswerOf(requests.filter((r) => r.id !== id), answer);
  // The answer's own fingerprint only once it went out (noteAnswerDelivered): a failed delivery
  // retried with the same words must still be delivered, not taken for a repeat.
  return same ? { sameAnswerAs: same.id } : {};
}

/**
 * The answer to `id` with these words reached its asker's session (performReply, after the
 * delivery), whatever settled the request: a later answer with the same words is a repeat of it.
 */
export async function noteAnswerDelivered(id: string, stamp: Pick<AnswerStamp, 'digest' | 'deliveredTo'>, now = Date.now()): Promise<void> {
  await updateRequests((store) => {
    const requests = [...(store.requests ?? [])];
    const idx = requests.findIndex((r) => r.id === id);
    // The row keeps the first answer that reached its asker: a second, different late answer is
    // delivered too, but the request was settled by the first (its reply stays the first's).
    if (idx === -1 || requests[idx].answerDigest) return undefined;
    requests[idx] = { ...requests[idx], answerDigest: stamp.digest, deliveredTo: stamp.deliveredTo, answeredAt: new Date(now).toISOString() };
    return { requests };
  });
}

export async function settleReplied(id: string, reply?: SessionRequest['reply'] | null, forwardedTo?: string, answer?: AnswerStamp): Promise<SessionRequest | null> {
  return settle(id, 'replied', undefined, reply ?? undefined, forwardedTo, answer);
}

/**
 * A reply to an OVERDUE request (status 'expired'): it is answered now, so it leaves every
 * "overdue, still open" list. Exactly once, like settle: null when it was not overdue.
 */
export async function settleLateReply(id: string, reply?: SessionRequest['reply'] | null, forwardedTo?: string, answer?: AnswerStamp): Promise<SessionRequest | null> {
  let settled: SessionRequest | null = null;
  await updateRequests((store) => {
    const requests = [...(store.requests ?? [])];
    const idx = requests.findIndex((r) => r.id === id);
    if (idx === -1 || requests[idx].status !== 'expired') return undefined;
    settled = {
      ...requests[idx], status: 'replied', settledAt: new Date().toISOString(), lateFrom: 'expired',
      ...(reply ? { reply } : {}), ...(forwardedTo ? { forwardedTo } : {}), ...stampAnswer(requests, id, answer),
    };
    requests[idx] = settled;
    return { requests };
  });
  return settled;
}

/** How long an overdue request stays open: as long as a settled row is kept at all. */
export const OVERDUE_OPEN_MS = SETTLED_RETENTION_MS;

/** Every overdue request still open: expired, unanswered, younger than OVERDUE_OPEN_MS. */
export async function overdueOpenRequests(now = Date.now()): Promise<SessionRequest[]> {
  const store = await readJsonFile<RequestStore>(REQUESTS_FILE, EMPTY);
  return (store.requests ?? []).filter((r) => r.status === 'expired' && now - Date.parse(r.createdAt) <= OVERDUE_OPEN_MS);
}

/** When an overdue request's one reminder is due: twice its own wait, counted from the ask. */
export function reminderDueAt(r: SessionRequest): number {
  const asked = Date.parse(r.createdAt);
  const paused = r.pausedMs ?? 0;
  const after = r.remindPausedMs ?? 0;
  // A wait its active target moved counts as it ended: the reminder is one more wait after it went overdue.
  if (r.activeWaits && r.overdueAt) return Date.parse(r.overdueAt) + requestWaitMs(r) + after;
  const wait = (r.ownDeadlineAt ?? r.deadlineAt) - asked - paused;
  return asked + paused + 2 * Math.max(wait, MIN_REPLY_TIMEOUT_SECS * 1000) + after;
}

/** Claim an overdue request's reminder (exactly once). Null when it was answered or already reminded. */
export async function claimReminder(id: string, now = Date.now()): Promise<SessionRequest | null> {
  let claimed: SessionRequest | null = null;
  await updateRequests((store) => {
    const requests = [...(store.requests ?? [])];
    const idx = requests.findIndex((r) => r.id === id);
    if (idx === -1 || requests[idx].status !== 'expired' || requests[idx].remindedAt) return undefined;
    claimed = { ...requests[idx], remindedAt: new Date(now).toISOString() };
    requests[idx] = claimed;
    return { requests };
  });
  return claimed;
}

/**
 * The request's ask reached its CLI, and the queue did not take that delivery back: `takenBack`
 * holds the target's queue rows waiting to go out again (sessions/request-reached.ts takenBackIds).
 */
export function stillReached(r: Pick<SessionRequest, 'reachedAt' | 'messageId'>, takenBack?: ReadonlySet<string>): boolean {
  return !!r.reachedAt && !(r.messageId && takenBack?.has(r.messageId));
}

/** Claim a pending request's one "nothing since you asked" notice. Null when it is not pending or was told. */
export async function claimSilentNotice(id: string, now = Date.now(), seen?: { reachedAt?: string }): Promise<SessionRequest | null> {
  let claimed: SessionRequest | null = null;
  await updateRequests((store) => {
    const requests = [...(store.requests ?? [])];
    const idx = requests.findIndex((r) => r.id === id);
    // Delivered since the caller judged it (it asks the host, up to 5 s): not silent, no claim.
    // `seen` is the stamp it judged void (the queue took that delivery back); none given: any stamp refuses.
    const reached = requests[idx]?.reachedAt;
    if (idx === -1 || requests[idx].status !== 'pending' || requests[idx].silentToldAt || (reached && reached !== seen?.reachedAt)) return undefined;
    claimed = { ...requests[idx], silentToldAt: new Date(now).toISOString() };
    requests[idx] = claimed;
    return { requests };
  });
  return claimed;
}

/**
 * Stamp `reachedAt` on the pending requests whose asked message is one of these queue rows, now
 * that it was delivered to its CLI (written, or taken). Each delivery moves it to the latest one:
 * a row the queue took back (its process died unread) and sent again is reached again only by
 * that send, and a claim made against the earlier stamp sees it moved (claimSilentNotice).
 * A settled row is left as it is. Returns the ids it stamped.
 */
export async function markRequestsReached(messageIds: readonly string[], now = Date.now()): Promise<string[]> {
  const ids = new Set(messageIds.filter(Boolean));
  if (ids.size === 0) return [];
  // A read first: almost no delivered message carries a request, and this runs on every delivery.
  const rows = (await readJsonFile<RequestStore>(REQUESTS_FILE, EMPTY).catch(() => EMPTY)).requests ?? [];
  if (!rows.some((r) => r.status === 'pending' && !!r.messageId && ids.has(r.messageId))) return [];
  const stamped: string[] = [];
  await updateRequests((store) => {
    const requests = [...(store.requests ?? [])];
    const at = new Date(now).toISOString();
    for (let i = 0; i < requests.length; i++) {
      const r = requests[i];
      if (r.status !== 'pending' || !r.messageId || !ids.has(r.messageId) || r.reachedAt === at) continue;
      requests[i] = { ...r, reachedAt: at };
      stamped.push(r.id);
    }
    return stamped.length ? { requests } : undefined;
  });
  return stamped;
}

/** Undo a silent-target claim whose notice could not be delivered, so the next sweep tries again. */
export async function releaseSilentNotice(id: string): Promise<void> {
  await updateRequests((store) => {
    const requests = [...(store.requests ?? [])];
    const idx = requests.findIndex((r) => r.id === id);
    if (idx === -1 || !requests[idx].silentToldAt) return undefined;
    const { silentToldAt: _told, ...rest } = requests[idx];
    requests[idx] = rest;
    return { requests };
  });
}

/** Undo a claim whose reminder could not be delivered, so the next sweep tries again. */
export async function releaseReminder(id: string): Promise<void> {
  await updateRequests((store) => {
    const requests = [...(store.requests ?? [])];
    const idx = requests.findIndex((r) => r.id === id);
    if (idx === -1 || !requests[idx].remindedAt) return undefined;
    const { remindedAt: _remindedAt, ...rest } = requests[idx];
    requests[idx] = rest;
    return { requests };
  });
}

export async function settleNotified(
  id: string,
  outcome: SessionRequestOutcome,
): Promise<SessionRequest | null> {
  return settle(id, outcome === 'timeout' ? 'expired' : 'notified', outcome);
}

/**
 * Withdraw a request nobody waits on any more (its asker's task completed):
 * nobody is told, the target stops seeing it as owed (open_items), and the
 * sweeper never fires a notice for it. `restoreRequest` undoes it.
 */
export async function withdrawRequest(id: string): Promise<SessionRequest | null> {
  return settle(id, 'withdrawn');
}

/**
 * An engine switch handed a task's conversation to a new session
 * (sessions/engine-switch.ts): the open requests on either side follow it, so an
 * answer owed by the task comes from the new session and an answer the task waits
 * for lands there. Returns how many rows moved.
 */
export async function retargetRequestsToSession(fromSessionId: string, toSessionId: string): Promise<number> {
  if (!fromSessionId || !toSessionId || fromSessionId === toSessionId) return 0;
  let moved = 0;
  await updateRequests((store) => {
    const requests = (store.requests ?? []).map((r) => {
      if (r.status !== 'pending' && r.status !== 'expired') return r;
      const to = r.toSessionId === fromSessionId;
      const from = r.fromSessionId === fromSessionId;
      if (!to && !from) return r;
      moved++;
      return { ...r, ...(to ? { toSessionId } : {}), ...(from ? { fromSessionId: toSessionId } : {}) };
    });
    return moved > 0 ? { ...store, requests } : undefined;
  });
  return moved;
}

/** Record the queue row the asked message went out as (POST /messages, after delivery queued it). */
export async function noteRequestMessage(id: string, messageId: string): Promise<void> {
  await updateRequests((store) => {
    const requests = [...(store.requests ?? [])];
    const idx = requests.findIndex((r) => r.id === id);
    if (idx === -1 || requests[idx].messageId === messageId) return undefined;
    requests[idx] = { ...requests[idx], messageId };
    return { requests };
  });
}

/** Put a withdrawn request back to pending (its asker's task was reopened). Null when it is not withdrawn. */
export async function restoreRequest(id: string): Promise<SessionRequest | null> {
  let restored: SessionRequest | null = null;
  await updateRequests((store) => {
    const requests = [...(store.requests ?? [])];
    const idx = requests.findIndex((r) => r.id === id);
    if (idx === -1 || requests[idx].status !== 'withdrawn') return undefined;
    const { settledAt: _settledAt, outcome: _outcome, ...rest } = requests[idx];
    restored = { ...rest, status: 'pending' };
    requests[idx] = restored;
    return { requests };
  });
  return restored;
}

/**
 * Pending requests aimed at this task and/or session (the turn-end hook's query).
 *
 * Known boundary: the taskId leg is what lets a request survive a target session
 * being restarted/forked (new claudeSessionId, same task) — the reply path relies
 * on it (tests/core/session-send-core.test.ts). The cost is that if TWO live
 * sessions share one task, one ending its turn can settle a request aimed at the
 * other as `completed` early. That is only a noisy notification, not lost data:
 * the real reply still delivers late if it arrives. Kept deliberately; tightening
 * it would break the restart/fork reply case.
 */
export async function pendingRequestsForTarget(
  target: { sessionId?: string; taskId?: string },
): Promise<SessionRequest[]> {
  if (!target.sessionId && !target.taskId) return [];
  const store = await readJsonFile<RequestStore>(REQUESTS_FILE, EMPTY);
  return (store.requests ?? []).filter(
    (r) => r.status === 'pending' && (
      (!!target.sessionId && r.toSessionId === target.sessionId)
      || (!!target.taskId && r.toTaskId === target.taskId)
    ),
  );
}

/**
 * Pending requests this session REGISTERED — the ASKER side of the ledger
 * (`pendingRequestsForTarget` is the receiver side).
 *
 * The fork hand-off reads this: a session being forked may still be owed
 * answers, and the fork is where the human continues, so the fork has to be told
 * which ids can still arrive in it (reply-routing.ts is what makes them arrive).
 * Newest-first, so a truncated list keeps the freshest asks.
 */
export async function pendingRequestsFromSession(sessionId: string): Promise<SessionRequest[]> {
  return requestsFromSession(sessionId, 'pending');
}

/** This session's requests in one status, newest first. */
export async function requestsFromSession(sessionId: string, status: SessionRequestStatus): Promise<SessionRequest[]> {
  const sid = (sessionId ?? '').trim();
  if (!sid) return [];
  const store = await readJsonFile<RequestStore>(REQUESTS_FILE, EMPTY);
  return (store.requests ?? [])
    .filter((r) => r.status === status && r.fromSessionId === sid)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Did the task `toTaskId` answer a request from one of `fromSessionIds` within
 * the last `windowMs`? The subtask watch asks this so a child that just replied
 * to its parent is not reported "stopped" a moment later: the reply was the
 * update. An answer that went past the parent (`forwardedTo`) never reached it, so it does not count.
 */
export async function repliedRecently(
  fromSessionIds: Iterable<string>,
  toTaskId: string,
  windowMs: number,
  now = Date.now(),
): Promise<boolean> {
  return (await lastReplyAt(fromSessionIds, toTaskId, windowMs, now)) !== undefined;
}

/**
 * When the task `toTaskId` last answered a request from one of `fromSessionIds`, within `windowMs`
 * (ISO), else undefined. A late answer counts too: one to a request a turn end had already settled
 * (`notified`) still reached its asker, at `answeredAt` (2026-11-12, the org reflection: a worker
 * answered its lead six hours after the request's fallback, and the "completed" notice 30 s later
 * quoted the same result again, because only a `replied` row counted).
 */
export async function lastReplyAt(
  fromSessionIds: Iterable<string>,
  toTaskId: string,
  windowMs: number,
  now = Date.now(),
): Promise<string | undefined> {
  const askers = new Set(fromSessionIds);
  if (askers.size === 0 || !toTaskId) return undefined;
  const store = await readJsonFile<RequestStore>(REQUESTS_FILE, EMPTY);
  let best: string | undefined;
  for (const r of store.requests ?? []) {
    if (r.forwardedTo || r.toTaskId !== toTaskId || !askers.has(r.fromSessionId)) continue;
    // answeredAt: the answer reached its asker (noteAnswerDelivered); a replied row without one is an older Walnut's.
    const at = r.answeredAt ?? (r.status === 'replied' ? r.settledAt : undefined);
    const ms = at ? Date.parse(at) : NaN;
    if (!Number.isFinite(ms) || now - ms > windowMs || ms > now + 60_000) continue;
    if (!best || ms > Date.parse(best)) best = at;
  }
  return best;
}

/** Every pending request (the host copy's query: rows whose two parties share a host). */
export async function listPendingRequests(): Promise<SessionRequest[]> {
  const store = await readJsonFile<RequestStore>(REQUESTS_FILE, EMPTY);
  return (store.requests ?? []).filter((r) => r.status === 'pending');
}

/**
 * Take in a row a host daemon created while this server was away
 * (offline-handover.ts). The daemon owned it until now, so ITS state wins over
 * a copy already here; a row this server settled itself is never reopened.
 * Returns whether anything changed.
 */
export async function importOfflineRequest(row: SessionRequest): Promise<boolean> {
  let changed = false;
  await updateRequests((store) => {
    const requests = [...(store.requests ?? [])];
    const idx = requests.findIndex((r) => r.id === row.id);
    if (idx === -1) {
      // A host never hands a request on (a send naming hands_on goes to the server).
      requests.push(row);
    } else {
      // The links are this server's: a host's copy of the row never carries them.
      const here = requests[idx];
      const next: SessionRequest = {
        ...row,
        ...(here.carriedBy ? { carriedBy: here.carriedBy, deadlineAt: Math.max(row.deadlineAt, here.deadlineAt) } : {}),
        ...(here.ownDeadlineAt !== undefined ? { ownDeadlineAt: here.ownDeadlineAt } : {}),
        ...(here.carries ? { carries: here.carries } : {}),
        // Time this server credited for being away (creditDowntime) stays credited.
        ...(here.pausedMs ? { pausedMs: here.pausedMs, deadlineAt: Math.max(row.deadlineAt, here.deadlineAt) } : {}),
        ...(here.remindPausedMs ? { remindPausedMs: here.remindPausedMs } : {}),
        // What this server learned of it stays learned: the asker was told once, the target has it.
        ...(here.silentToldAt && !row.silentToldAt ? { silentToldAt: here.silentToldAt } : {}),
        ...(here.reachedAt && !row.reachedAt ? { reachedAt: here.reachedAt } : {}),
        ...(here.messageId && !row.messageId ? { messageId: here.messageId } : {}),
      };
      if (requests[idx].status !== 'pending' || JSON.stringify(requests[idx]) === JSON.stringify(next)) return undefined;
      requests[idx] = next;
      // The host settled it: what it carried has its work back.
      if (next.status !== 'pending' && next.carries?.length) pullInBack(requests, next.id);
    }
    changed = true;
    return { requests: prune(requests) };
  });
  return changed;
}

/** The wait a request was asked with (ms): before any hand-off or active target moved it. */
export function requestWaitMs(r: SessionRequest): number {
  if (typeof r.waitMs === 'number' && r.waitMs > 0) return r.waitMs;
  const asked = Date.parse(r.createdAt);
  return Math.max(MIN_REPLY_TIMEOUT_SECS * 1000, (r.ownDeadlineAt ?? r.deadlineAt) - (Number.isFinite(asked) ? asked : 0) - (r.pausedMs ?? 0));
}

/**
 * Its target is at work (`why`): a pending request past its deadline waits one more of its own
 * waits, at most ACTIVE_WAIT_FACTOR of them from the ask and never past MAX_REPLY_TIMEOUT_SECS.
 * Atomic; returns the row with its new deadline, or null when it is no longer pending or the
 * longest wait is reached (then its asker hears, as before).
 */
export async function waitWhileActive(id: string, why: string, now = Date.now()): Promise<SessionRequest | null> {
  let moved: SessionRequest | null = null;
  await updateRequests((store) => {
    const requests = [...(store.requests ?? [])];
    const idx = requests.findIndex((r) => r.id === id);
    const r = requests[idx];
    if (!r || r.status !== 'pending' || r.deadlineAt > now) return undefined;
    const wait = requestWaitMs(r);
    const asked = Date.parse(r.createdAt);
    const cap = (Number.isFinite(asked) ? asked : now) + (r.pausedMs ?? 0) + Math.min(MAX_REPLY_TIMEOUT_SECS * 1000, ACTIVE_WAIT_FACTOR * wait);
    const next = Math.min(now + wait, cap);
    if (next <= now) return undefined;
    moved = { ...r, deadlineAt: next, waitMs: wait, activeWaits: (r.activeWaits ?? 0) + 1, activeWhy: why };
    requests[idx] = moved;
    return { requests };
  });
  return moved;
}

/** When this process started: a restart ends the time Walnut was away there. */
const PROCESS_STARTED_AT = Date.now();

/** The sweep's clock: when it last ran (creditDowntime). */
const CLOCK_FILE = path.join(WALNUT_HOME, 'local', 'session-request-clock.json');

/** A gap between two sweeps (60 s apart) longer than this is time Walnut was not running. */
export const DOWNTIME_GAP_MS = 3 * 60_000;

/**
 * Walnut was not running from the last sweep to `now` (stopped, or the Mac asleep): no target
 * could answer then, so that time does not count against any deadline. Every pending request
 * still running its clock then gets its deadline moved by the gap, and an overdue one not yet
 * reminded gets its reminder moved too. 2026-11-06: the Mac and Walnut were away 02:37 to 06:46
 * UTC, and five OVERDUE notices went out within 12 s of coming back. Returns the gap credited
 * (0 when there was none). The first sweep ever only starts the clock.
 */
export async function creditDowntime(now = Date.now(), clockFile = CLOCK_FILE, startedAt = PROCESS_STARTED_AT): Promise<number> {
  const clock = await readJsonFile<{ aliveAt?: number } | null>(clockFile, null).catch(() => null);
  const last = Number(clock?.aliveAt);
  const gap = Number.isFinite(last) && last > 0 && now - last > DOWNTIME_GAP_MS ? now - last : 0;
  if (gap > 0) {
    // Away until this process started (a restart), or until now (the Mac asleep, this process
    // paused). A row gets only the part of it that it lived through: one asked after the restart
    // gets none.
    const awayEnd = startedAt > last ? Math.min(startedAt, now) : now;
    const owed = (r: SessionRequest) => {
      const born = Date.parse(r.createdAt);
      return Math.max(0, awayEnd - Math.max(last, Number.isFinite(born) ? born : last));
    };
    let pending = 0;
    let reminders = 0;
    await updateRequests((store) => {
      const requests = (store.requests ?? []).map((r) => {
        const credit = owed(r);
        if (credit <= 0) return r;
        if (r.status === 'pending' && r.deadlineAt > last) {
          pending++;
          return { ...r, deadlineAt: r.deadlineAt + credit, ...(r.ownDeadlineAt !== undefined ? { ownDeadlineAt: r.ownDeadlineAt + credit } : {}), pausedMs: (r.pausedMs ?? 0) + credit };
        }
        if (r.status === 'expired' && r.overdueAt && !r.remindedAt && reminderDueAt(r) > last) {
          reminders++;
          return { ...r, remindPausedMs: (r.remindPausedMs ?? 0) + credit };
        }
        return r;
      });
      return pending + reminders ? { requests } : undefined;
    });
    log.session.info('walnut was away: request deadlines moved by the time it was not running', {
      from: new Date(last).toISOString(), minutes: Math.round(gap / 60_000), pending, reminders,
    });
  }
  await writeJsonFile(clockFile, { aliveAt: now });
  return gap;
}

/** Pending requests past their deadline (the sweeper's query). */
export async function overdueRequests(now = Date.now()): Promise<SessionRequest[]> {
  const store = await readJsonFile<RequestStore>(REQUESTS_FILE, EMPTY);
  return (store.requests ?? []).filter((r) => r.status === 'pending' && r.deadlineAt <= now);
}

// ── wording ──────────────────────────────────────────────────────────────────
//
// Both deliveries are `<walnut-message …>` envelopes (see
// peers/walnut-message-tag.ts): provenance in attributes, the other party's
// words in the body, and the serializer's body escaping is what keeps text from
// forging framing. The `note` attribute names who is speaking.

const NOTE_NOTIFICATION = 'automated Walnut status notice';

/**
 * The ONE line Walnut appends to a message delivered with expect_reply. It sits
 * OUTSIDE the envelope, because this part is Walnut speaking, and the exact
 * command is the whole point, so it is the whole line.
 */
export function buildReplyTrailer(request: SessionRequest, alsoOpen?: readonly string[]): string {
  return kit.buildReplyTrailer(request, alsoOpen?.length ? { alsoOpen } : undefined);
}

/** The asker's other open requests to the same target (its session or its task), oldest first. */
export async function sameAskerOpen(request: Pick<SessionRequest, 'id' | 'fromSessionId' | 'toSessionId' | 'toTaskId'>): Promise<string[]> {
  const open = await pendingRequestsForTarget({ sessionId: request.toSessionId, taskId: request.toTaskId }).catch(() => [] as SessionRequest[]);
  return open.filter((r) => r.id !== request.id && r.fromSessionId === request.fromSessionId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((r) => r.id);
}

/**
 * What the ASKER reads when the target replied: the target session's own words
 * as the body, never presented as the user or as Walnut.
 */
export function buildReplyDeliveryText(
  request: SessionRequest,
  sender: { title: string; shortId: string; host: string; sessionId?: string; taskId?: string },
  text: string,
  opts?: { title?: string },
): string {
  return kit.buildReplyDeliveryText(request, sender, text, opts);
}

/** How much of the target's last message a notice quotes. The asker reads this
 *  in its own context, so it is a summary's worth, not a transcript. */
export const NOTICE_LAST_MESSAGE_MAX = kit.NOTICE_LAST_MESSAGE_MAX;

/** The target's own last words, as the notice quotes them. */
export interface NoticeLastMessage {
  /** Its last message; '' when its last turn said nothing. */
  text: string;
  /** The message was longer than {@link NOTICE_LAST_MESSAGE_MAX} and was cut. */
  clipped?: boolean;
  /** The tool calls it made AFTER that message (or in a turn that said nothing), one line each. */
  actions?: string[];
  /** Its last message was only the agent-ack (or no-action) line (text ''). */
  ack?: boolean;
}

/** Cut a last message to the notice budget, on a line break when one is near. */
export function clipNoticeMessage(text: string): NoticeLastMessage | undefined {
  return kit.clipNoticeMessage(text);
}

/**
 * What the ASKER reads when Walnut (not the target) ends the wait. The outcome
 * sentence leads; the target's last message follows when Walnut could read it
 * (so a child that finished without replying still hands over its result, with
 * no task_history round trip); the ids in the attributes let the asker pull
 * details itself, and the `Next:` block names the exact calls that do it.
 *
 * The quoted message is the other session's words, so it is fenced and labelled
 * as data; the envelope's own escaping keeps it from opening or closing a tag,
 * and the `note` attribute says Walnut, not a session, wrote the notice.
 * A task the target closed itself says so instead of "its turn ended", because
 * COMPLETE is terminal and no later turn-end edge will ever speak for it.
 */
export function buildRequestNotification(
  request: SessionRequest,
  outcome: SessionRequestOutcome,
  target: { title?: string; sessionId?: string; taskId?: string; phase?: string; lastMessage?: NoticeLastMessage; handedOn?: EnvelopeHandedOn[] },
): string {
  return kit.buildRequestNotification(request, outcome, target);
}

/**
 * The one reminder an asker gets for its OVERDUE requests, at twice each one's deadline: still
 * unanswered, still open, and the asker decides what to do. Several due at once share ONE
 * message (one turn for the asker, not one per request).
 */
export function buildOverdueReminder(
  due: readonly { request: SessionRequest; target: { title?: string; sessionId?: string; taskId?: string; phase?: string } }[],
  now = Date.now(),
): string {
  const ago = (r: SessionRequest) => {
    const hours = Math.max(1, Math.round((now - Date.parse(r.createdAt)) / 3_600_000));
    return hours === 1 ? 'about an hour' : `about ${hours} hours`;
  };
  const one = due.length === 1 ? due[0] : undefined;
  const lines = due.map(({ request: r, target: t }) =>
    `- ${r.id} to ${sessionHandle(t.title, t.sessionId)}${t.taskId ? ` (${t.taskId}${t.phase ? `, ${t.phase} now` : ''})` : ''}, asked ${ago(r)} ago: "${r.preview}"`);
  const next = due.filter((d) => d.target.taskId).slice(0, 3)
    .map((d) => `  walnut tools call task_get '{"id":"${d.target.taskId}"}'          # its task state`);
  return buildWalnutMessage({
    kind: 'notification',
    attrs: {
      from: 'Walnut',
      ...(one ? {
        about: sessionHandle(one.target.title, one.target.sessionId),
        'about-session': one.target.sessionId,
        'about-task': one.target.taskId,
        request: one.request.id,
        asked: one.request.preview,
      } : {}),
      outcome: 'timeout',
      note: NOTE_NOTIFICATION,
    },
    body: [
      due.length === 1
        ? 'Reminder: your request is still OVERDUE and open, twice its deadline after you asked, with no reply:'
        : `Reminder: ${due.length} of your requests are still OVERDUE and open, twice their deadline after you asked, with no reply:`,
      ...lines,
      'A reply still settles one. If the answer came another way, or the work is no longer needed, carry on without it: this is the only reminder.',
      ...(next.length ? ['', 'Next:', ...next] : []),
    ].join('\n'),
  });
}

/**
 * What the ASKER reads when its message never reached the target: the host
 * refused to run the session, the resumed CLI exited before it read the line,
 * or the message still waits in the target's queue at the deadline. No turn ran
 * on it, so nothing of the target is quoted (2026-10-28: a refused send was
 * reported as "Its turn ended WITHOUT an explicit reply" with the target's
 * message from hours before, which the asker read as the answer).
 * `stillQueued`: the message may yet go out (the deadline sweeper's case).
 */
export function buildUndeliveredNotification(
  request: SessionRequest,
  target: { title?: string; sessionId?: string; taskId?: string },
  why: string,
  stillQueued = false,
  /** Other requests of the same asker whose messages did not reach it either: one notice names them. */
  also?: ReadonlyArray<{ id: string; preview: string }>,
): string {
  const next = target.taskId ? [`  walnut tools call task_get '{"id":"${target.taskId}"}'          # its task state`] : [];
  // Another process has the session open (the user's terminal, most often): the
  // task is in use, not broken, and the reason says so in plain words.
  const held = isHeldElsewhereReason(why);
  return buildWalnutMessage({
    kind: 'notification',
    attrs: {
      from: 'Walnut',
      about: sessionHandle(target.title, target.sessionId),
      'about-session': target.sessionId,
      'about-task': target.taskId,
      request: request.id,
      asked: request.preview,
      outcome: stillQueued ? 'timeout' : 'error',
      note: 'automated Walnut status notice',
    },
    body: [
      held
        ? 'Your message has NOT BEEN DELIVERED yet: that session is open in another process right now, most likely the user working in it in a terminal.'
        : stillQueued
          ? 'Your message has NOT BEEN DELIVERED yet: it still waits in that session\'s queue, and no turn has run on it.'
          : 'Your message was NOT DELIVERED: no turn ran on it in that session, so it has not read your request.',
      `Why: ${why.replace(/\s+/g, ' ').trim()}`,
      ...(kit.alsoLine(also, 'whose messages did not reach it either') ? [kit.alsoLine(also, 'whose messages did not reach it either') as string] : []),
      held
        ? 'If you send it again yourself instead, it may run twice.'
        : stillQueued
          ? 'It goes out by itself once that session can take it.'
          : 'It is kept in that session\'s queue, and a Retry there sends it once the cause is gone. '
            + 'If you send it again yourself instead, it may run twice.',
      ...(next.length > 0 ? [`Next:\n${next.join('\n')}`] : []),
    ].join('\n\n'),
  });
}

/** How many ids the fork hand-off names before it stops listing. */
const FORK_NOTICE_MAX_IDS = 8;

/**
 * What a FORK reads on its first turn when the session it was forked from is
 * still owed answers.
 *
 * Why it exists: a fork inherits the parent's whole conversation, so it inherits
 * the parent's open questions too — and the human who forked is reading the FORK.
 * Without this notice the fork has no idea an `rq-…` can land in it (2026-09-11:
 * a reply arrived six minutes after a fork and the fork never knew what it was
 * answering). The ids go in the BODY, one list, because `request` is a
 * single-value attribute and a comma-joined attr would be a second, unparseable
 * encoding of the same thing.
 *
 * Zero-noise contract: callers must not build this when nothing is pending —
 * an empty list returns '' so a caller that forgets still says nothing.
 */
export function buildForkHandoffNotice(
  source: { title?: string; sessionId: string; taskId?: string },
  pending: SessionRequest[],
): string {
  if (pending.length === 0) return '';
  const handle = sessionHandle(source.title, source.sessionId);
  const shown = pending.slice(0, FORK_NOTICE_MAX_IDS);
  const ids = shown.map((r) => r.id).join(', ');
  const more = pending.length > shown.length ? ` (+${pending.length - shown.length} more)` : '';
  const first = shown[0].id;
  return buildWalnutMessage({
    kind: 'notification',
    attrs: {
      from: 'Walnut',
      about: handle,
      'about-session': source.sessionId,
      'about-task': source.taskId,
      note: NOTE_NOTIFICATION,
    },
    body: [
      `You were forked from ${handle}. It has ${pending.length} pending request(s) `
      + `it asked other sessions and has not been answered on — those answers can still `
      + `arrive HERE: ${ids}${more}.`,
      '',
      `Read one with: walnut tools call request_get '{"id":"${first}"}'`,
      'Do not poll them: an answer (or a Walnut notice that none came) is delivered to '
      + 'this session on its own.',
    ].join('\n'),
  });
}

export { REQUESTS_FILE };
