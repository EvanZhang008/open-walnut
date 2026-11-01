/**
 * How one of an Org node's Threads reads (threads-model.ts): as its conversation, each of the
 * user's messages with the node's answer under it, numbered (2026-11-01, the user: "do it like
 * slack thread ... 1. what is small mode, then your explanation, 2. why, who asked you to do it").
 *
 * The card shows only what he has not seen: the node's answers he has not reacted to, under the
 * node's summary; what he already knew is gone from it (2026-11-01, the user: "I replied from the
 * first one to the ninth, so why still show the first to the eighth?"). The whole conversation
 * stays one click away. He knows an answer once he reacted after it: wrote again in
 * the thread, the node marked it known after he reacted elsewhere (`known`, checked by the
 * model), or he acknowledged the thread. Silence is not knowing ("I had not replied ... so clearly
 * I had not acknowledged it").
 *
 * One reply of the node's can cover messages he sent to different threads in one turn (a message
 * that came in while it was working). Walnut cannot tell which part answers which, so that reply
 * stays out of every card and only reads in the whole conversation (2026-11-01: an unrelated long
 * answer sat under his "also in create new task UI" message); the node's summary carries the news.
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
    // A message of his whose reply Walnut did not find, sent before that same reply covered a later
    // one, was covered by it too: one exchange, never the reply twice around it.
    if (first.answer) {
      for (let k = j; k < t.messages.length && !t.messages[k].answer && t.messages[k].at < first.answer.at; k++) {
        if (sameAnswer(first.answer, t.messages[k + 1]?.answer)) j = k + 2;
      }
      while (j < t.messages.length && sameAnswer(first.answer, t.messages[j].answer)) j++;
    }
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

/** The node's words that wait on his reaction: answered (or posted), and he has not written since. */
export function unreactedAnswers(t: ViewThread): number {
  return exchangesOf(t).filter((x) => (x.answer || x.opener) && !x.known).length;
}

/**
 * What a card shows: the answers he has not reacted to, and his messages after the last answer
 * still waiting for one (an older message no reply was ever found for is history, not news).
 */
export interface CardView<M extends ViewMessage = ViewMessage> {
  unread: ThreadExchange<M>[];
  waiting: ThreadExchange<M>[];
}

export function cardView<M extends ViewMessage>(t: ViewThread<M>, shared: ReadonlySet<string> = NONE): CardView<M> {
  const exchanges = exchangesOf(t);
  let lastSaid = -1;
  exchanges.forEach((x, i) => { if (x.answer || x.opener) lastSaid = i; });
  return {
    unread: exchanges.filter((x) => (x.answer || x.opener) && !x.known && !x.messages.some((m) => shared.has(m.id))),
    waiting: exchanges.slice(lastSaid + 1).filter((x) => !x.answer && !x.opener),
  };
}

const NONE: ReadonlySet<string> = new Set();

/** The messages whose answer is one reply that also sits under a message of another thread. */
export function sharedAnswers(threads: ReadonlyArray<{ id: string; messages: readonly ViewMessage[] }>): Set<string> {
  const byReply = new Map<string, { threads: Set<string>; messages: string[] }>();
  for (const t of threads) {
    for (const m of t.messages) {
      if (!m.answer) continue;
      const key = `${m.answer.at}\n${m.answer.text}`;
      let g = byReply.get(key);
      if (!g) byReply.set(key, (g = { threads: new Set(), messages: [] }));
      g.threads.add(t.id);
      g.messages.push(m.id);
    }
  }
  const out = new Set<string>();
  for (const g of byReply.values()) if (g.threads.size > 1) for (const id of g.messages) out.add(id);
  return out;
}
