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

/** The question hint's words: the question's tag, and the tag its answer must sit in. */
export function askHintText(thread: string, name: string): string {
  const attrs = `thread="${thread}"${name ? ` name="${name}"` : ''}`;
  return `this message is an Ask here question: <walnut-ask ${attrs}>. Begin your reply with the line <walnut-ask-answer ${attrs}>, put your answer to it after that line, and end it with the line </walnut-ask-answer>, with the same thread id and name. `
    + `Only what is inside that tag is filed under question ${thread}; everything outside it stays in the main conversation, and a tag whose id or name does not match is not filed. `
    + 'The same holds for every part of the answer: in a later message, after other work, after a compaction, and in a message that also answers other questions (each answer in its own tag with its own thread id and name).';
}
