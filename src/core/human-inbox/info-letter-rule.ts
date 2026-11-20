/**
 * An `info` letter enters the inbox only when it is a report the user asked for (2026-11-20, the
 * user, on a plugin letter "Slack: 1 new (0 mentions, 1 DM)" marked info: "why send me this").
 * The inbox holds what needs him: a decision, a review, or a report he asked for. A new-message
 * count, a digest nobody set up, a forwarded reminder or an FYI is not a letter.
 *
 * The rule is one check at the store's choke point (store.ts sendLetterOnce refuses an info letter
 * without the mark, 409 `info_not_inbox`), so no path goes around it. The mark is the sender's
 * `userAsked` / `user_asked` (types.ts NewLetter), never stored. Before the store, each kind of
 * sender meets it in the words it can act on:
 *  - a session (human_inbox_send, the relay, a host's journal): refused with what to do instead
 *    (letter-ops.ts), after a task that keeps Threads filed the update to its thread;
 *  - a script or tool with no session (`sender.via === 'api'`) and a plugin's letter with no
 *    buttons (plugins/server-api.ts): a notice in the notification center instead, and the call
 *    still succeeds, since neither reads prose;
 *  - Walnut's own info letters: each kind says which it is (walnut-letters/kind.ts `info`).
 */
import { createHash } from 'node:crypto';
import { bus, EventNames } from '../event-bus.js';
import { log } from '../../logging/index.js';
import { derivePreview, truncatePreview } from './preview.js';
import type { LetterType } from './types.js';

export const INFO_NOT_INBOX = 'info_not_inbox' as const;

/** What a session reads when its info letter is refused (409 info_not_inbox). */
export const INFO_NOT_INBOX_MESSAGE = 'Not sent: an info letter is only for a report the user asked for. '
  + 'The inbox holds what needs him (a decision, a review, or a report he asked for), never progress, a finished step or an FYI. '
  + 'Put this in your task\'s thread or note instead (thread_update, task_note_write), or say it in your chat reply. '
  + 'Only when the user himself asked for this report (a digest or report he set up, "tell me when X"), send it again with user_asked:true.';

/** Whether this letter may enter the inbox under the info rule: any type but info, or info the user asked for. */
export function passesInfoRule(input: { type?: LetterType | string; userAsked?: boolean; user_asked?: boolean }): boolean {
  return input.type !== 'info' || input.userAsked === true || input.user_asked === true;
}

/**
 * The part of a notice's key that names one subject: digits folded, so "Slack: 1 new" and "Slack: 3
 * new" are one notice that each new count replaces, instead of a pile of them.
 */
export function noticeSubjectKey(subject: string): string {
  const folded = subject.trim().toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');
  return createHash('sha1').update(folded).digest('hex').slice(0, 12);
}

export interface InfoLetterContent {
  subject: string;
  text?: string;
  markdown?: string;
  html?: string;
  taskRefs?: readonly string[];
}

/** The notice an info letter became: its record id and dedup key. */
export interface InfoNotice {
  id: string;
  dedupKey: string;
}

/** The notice's one-line body: the letter's own preview, as the inbox row would have shown it. */
export function noticeBody(content: InfoLetterContent): string {
  return derivePreview({ text: content.text, markdown: content.markdown, html: content.html });
}

/**
 * Write the notice an info letter becomes: same subject and preview, a tap opens the first task it
 * named (what the letter's pill would have opened). A newer one with the same subject replaces it;
 * the very same one again while unread is answered as already there.
 */
export async function sendInfoNotice(
  content: InfoLetterContent,
  from: { dedupKey: string; emitSource: string; why: string },
): Promise<InfoNotice> {
  const { findNotification, replaceNotification } = await import('../notifications/store.js');
  const taskId = content.taskRefs?.find((t) => typeof t === 'string' && t.length > 0);
  const body = noticeBody(content);
  const title = truncatePreview(content.subject, 200);
  // The same words again (a script's retry, a host's redrain) while the last one is unread: it is
  // that notice, with no second toast.
  const same = await findNotification(from.dedupKey);
  if (same && !same.read && same.title === title && (same.body ?? '') === body) return { id: same.id, dedupKey: same.dedupKey };
  const { record, replaced } = await replaceNotification({
    kind: 'skill',
    severity: 'info',
    title,
    ...(body ? { body } : {}),
    dedupKey: from.dedupKey,
    ...(taskId ? { taskId } : {}),
  });
  const source = { source: from.emitSource };
  // Removal first: the client only toasts a key it is not already showing.
  if (replaced) bus.emit(EventNames.NOTIFICATION_REMOVED, { id: replaced.id, dedupKey: replaced.dedupKey }, ['web-ui'], source);
  bus.emit('notification:new', record, ['web-ui'], source);
  log.notif.info('human-inbox: an info letter nobody asked for became a notice', { dedupKey: from.dedupKey, noticeId: record.id, why: from.why });
  return { id: record.id, dedupKey: record.dedupKey };
}
