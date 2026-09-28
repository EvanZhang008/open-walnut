/**
 * Fallback notification for expect_reply requests — the "Walnut speaks when
 * the target didn't" half of the reply loop.
 *
 * Two triggers share this one function (and the atomic settle inside it):
 *   - the session-request-watch builtin hook, on the target task's phase edge
 *     (turn end / error / awaiting-human all land NEED_ACTION; a task the
 *     target closed lands COMPLETE) and on the turn end of a closed task;
 *   - the deadline sweeper (sweepSessionRequests), for targets whose edges
 *     never fired at all (edges here are HINTS: phases are flaky by design —
 *     stale-result gating, reconciler flips — the sweeper is the guarantee).
 *
 * settleNotified runs FIRST: the status transition must never wait on
 * delivery embellishment (title lookups, session reads) — and whoever loses
 * the settle race stays silent, so the asker hears exactly one voice.
 *
 * The notice quotes the target's last message (the turn result when the caller
 * has it, else the session's transcript, with the tool calls made after that
 * message), so a child that finished without replying still hands its result
 * over and the asker needs no task_history call.
 */

import { log } from '../../logging/index.js';
import { cutEnd } from '../text-cut.js';
import {
  buildRequestNotification,
  clipNoticeMessage,
  overdueRequests,
  settleNotified,
  type NoticeLastMessage,
  type SessionRequest,
  type SessionRequestOutcome,
} from '../session-requests.js';

/**
 * How long a notice waits on a transcript read before it goes without the quote.
 * Generous on purpose: nothing waits on the notice but the asker, whose other
 * option is the 1h/6h deadline, and a live read measured 5.4s on a loaded Mac
 * (2026-09-28), where a 3s budget sent the notice with no quote at all.
 */
export const LAST_MESSAGE_READ_MS = 10_000;
/** At most this many tool calls are listed after the last message (the newest ones). */
const NOTICE_MAX_ACTIONS = 8;
/** The CLI's own marker after an interrupt: a user row, but not a new turn. */
const INTERRUPT_MARKER = /^\[Request interrupted/;

type TranscriptRow = { role: string; text: string; kind?: string; detail?: string };

/** One tool call as a notice lists it; the row's own one-line summary, bounded. */
const ACTION_LINE_MAX = 200;

/**
 * What the target last said and did, from its transcript rows. Its last turn
 * (the rows after the last real user message) speaks first: that turn's last
 * text, plus the tool calls it made AFTER that text, because a turn that opens
 * with "let me look at the folder" and then writes the files has its result in
 * the calls, not the words. The common silent ending is a child that writes its
 * files and closes its own task, which ends the turn on the spot (completing a
 * task completes its session). A turn with neither falls back to the last text
 * of an earlier turn.
 */
export function lastWordsOf(messages: ReadonlyArray<TranscriptRow> | undefined): NoticeLastMessage | undefined {
  if (!messages?.length) return undefined;
  const said = (m: TranscriptRow) => m.role === 'assistant' && !m.kind && m.text.trim();
  let start = messages.length;
  while (start > 0) {
    const m = messages[start - 1];
    if (m.role === 'user' && !INTERRUPT_MARKER.test(m.text.trim())) break;
    start--;
  }
  const turn = messages.slice(start);
  let lastSaid = turn.length - 1;
  while (lastSaid >= 0 && !said(turn[lastSaid])) lastSaid--;
  const actions = turn.slice(lastSaid + 1).filter((m) => m.kind === 'tool' && m.text.trim()).slice(-NOTICE_MAX_ACTIONS)
    .map((m) => {
      const line = m.detail?.trim() ? `${m.text.trim()}: ${m.detail.trim()}` : m.text.trim();
      return line.length > ACTION_LINE_MAX ? `${line.slice(0, cutEnd(line, ACTION_LINE_MAX - 1))}…` : line;
    });
  if (lastSaid >= 0) {
    const words = clipNoticeMessage(turn[lastSaid].text)!;
    return actions.length ? { ...words, actions } : words;
  }
  if (actions.length) return { text: '', actions };
  const earlier = messages.slice(0, start).reverse().find(said);
  return earlier ? clipNoticeMessage(earlier.text) : undefined;
}

export interface FallbackContext {
  /** The target task's phase at the edge ('COMPLETE' changes the wording). */
  phase?: string;
  /** The target's final text for the turn that just ended, when the caller has it. */
  lastMessage?: string;
}

/**
 * The target's last words (lastWordsOf), read from its transcript. A live build
 * first (the turn that just ended is already in the JSONL), bounded, because a
 * remote host can be slow or gone; then the cached projection. Never throws.
 */
export async function readLastWords(sessionId: string | undefined): Promise<NoticeLastMessage | undefined> {
  if (!sessionId) return undefined;
  const projection = await import('../session-projection.js');
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const live = await Promise.race([
      projection.buildSessionTranscript(sessionId),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), LAST_MESSAGE_READ_MS); timer.unref?.(); }),
    ]).finally(() => clearTimeout(timer));
    const found = lastWordsOf(live?.messages);
    if (found) return found;
  } catch { /* fall through to the cache */ }
  try {
    return lastWordsOf((await projection.readSessionTranscript(sessionId))?.messages);
  } catch {
    return undefined;
  }
}

