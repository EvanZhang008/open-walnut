/**
 * How one of an Org node's Threads reads (threads-model.ts): as its conversation, each of the
 * user's messages with the node's answer under it, numbered (2026-11-01, the user: "do it like
 * slack thread ... 1. what is small mode, then your explanation, 2. why, who asked you to do it").
 *
 * What he already knows folds to one line of context; what he does not is shown in full
 * (2026-11-01, the user: "only show the last one and some kind of context for before, unless the
 * user doesn't know about a thread"). He knows an answer once he reacted after it: wrote again in
 * the thread, the node marked it known after he reacted elsewhere (`known`, checked by the
 * model), or he acknowledged the thread. Silence is not knowing ("I had not replied ... so clearly
 * I had not acknowledged it").
 *
 * Pure, shared by the web view (@open-walnut/thread-view) and the node's cleanup reminder.
 */

/** What the view reads of a message (threads-model.ts ThreadMessage, or the web's copy of it). */
export interface ViewMessage {
  id: string;
  at: string;
  text: string;
  answer?: { text: string; at: string; about?: string[] };
}

/** What the view reads of a thread. */
export interface ViewThread<M extends ViewMessage = ViewMessage> {
  messages: M[];
  known?: { through: string };
  closed?: { by: string };
  /** The node opened the thread itself: its first post. */
  opener?: { text: string; at: string; from: string; ref?: string };
}

/** One exchange: his message (or a few in a row the node answered at once) and the answer. */
export interface ThreadExchange<M extends ViewMessage = ViewMessage> {
  /** 1-based number of its first message in the thread. */
  n: number;
  messages: M[];
  answer?: NonNullable<M['answer']>;
  /** The first post of a thread the node opened (number 0, no message of his). */
  opener?: NonNullable<ViewThread['opener']>;
  /** He reacted after the answer: it is context now, not news. */
  known: boolean;
}

export interface ThreadView<M extends ViewMessage = ViewMessage> {
  exchanges: ThreadExchange<M>[];
  /** The first exchanges that fold into the context line (he knows them); the rest show in full. */
  folded: number;
}

/** Group the messages by the answer that covers them, in order. Messages after the last answer wait together. */
export function exchangesOf<M extends ViewMessage>(t: ViewThread<M>): ThreadExchange<M>[] {
  const out: ThreadExchange<M>[] = [];
  const knownThrough = t.known ? t.messages.findIndex((m) => m.id === t.known!.through) : -1;
  const ackedByHim = t.closed?.by === 'human';
  if (t.opener) {
    const o = t.opener;
    out.push({ n: 0, messages: [], opener: o, known: ackedByHim || t.messages.some((m) => m.at > o.at) });
  }
  let n = 1;
  let i = 0;
  while (i < t.messages.length) {
    const first = t.messages[i];
    let j = i + 1;
    // The same answer (one reply to two messages sent in a row), or the unanswered tail.
    while (j < t.messages.length && sameAnswer(first.answer, t.messages[j].answer)) j++;
    const messages = t.messages.slice(i, j);
    const answer = first.answer as NonNullable<M['answer']> | undefined;
    const later = t.messages.slice(j).some((m) => !!answer && m.at > answer.at);
    out.push({ n, messages, ...(answer ? { answer } : {}), known: !!answer && (later || ackedByHim || knownThrough >= i) });
    n += messages.length;
    i = j;
  }
  return out;
}

function sameAnswer(a: ViewMessage['answer'], b: ViewMessage['answer']): boolean {
  if (!a || !b) return !a && !b;
  return a.at === b.at && a.text === b.text;
}

/** The thread as it reads: exchanges he knows fold to context, the latest stays in full. */
export function threadView<M extends ViewMessage>(t: ViewThread<M>): ThreadView<M> {
  const exchanges = exchangesOf(t);
  const firstNews = exchanges.findIndex((x) => !x.known);
  // All known: the last exchange still reads in full, the rest is context.
  const folded = firstNews < 0 ? Math.max(0, exchanges.length - 1) : firstNews;
  return { exchanges, folded };
}

/** The node's words that wait on his reaction: answered (or posted), and he has not written since. */
export function unreactedAnswers(t: ViewThread): number {
  return exchangesOf(t).filter((x) => (x.answer || x.opener) && !x.known).length;
}
