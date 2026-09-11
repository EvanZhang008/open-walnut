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
import type { SessionRecord } from '../types.js';
import { buildPeerWrapper } from '../peers/peer-wrapper.js';
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
  type SessionRequest,
} from '../session-requests.js';

/** Enqueue + bus fan-out ceiling — same rationale as letter delivery. */
const DELIVERY_TIMEOUT_MS = 8_000;

/** Shared across all callers in this process — throttle state is per-sender. */
const sharedThrottle = new PeerThrottle();

export class SendError extends Error {
  constructor(
    public code:
      | 'bad_request' | 'unknown_target' | 'ambiguous_target' | 'task_has_no_session'
      | 'target_archived' | 'self_send' | 'queue_full' | 'throttled' | 'delivery_failed'
      | 'unknown_request' | 'request_already_settled' | 'not_request_target' | 'origin_session_gone',
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
  /** rq-… id — this send IS the reply; `to` may be omitted (routes to the asker). */
  inReplyTo?: string;
  /** Idempotency id (qm-…) forwarded to the durable queue. */
  messageId?: string;
  /** Transport-stamped caller session id; undefined = the human's own CLI. */
  callerSid?: string;
  /** Transport-stamped host the calling CLI runs on — labels an ANONYMOUS
   *  sender's envelope honestly (a session caller's host comes from its record). */
  callerHost?: string;
}

export interface SessionSendResult {
  /** queued = dispatched; deferred = enqueued but target awaits a permission prompt. */
  delivery: 'queued' | 'deferred';
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
  /** Present on an in_reply_to send. */
  repliedTo?: string;
  messageId?: string;
}

const shortId = (sid: string): string => sid.slice(0, 8);
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

/**
 * Resolve `to` → one target session.
 * ⓪ printed `Title [8hex]` handle (exact id, then unique prefix; a bracketed
 *   word that matches no session, e.g. `css [fade]`, falls through) →
 * ① exact session id → ② task id/unique prefix (its attached session) →
 * ③ unique session-id prefix (>=4) → ④ unique case-insensitive title substring.
 * A `to` that matches BOTH a task and a session at the same stage is ambiguous.
 */
export async function resolveSendTarget(to: string): Promise<ResolvedTarget> {
  const candidates = await sendCandidates();

  const printed = to.match(PRINTED_HANDLE)?.[1]?.toLowerCase();
  if (printed) {
    const byHandle = candidates.find((s) => s.claudeSessionId.toLowerCase() === printed)
      ?? null;
    if (byHandle) return { session: byHandle };
    const hits = candidates.filter((s) => s.claudeSessionId.toLowerCase().startsWith(printed));
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
  let taskHit: { id: string; title: string } | undefined;
  try {
    const { getTask } = await import('../task-manager.js');
    const task = await getTask(to);
    taskHit = { id: task.id, title: task.title };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Ambiguous ID prefix')) throw new SendError('ambiguous_target', msg, 400);
    // "No task found" and store errors both fall through to session matching.
  }

  const lower = to.toLowerCase();
  const byPrefix = to.length >= 4
    ? candidates.filter((s) => s.claudeSessionId.toLowerCase().startsWith(lower))
    : [];

  if (taskHit && byPrefix.length > 0) {
    throw ambiguous(to, [
      { id: taskHit.id, title: `task: ${taskHit.title}` },
      ...byPrefix.map((s) => ({ id: s.claudeSessionId, title: s.title, host: s.host })),
    ]);
  }

  if (taskHit) {
    const { getSessionsForTask } = await import('../session-tracker.js');
    const sessions = liveSessionsForTask(await getSessionsForTask(taskHit.id));
    if (sessions.length === 0) {
      throw new SendError('task_has_no_session',
        `task "${taskHit.title}" (${shortId(taskHit.id)}) has no session — start one with session_start`,
        409, { taskId: taskHit.id });
    }
    // Prefer the task's current slot; otherwise the most recently active row.
    const bySlot = sessions.length === 1 ? sessions[0]
      : [...sessions].sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''))[0];
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

  throw new SendError('unknown_target', `nothing matches "${to}" — a session id/prefix, task id, or unique title substring`, 404);
}

/** Caller classes the envelope decision keys on. */
export type CallerIdentity =
  | { kind: 'session'; record: SessionRecord }
  | { kind: 'external' }            // gateway 'external' or an unknown sid
  | { kind: 'human' };              // no caller sid at all: the user's own CLI

export async function resolveCaller(callerSid: string | undefined): Promise<CallerIdentity> {
  const sid = (callerSid ?? '').trim();
  if (!sid) return { kind: 'human' };
  if (sid === 'external') return { kind: 'external' };
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const record = await getSessionByClaudeId(sid);
    return record ? { kind: 'session', record } : { kind: 'external' };
  } catch {
    return { kind: 'external' };
  }
}

/**
 * Deliver `text` to a session with the letter-ops three-state handling:
 * normal → durable queue + dispatch; parked on a permission prompt → enqueue
 * WITHOUT dispatch (both delivery paths auto-deny pending prompts — the
 * message rides the next natural drain); missing session is the caller's error.
 */