export async function notifyRequesterFallback(
  request: SessionRequest,
  outcome: SessionRequestOutcome,
  context: FallbackContext = {},
): Promise<boolean> {
  const settled = await settleNotified(request.id, outcome);
  if (!settled) return false; // replied / already notified — someone else spoke

  try {
    // Same address resolution the real reply uses (reply-routing.ts): a notice
    // filed in a session the human stopped reading is as lost as a reply. An
    // asker that is still live resolves to itself — unchanged.
    const { resolveReplyDestination, logReplyReroute } = await import('./reply-routing.js');
    const destination = await resolveReplyDestination(request.fromSessionId);
    if (!destination) {
      log.session.info('request fallback: asker session gone — notification skipped', {
        requestId: request.id, fromSessionId: request.fromSessionId, outcome,
      });
      return false;
    }
    logReplyReroute(request.id, request.fromSessionId, destination);
    const origin = destination.session;

    // Target naming is embellishment — a failed lookup must not lose the notice.
    let targetTitle: string | undefined;
    let targetPhase = context.phase;
    let targetSessionId = request.toSessionId;
    if (request.toTaskId) {
      try {
        const { listTasksByIds } = await import('../task-manager.js');
        const task = (await listTasksByIds([request.toTaskId]))[0];
        targetTitle = task?.title;
        targetPhase ??= task?.phase;
        targetSessionId ??= task?.session_id ?? undefined;
      } catch { /* title stays generic */ }
    }
    // So is the quote: the turn's own result when the edge carried it, else the transcript.
    const lastMessage = (context.lastMessage ? clipNoticeMessage(context.lastMessage) : undefined)
      ?? await readLastWords(targetSessionId);

    const text = buildRequestNotification(settled, outcome, {
      title: targetTitle,
      sessionId: request.toSessionId,
      taskId: request.toTaskId,
      phase: targetPhase,
      lastMessage,
    });

    const { deliverToSession } = await import('./session-send-core.js');
    const { delivery } = await deliverToSession(origin, {
      busText: text, enqueueText: text, source: 'walnut-notify', taskId: origin.taskId,
    });
    log.session.info('request fallback notification delivered', {
      requestId: request.id, fromSessionId: request.fromSessionId,
      toSessionId: origin.claudeSessionId, outcome, delivery,
      phase: targetPhase, quoted: lastMessage ? lastMessage.text.length : 0, clipped: lastMessage?.clipped ?? false,
      actions: lastMessage?.actions?.length ?? 0,
    });
    return true;
  } catch (err) {
    // The row is already settled — a delivery failure must not un-settle it
    // (that would re-arm every edge); log loudly instead.
    log.session.error('request fallback notification failed after settle', {
      requestId: request.id, outcome, error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** One sweeper tick: notify every pending request past its deadline. */
let sweeping: Promise<number> | undefined;

/**
 * One sweep at a time: each overdue notice may wait up to LAST_MESSAGE_READ_MS on
 * a transcript, so a backlog can outlast the 60s interval. A tick that lands
 * during a sweep joins it instead of scanning the same rows again.
 */
export function sweepSessionRequests(): Promise<number> {
  sweeping ??= (async () => {
    try {
      const overdue = await overdueRequests();
      let notified = 0;
      for (const request of overdue) {
        if (await notifyRequesterFallback(request, 'timeout')) notified++;
      }
      return notified;
    } finally {
      sweeping = undefined;
    }
  })();
  return sweeping;
}
