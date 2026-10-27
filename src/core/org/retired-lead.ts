/**
 * A lead whose project the user put under another VP is on its way out: handover-close.ts closes
 * it after the turn that hands over. Two things kept such a lead at work anyway (2026-10-26: Main
 * sent the user's go to delete six stacks to the old lead 85 minutes after it had handed over, and
 * both leads then followed the same deletions, each counted as needing the user): a message its
 * host delivered while this Mac was away, which reopened it when the host's journal came back, and
 * a send to it by its old task id. So:
 *  - a session's send or start for it is refused with a pointer to the lead that took over
 *    (session-send-core.ts, task-start.ts; a host answering while the server is away says the
 *    same, offline-host-core.ts), and a session's org_send by its id reaches that lead
 *    (org-store.ts);
 *  - a message its host delivered while the server was away leaves it complete when the journal
 *    comes back, and its session hears the note below (offline-handover.ts);
 *  - every message that still reaches it (the user's, a reply, a forced send) carries a note
 *    saying it no longer leads the project: pass the ask on, finish, and complete its own task.
 *    The lead does that itself; Walnut never closes a session that may be mid-work.
 */
import type { Task } from '../types.js';
import { createEnvelopeKit } from '../peers/envelope-kit.js';
import { successorOf } from './org-tree.js';

const kit = createEnvelopeKit();
const HANDED_OVER = 'handed-over';

export interface RetiredLead { lead: Task; successor: Task }

/** `taskId` is a lead that handed its project over: it, and the lead that leads it now. */
export async function retiredLead(taskId: string | undefined): Promise<RetiredLead | undefined> {
  if (!taskId) return undefined;
  const tm = await import('../task-manager.js');
  const lead = await Promise.resolve().then(() => tm.getTask(taskId)).catch(() => undefined);
  // Only a lead pays for the whole list.
  if (lead?.org_role !== 'lead') return undefined;
  const successor = successorOf(await tm.listTasks(), lead);
  return successor ? { lead, successor } : undefined;
}

/** What a sender is told about a lead that handed over: where to send instead. */
export function retiredLeadPointer({ lead, successor }: RetiredLead): string {
  return kit.handedOverPointer(
    { id: lead.id, title: lead.title, project: (lead.project ?? '').trim() },
    { id: successor.id, title: successor.title, phase: successor.phase },
  );
}

/**
 * A new message or start for `targetTaskId` from a session whose task is `callerTaskId`: refused
 * with the pointer when the target is a lead that handed its project over, unless the caller is
 * the lead that took it. Null = it may go.
 */
export async function retiredLeadRefusal(
  callerTaskId: string | undefined,
  targetTaskId: string | undefined,
): Promise<{ retired: RetiredLead; message: string; detail: Record<string, string> } | null> {
  const retired = await retiredLead(targetTaskId);
  if (!retired || callerTaskId === retired.successor.id) return null;
  return {
    retired,
    message: retiredLeadPointer(retired),
    detail: { taskId: retired.lead.id, currentLeadTaskId: retired.successor.id, project: (retired.lead.project ?? '').trim() },
  };
}

/** The note a message into a lead that handed over carries, ahead of the message. */
export function retiredLeadNote({ lead, successor }: RetiredLead): string {
  const project = (lead.project ?? '').trim();
  return [
    `You no longer lead ${project}: the user put it under "${successor.title}" (${successor.id}), which leads it now.`,
    `Do not start work for ${project} here. If this message asks for any, pass it to ${successor.id} with task_send,`,
    'saying what you already did about it, so it is done once.',
    'Then finish what you had started, and complete your own task (task_complete) if it is still open: you are not a',
    'lead any more, so the rule that a lead never completes its own task no longer applies to you.',
  ].join(' ');
}

/** The note as a Walnut notification. */
export function retiredLeadNotice(retired: RetiredLead, lead = ''): string {
  return kit.buildWalnutMessage({
    kind: 'notification',
    attrs: { from: 'Walnut', outcome: HANDED_OVER, note: 'automated Walnut status notice' },
    body: lead ? `${lead}\n${retiredLeadNote(retired)}` : retiredLeadNote(retired),
  });
}

/** The note for a message into `sessionId`, when its task is a lead that handed over and `body`
 *  does not carry it already; else null. */
export async function pendingRetiredLeadNote(sessionId: string, body: string): Promise<string | null> {
  if (body.includes(`outcome="${HANDED_OVER}"`)) return null;
  // The handover notice and its turn: Walnut closes the lead after it (handover-close.ts), and a
  // give-back in between must leave it open, so it is never asked to close itself then.
  if (body.includes('outcome="handover"')) return null;
  try {
    const { hasPendingHandover } = await import('./handover-close.js');
    if (hasPendingHandover(sessionId)) return null;
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const record = await getSessionByClaudeId(sessionId);
    const retired = await retiredLead(record?.taskId);
    if (!retired) return null;
    // One note says it: a row still queued with it is read first.
    const { getQueue } = await import('../session-message-queue.js');
    if ((await getQueue(sessionId)).some((m) => m.message.includes(`outcome="${HANDED_OVER}"`))) return null;
    return retiredLeadNotice(retired);
  } catch {
    return null;
  }
}
