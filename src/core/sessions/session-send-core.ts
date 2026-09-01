/**
 * session_send core — THE one way anything sends a message to a session.
 *
 * One entry point (`performSessionSend`) absorbs what used to be three
 * surfaces: the old `session_send` op (plain enqueue by session id), the
 * `walnut peers send` gateway capability (fenced session→session notes), and
 * the resume half of `task_start` (send by TASK id into its live session).
 * The differences between them were never different message kinds — they were
 * delivery-layer properties (who is speaking → fence or not; how the target
 * was named → id vs task vs title), so they live here as properties, keyed on
 * the caller identity the transport already stamps (x-walnut-caller-sid).
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
  /** Register a pending request; the target is told how to reply. Session callers only. */
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
   *  sender's fence honestly (a session caller's host comes from its record). */
  callerHost?: string;
}

export interface SessionSendResult {
  /** queued = dispatched; deferred = enqueued but target awaits a permission prompt. */
  delivery: 'queued' | 'deferred';
  targetSessionId: string;
  targetTitle: string | null;
  targetTaskId?: string;
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

/**
 * Resolve `to` → one target session.
 * ① exact session id → ② task id/unique prefix (its attached session) →
 * ③ unique session-id prefix (>=4) → ④ unique case-insensitive title substring.
 * A `to` that matches BOTH a task and a session at the same stage is ambiguous.
 */
export async function resolveSendTarget(to: string): Promise<ResolvedTarget> {
  const candidates = await sendCandidates();

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

/** Caller classes the fence decision keys on. */
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

  // Fence + throttle apply exactly when the SPEAKER is not the human: another
  // session (named fence) or an unidentified process (anonymous fence).
  const fenced = caller.kind !== 'human';
  let enqueueText = text;
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
    enqueueText = buildPeerWrapper(text, caller.kind === 'session'
      ? {
        title: caller.record.title ?? 'untitled session',
        shortId: shortId(caller.record.claudeSessionId),
        host: displayHost(caller.record.host),
      }
      : {
        title: 'external',
        shortId: 'external',
        // No transport host = genuinely unknown; never guess 'local' for an
        // anonymous sender the way displayHost() does for tracked sessions.
        host: input.callerHost?.trim()
          ? displayHost(input.callerHost.trim().slice(0, 64))
          : 'unknown',
        anonymous: true,
      });
  }

  // expect_reply: register the pending row BEFORE delivery so the trailer can
  // name a request id that already exists.
  let request: SessionRequest | undefined;
  if (input.expectReply) {
    if (caller.kind !== 'session') {
      throw new SendError('bad_request',
        'expect_reply needs a session caller — a reply can only be routed back to a tracked session');
    }
    request = await createSessionRequest({
      fromSessionId: caller.record.claudeSessionId,
      toSessionId: targetSid,
      toTaskId: target.taskId ?? target.session.taskId,
      text,
      replyTimeoutSecs: input.replyTimeoutSecs,
    });
    enqueueText = `${enqueueText}\n${buildReplyTrailer(request)}`;
  }

  const source = caller.kind === 'human' ? 'cli' : 'peer';
  const taskId = target.taskId ?? target.session.taskId;
  let delivery: 'queued' | 'deferred';
  let messageId: string | undefined;
  try {
    ({ delivery, messageId } = await deliverToSession(target.session, {
      busText: text, enqueueText, source, taskId, messageId: input.messageId,
    }));
  } catch (err) {
    // The message never landed. A request row we just created would otherwise
    // sit pending until its deadline, then the sweeper would tell the asker
    // "no reply by your deadline" about a send that never happened — so drop it.
    if (request) await deletePendingRequest(request.id);
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
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const origin = await getSessionByClaudeId(request.fromSessionId);
  if (!origin || origin.archived) {
    throw new SendError('origin_session_gone',
      `the asking session (${shortId(request.fromSessionId)}) is gone — nothing to deliver to`, 410);
  }

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
    title: caller.record.title ?? 'untitled session',
    shortId: shortId(caller.record.claudeSessionId),
    host: displayHost(caller.record.host),
  }, text);

  const { delivery, messageId } = await deliverToSession(origin, {
    busText: text, enqueueText: wrapped, source: 'peer',
    taskId: origin.taskId, messageId: input.messageId,
  });

  log.session.info('session reply delivered to asker', {
    requestId: id, fromSessionId: caller.record.claudeSessionId,
    toSessionId: request.fromSessionId, delivery, messageId,
  });
  return {
    delivery,
    targetSessionId: request.fromSessionId,
    targetTitle: origin.title ?? null,
    ...(origin.taskId ? { targetTaskId: origin.taskId } : {}),
    repliedTo: id,
    ...(messageId ? { messageId } : {}),
  };
}
