/**
 * session_send core — THE one way anything sends a message to a session.
 *
 * One entry point (`performSessionSend`) absorbs what used to be three
 * surfaces: the old `session_send` op (plain enqueue by session id), the
 * `walnut peers send` gateway capability (session→session notes in an
 * envelope), and the resume half of `task_start` (send by TASK id into its live
 * session). The differences between them were never different message kinds —
 * they were delivery-layer properties (who is speaking → envelope or not; how
 * the target was named → id vs task vs title), so they live here as properties,
 * keyed on the caller identity the transport already stamps
 * (x-walnut-caller-sid).
 *
 * Reply loop: expect_reply registers a pending row in session-requests.ts and
 * appends a Walnut-authored trailer telling the receiver the exact command to
 * answer with; in_reply_to settles that row FIRST (atomic — the status flip
 * must never wait on delivery embellishment) and routes the answer back to the
 * asker. Fallback notification when no reply comes lives in
 * session-hooks/builtins.ts (turn-end edge) + the deadline sweeper.
 */

import { log } from '../../logging/index.js';
import { matchIdRef, refNamesId } from '../../lib/id-ref.js';
import type { SessionRecord } from '../types.js';
import type { UserSaid } from './user-spoke.js';
import { buildPeerWrapper } from '../peers/peer-wrapper.js';
import { pluginCallerName } from '../plugins/plugin-caller.js';
import { senderTitleOf } from '../peers/sender-name.js';
import { createEnvelopeKit } from '../peers/envelope-kit.js';
import { sessionHandle } from '../peers/walnut-message-tag.js';
import { PeerThrottle, PEER_PENDING_CAP } from '../peers/peer-throttle.js';
import { isSideThreadLane } from './side-thread-fork.js';
import {
  buildReplyDeliveryText,
  buildReplyTrailer,
  createSessionRequest,
  deletePendingRequest,
  getSessionRequest,
  settleReplied,
  settleLateReply,
  withdrawRequest,
  listAllSessionRequests,
  answerDigest,
  noteAnswerDelivered,
  sameAnswerOf,
  type AnswerStamp,
  type SessionRequest,
} from '../session-requests.js';
import { queueSentBy } from './send-sent-by.js';
import { assertAreaDelivery } from '../router/delivery-scope.js';
import { frameForSource } from './send-frame.js';
import { isPersonSource } from './send-sent-by.js';
import { noteRequestDelivering } from './undelivered-requests.js';
import { isSupersededSession } from './engine-switch-marker.js';

const kit = createEnvelopeKit();

/** Enqueue + bus fan-out ceiling — same rationale as letter delivery. */
const DELIVERY_TIMEOUT_MS = 8_000;

/** Shared across all callers in this process — throttle state is per-sender. */
const sharedThrottle = new PeerThrottle();

export class SendError extends Error {
  constructor(
    public code:
      | 'bad_request' | 'unknown_target' | 'ambiguous_target' | 'task_has_no_session'
      | 'target_archived' | 'task_starting' | 'self_send' | 'queue_full' | 'throttled' | 'delivery_failed'
      | 'unknown_request' | 'request_already_settled' | 'not_request_target' | 'origin_session_gone'
      | 'parent_complete' | 'target_complete' | 'lead_handed_over' | 'org_off' | 'not_above' | 'no_open_ask' | 'user_words' | 'user_spoke_since' | 'area_forbidden' | 'cross_area',
    message: string,
    public statusCode = 400,
    public detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SendError';
  }
}

export interface SessionSendInput {
  /** Session id, unique id prefix (>=4), task id/prefix, or unique title substring. */
  to?: string;
  text: string;
  /** Register a pending request; the target is told how to reply. Session
   *  callers only. Tri-state, and `undefined` is NOT "off" (changed
   *  2026-09-01): true = register and fail loudly for a non-session caller,
   *  undefined = DEFAULT ON for a session caller / silently skipped otherwise,
   *  false = never. Ignored on an `inReplyTo` send (that IS the answer). */
  expectReply?: boolean;
  /** Seconds until the no-reply fallback notification (clamped 60s..24h, default 1h). */
  replyTimeoutSecs?: number;
  /** What the request asks for, when the caller knows better than the target (a task start): its default deadline. */
  replyKind?: import('../session-requests.js').ReplyKind;
  /** rq-… id — this send IS the reply; `to` may be omitted (routes to the asker). */
  inReplyTo?: string;
  /** rq-… id of a request the caller owes and hands to the target with this ask: its asker
   *  waits for the target's answer (session-requests.ts linkHandoffs). Needs the reply request. */
  handsOn?: string;
  /** The sender's one-line TL;DR of `text`: the envelope's `title`, the line the
   *  reader's card shows until opened. Only a fenced (non-human) send carries one. */
  title?: string;
  /** A COMPLETE target takes a session's message only with `force: true` and a
   *  `reason` (why it must act again), which leads the delivered text. */
  force?: boolean;
  reason?: string;
  /** Idempotency id (qm-…) forwarded to the durable queue. */
  messageId?: string;
  /** A reply's structured fields (peers/structured-reply.ts): `inReplyTo` sends only. The asker
   *  reads them as sections of the text; a non-empty `not_done` marks the reply Partial. */
  reply?: { result?: unknown; evidence?: unknown; not_done?: unknown; score?: unknown };
  /** This message answers the target's open question to the user, in the user's place
   *  (sessions/ask-answer.ts): only from a task above it, its lead or VP, Main, or the person. */
  answersAsk?: boolean;
  /** With answersAsk on an ask only the user approves: their own words it acts on. */
  userWords?: string;
  /** Internal (answers_ask): deliver only into this session while it runs, bound to the stop fence
   *  read when it was checked (ask-answer.ts liveSendGuard); never through the route. */
  liveOnly?: import('./ask-answer.js').LiveDelivery;
  /** Transport-stamped caller session id; undefined = the human's own CLI. */
  callerSid?: string;
  /** Walnut itself sends this (a start that continues a task's conversation, on behalf of a routine, a
   *  script or another task's start): with a source no person types into, a caller-less send is framed
   *  as Walnut's instead of read as the human's own CLI (sessions/send-frame.ts). */
  source?: string;
  /** Transport-stamped host the calling CLI runs on — labels an ANONYMOUS
   *  sender's envelope honestly (a session caller's host comes from its record). */
  callerHost?: string;
  /** An anonymous caller that named itself: a script or scheduled job (the CLI's `x-walnut-sender`). */
  callerLabel?: string;
}

export interface SessionSendResult {
  /** queued = dispatched; deferred = enqueued but target awaits a permission prompt;
   *  recorded = an answer for the user kept on a task it was not delivered to (`notWoken`). */
  delivery: 'queued' | 'deferred' | 'recorded';
  /** An answers_ask send to a COMPLETE task or one with no session running: recorded, no turn started. */
  notWoken?: 'complete' | 'stopped';
  /** An answers_ask send, or a message to a task that still asks (openAsk): what the user wrote there (user-spoke.ts). */
  userSaid?: UserSaid;
  targetSessionId: string;
  targetTitle: string | null;
  targetTaskId?: string;
  /** The resolved target, in the shape `to` accepts back: `handle` is the
   *  printed `Title [8hex]`, so a caller can address the same session again
   *  without re-deriving anything. */
  target: { handle: string; sessionId: string; taskId?: string };
  queueDepth?: number;
  /** Present when expect_reply registered a request. */
  requestId?: string;
  /** The requests this ask handed on (`hands_on`), and the ones it could not, with why. */
  handedOn?: string[];
  handOnRefused?: { id: string; reason: string }[];
  /** Present on an in_reply_to send. */
  repliedTo?: string;
  /** The requests the answered one carried, answered by it too: the answer went to the outermost one's asker. */
  answeredFor?: string[];
  /** The request whose answer, already delivered with the same words, settled this one: nothing was delivered again. */
  sameAnswerAs?: string;
  /** The target's open ask of the user, sent by a task above it without answers_ask (openAskBelow). */
  openAsk?: string;
  messageId?: string;
}