export async function deliverToSession(
  target: SessionRecord,
  opts: { busText: string; enqueueText: string; source: string; taskId?: string; messageId?: string },
): Promise<{ delivery: 'queued' | 'deferred'; messageId?: string }> {
  const sid = target.claudeSessionId;
  if (target.pendingPermission) {
    const { enqueueMessage } = await import('../session-message-queue.js');
    const parked = await withTimeout(
      enqueueMessage(sid, opts.enqueueText, opts.messageId ? { id: opts.messageId } : undefined),
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
    }),
    DELIVERY_TIMEOUT_MS,
  );
  if (!queued) throw new SendError('delivery_failed', 'delivery timed out — retry', 503);
  return { delivery: 'queued', messageId: (queued as { id?: string }).id };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const onTimeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  return Promise.race([p, onTimeout]).finally(() => { if (timer) clearTimeout(timer); });
}

/** The one send entry point (route + gateway both land here). */
export async function performSessionSend(input: SessionSendInput): Promise<SessionSendResult> {
  const text = (input.text ?? '').trim();
  if (!text) throw new SendError('bad_request', 'text must be a non-empty string');
  const caller = await resolveCaller(input.callerSid);

  if (input.inReplyTo) return performReply(input, caller, text);

  if (!input.to) throw new SendError('bad_request', '`to` is required (or pass in_reply_to)');
  const target = await resolveSendTarget(input.to);
  const targetSid = target.session.claudeSessionId;

  if (target.session.archived) {
    throw new SendError('target_archived', `session ${shortId(targetSid)} is archived`, 409);
  }
  if (caller.kind === 'session' && caller.record.claudeSessionId === targetSid) {
    throw new SendError('self_send', 'target resolves to the calling session itself');
  }

  // Envelope + throttle apply exactly when the SPEAKER is not the human:
  // another session (named peer-note) or an unidentified process (anonymous).
  const fenced = caller.kind !== 'human';
  if (fenced) {
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
  let request: SessionRequest | undefined;
  if (input.expectReply !== false) {
    if (caller.kind !== 'session') {
      if (input.expectReply === true) {
        throw new SendError('bad_request',
          'expect_reply needs a session caller — a reply can only be routed back to a tracked session');
      }
    } else {
      request = await createSessionRequest({
        fromSessionId: caller.record.claudeSessionId,
        toSessionId: targetSid,
        toTaskId: target.taskId ?? target.session.taskId,
        text,
        replyTimeoutSecs: input.replyTimeoutSecs,
        // Nobody asked for this one — the default did. Longer fallback fuse, so
        // routine session→session notes don't each become a "no reply" notice.
        implicit: input.expectReply === undefined,
      });
    }
  }

  let enqueueText = text;
  if (fenced) {
    enqueueText = buildPeerWrapper(text, caller.kind === 'session'
      ? {
        // No title → the handle is just `[8hex]`; never invent a name.
        title: caller.record.title ?? '',
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
          : 'unknown',
        anonymous: true,
      });
  }
  // One `\n`, one line, and only when a request exists to answer.
  if (request) enqueueText = `${enqueueText}\n${buildReplyTrailer(request)}`;

  const source = caller.kind === 'human' ? 'cli' : 'peer';
  const taskId = target.taskId ?? target.session.taskId;
  let delivery: 'queued' | 'deferred';
  let messageId: string | undefined;
  try {
    ({ delivery, messageId } = await deliverToSession(target.session, {
      busText: text, enqueueText, source, taskId, messageId: input.messageId,
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
): Promise<SessionSendResult> {
  const id = String(input.inReplyTo);
  const request = await getSessionRequest(id);
  if (!request) throw new SendError('unknown_request', `no such request: ${id}`, 404);

  if (caller.kind !== 'session') {
    throw new SendError('not_request_target', 'replies must come from the session the request was sent to', 403);
  }
  const isTarget = caller.record.claudeSessionId === request.toSessionId
    || (!!request.toTaskId && caller.record.taskId === request.toTaskId);
  if (!isTarget) {
    throw new SendError('not_request_target',
      `request ${id} was not addressed to this session`, 403);
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
  const destination = await resolveReplyDestination(request.fromSessionId, {
    // Never route the answer back into the session that is answering.
    exclude: [caller.record.claudeSessionId],
  });
  if (!destination) {
    throw new SendError('origin_session_gone',
      `the asking session (${shortId(request.fromSessionId)}) is gone — nothing to deliver to`, 410);
  }
  logReplyReroute(id, request.fromSessionId, destination);
  const origin = destination.session;

  if (request.status !== 'pending') {
    // Late but honest: the asker was already notified (turn end / timeout), yet
    // a real answer beats a status notice — deliver it anyway, marked late.
    log.session.info('session reply after settle — delivering late', { requestId: id, status: request.status });
  } else {
    const settled = await settleReplied(id);
    if (!settled) {
      log.session.info('session reply lost the settle race — delivering late', { requestId: id });
    }
  }

  const wrapped = buildReplyDeliveryText(request, {
    // No title → the handle is just `[8hex]`; never invent a name.
    title: caller.record.title ?? '',
    shortId: shortId(caller.record.claudeSessionId),
    sessionId: caller.record.claudeSessionId,
    taskId: caller.record.taskId,
    host: displayHost(caller.record.host),
  }, text);

  const { delivery, messageId } = await deliverToSession(origin, {
    busText: text, enqueueText: wrapped, source: 'peer',
    taskId: origin.taskId, messageId: input.messageId,
  });

  const originSid = origin.claudeSessionId;
  log.session.info('session reply delivered to asker', {
    requestId: id, fromSessionId: caller.record.claudeSessionId,
    requesterSessionId: request.fromSessionId,
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
    ...(messageId ? { messageId } : {}),
  };
}
