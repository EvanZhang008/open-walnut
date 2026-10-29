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

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { WALNUT_HOME } from '../constants.js';
import { readJsonFile, updateJsonFile } from '../utils/fs.js';
import { buildWalnutMessage, sessionHandle } from './peers/walnut-message-tag.js';
import { createEnvelopeKit, type EnvelopeHandedOn } from './peers/envelope-kit.js';
import { isHeldElsewhereReason } from './sessions/undelivered-requests.js';
import { log } from '../logging/index.js';

const REQUESTS_FILE = path.join(WALNUT_HOME, 'session-requests.json');

// The wording lives in peers/envelope-kit.ts: a host daemon answering while the
// server is away builds the same previews and envelopes, byte for byte.
const kit = createEnvelopeKit();

/** Most-recent-N cap; settled rows past the cap drop off the tail. */
const MAX_REQUESTS = 500;
/** Settled rows older than this are pruned on write. */
const SETTLED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
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
  /** The deadline the asker set, before a hand-off moved it (unlinkHandoff puts it back). */
  ownDeadlineAt?: number;
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
export function clampReplyTimeoutSecs(secs: number | undefined, implicit = false): number {
  if (typeof secs !== 'number' || !Number.isFinite(secs)) {
    return implicit ? IMPLICIT_REPLY_TIMEOUT_SECS : DEFAULT_REPLY_TIMEOUT_SECS;
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
}): Promise<SessionRequest & { handOnRefused?: HandOnRefusal[] }> {
  const request: SessionRequest = {
    id: `rq-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    fromSessionId: input.fromSessionId,
    ...(input.toSessionId ? { toSessionId: input.toSessionId } : {}),
    ...(input.toTaskId ? { toTaskId: input.toTaskId } : {}),
    preview: kit.requestPreview(input.text),
    status: 'pending',
    createdAt: new Date().toISOString(),
    deadlineAt: Date.now() + clampReplyTimeoutSecs(input.replyTimeoutSecs, input.implicit) * 1000,
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
    };
    requests[idx] = settled;
    // A request this one carried has its work back: its wait shrinks to its target's own answer.
    if (settled.carries?.length) pullInBack(requests, id);
    return { requests };
  });
  return settled;
}

export async function settleReplied(id: string): Promise<SessionRequest | null> {
  return settle(id, 'replied');
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
 * update.
 */
export async function repliedRecently(
  fromSessionIds: Iterable<string>,
  toTaskId: string,
  windowMs: number,
  now = Date.now(),
): Promise<boolean> {
  const askers = new Set(fromSessionIds);
  if (askers.size === 0 || !toTaskId) return false;
  const store = await readJsonFile<RequestStore>(REQUESTS_FILE, EMPTY);
  return (store.requests ?? []).some((r) =>
    r.status === 'replied' && r.toTaskId === toTaskId && askers.has(r.fromSessionId)
    && !!r.settledAt && now - Date.parse(r.settledAt) <= windowMs);
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
export function buildReplyTrailer(request: SessionRequest): string {
  return kit.buildReplyTrailer(request);
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
