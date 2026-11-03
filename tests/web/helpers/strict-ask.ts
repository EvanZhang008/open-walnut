/**
 * The strict Ask here hint as the server writes it (src/core/sessions/ask-thread.ts),
 * so the web's reader (web/src/utils/ask-answer.ts) is tested against the real text.
 */
import { askHintText } from '../../../src/core/sessions/ask-thread';

export function strictAskHintText(thread: string, name: string): string {
  return askHintText(thread, name);
}

/** A user row carrying a strict question's hint. */
export function strictAskRow<T extends object = object>(
  msgId: string, text: string, thread: string, name: string, extra: T = {} as T,
): { role: 'user'; msgId: string; text: string; hints: Array<{ kind: string; arg: string; text: string }> } & T {
  return { role: 'user', msgId, text, hints: [{ kind: 'question', arg: thread, text: askHintText(thread, name) }], ...extra };
}
