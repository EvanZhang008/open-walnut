/**
 * A reply to a request that carries another one goes to the asker of that other one.
 *
 * Main asks a lead (rq-A); the lead hands the work to a worker with `hands_on: rq-A`, so its own
 * ask (rq-B) carries rq-A (session-requests.ts linkHandoffs). The worker answers rq-B, and that
 * answer used to reach the lead only: the lead then relayed it to Main by hand, rebuilt it from a
 * file when the reply had scrolled out of its context, or forgot (2026-10-30 org review: five
 * relays in one evening). Now the answer goes straight to Main as the answer to rq-A, both
 * requests settle, and the lead hears one line saying where it went.
 *
 * It goes past the lead only when that is plainly what the lead meant: the request it answers
 * carries exactly one open request (pending or overdue), and that request has no other carrier
 * (two workers each doing half of it, one answered already or not, means the lead combines).
 * A task answering the carried request itself settles the ask that handed it on the same way
 * (`directCarriers`). A worker whose lead's task is complete is refused before any of this
 * (refuseSendToCompleteParent), so nothing goes up past a closed lead. The same
 * holds up a chain (Main to a lead to a worker to a helper), at most MAX_CHAIN steps. When the
 * outermost asker is gone, or its task is complete, nothing goes past: the lead gets the answer
 * as before.
 */
import type { SessionRequest } from '../session-requests.js';
import type { ReplyDestination } from './reply-routing.js';

/** The longest chain followed: a task's subtasks sit at most 3 levels deep. */
export const MAX_CHAIN = 4;

const open = (r: SessionRequest | undefined): r is SessionRequest => !!r && (r.status === 'pending' || r.status === 'expired');

/**
 * The requests an answer to `answered` also answers, nearest first, outermost last; empty when
 * it answers only itself. Pure.
 */
export function answerChain(answered: SessionRequest, rows: readonly SessionRequest[]): SessionRequest[] {
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const out: SessionRequest[] = [];
  let cur = answered;
  for (let i = 0; i < MAX_CHAIN; i++) {
    const carried = (cur.carries ?? []).map((id) => byId.get(id)).filter(open);
    if (carried.length !== 1) break;
    const up = carried[0]!;
    if (out.some((r) => r.id === up.id) || up.id === answered.id) break;
    // Another ask carries it too, open or answered: each answer is a part, and the asker in between combines them.
    if ((up.carriedBy ?? []).some((c) => c.id !== cur.id && !!byId.get(c.id) && byId.get(c.id)!.status !== 'withdrawn')) break;
    out.push(up);
    cur = up;
  }
  return out;
}

export interface OnwardAnswer {
  /** The requests this answer also settles, outermost last. */
  chain: SessionRequest[];
  /** The outermost one: its asker gets the answer. */
  final: SessionRequest;
  /** Where that asker reads it now (reply-routing.ts). */
  destination: ReplyDestination;
}

/** Where an answer to `answered` goes past its own asker, or null to deliver as before. Never throws. */
export async function onwardAnswer(answered: SessionRequest, replierSessionId: string): Promise<OnwardAnswer | null> {
  try {
    if (!open(answered) || !answered.carries?.length) return null;
    const { listAllSessionRequests } = await import('../session-requests.js');
    const chain = answerChain(answered, await listAllSessionRequests());
    const final = chain[chain.length - 1];
    if (!final) return null;
    const { resolveReplyDestination } = await import('./reply-routing.js');
    const dest = await resolveReplyDestination(final.fromSessionId, { exclude: [replierSessionId] });
    if (!dest) return null;
    if (dest.session.taskId) {
      const { listTasksByIds } = await import('../task-manager.js');
      const [task] = await listTasksByIds([dest.session.taskId]);
      if (!task || task.phase === 'COMPLETE') return null;
    }
    return { chain, final, destination: dest };
  } catch {
    return null;
  }
}

/**
 * The open asks of `callerTaskId` that carry `answered`, when that task answers it directly
 * (session-send-core.ts isTarget lets it): each one is settled by that answer. Pure.
 */
export function directCarriers(answered: SessionRequest, callerTaskId: string | undefined, rows: readonly SessionRequest[]): SessionRequest[] {
  if (!callerTaskId) return [];
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  return (answered.carriedBy ?? [])
    .filter((c) => c.taskId === callerTaskId)
    .map((c) => byId.get(c.id))
    .filter((r): r is SessionRequest => open(r) && r.toTaskId === callerTaskId);
}

/** The one line an asker the answer went past reads. */
export function wentPastLine(opts: {
  replier: { title?: string | null; taskId?: string | null };
  /** The asker's own request, the one that carried `final`. */
  yours: string;
  final: SessionRequest;
  finalAsker: { title?: string | null; taskId?: string | null };
}): string {
  const who = opts.replier.title ? `"${opts.replier.title}"${opts.replier.taskId ? ` (${opts.replier.taskId})` : ''}` : (opts.replier.taskId ?? 'The task you asked');
  const to = opts.finalAsker.title ? `"${opts.finalAsker.title}"` : 'the original asker';
  const read = opts.replier.taskId ? `; task_history ${opts.replier.taskId} shows it` : '';
  return `${who} answered your ${opts.yours}, which carried ${opts.final.id}: Walnut gave the answer straight to ${to} as the answer to ${opts.final.id}, and both are settled. Nothing to relay${read}.`;
}
