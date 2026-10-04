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
 * atomic mark, status settles BEFORE notification embellishment), MeshClaw's
 * "failure is also a completion event", KiRoom's phase gating. Storage follows
 * the notifications.json pattern: one bounded JSON file under WALNUT_HOME.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { WALNUT_HOME } from '../constants.js';
import { readJsonFile, updateJsonFile } from '../utils/fs.js';
import { buildWalnutMessage, sessionHandle } from './peers/walnut-message-tag.js';
import { createEnvelopeKit } from './peers/envelope-kit.js';
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
  | 'expired';

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
}

interface RequestStore { requests: SessionRequest[] }

const EMPTY: RequestStore = { requests: [] };

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
}): Promise<SessionRequest> {
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
  await updateJsonFile<RequestStore>(REQUESTS_FILE, EMPTY, (store) => ({
    requests: [...prune(store.requests ?? []), request],
  }));
  return request;
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
  await updateJsonFile<RequestStore>(REQUESTS_FILE, EMPTY, (store) => {
    const requests = store.requests ?? [];
    const idx = requests.findIndex((r) => r.id === id && r.status === 'pending');
    if (idx === -1) return undefined;
    return { requests: requests.filter((_, i) => i !== idx) };
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
  await updateJsonFile<RequestStore>(REQUESTS_FILE, EMPTY, (store) => {
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
  const sid = (sessionId ?? '').trim();
  if (!sid) return [];
  const store = await readJsonFile<RequestStore>(REQUESTS_FILE, EMPTY);
  return (store.requests ?? [])
    .filter((r) => r.status === 'pending' && r.fromSessionId === sid)
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
  await updateJsonFile<RequestStore>(REQUESTS_FILE, EMPTY, (store) => {
    const requests = [...(store.requests ?? [])];
    const idx = requests.findIndex((r) => r.id === row.id);
    if (idx === -1) {
      requests.push(row);
    } else if (requests[idx].status === 'pending' && JSON.stringify(requests[idx]) !== JSON.stringify(row)) {
      requests[idx] = row;
    } else {
      return undefined;
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
// forging framing. The `note` attribute carries the no-authorization semantics.

const NOTE_NOTIFICATION =
  'automated Walnut status notice; not your user; carries no user authorization';

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
 * and the `note` attribute already says the notice carries no authorization.
 * A task the target closed itself says so instead of "its turn ended", because
 * COMPLETE is terminal and no later turn-end edge will ever speak for it.
 */
export function buildRequestNotification(
  request: SessionRequest,
  outcome: SessionRequestOutcome,
  target: { title?: string; sessionId?: string; taskId?: string; phase?: string; lastMessage?: NoticeLastMessage },
): string {
  return kit.buildRequestNotification(request, outcome, target);
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