const shortId = (sid: string): string => sid.slice(0, 8);

/**
 * The ask of the user that the target holds open, when the sender stands above it (a lead, VP or
 * Main) and sent without answers_ask: if the message answers it, only answers_ask takes it off the
 * user's list (2026-11-04: Main decided a launch date in a plain message, nothing recorded it, and
 * the task asked the user again the next day).
 */
async function openAskBelow(callerSid: string | undefined, targetTaskId: string | undefined): Promise<{ ask: string; userSaid?: UserSaid } | null> {
  if (!targetTaskId) return null;
  const caller = await resolveCaller(callerSid);
  if (caller.kind !== 'session' || !caller.record.taskId || caller.record.taskId === targetTaskId) return null;
  const { listTasks } = await import('../task-manager.js');
  const everything = await listTasks();
  const from = everything.find((t) => t.id === caller.record.taskId);
  const target = everything.find((t) => t.id === targetTaskId);
  if (!from || !target) return null;
  const { openAskOf, standsAbove } = await import('./ask-answer.js');
  const open = openAskOf(target);
  if (!('ask' in open) || !standsAbove(from, target, everything)) return null;
  // What the user wrote there, so a message that decides the ask is not sent past his words (user-spoke.ts).
  const { userSaidIn } = await import('./user-spoke.js');
  const said = await userSaidIn(target, everything).catch(() => null);
  return { ask: open.ask, ...(said?.words.length ? { userSaid: said } : {}) };
}
const displayHost = (host: string | undefined): string =>
  !host || host === '__local__' ? 'local' : host;

/** Same candidate filter as peers.list had: real CLI sessions only. */
async function sendCandidates(): Promise<SessionRecord[]> {
  const { listSessions, isEnvironmentSession } = await import('../session-tracker.js');
  const all = await listSessions();
  // Side threads are hidden asides of another session, addressable only by their
  // own id — never a name/prefix match target for a peer send.
  return all.filter(
    (s) => s.provider !== 'embedded'
      && !isEnvironmentSession(s)
      && !isSideThreadLane(s.lane),
  );
}

export interface ResolvedTarget {
  session: SessionRecord;
  /** Set when `to` named a task — carried into the queue + request rows. */
  taskId?: string;
}

function ambiguous(target: string, hits: Array<{ id: string; title?: string | null; host?: string }>): SendError {
  return new SendError('ambiguous_target', `"${target}" matches ${hits.length} sessions/tasks — use a longer id`, 400, {
    candidates: hits.slice(0, 5).map((h) => ({
      shortId: shortId(h.id), title: h.title ?? null, host: displayHost(h.host),
    })),
  });
}

/** Live enough to receive a message through the durable queue (resume revives). */
function liveSessionsForTask(sessions: SessionRecord[]): SessionRecord[] {
  return sessions.filter((s) => !s.archived);
}

/** The `Title [8hex]` / `[8hex]` handle every envelope and session_list row
 *  prints. The class is wider than hex because provider-issued session ids
 *  (ACP engines) are not UUIDs and still get printed this way. */
const PRINTED_HANDLE = /\[([0-9a-z][0-9a-z-]{3,})\]\s*$/i;

/** How many recently active sessions' tasks a bare name is matched against by task title. */
const TASK_TITLE_MATCH_MAX = 200;

/**
 * Resolve `to` → one target session.
 * ⓪ printed `Title [8hex]` handle (exact id, then unique prefix; a bracketed
 *   word that matches no session, e.g. `css [fade]`, falls through) →
 * ① exact session id → ② task id/unique prefix (its attached session) →
 * ③ unique session-id prefix (>=4) → ④ unique case-insensitive title substring.
 * A `to` that matches BOTH a task and a session at the same stage is ambiguous.
 */
export async function resolveSendTarget(to: string): Promise<ResolvedTarget> {
  const found = await resolveSendTargetAddress(to);
  // An old handle of a session an engine switch replaced (printed in a transcript, a
  // notice, a request) reaches the task's active session instead (engine-switch.ts).
  if (isSupersededSession(found.session) && found.session.taskId) return resolveSendTargetAddress(found.session.taskId);
  return found;
}

async function resolveSendTargetAddress(to: string): Promise<ResolvedTarget> {
  const candidates = await sendCandidates();

  const printed = to.match(PRINTED_HANDLE)?.[1]?.toLowerCase();
  if (printed) {
    const byHandle = candidates.find((s) => s.claudeSessionId.toLowerCase() === printed)
      ?? null;
    if (byHandle) return { session: byHandle };
    const hits = matchIdRef(candidates, printed, (s) => s.claudeSessionId.toLowerCase());
    if (hits.length === 1) return { session: hits[0] };
    if (hits.length > 1) {
      throw ambiguous(to, hits.map((s) => ({ id: s.claudeSessionId, title: s.title, host: s.host })));
    }
    // No session owns that id: the brackets were part of a title, keep going.
  }

  const exact = candidates.find((s) => s.claudeSessionId === to);
  if (exact) return { session: exact };

  // Task handle: getTask is the canonical prefix matcher (throws on no match /
  // ambiguity). A miss is fine — `to` may be a session prefix or a title.
  let taskHit: { id: string; title: string; session_id?: string; exec_session_id?: string } | undefined;
  try {
    const { getTask } = await import('../task-manager.js');
    const task = await getTask(to);
    taskHit = { id: task.id, title: task.title, session_id: task.session_id, exec_session_id: task.exec_session_id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Ambiguous ID prefix')) throw new SendError('ambiguous_target', msg, 400);
    // "No task found" and store errors both fall through to session matching.
  }

  const lower = to.toLowerCase();
  const byPrefix = to.length >= 4
    ? matchIdRef(candidates, lower, (s) => s.claudeSessionId.toLowerCase())
    : [];

  if (taskHit && byPrefix.length > 0) {
    throw ambiguous(to, [
      { id: taskHit.id, title: `task: ${taskHit.title}` },
      ...byPrefix.map((s) => ({ id: s.claudeSessionId, title: s.title, host: s.host })),
    ]);
  }

  if (taskHit) {
    const { getSessionsForTask } = await import('../session-tracker.js');
    let sessions = liveSessionsForTask(await getSessionsForTask(taskHit.id));
    if (sessions.length === 0) {
      // Mid engine switch the task has no active session for a few seconds: wait for the new one.
      const { awaitSwitch, movingFrom } = await import('./engine-switch.js');
      // A move takes minutes: the message is held on the session it replaces and moves with the task.
      const moving = movingFrom({ taskId: taskHit.id });
      const from = moving ? (await getSessionsForTask(taskHit.id)).find((s) => s.claudeSessionId === moving) : undefined;
      if (from) sessions = [from];
      else if (await awaitSwitch(taskHit.id)) sessions = liveSessionsForTask(await getSessionsForTask(taskHit.id));
    }
    if (sessions.length === 0) {
      throw new SendError('task_has_no_session',
        `Task "${taskHit.title}" (${taskHit.id}) is not started. Use task_start with that id.`,
        409, { taskId: taskHit.id });
    }
    // Prefer the task's current slot; otherwise the most recently active row.
    const bySlot = sessions.find((s) => s.claudeSessionId === (taskHit.session_id || taskHit.exec_session_id))
      ?? [...sessions].sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''))[0];
    return { session: bySlot, taskId: taskHit.id };
  }

  if (byPrefix.length === 1) return { session: byPrefix[0] };
  if (byPrefix.length > 1) {
    throw ambiguous(to, byPrefix.map((s) => ({ id: s.claudeSessionId, title: s.title, host: s.host })));
  }

  const byTitle = candidates.filter((s) => (s.title ?? '').toLowerCase().includes(lower));
  if (byTitle.length === 1) return { session: byTitle[0] };
  if (byTitle.length > 1) {
    throw ambiguous(to, byTitle.map((s) => ({ id: s.claudeSessionId, title: s.title, host: s.host })));
  }

  // Envelopes name a sender by its TASK title (peers/sender-name.ts), so a name copied
  // from one without its `[8hex]` is matched against the titles of the tasks behind the
  // most recently active sessions (bounded: an in-memory lookup each, never a table read).
  const recent = candidates
    .filter((s) => !s.archived && s.taskId)
    .sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''));
  const taskIds = [...new Set(recent.map((s) => s.taskId!))].slice(0, TASK_TITLE_MATCH_MAX);
  const { getTask } = await import('../task-manager.js');
  const named: Array<{ id: string; title: string }> = [];
  for (const id of taskIds) {
    const title = await getTask(id).then((t) => t.title ?? '', () => '');
    if (title.toLowerCase().includes(lower)) named.push({ id, title });
  }
  if (named.length === 1) return resolveSendTargetAddress(named[0].id);
  if (named.length > 1) throw ambiguous(to, named.map((t) => ({ id: t.id, title: `task: ${t.title}` })));

  throw new SendError('unknown_target', `nothing matches "${to}" — a session id/prefix, task id, or unique title substring`, 404);
}

