/**
 * An Ask here question's thread id and name, as its send names them and its answer must
 * repeat (2026-11-03, the user: "each question has a thread id and thread name, and they must
 * match ... the thread can be nested"). The id is the question's number on the main
 * conversation and a path below the question it was asked in when nested (6, 6.1, 6.1.2).
 * Read by the question hint (hints/hint-registry.ts), the thread meta (thread-meta.ts) and the
 * Stop hook (ask-unanswered.ts); the web's reader is web/src/utils/ask-answer.ts. Pure.
 */

/** The words an Ask here question goes by in its tag: its title, else the start of its words. */
export function askNameOf(meta: { title?: string; question?: string } | undefined, message?: string): string {
  const raw = meta?.title?.trim() || meta?.question?.trim() || (message ?? '').trim();
  const flat = raw.replace(/[\s"<>&]+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 59).trimEnd()}\u2026` : flat;
}

/** A thread id: the question's number on the main conversation, a path below it when nested (6, 6.1, 6.1.2). */
export const ASK_THREAD_RE = /^\d{1,5}(?:\.\d{1,5}){0,5}$/;

/**
 * The question hint's words: one self-contained line naming the question and the tag its answer
 * goes in. It rides every message of a thread, so it stays short (2026-11-12, the user, of the
 * ~830-byte block it was: "what is this ask here... hmm"), and nothing of it moves into the
 * prompt, which every session carries on every request. The tag must open the reply
 * (web/src/utils/ask-answer.ts askAnswerOpening reads it at the start).
 */
export function askHintText(thread: string, name: string): string {
  const attrs = `thread="${thread}"${name ? ` name="${name}"` : ''}`;
  return `Ask here question <walnut-ask ${attrs}>: begin your reply with the line <walnut-ask-answer ${attrs}> and end the answer with </walnut-ask-answer>; only text inside is filed under it, so tag every later part too.`;
}
