/**
 * Which thread a chat message belongs to, as the chat shows it under the message (experiment
 * `reply_thread_line`; 2026-11-20, the user, translated: "every time I reply I can't tell which one
 * I replied to ... what the AI sees, I should see too"). Pure, shared by the server's read step
 * (reply-thread-index.ts) and the web chat.
 *
 * The thread of his message is the one Walnut filed it under: the `threads` hint it carried to the
 * node names it (thread-capture.ts threadHintText), so the line says exactly what the node was
 * told, never a second guess. The node's answer belongs to the thread of the message it answers.
 */

/** The thread a chat row carries (additive `thread` on history and transcript rows). */
export interface ReplyThread {
  id: string;
  /** Its title now (read when the row was served); the title it had when filed if it is gone. */
  title?: string;
  /** The task that holds it now, when that is not the chat's own (it moved, or it is a task's below). */
  node?: string;
  /** Closed (acknowledged, dropped or moved on): it still opens. */
  closed?: true;
  /** No longer kept (swept a week after it closed): shown, opens nothing. */
  gone?: true;
}

/** A hint as a row carries it (hints/hint-format.ts CarriedHint). */
interface HintLike { kind: string; text: string }

const ID = '(th-[A-Za-z0-9]+)';
const TITLE = '"((?:[^"\\\\]|\\\\.)*)"';
/** Every way threadHintText begins: the thread id, then its title when the text names it. */
const HEAD_RE = new RegExp(`^(?:his reply in thread|a follow-up in thread|already filed under thread|filed under thread|filed as new thread) ${ID}(?: ${TITLE})?`);
const TASK = '([A-Za-z0-9][A-Za-z0-9_.:-]*)';
const BELOW_RE = new RegExp(` \\(${TASK}\\), a task below you:`);
const MOVED_RE = new RegExp(` \\(${TASK}\\) with its work:`);

/** The thread a `threads` hint's text names (the reverse of thread-capture.ts threadHintText). */
export function threadOfHintText(text: string): ReplyThread | null {
  const m = HEAD_RE.exec(text.trim());
  if (!m) return null;
  let title: string | undefined;
  if (m[2] !== undefined) {
    try { title = JSON.parse(`"${m[2]}"`) as string; } catch { title = m[2]; }
  }
  const node = BELOW_RE.exec(text)?.[1] ?? MOVED_RE.exec(text)?.[1];
  return { id: m[1]!, ...(title ? { title } : {}), ...(node ? { node } : {}) };
}

/** The thread a user row was filed under: its `threads` hint's. Null when it carried none. */
export function threadOfHints(hints: readonly HintLike[] | undefined): ReplyThread | null {
  const hint = hints?.find((h) => h.kind === 'threads');
  return hint ? threadOfHintText(hint.text) : null;
}

/** The shape the carry reads (a history row). */
export interface CarryRow {
  role: 'user' | 'assistant' | 'system' | string;
  text?: string;
  injected?: boolean;
  cliError?: boolean | true;
}

/**
 * The node's answer to each of his filed messages: the last row with words of the stretch that
 * follows a message he sent, until the next message sent in (his or anyone's). Two messages before
 * one answer: the answer goes with the later one. Returns row index → that message's thread.
 */
export function answerThreads<R extends CarryRow, T>(rows: readonly R[], threadOf: (row: R) => T | null | undefined): Map<number, T> {
  const out = new Map<number, T>();
  let carry: T | null = null;
  let last = -1;
  const settle = () => { if (carry && last >= 0) out.set(last, carry); last = -1; };
  rows.forEach((row, i) => {
    if (row.role === 'user' && !row.injected) {
      settle();
      carry = threadOf(row) ?? null;
      return;
    }
    if (row.role === 'assistant' && !row.cliError && (row.text ?? '').trim()) last = i;
  });
  settle();
  return out;
}

/** The task part of an answer's line: the tasks it is about, the chat's own left out. */
export function answerTasks(about: readonly string[] | undefined, own: string | undefined): string[] {
  return (about ?? []).filter((id) => id !== own);
}
