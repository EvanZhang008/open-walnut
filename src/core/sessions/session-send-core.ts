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
  type SessionRequest,
} from '../session-requests.js';
import { queueSentBy } from './send-sent-by.js';
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
      | 'parent_complete' | 'target_complete' | 'lead_handed_over',
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
  reply?: { result?: unknown; evidence?: unknown; not_done?: unknown };
  /** Transport-stamped caller session id; undefined = the human's own CLI. */
  callerSid?: string;
  /** Transport-stamped host the calling CLI runs on — labels an ANONYMOUS
   *  sender's envelope honestly (a session caller's host comes from its record). */
  callerHost?: string;
  /** An anonymous caller that named itself: a script or scheduled job (the CLI's `x-walnut-sender`). */
  callerLabel?: string;
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
  /** The requests this ask handed on (`hands_on`), and the ones it could not, with why. */
  handedOn?: string[];
  handOnRefused?: { id: string; reason: string }[];
  /** Present on an in_reply_to send. */
  repliedTo?: string;
  /** The requests the answered one carried, answered by it too: the answer went to the outermost one's asker. */
  answeredFor?: string[];
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
  opts: { busText: string; enqueueText: string; source: string; taskId?: string; messageId?: string; fromLeader?: boolean; endsWait?: boolean },
): Promise<{ delivery: 'queued' | 'deferred'; messageId?: string }> {
  const sid = target.claudeSessionId;
  const leaderAnswersQuestion = opts.fromLeader === true && target.pendingPermission?.toolName === 'AskUserQuestion';
  if (target.pendingPermission && !leaderAnswersQuestion) {
    const { enqueueMessage } = await import('../session-message-queue.js');
    const { escapeHintTags } = await import('../hints/hint-format.js');
    const sentBy = queueSentBy(opts.source);
    const parked = await withTimeout(
      // Escaped like every queued send (hints/hint-format.ts); no hint rides a parked row.
      enqueueMessage(sid, escapeHintTags(opts.enqueueText), { ...(opts.messageId ? { id: opts.messageId } : {}), ...(sentBy ? { sentBy } : {}) }),
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
export async function noteResultReport(
  taskId: string,
  head: Omit<import('../peers/structured-reply.js').TaskResultReport, 'at' | 'result' | 'evidence' | 'not_done' | 'settled'>,
  fields: import('../peers/structured-reply.js').StructuredReply | null,
  opts: { emit?: boolean } = {},
): Promise<import('../peers/structured-reply.js').TaskResultReport | undefined> {
  try {
    const { updateTaskRaw } = await import('../task-manager.js');
    const report = { ...head, at: new Date().toISOString(), ...(fields ?? {}) };
    const { isPartial } = await import('../peers/structured-reply.js');
    // One read-modify-write under the row lock: a settle racing this write is never lost to it.
    const { task, changed } = await updateTaskRaw(taskId, (cur) => {
      const was = cur.result_report;
      // A plain reply carries no result: it only ends a Partial it answers itself (the same
      // request), and never erases a result written before (a completion's, another reply's).
      if (!fields && head.via === 'reply' && !(isPartial(was) && was?.request_id === head.request_id)) return null;
      return { result_report: report };
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
  if (!own?.parent_task_id || !targetTaskId.startsWith(own.parent_task_id)) return;
  const target = await getTask(targetTaskId).catch(() => undefined);
  if (!target || !target.id.startsWith(own.parent_task_id) || target.phase !== 'COMPLETE') return;
  throw new SendError('parent_complete',
    `"${target.title}" (${target.id}) is your task's parent and it is complete: it no longer takes messages `
    + 'from its subtasks. Keep your result in your own task, where the user reads it; if that task should hear '
    + 'from you again, the user reopens it.', 409, { parentTaskId: target.id });
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
  return !!task?.parent_task_id && caller.record.taskId.startsWith(task.parent_task_id);
}

/** The one send entry point (route + gateway both land here). */
export async function performSessionSend(input: SessionSendInput): Promise<SessionSendResult> {
  const { readStructuredReply, composeReplyText } = await import('../peers/structured-reply.js');
  const fields = input.reply ? readStructuredReply(input.reply) : null;
  if (fields && !input.inReplyTo) {
    throw new SendError('bad_request', 'result, evidence and not_done answer a request: pass in_reply_to (rq-…)');
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

  if (target.session.archived) {
    throw new SendError('target_archived', `session ${shortId(targetSid)} is archived`, 409);
  }
  if (caller.kind === 'session' && caller.record.claudeSessionId === targetSid) {
    throw new SendError('self_send', 'target resolves to the calling session itself');
  }
  await refuseSendToCompleteParent(caller, target.taskId ?? target.session.taskId);
  const admitted = await admitRetiredLead(caller, target.taskId ?? target.session.taskId, input, text);
  const body = await admitCompleteTarget(caller, target.taskId ?? target.session.taskId, input, admitted, 'send');

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
  let request: (SessionRequest & { handOnRefused?: { id: string; reason: string }[] }) | undefined;
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
        ...(input.handsOn ? { handsOn: [input.handsOn] } : {}),
      });
    }
  }
  // Until its message is queued, no edge of the target speaks for this request.
  const delivered = request ? noteRequestDelivering(request.id) : undefined;

  let enqueueText = body;
  if (fenced) {
    enqueueText = buildPeerWrapper(body, caller.kind === 'session'
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
        ...(input.callerLabel ? { automation: input.callerLabel } : {}),
      }, { title: input.title });
  }
  // One `\n`, one line, and only when a request exists to answer.
  if (request) enqueueText = `${enqueueText}\n${buildReplyTrailer(request)}`;

  const source = caller.kind === 'human' ? 'cli' : 'peer';
  const taskId = target.taskId ?? target.session.taskId;
  let delivery: 'queued' | 'deferred';
  let messageId: string | undefined;
  try {
    const fromLeader = await callerLeads(caller, taskId);
    ({ delivery, messageId } = await deliverToSession(target.session, {
      busText: body, enqueueText, source, taskId, messageId: input.messageId, fromLeader,
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
): Promise<SessionSendResult> {
  const id = String(input.inReplyTo);
  const request = await getSessionRequest(id);
  if (!request) throw new SendError('unknown_request', `no such request: ${id}`, 404);

  if (caller.kind !== 'session') {
    throw new SendError('not_request_target', 'replies must come from the session the request was sent to', 403);
  }
  // The task it was handed on to (request-handoff.ts) answers it as well as its target.
  const isTarget = caller.record.claudeSessionId === request.toSessionId
    || (!!request.toTaskId && caller.record.taskId === request.toTaskId)
    || (!!caller.record.taskId && (request.carriedBy ?? []).some((c) => c.taskId === caller.record.taskId));
  if (!isTarget) {
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
  // Before the settle: a refused answer leaves the request open for a forced retry.
  const replyBody = await admitCompleteTarget(caller, origin.taskId, input, text, 'reply');

  // Settles one request with this answer, pending or overdue; `fwd` marks one whose asker the answer went past.
  const settleOpen = async (rid: string, fwd?: string) =>
    (await settleReplied(rid, fields, fwd).catch(() => null)) ?? await settleLateReply(rid, fields, fwd).catch(() => null);
  if (onward) {
    // Settled once the answer is delivered: a failed delivery leaves the whole chain open.
  } else if (request.status !== 'pending') {
    // Late but honest: the asker was already notified (turn end / timeout), yet
    // a real answer beats a status notice — deliver it anyway, marked late.
    log.session.info('session reply after settle — delivering late', { requestId: id, status: request.status });
    // An overdue request was still open: this answer closes it.
    if (request.status === 'expired') await settleLateReply(id, fields).catch(() => null);
  } else {
    const settled = await settleReplied(id, fields);
    if (!settled) {
      log.session.info('session reply lost the settle race — delivering late', { requestId: id });
    }
  }
  const answeredFor = onward?.final ?? request;
  // The replier's latest result, kept on its task: the Board and the Brief read Partial from it.
  if (caller.record.taskId) {
    await noteResultReport(caller.record.taskId, {
      via: 'reply', request_id: answeredFor.id, ...(origin.taskId ? { to_task_id: origin.taskId } : {}), by: `task:${caller.record.taskId}`,
    }, fields);
  }

  const wrapped = buildReplyDeliveryText(answeredFor, {
    // No title → the handle is just `[8hex]`; never invent a name.
    title: caller.record.title ?? '',
    shortId: shortId(caller.record.claudeSessionId),
    sessionId: caller.record.claudeSessionId,
    taskId: caller.record.taskId,
    host: displayHost(caller.record.host),
  }, replyBody, { title: input.title });

  const { delivery, messageId } = await deliverToSession(origin, {
    busText: replyBody, enqueueText: wrapped, source: 'peer', endsWait: true,
    taskId: origin.taskId, messageId: input.messageId,
    fromLeader: await callerLeads(caller, origin.taskId),
  });

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
        replier: { title: caller.record.title ?? null, taskId: caller.record.taskId ?? null },
        yours: r.id,
        final: answeredFor,
        finalAsker: { title: origin.title ?? null, taskId: origin.taskId ?? null },
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
    ...(messageId ? { messageId } : {}),
  };
}