/** Caller classes the envelope decision keys on. */
export type CallerIdentity =
  | { kind: 'session'; record: SessionRecord }
  | { kind: 'external'; app?: string } // gateway 'external' or an unknown sid; `app`: an installed plugin's own call
  | { kind: 'human' };              // no caller sid at all: the user's own CLI

/** The caller's own session id when the header resolves to a live record, else undefined (a person or unknown). */
export async function trustedCallerSessionId(callerSid: string | undefined): Promise<string | undefined> {
  const caller = await resolveCaller(callerSid).catch(() => null);
  return caller?.kind === 'session' ? caller.record.claudeSessionId || undefined : undefined;
}

export async function resolveCaller(callerSid: string | undefined): Promise<CallerIdentity> {
  const sid = (callerSid ?? '').trim();
  if (!sid) return { kind: 'human' };
  if (sid === 'external') return { kind: 'external' };
  // An installed App's own op call: no session, but not an unknown program either (plugin-caller.ts).
  const app = pluginCallerName(sid);
  if (app) return { kind: 'external', app };
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const record = await getSessionByClaudeId(sid);
    // A session an engine switch replaced keeps no authority as its task: a process
    // still finishing a command must not complete, answer for or stop the task.
    if (record && isSupersededSession(record)) {
      log.session.info('caller is a session an engine switch replaced; treated as an outside caller', { callerSid: sid, taskId: record.taskId, supersededBy: record.supersededBy });
      return { kind: 'external' };
    }
    return record ? { kind: 'session', record } : { kind: 'external' };
  } catch {
    return { kind: 'external' };
  }
}

/**
 * Deliver `text` to a session with the letter-ops three-state handling:
 * normal → durable queue + dispatch; parked on a permission prompt → enqueue
 * WITHOUT dispatch (the row waits behind the prompt and goes out once it is
 * answered, see QueuedMessage.closesPrompt); missing session is the caller's error.
 *
 * `fromLeader`: the sender leads the target (its parent task's session). A
 * worker's question is its leader's to answer, so a pending AskUserQuestion
 * does not hold the leader's message: it is dispatched, and the delivery path
 * closes the question (2026-10-05: a worker asked the user a question, and the
 * leader's two messages carrying the user's answer sat behind it for hours).
 * A tool permission prompt still holds every message but the user's own.
 */
export async function deliverToSession(
  target: SessionRecord,
  opts: { busText: string; enqueueText: string; source: string; taskId?: string; messageId?: string; fromLeader?: boolean; endsWait?: boolean; liveOnly?: import('./ask-answer.js').LiveDelivery },
): Promise<{ delivery: 'queued' | 'deferred'; messageId?: string }> {
  const sid = target.claudeSessionId;
  // An answer for the user goes only into the live session it was checked against (ask-answer.ts).
  let guard: { stopFence: string | null; stillWanted: () => boolean } | undefined;
  if (opts.liveOnly) {
    const { AnswerNotLiveError, liveSendGuard } = await import('./ask-answer.js');
    if (opts.liveOnly.sid !== sid) throw new AnswerNotLiveError(sid);
    guard = await liveSendGuard(opts.liveOnly);
    if (!guard.stillWanted()) throw new AnswerNotLiveError(sid);
  }
  const leaderAnswersQuestion = opts.fromLeader === true && target.pendingPermission?.toolName === 'AskUserQuestion';
  if (target.pendingPermission && !leaderAnswersQuestion) {
    // The raw enqueue below skips sendMessageToSession, so the area check runs here, on the
    // record as it is now (router/delivery-scope.ts), never on the caller's snapshot.
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const fresh = await getSessionByClaudeId(sid);
    if (!fresh) throw new SendError('unknown_target', `session ${shortId(sid)} no longer exists`, 404);
    assertAreaDelivery(fresh, sid, opts.source, opts.messageId);
    const { enqueueMessage } = await import('../session-message-queue.js');
    const { escapeHintTags } = await import('../hints/hint-format.js');
    const sentBy = queueSentBy(opts.source);
    const parked = await withTimeout(
      // Escaped like every queued send (hints/hint-format.ts); no hint rides a parked row.
      enqueueMessage(sid, frameForSource(escapeHintTags(opts.enqueueText), opts.source), { ...(opts.messageId ? { id: opts.messageId } : {}), ...(sentBy ? { sentBy } : {}), ...(guard ? { stopFence: guard.stopFence } : {}) }),
      DELIVERY_TIMEOUT_MS,
    );
    if (!parked) throw new SendError('delivery_failed', 'enqueue timed out — retry', 503);
    return { delivery: 'deferred', messageId: parked.id };
  }
  const { sendMessageToSession } = await import('../session-message-queue.js');
  const queued = await withTimeout(
    sendMessageToSession(sid, opts.busText, {
      source: opts.source,
      enqueueMessage: opts.enqueueText === opts.busText ? undefined : opts.enqueueText,
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
      ...(opts.messageId ? { messageId: opts.messageId } : {}),
      ...(leaderAnswersQuestion ? { closesPrompt: true } : {}),
      ...(opts.endsWait ? { endsWait: true } : {}),
      ...(guard ?? {}),
    }),
    DELIVERY_TIMEOUT_MS,
  );
  if (!queued) throw new SendError('delivery_failed', 'delivery timed out — retry', 503);
  return { delivery: 'queued', messageId: (queued as { id?: string }).id };
}

/**
 * A task's latest result (Task.result_report), from a reply or a completion. A reply with fields,
 * or any completion, replaces it, so a full answer after a partial one clears the Partial mark; a
 * plain reply writes only to end a Partial of the same request (a quick answer elsewhere settles
 * nothing, and erases no result).
 * Best effort: a failed write never fails the reply or the completion.
 */
