/**
 * A title that gains a second topic is never renamed silently. When a session's self-report
 * appends a topic (`Head · Topic`, session-hooks/builtins.ts applyTitleDirective), Walnut tells
 * the task and the task that last handed it work, each in one quiet note (no turn starts): the
 * new topic may be a second deliverable that belongs in a task of its own.
 *
 * Why (2026-11-16): two leads put a second deliverable into an open task (an outage fix into a
 * code review's task; a website launch into a logo redesign's task), and the task's
 * own report then appended it to the title ("· <outage> Poller Fix", "· Website Launch"). The
 * rename hid the misroute instead of showing it; nobody was told.
 */
import { log } from '../../logging/index.js';
import { deliverableLine } from '../task-deliverable.js';

/** How far back a message counts as the one that handed the task its new topic. */
export const TOPIC_SENDER_WINDOW_MS = 6 * 60 * 60 * 1000;
export const TITLE_TOPIC_SOURCE = 'title-topic';

export interface TitleTopicChange { taskId: string; from: string; to: string; topic: string }

/** The two notes' words (English: the models read them). Exported for tests. */
export function titleTopicNotes(change: TitleTopicChange, deliverable: string, sender?: { id: string; title: string }): { task: string; sender?: string } {
  const was = `"${change.to}" (was "${change.from}")`;
  const own = deliverable ? ` Your deliverable: "${deliverable}".` : '';
  const who = sender ? `"${sender.title}" (${sender.id}), which last sent you work,` : 'whoever handed it to you';
  return {
    task: `Walnut added the topic "${change.topic}" to your title: ${was}.${own} If "${change.topic}" is not part of that `
      + `deliverable, it is a second deliverable: tell ${who} that it belongs in a task of its own, and set your title back.`,
    ...(sender ? {
      sender: `Walnut added the topic "${change.topic}" to the title of "${change.from}" (${change.taskId}) after your message: `
        + `it now reads "${change.to}".${deliverable ? ` Its deliverable: "${deliverable}".` : ''} If you gave it a different `
        + 'deliverable, task_create that work and tell the task to drop it; if it is the same deliverable, nothing to do.',
    } : {}),
  };
}

/** Tell the task and its latest sender. Never throws. */
export async function noticeTitleTopic(change: TitleTopicChange, nowMs = Date.now()): Promise<void> {
  try {
    const { getTask } = await import('../task-manager.js');
    const task = await getTask(change.taskId).catch(() => undefined);
    if (!task) return;
    const { latestSenderTo } = await import('../org/lead-traffic.js');
    const senderId = latestSenderTo(task.id, TOPIC_SENDER_WINDOW_MS, nowMs);
    const senderTask = senderId ? await getTask(senderId).catch(() => undefined) : undefined;
    const sender = senderTask && senderTask.phase !== 'COMPLETE' ? { id: senderTask.id, title: senderTask.title } : undefined;
    const notes = titleTopicNotes(change, deliverableLine(task), sender);
    const { performSessionSend } = await import('./session-send-core.js');
    const send = async (to: string, text: string) => {
      try {
        await performSessionSend({ to, text, wake: false, source: TITLE_TOPIC_SOURCE });
      } catch (err) {
        log.session.info('title topic note not delivered', { to, error: err instanceof Error ? err.message : String(err) });
      }
    };
    await send(task.id, notes.task);
    if (sender && notes.sender) await send(sender.id, notes.sender);
    log.session.info('title topic told', { taskId: task.id, topic: change.topic, senderTaskId: sender?.id ?? null });
  } catch (err) {
    log.session.warn('title topic note failed', { taskId: change.taskId, error: err instanceof Error ? err.message : String(err) });
  }
}
