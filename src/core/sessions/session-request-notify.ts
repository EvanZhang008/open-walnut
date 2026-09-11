/**
 * Fallback notification for expect_reply requests — the "Walnut speaks when
 * the target didn't" half of the reply loop.
 *
 * Two triggers share this one function (and the atomic settle inside it):
 *   - the session-request-watch builtin hook, on the target task's phase edge
 *     (turn end / error / awaiting-human — all land AGENT_COMPLETE);
 *   - the deadline sweeper (sweepSessionRequests), for targets whose edges
 *     never fired at all (edges here are HINTS: phases are flaky by design —
 *     stale-result gating, reconciler flips — the sweeper is the guarantee).
 *
 * settleNotified runs FIRST: the status transition must never wait on
 * delivery embellishment (title lookups, session reads) — and whoever loses
 * the settle race stays silent, so the asker hears exactly one voice.
 */

import { log } from '../../logging/index.js';
import {
  buildRequestNotification,
  overdueRequests,
  settleNotified,
  type SessionRequest,
  type SessionRequestOutcome,
} from '../session-requests.js';

export async function notifyRequesterFallback(
  request: SessionRequest,
  outcome: SessionRequestOutcome,
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
    if (request.toTaskId) {
      try {
        const { listTasksByIds } = await import('../task-manager.js');
        targetTitle = (await listTasksByIds([request.toTaskId]))[0]?.title;
      } catch { /* title stays generic */ }
    }

    const text = buildRequestNotification(settled, outcome, {
      title: targetTitle,
      sessionId: request.toSessionId,
      taskId: request.toTaskId,
    });

    const { deliverToSession } = await import('./session-send-core.js');
    const { delivery } = await deliverToSession(origin, {
      busText: text, enqueueText: text, source: 'walnut-notify', taskId: origin.taskId,
    });
    log.session.info('request fallback notification delivered', {
      requestId: request.id, fromSessionId: request.fromSessionId,
      toSessionId: origin.claudeSessionId, outcome, delivery,
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
export async function sweepSessionRequests(): Promise<number> {
  const overdue = await overdueRequests();
  let notified = 0;
  for (const request of overdue) {
    if (await notifyRequesterFallback(request, 'timeout')) notified++;
  }
  return notified;
}