/** A review's score alone (a close that settles the user's items writes its own result). Best effort. */
export async function noteReviewScore(taskId: string, score: import('../peers/structured-reply.js').ReviewScore, via: 'reply' | 'complete'): Promise<void> {
  try {
    const { updateTaskRaw } = await import('../task-manager.js');
    await updateTaskRaw(taskId, () => ({ review_score: { ...score, at: new Date().toISOString(), via } }), { source: 'result-report', push: false });
  } catch (err) {
    log.session.warn('review score not recorded on the task', { taskId, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function noteResultReport(
  taskId: string,
  head: Omit<import('../peers/structured-reply.js').TaskResultReport, 'at' | 'result' | 'evidence' | 'not_done' | 'settled' | 'score'>,
  fields: import('../peers/structured-reply.js').StructuredReply | null,
  opts: { emit?: boolean } = {},
): Promise<import('../peers/structured-reply.js').TaskResultReport | undefined> {
  try {
    const { updateTaskRaw } = await import('../task-manager.js');
    const { score, ...rest } = fields ?? {};
    const plain = !rest.result && !rest.evidence?.length && !rest.not_done?.length;
    let report: import('../peers/structured-reply.js').TaskResultReport = { ...head, at: new Date().toISOString(), ...rest };
    // A review's score is kept on its own field: a later result never erases it.
    const reviewScore = score ? { review_score: { ...score, at: report.at, via: head.via, ...(head.request_id ? { request_id: head.request_id } : {}) } } : {};
    const { isPartial, openOwed } = await import('../peers/structured-reply.js');
    // One read-modify-write under the row lock: a settle racing this write is never lost to it.
    const { task, changed } = await updateTaskRaw(taskId, (cur) => {
      const was = cur.result_report;
      // A plain reply carries no result: it only ends a Partial it answers itself (the same
      // request), and never erases a result written before (a completion's, another reply's).
      // A score alone is plain too: it is written on its own, and the result stays.
      if (plain) {
        const endsPartial = head.via === 'reply' ? isPartial(was) && was?.request_id === head.request_id : isPartial(was);
        if (!endsPartial) return score ? reviewScore : null;
      }
      // A reply never ends what a close left for the user (sessions/owed-to-user.ts): the hold rides on.
      const held = head.via === 'reply' ? openOwed(was) : undefined;
      // The merged list mixes an earlier writer's items: its writer is unknown, result/evidence stay this one's.
      if (held) report = { ...report, owed: held, not_done: [...new Set([...(report.not_done ?? []), ...held.items])], not_done_by: 'unknown' };
      return { result_report: report, ...reviewScore };
    }, { source: 'result-report', push: false });
    if (!changed) return undefined;
    // Surfaces learn of it (the Board's Partial); a completion's own event carries it instead.
    if (opts.emit !== false && task) {
      const { bus, EventNames } = await import('../event-bus.js');
      bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'result-report' });
    }
    return report;
  } catch (err) {
    log.session.warn('result not recorded on the task', {
      taskId, via: head.via, error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const onTimeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  return Promise.race([p, onTimeout]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * A subtask never messages its COMPLETE parent (2026-10-04, user call: "once I
 * close it, the subtask must not keep messaging it"). A parent may now complete
 * while its subtasks run, and a peer message reopens a completed task, so
 * without this a worker's report or reply would pull a closed leader back to
 * IN_PROGRESS. Refused with a pointer instead; anyone else's message to a
 * completed task still reopens it, and reopening the parent lifts this.
 */
async function refuseSendToCompleteParent(caller: CallerIdentity, targetTaskId: string | undefined): Promise<void> {
  if (caller.kind !== 'session' || !caller.record.taskId || !targetTaskId) return;
  const { getTask } = await import('../task-manager.js');
  const own = await getTask(caller.record.taskId).catch(() => undefined);
  // A stored parent id may be a legacy short prefix of the parent's id.
  const parentRef = own?.parent_task_id;
  if (!parentRef) return;
  const exact = await isTaskId(parentRef);
  if (!refNamesId(parentRef, targetTaskId, exact, own?.id)) return;
  const target = await getTask(targetTaskId).catch(() => undefined);
  if (!target || !refNamesId(parentRef, target.id, exact, own?.id) || target.phase !== 'COMPLETE') return;
  throw new SendError('parent_complete',
    `"${target.title}" (${target.id}) is your task's parent and it is complete: it no longer takes messages `
    + 'from its subtasks. Keep your result in your own task, where the user reads it; if that task should hear '
    + 'from you again, the user reopens it.', 409, { parentTaskId: target.id });
}

/**
 * The org is off (org/org-enabled.ts): Main and the VPs take no new message from an agent or from
 * Walnut. A person's own message still goes in, and so does an answer to a question one of them
 * asked (performReply), so nothing it waits on is left open.
 */
async function refuseOrgNodeWhileOff(caller: CallerIdentity, source: string | undefined, targetTaskId: string | undefined): Promise<void> {
  if (!targetTaskId) return;
  if (caller.kind === 'human' && (!source || isPersonSource(source))) return;
  const { isOrgEnabled, isOrgNode, ORG_OFF_MESSAGE } = await import('../org/org-enabled.js');
  if (await isOrgEnabled()) return;
  const { getTask } = await import('../task-manager.js');
  const target = await getTask(targetTaskId).catch(() => undefined);
  if (isOrgNode(target)) throw new SendError('org_off', ORG_OFF_MESSAGE, 409, { taskId: target!.id });
}

/**
 * A session's message to a lead that handed its project over goes to the lead that took it over
 * (org/retired-lead.ts; 2026-10-26, Main's go for six stack deletions reached the old lead 85
 * minutes after its handover, and both leads followed it). Refused with that pointer, unless the
 * old lead itself must act (`force` with a reason, which then leads the text; a COMPLETE one's
 * reason is admitCompleteTarget's to lead) or the caller is the lead that took over. The human
 * always reaches it. Returns the text to deliver.
 */
async function admitRetiredLead(caller: CallerIdentity, targetTaskId: string | undefined, input: SessionSendInput, text: string): Promise<string> {
  if (caller.kind !== 'session' || !targetTaskId) return text;
  const { retiredLeadRefusal } = await import('../org/retired-lead.js');
  const refusal = await retiredLeadRefusal(caller.record.taskId, targetTaskId);
  if (!refusal) return text;
  if (input.force !== true) {
    throw new SendError('lead_handed_over',
      `${refusal.message} If the old lead itself must act, pass force:true with reason:"<why it, not the lead that took over>".`,
      409, refusal.detail);
  }
  const reason = (input.reason ?? '').replace(/\s+/g, ' ').trim();
  if (reason.length < RETIRED_LEAD_REASON_MIN) {
    throw new SendError('bad_request',
      `force:true needs a reason (at least ${RETIRED_LEAD_REASON_MIN} characters) saying why "${refusal.retired.lead.title}" `
      + `(${refusal.retired.lead.id}), which no longer leads ${refusal.detail.project}, must act rather than the lead that took over.`, 400);
  }
  if (refusal.retired.lead.phase === 'COMPLETE') return text;
  return `This comes to you although you no longer lead ${refusal.detail.project}. Why: ${reason.slice(0, 300)}\n\n${text}`;
}

const RETIRED_LEAD_REASON_MIN = 10;

/**
 * A session's message to a COMPLETE task (envelope-kit.ts checkCompleteTarget):
 * refused unless it passes `force` with a reason, which then leads the text.
 * Returns the text to deliver. The human, an anonymous process, and a send to a
 * task that is still open pass untouched.
 */
async function admitCompleteTarget(
  caller: CallerIdentity,
  targetTaskId: string | undefined,
  input: SessionSendInput,
  text: string,
  mode: 'send' | 'reply',
): Promise<string> {
  if (caller.kind !== 'session' || !targetTaskId) return text;
  const { getTask } = await import('../task-manager.js');
  const target = await getTask(targetTaskId).catch(() => undefined);
  if (target?.phase !== 'COMPLETE') return text;
  const check = kit.checkCompleteTarget({ id: target.id, title: target.title }, input, mode);
  if (!check.ok) {
    throw new SendError(check.code, check.message, check.code === 'target_complete' ? 409 : 400,
      { taskId: target.id, phase: 'COMPLETE' });
  }
  log.session.info('session_send: a complete task is reopened by a forced message', {
    targetTaskId: target.id, callerSessionId: caller.record.claudeSessionId, mode, reason: check.reason,
  });
  return check.text(text);
}

/** The caller's task is the parent of `taskId` (a stored parent id may be a legacy prefix). */
async function callerLeads(caller: CallerIdentity, taskId: string | undefined): Promise<boolean> {
  if (caller.kind !== 'session' || !caller.record.taskId || !taskId) return false;
  const { getTask } = await import('../task-manager.js');
  const task = await getTask(taskId).catch(() => undefined);
  const parentRef = task?.parent_task_id;
  return !!parentRef && refNamesId(parentRef, caller.record.taskId, await isTaskId(parentRef), task.id);
}

/** Some task's id is `ref` itself (so `ref` is no prefix of another id). */
async function isTaskId(ref: string): Promise<boolean> {
  const { getTask } = await import('../task-manager.js');
  return (await getTask(ref).catch(() => undefined))?.id === ref;
}

/** Whether a task is an org node (a lead or Main). Unknown counts as not. */
async function targetIsLead(taskId: string | undefined): Promise<boolean> {
  if (!taskId) return false;
  const { getTask } = await import('../task-manager.js');
  return !!(await getTask(taskId).catch(() => undefined))?.org_role;
}

/** The answers being delivered now, by asker, words and replier (performReply's single flight). */
const answering = new Map<string, Promise<void>>();

/** Wait for an answer with the same key in flight, then hold the key; the returned call releases it. */
async function holdAnswer(key: string): Promise<() => void> {
  while (answering.has(key)) await answering.get(key)!.catch(() => {});
  let release!: () => void;
  answering.set(key, new Promise<void>((resolve) => { release = resolve; }));
  return () => { answering.delete(key); release(); };
}

/** A send that went out as a message (every send but an answer for the user that was only recorded). */
export type DeliveredSendResult = SessionSendResult & { delivery: 'queued' | 'deferred' };

/** The one send entry point (route + gateway both land here). */
export async function performSessionSend(input: SessionSendInput & { answersAsk?: false }): Promise<DeliveredSendResult>;
export async function performSessionSend(input: SessionSendInput): Promise<SessionSendResult>;
export async function performSessionSend(input: SessionSendInput): Promise<SessionSendResult> {
  if (!input.answersAsk) {
    const result = await performPlainSend(input);
    const open = input.inReplyTo ? null : await openAskBelow(input.callerSid, result.targetTaskId).catch(() => null);
    return open ? { ...result, openAsk: open.ask, ...(open.userSaid ? { userSaid: open.userSaid } : {}) } : result;
  }
  // An answer for the user (ask-answer.ts): checked and led by Walnut's line, then recorded.
  const caller = await resolveCaller(input.callerSid);
  if (caller.kind === 'external' || (caller.kind === 'session' && !caller.record.taskId)) {
    throw new SendError('bad_request', 'answers_ask needs a task\'s session or the person as the sender');
  }
  let targetTaskId: string | undefined;
  let asked: SessionRequest | undefined;
  let destination: SessionRecord | undefined;
  if (input.inReplyTo) {
    asked = await getSessionRequest(input.inReplyTo);
    if (asked) {
      const { getSessionByClaudeId } = await import('../session-tracker.js');
      targetTaskId = (await getSessionByClaudeId(asked.fromSessionId).catch(() => undefined))?.taskId;
    }
  } else if (input.to) {
    // A target that cannot be reached fails here as the send would, never as a plain send; a task
    // with no session at all is still answered (recorded), never started.
    try {
      const resolved = await resolveSendTarget(input.to);
      targetTaskId = resolved.taskId ?? resolved.session.taskId;
      destination = resolved.session;
    } catch (err) {
      if (!(err instanceof SendError && err.code === 'task_has_no_session' && typeof err.detail?.taskId === 'string')) throw err;
      targetTaskId = err.detail.taskId;
    }
  }
  const { prepareAskAnswer, AskAnswerError, answerReach, liveDelivery, notDeliveredLive } = await import('./ask-answer.js');
  const words = input.text?.trim() || (typeof input.reply?.result === 'string' ? input.reply.result : '');
  let prepared: Awaited<ReturnType<typeof prepareAskAnswer>>;
  try {
    prepared = await prepareAskAnswer(
      caller.kind === 'session' ? caller.record.taskId! : null, targetTaskId, words, input.userWords,
      caller.kind === 'session' ? caller.record.claudeSessionId : undefined,
    );
  } catch (err) {
    if (err instanceof AskAnswerError) throw new SendError(err.code, err.message, err.status, targetTaskId ? { taskId: targetTaskId } : undefined);
    throw err;
  }
  // An answer to a request goes where performReply would send it: past the asker for a request it
  // carries, or the asker's live fork (reply-routing.ts). The gate judges that very session.
  if (asked && caller.kind === 'session') destination = await replyDestinationOf(asked, caller.record.claudeSessionId);
  // A COMPLETE task, or one whose session is not running, is never woken by an answer: it is
  // recorded and taken off the user's Needs you (2026-11-06: an answer resumed a stopped session).
  const forced = input.force === true && !!input.reason?.trim();
  const reach = answerReach(prepared.target, destination ? [destination] : [], { force: forced });
  const recordOnly = async (why: 'complete' | 'stopped'): Promise<SessionSendResult> => {
    if (asked) await settleAnswerNotDelivered(asked, caller, input);
    await prepared.commit();
    log.session.info('answers_ask: recorded, not delivered', { taskId: prepared.target.id, why, requestId: asked?.id });
    const sid = destination?.claudeSessionId ?? asked?.fromSessionId ?? '';
    return {
      delivery: 'recorded', notWoken: why, targetSessionId: sid, targetTitle: prepared.target.title, targetTaskId: prepared.target.id,
      target: { handle: sessionHandle(prepared.target.title, sid), sessionId: sid, taskId: prepared.target.id },
      ...(asked ? { repliedTo: asked.id } : {}),
      ...(prepared.userSaid ? { userSaid: prepared.userSaid } : {}),
    };
  };
  if (!reach.wakes) {
    if (input.handsOn) {
      throw new SendError('bad_request', `hands_on needs "${prepared.target.title}" (${prepared.target.id}) to work on the request, and it is ${reach.why === 'complete' ? 'complete' : 'not running'}: answer without hands_on, then task_start it with the request.`, 409, { taskId: prepared.target.id });
    }
    return recordOnly(reach.why);
  }
  // Delivered only into the session just checked, while it still runs and no Stop came since; a
  // forced answer may resume it, as a forced message does.
  const liveOnly = !forced && destination ? await liveDelivery(destination.claudeSessionId) : undefined;
  let result: DeliveredSendResult;
  try {
    result = await performPlainSend({
      ...input, answersAsk: false, ...(liveOnly ? { liveOnly } : {}),
      text: input.text?.trim() ? `${prepared.line}\n\n${input.text}` : prepared.line,
    });
  } catch (err) {
    // It stopped between the check and the write: nothing was queued, so it is only recorded.
    if (liveOnly && await notDeliveredLive(err)) return recordOnly('stopped');
    throw err;
  }
  await prepared.commit();
  return prepared.userSaid ? { ...result, userSaid: prepared.userSaid } : result;
}

/** Where an answer to `request` from `replierSid` goes (performReply's own routing), or undefined. */
async function replyDestinationOf(request: SessionRequest, replierSid: string): Promise<SessionRecord | undefined> {
  const { onwardAnswer } = await import('./reply-handoff.js');
  const onward = await onwardAnswer(request, replierSid);
  if (onward) return onward.destination.session;
  const { resolveReplyDestination } = await import('./reply-routing.js');
  return (await resolveReplyDestination(request.fromSessionId, { exclude: [replierSid] }))?.session;
}

/** Whether the caller answers this request: its target, or the task it was handed on to (request-handoff.ts). */
function answersRequest(caller: CallerIdentity, request: Pick<SessionRequest, 'toSessionId' | 'toTaskId' | 'carriedBy'>): boolean {
  if (caller.kind !== 'session') return false;
  return caller.record.claudeSessionId === request.toSessionId
    || (!!request.toTaskId && caller.record.taskId === request.toTaskId)
    || (!!caller.record.taskId && (request.carriedBy ?? []).some((c) => c.taskId === caller.record.taskId));
}

/**
 * An answer for the user to a request whose asker is not running (or is complete): the request is
 * settled by it, as a reply would settle it, and nothing is delivered, so no overdue notice wakes
 * the asker later either. The answer itself is kept on the asker (Task.ask_answered).
 */
async function settleAnswerNotDelivered(
  request: SessionRequest, caller: CallerIdentity, input: SessionSendInput,
): Promise<void> {
  if (!answersRequest(caller, request)) {
    throw new SendError('not_request_target', `request ${request.id} was not addressed to this session`, 403);
  }
  const { readStructuredReply } = await import('../peers/structured-reply.js');
  const fields = input.reply ? readStructuredReply(input.reply) : null;
  if (request.status === 'pending') await settleReplied(request.id, fields).catch(() => null);
  else if (request.status === 'expired') await settleLateReply(request.id, fields).catch(() => null);
}

async function performPlainSend(input: SessionSendInput): Promise<DeliveredSendResult> {
  const { readStructuredReply, composeReplyText } = await import('../peers/structured-reply.js');
  const fields = input.reply ? readStructuredReply(input.reply) : null;
  if (fields && !input.inReplyTo) {
    throw new SendError('bad_request', 'result, evidence, not_done and score answer a request: pass in_reply_to (rq-…)');
  }
  const text = composeReplyText(input.text, fields).trim();
  if (!text) throw new SendError('bad_request', 'text must be a non-empty string (or, answering a request, give result)');
  const caller = await resolveCaller(input.callerSid);

  if (input.inReplyTo) return performReply(input, caller, text, fields);

  if (!input.to) throw new SendError('bad_request', '`to` is required (or pass in_reply_to)');
  if (input.handsOn !== undefined && !/^rq-[a-f0-9]{6,}$/.test(input.handsOn)) throw new SendError('bad_request', 'hands_on must be an rq-… id');
  if (input.handsOn && input.expectReply === false) {
    throw new SendError('bad_request', 'hands_on needs a reply request: its asker waits for this answer (leave expect_reply on)');
  }
  let target: Awaited<ReturnType<typeof resolveSendTarget>>;
  try {
    target = await resolveSendTarget(input.to);
  } catch (err) {
    // A completed parent usually has no live session: say why, never "use task_start".
    if (err instanceof SendError && err.code === 'task_has_no_session') {
      const noSessionTask = typeof err.detail?.taskId === 'string' ? err.detail.taskId : undefined;
      await refuseSendToCompleteParent(caller, noSessionTask);
      await admitRetiredLead(caller, noSessionTask, input, text);
      // A complete task says so, not "not started"; forced, task_start is the way on.
      await admitCompleteTarget(caller, noSessionTask, input, text, 'send');
    }
    throw err;
  }
  const targetSid = target.session.claudeSessionId;
  if (caller.kind === 'session' && caller.record.taskId) {
    const { mayShareTaskContext } = await import('../router/context-sharing.js');
    if (!await mayShareTaskContext(caller.record.taskId, target.taskId ?? target.session.taskId)) {
      throw new SendError('area_forbidden', 'Context cannot be sent across an area boundary.', 403);
    }
  }

  // A session its task is moving away from is archived until the move is done: a message for it
  // is held there and moves with the task (engine-switch.ts movingFrom), never refused.
  if (target.session.archived && !(await import('./engine-switch.js')).movingFrom({ sessionId: targetSid })) {
    throw new SendError('target_archived', `session ${shortId(targetSid)} is archived`, 409);
  }
  if (caller.kind === 'session' && caller.record.claudeSessionId === targetSid) {
    throw new SendError('self_send', 'target resolves to the calling session itself');
  }
  await refuseSendToCompleteParent(caller, target.taskId ?? target.session.taskId);
  await refuseOrgNodeWhileOff(caller, input.source, target.taskId ?? target.session.taskId);
  const admitted = await admitRetiredLead(caller, target.taskId ?? target.session.taskId, input, text);
  const body = await admitCompleteTarget(caller, target.taskId ?? target.session.taskId, input, admitted, 'send');

  // Envelope + throttle apply exactly when the SPEAKER is not the human:
  // another session (named peer-note) or an unidentified process (anonymous).
  const walnutSends = caller.kind === 'human' && !!input.source && !isPersonSource(input.source);
  const fenced = caller.kind !== 'human' || walnutSends;
  if (fenced && !walnutSends) {
    // An anonymous (env-less) caller is bucketed per HOST, not under one global
    // `external` key: otherwise a runaway agent on a dev box would throttle the
    // user's own terminal on the Mac. A tracked session is its own bucket.
    const senderKey = caller.kind === 'session'
      ? caller.record.claudeSessionId
      : `external@${input.callerHost?.trim().slice(0, 64) || 'local'}`;
    const decision = sharedThrottle.admit(senderKey, targetSid, text);
    if (!decision.allowed) {
      throw new SendError('throttled', 'peer send throttled — do not retry in a loop', 429,
        { retryAfterMs: decision.retryAfterMs });
    }
    const { getQueue } = await import('../session-message-queue.js');
    const queueDepth = (await getQueue(targetSid)).length;
    if (queueDepth >= PEER_PENDING_CAP) {
      throw new SendError('queue_full', `session ${shortId(targetSid)} already has ${queueDepth} queued messages`, 429);
    }
  }

  // expect_reply: register the pending row BEFORE the envelope is built (the
  // request id rides INSIDE the open tag as `request="rq-…"`, not just in the
  // trailer) and before delivery, so nothing ever names an id that does not exist.
  //
  // ON unless explicitly disabled. A session asking another session something
  // wants the answer; making that opt-in meant every forgotten flag silently
  // dropped it. A human/external caller has nowhere to route a reply to, so
  // the DEFAULT degrades to "no request" there — only an explicit `true` still
  // errors, because then the caller asked for something impossible.
  // (An inReplyTo send never reaches here — performReply returns at :259.)
  let request: (SessionRequest & { handOnRefused?: { id: string; reason: string }[] }) | undefined;
  // The queue row's id, picked before the request row: the row then names it from the start, so
  // its delivery stamps the request reached however fast it goes (session-requests.ts markRequestsReached).
  const rowId = input.messageId ?? (await import('../session-queue-store.js')).generateId();
  // A note up the org (to its own leader, its VP, or Main) reports: no request unless asked for one
  // (reply-direction.ts). A hand-off keeps its asker's request.
  const reportsUp = input.expectReply === undefined && !input.handsOn && caller.kind === 'session'
    && await (await import('./reply-direction.js')).goesUp(caller.record.taskId, target.taskId ?? target.session.taskId).catch(() => false);
  if (input.expectReply !== false && !reportsUp) {
    if (caller.kind !== 'session') {
      if (input.handsOn) throw new SendError('bad_request', 'hands_on needs a session caller: only a session owes a request');
      if (input.expectReply === true) {
        throw new SendError('bad_request',
          'expect_reply needs a session caller — a reply can only be routed back to a tracked session');
      }
    } else {
      request = await createSessionRequest({
        fromSessionId: caller.record.claudeSessionId,
        ...(caller.record.taskId ? { fromTaskId: caller.record.taskId } : {}),
        toSessionId: targetSid,
        toTaskId: target.taskId ?? target.session.taskId,
        text,
        replyTimeoutSecs: input.replyTimeoutSecs,
        // Nobody asked for this one — the default did. Longer fallback fuse, so
        // routine session→session notes don't each become a "no reply" notice.
        implicit: input.expectReply === undefined,
        // A lead's or Main's answer waits on its teams: a longer default deadline.
        kind: input.replyKind ?? (await targetIsLead(target.taskId ?? target.session.taskId) ? 'lead' : 'send'),
        ...(input.handsOn ? { handsOn: [input.handsOn] } : {}),
        messageId: rowId,
      });
    }
  }
  // Until its message is queued, no edge of the target speaks for this request.
  const delivered = request ? noteRequestDelivering(request.id) : undefined;

  let enqueueText = body;
  if (fenced) {
    enqueueText = buildPeerWrapper(body, caller.kind === 'session'
      ? {
        // The sender's TASK title (sender-name.ts); none → the handle is just `[8hex]`.
        title: await senderTitleOf(caller.record),
        shortId: shortId(caller.record.claudeSessionId),
        sessionId: caller.record.claudeSessionId,
        taskId: caller.record.taskId,
        host: displayHost(caller.record.host),
        ...(request ? { requestId: request.id } : {}),
      }
      : {
        title: '',
        shortId: '',
        // No transport host = genuinely unknown; never guess 'local' for an
        // anonymous sender the way displayHost() does for tracked sessions.
        host: input.callerHost?.trim()
          ? displayHost(input.callerHost.trim().slice(0, 64))
          : walnutSends ? 'local' : 'unknown',
        anonymous: true,
        ...(caller.kind === 'external' && caller.app ? { app: caller.app }
          : input.callerLabel ? { automation: input.callerLabel } : walnutSends ? { automation: `Walnut (${input.source})` } : {}),
      }, { title: input.title });
  }
  // One `\n`, one line, and only when a request exists to answer.
  if (request) enqueueText = `${enqueueText}\n${buildReplyTrailer(request)}`;

  const source = caller.kind === 'human' && !walnutSends ? 'cli' : 'peer';
  const taskId = target.taskId ?? target.session.taskId;
  let delivery: 'queued' | 'deferred';
  let messageId: string | undefined;
  try {
    const fromLeader = await callerLeads(caller, taskId);
    ({ delivery, messageId } = await deliverToSession(target.session, {
      busText: body, enqueueText, source, taskId, messageId: rowId, fromLeader,
      ...(input.liveOnly ? { liveOnly: input.liveOnly } : {}),
    }));
  } catch (err) {
    // A rejected delivery never landed, so a request row we just created would
    // otherwise sit pending until its deadline and the sweeper would tell the
    // asker "no reply by your deadline" about a send that never happened. A
    // TIMEOUT is different: withTimeout abandons the enqueue, it does not cancel
    // it, so the envelope (carrying request="rq-…") may still arrive and the
    // receiver's reply needs a row to land in. Leave that row to the sweeper.
    const timedOut = err instanceof SendError && err.code === 'delivery_failed';
    if (request && !timedOut) {
      await deletePendingRequest(request.id).catch((e) => {
        log.session.warn('session_send: could not drop the orphaned request row', {
          requestId: request.id, error: e instanceof Error ? e.message : String(e),
        });
      });
    }
    throw err;
  } finally {
    delivered?.();
  }

  log.session.info('session_send delivered', {
    targetSessionId: targetSid, taskId, delivery, fenced,
    requestId: request?.id, callerKind: caller.kind, messageId,
  });
  return {
    delivery,
    targetSessionId: targetSid,
    targetTitle: target.session.title ?? null,
    ...(taskId ? { targetTaskId: taskId } : {}),
    target: {
      handle: sessionHandle(target.session.title, targetSid),
      sessionId: targetSid,
      ...(taskId ? { taskId } : {}),
    },
    ...(request ? { requestId: request.id } : {}),
    ...(request?.carries?.length ? { handedOn: request.carries } : {}),
    ...(request?.handOnRefused?.length ? { handOnRefused: request.handOnRefused } : {}),
    ...(messageId ? { messageId } : {}),
  };
}

/**
 * in_reply_to: settle the request FIRST (atomic pending→replied; whoever wins
 * this transition is the one voice the asker hears), then route the answer to
 * the asker. Only the request's target session may close it.
 */
async function performReply(
  input: SessionSendInput,
  caller: CallerIdentity,
  text: string,
  fields: import('../peers/structured-reply.js').StructuredReply | null = null,
): Promise<DeliveredSendResult> {
  const id = String(input.inReplyTo);
  const request = await getSessionRequest(id);
  if (!request) throw new SendError('unknown_request', `no such request: ${id}`, 404);

  if (caller.kind !== 'session') {
    throw new SendError('not_request_target', 'replies must come from the session the request was sent to', 403);
  }
  // The task it was handed on to (request-handoff.ts) answers it as well as its target.
  if (!answersRequest(caller, request)) {
    throw new SendError('not_request_target',
      `request ${id} was not addressed to this session`, 403);
  }
  // Asked by the parent, which has completed since: refused before anything
  // else (its session is usually stopped by then), and the ask is withdrawn.
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const asker = await getSessionByClaudeId(request.fromSessionId).catch(() => undefined);
    await refuseSendToCompleteParent(caller, asker?.taskId);
  } catch (err) {
    if (request.status === 'pending') await withdrawRequest(id).catch(() => null);
    throw err;
  }

  // Resolve the asker BEFORE settling: a gone asker means there is nowhere to
  // deliver, and settling first would burn the request (status → replied) with
  // the answer lost forever. Left pending, the sweeper closes it honestly.
  //
  // The address is RESOLVED, not read off the row: a human who forked the asking
  // session and carried on in the fork is not reading the session that registered
  // the request any more (see reply-routing.ts for the incident). The common case
  // — an asker that is still live — resolves to itself, unchanged.
  const { resolveReplyDestination, logReplyReroute } = await import('./reply-routing.js');
  // A request that carries another one (hands_on) is answered for that one's asker: the answer
  // goes straight there, and the asker in between reads one line (reply-handoff.ts).
  const { onwardAnswer, wentPastLine } = await import('./reply-handoff.js');
  const onward = await onwardAnswer(request, caller.record.claudeSessionId);
  const destination = onward?.destination ?? await resolveReplyDestination(request.fromSessionId, {
    // Never route the answer back into the session that is answering.
    exclude: [caller.record.claudeSessionId],
  });
  if (!destination) {
    throw new SendError('origin_session_gone',
      `the asking session (${shortId(request.fromSessionId)}) is gone — nothing to deliver to`, 410);
  }
  logReplyReroute(onward?.final.id ?? id, onward?.final.fromSessionId ?? request.fromSessionId, destination);
  const origin = destination.session;
  if (caller.record.taskId) {
    const { mayShareTaskContext } = await import('../router/context-sharing.js');
    if (!await mayShareTaskContext(caller.record.taskId, origin.taskId)) {
      throw new SendError('cross_area', 'This reply crosses an incoming-item area. Nothing was delivered or settled.', 403);
    }
  }
  // Before the settle: a refused answer leaves the request open for a forced retry.
  const replyBody = await admitCompleteTarget(caller, origin.taskId, input, text, 'reply');

  // Settles one request with this answer, pending or overdue; `fwd` marks one whose asker the answer went past.
  const settleOpen = async (rid: string, fwd?: string) =>
    (await settleReplied(rid, fields, fwd).catch(() => null)) ?? await settleLateReply(rid, fields, fwd).catch(() => null);
  // The same words from this task already reached this asker for another (or this) request:
  // this one settles with it, and the asker reads one line instead of the answer again.
  const stamp: AnswerStamp = {
    digest: answerDigest(replyBody), deliveredTo: origin.claudeSessionId,
    by: { sessionId: caller.record.claudeSessionId, ...(caller.record.taskId ? { taskId: caller.record.taskId } : {}) },
  };
  let sameAs: string | undefined;
  // One answer at a time per asker and words: a second task_send with the same text waits until
  // the first is delivered (or failed), then reads it as a repeat (or as the answer, if it failed).
  const answeredFor = onward?.final ?? request;
  let replierTitle = '';
  let delivery: 'queued' | 'deferred' = 'queued';
  let messageId: string | undefined;
  const releaseAnswer = onward ? () => {} : await holdAnswer(`${stamp.deliveredTo}\u0000${stamp.digest}\u0000${stamp.by.taskId ?? stamp.by.sessionId}`);
  try {
    // Read again once the key is held: a send of the same words to the same request that waited
    // behind it finds the request settled by the first one, and reads itself as its repeat.
    const status = onward ? request.status : ((await getSessionRequest(id).catch(() => null)) ?? request).status;
    if (onward) {
      // Settled once the answer is delivered: a failed delivery leaves the whole chain open.
    } else if (status !== 'pending') {
      // Late but honest: the asker was already notified (turn end / timeout), yet
      // a real answer beats a status notice — deliver it anyway, marked late.
      log.session.info('session reply after settle — delivering late', { requestId: id, status });
      // An overdue request was still open: this answer closes it.
      if (status === 'expired') sameAs = (await settleLateReply(id, fields, undefined, stamp).catch(() => null))?.sameAnswerAs;
      // Answered already, and these are the words it got then (or another request got).
      else sameAs = sameAnswerOf(await listAllSessionRequests().catch(() => []), stamp)?.id;
    } else {
      const settled = await settleReplied(id, fields, undefined, stamp);
      if (!settled) {
        log.session.info('session reply lost the settle race — delivering late', { requestId: id });
      }
      // Lost the race to another answer: these may be the very words it delivered.
      sameAs = settled ? settled.sameAnswerAs : sameAnswerOf(await listAllSessionRequests().catch(() => []), stamp)?.id;
    }
    // The replier's latest result, kept on its task: the Board and the Brief read Partial from it.
    if (caller.record.taskId) {
      await noteResultReport(caller.record.taskId, {
        via: 'reply', request_id: answeredFor.id, ...(origin.taskId ? { to_task_id: origin.taskId } : {}), by: `task:${caller.record.taskId}`,
        ...(caller.record.claudeSessionId ? { sessionId: caller.record.claudeSessionId } : {}),
      }, fields);
    }

    replierTitle = await senderTitleOf(caller.record);
    if (sameAs) {
      // Delivered once: the asker reads which requests the answer it already has settles.
      const who = replierTitle ? `"${replierTitle}"${caller.record.taskId ? ` (${caller.record.taskId})` : ''}` : (caller.record.taskId ?? 'The task');
      const line = sameAs === id
        ? `${who} sent its answer to ${id} again, word for word: you already have it, so it was not delivered twice.`
        : `${who} answered ${id} with the same words as its answer to ${sameAs}, which you already have: ${id} is settled by it too, not delivered twice.`;
      const { getTask } = await import('../task-manager.js');
      if (origin.taskId && (await getTask(origin.taskId).catch(() => null))?.phase === 'WAITING') {
        // Parked on this answer since the first one: the line is what ends its wait.
        const { statusText } = await import('./status-push.js');
        const text = statusText([line]);
        ({ delivery, messageId } = await deliverToSession(origin, { busText: text, enqueueText: text, source: 'walnut-notify', taskId: origin.taskId, endsWait: true, ...(input.liveOnly ? { liveOnly: input.liveOnly } : {}) }));
      } else {
        // Read with its next message (or now, mid-turn): the answer itself is already there.
        const { tellOrRide } = await import('./status-push.js');
        await tellOrRide(origin.claudeSessionId, `same-answer-${id}`, line);
      }
      log.session.info('session reply was the same answer already delivered — not delivered again', {
        requestId: id, sameAnswerAs: sameAs, fromSessionId: caller.record.claudeSessionId, toSessionId: origin.claudeSessionId,
      });
    } else {
      const wrapped = buildReplyDeliveryText(answeredFor, {
        // The replier's TASK title (sender-name.ts); none → the handle is just `[8hex]`.
        title: replierTitle,
        shortId: shortId(caller.record.claudeSessionId),
        sessionId: caller.record.claudeSessionId,
        taskId: caller.record.taskId,
        host: displayHost(caller.record.host),
      }, replyBody, { title: input.title });

      ({ delivery, messageId } = await deliverToSession(origin, {
        busText: replyBody, enqueueText: wrapped, source: 'peer', endsWait: true,
        taskId: origin.taskId, messageId: input.messageId,
        fromLeader: await callerLeads(caller, origin.taskId),
        ...(input.liveOnly ? { liveOnly: input.liveOnly } : {}),
      }));
    }

    // A later answer with these words to this asker is a repeat of this one (sameAnswerOf).
    if (!onward && !sameAs) await noteAnswerDelivered(id, stamp).catch(() => {});
  } finally {
    releaseAnswer();
  }
  const originSid = origin.claudeSessionId;
  // The asks this answer went past: the chain below the outermost one, or the asks that handed
  // `request` on to the task answering it directly. Each settles, and its asker reads one line.
  const { directCarriers } = await import('./reply-handoff.js');
  const passed = onward
    ? [request, ...onward.chain.slice(0, -1)]
    : directCarriers(request, caller.record.taskId, await listAllSessionRequests().catch(() => []));
  if (onward) {
    for (const r of passed) await settleOpen(r.id, onward.final.id);
    await settleOpen(onward.final.id);
  } else {
    for (const r of passed) await settleOpen(r.id, id);
  }
  if (passed.length) {
    // Where each asker reads now (never woken; the answer itself is not repeated).
    const { tellOrRide } = await import('./status-push.js');
    for (const r of passed) {
      const at = await resolveReplyDestination(r.fromSessionId, { exclude: [caller.record.claudeSessionId, originSid] });
      if (!at) continue;
      await tellOrRide(at.session.claudeSessionId, `onward-${r.id}`, wentPastLine({
        replier: { title: replierTitle || null, taskId: caller.record.taskId ?? null },
        yours: r.id,
        final: answeredFor,
        finalAsker: { title: (await senderTitleOf(origin)) || null, taskId: origin.taskId ?? null },
      }));
    }
  }
  log.session.info('session reply delivered to asker', {
    requestId: id, fromSessionId: caller.record.claudeSessionId,
    requesterSessionId: request.fromSessionId,
    ...(onward ? { answeredFor: onward.chain.map((r) => r.id) } : {}),
    toSessionId: originSid, delivery, messageId,
  });
  return {
    delivery,
    // The RESOLVED address, not the row's fromSessionId: a caller that reads this
    // back must see where its answer actually went.
    targetSessionId: originSid,
    targetTitle: origin.title ?? null,
    ...(origin.taskId ? { targetTaskId: origin.taskId } : {}),
    // The "target" of a reply is the asker it routed back to.
    target: {
      handle: sessionHandle(origin.title, originSid),
      sessionId: originSid,
      ...(origin.taskId ? { taskId: origin.taskId } : {}),
    },
    repliedTo: id,
    ...(onward ? { answeredFor: onward.chain.map((r) => r.id) } : {}),
    ...(sameAs ? { sameAnswerAs: sameAs } : {}),
    ...(messageId ? { messageId } : {}),
  };
}
