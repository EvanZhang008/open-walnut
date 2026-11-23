/**
 * How one of an Org node's Threads reads (threads-model.ts): as its conversation, each of the
 * user's messages with the node's answer under it, numbered (2026-11-01, the user: "do it like
 * slack thread ... 1. what is small mode, then your explanation, 2. why, who asked you to do it").
 *
 * The card shows only what he has not seen: the node's answers he has not reacted to that its
 * summary did not supersede, under that summary; what he already knew is gone from it (2026-11-01, the user: "I replied from the
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

/**
 * Could his message sent at `hisAt` come after reading the node's words (an answer, its first
 * post)? Only when he had the time to read them: READ_CHARS_PER_SECOND characters a second, at least
 * READ_MIN_MS, counted from when the words were done. Unsure is unread (2026-11-21, the user: "最恶心
 * 的是什么？我没看，但是你把它给我 mark 了"): 17% of the automatic read marks on his Walnut VP came
 * from a message he sent seconds after a long answer, typed or dictated while it was still being
 * written. One rule for every place that takes a later message of his as having read what came
 * before it: exchangesOf, recordReaction, reactedSince and the node's known mark
 * (tests/core/org/thread-read-time.test.ts lists them). His own Acknowledge, known or close needs no time.
 */
export const READ_CHARS_PER_SECOND = 25;
export const READ_MIN_MS = 2_000;

/** How long reading `text` takes him at least, in ms. */
export function readMsFor(text: string | undefined): number {
  const n = text ? Array.from(text).length : 0;
  return Math.max(READ_MIN_MS, Math.ceil((n / READ_CHARS_PER_SECOND) * 1000));
}

/** His message at `hisAt` came long enough after `word` to have read it. Pure. */
export function readAfter(word: { at: string; text?: string }, hisAt: string | null | undefined): boolean {
  if (!hisAt) return false;
  const a = Date.parse(word.at);
  const h = Date.parse(hisAt);
  if (!Number.isFinite(a) || !Number.isFinite(h)) return hisAt > word.at;
  return h - a >= readMsFor(word.text);
}

/** What the view reads of a message (threads-model.ts ThreadMessage, or the web's copy of it). */
export interface ViewMessage {
  id: string;
  at: string;
  text: string;
  answer?: { text: string; at: string; about?: string[] };
  /** Answers through this time were visible when the user reacted; travels with the message. */
  readAt?: string;
  /** His reply to a thread of a task below, on its way to that task (threads-model.ts ThreadDelivery). */
  delivery?: { state: string };
}

/** What the view reads of a thread. */
export interface ViewThread<M extends ViewMessage = ViewMessage> {
  messages: M[];
  known?: { through: string; at?: string; by?: string };
  /** The user's last reaction on this subject, retained when its message is split out. */
  reactedAt?: string;
  closed?: { by: string };
  /** The node opened the thread itself: its first post. */
  opener?: { text: string; at: string; from: string; ref?: string };
  /** He put it aside until `until` (threads-model.ts ThreadSnoozed). */
  snoozed?: { until: string; at: string };
  /** He (or the node) watches it: it is in his Watching group too (threads-model.ts ThreadWatched). */
  watched?: { at: string; by?: string };
  /** The node's summary, when it was last rewritten (`replyAt`; absent on threads written before 2026-11-07). */
  reply?: string;
  /** What he wants, in the node's words; and the thread's title. */
  ask?: string;
  title?: string;
  replyAt?: string;
  /** The last change and who made it (his writes are `human`). */
  updatedAt?: string;
  by?: string;
  /** Walnut woke the node about this thread's overdue stretch that began at `since` (thread-recheck.ts). */
  recheck?: { since: string; at: string; pending?: boolean };
  /** Projected on read, never stored (thread-task-ask.ts): a task asks him this thread's decision now. */
  askedIn?: ThreadAskedIn;
  /** Projected on read (thread-popup.ts): a thread of a task below, listed on this node's Threads. */
  owner?: { task_id: string; title: string };
  /** The decision letter it holds (letter-thread-model.ts): the letter keeps its own re-check clock. */
  letter?: { id: string; done?: true; off?: true };
  /** Projected on read (thread-report-ask.ts): it reads needs because it holds the task's own ask. */
  heldAsk?: ThreadHeldAsk;
  /** He acknowledged it while its work ran, and when that work ended (thread-known.ts). */
  ackedAt?: string;
  ackDone?: string;
  /** Where it went from Acknowledged, who placed it and why (thread-known.ts). */
  ackPlaced?: AckPlaced;
}

/** Where a thread he acknowledged went, who placed it there (the node's AI or Walnut's rule) and why (thread-known.ts). */
export type AckPlace = 'working' | 'waiting' | 'closed';
export const ACK_PLACES = ['working', 'waiting', 'closed'] as const satisfies readonly AckPlace[];
/** Longest `place_why` kept: one line on his card. */
export const PLACE_WHY_MAX = 200;
export interface AckPlaced { to: AckPlace; by: 'node' | 'walnut'; at: string; why?: string }

/**
 * The task's own ask, read on its thread (thread-report-ask.ts): the thread reads `needs` with this
 * on it while the task asks that decision. `id` is the task's Action needed item id (its decision
 * id), `ask` its words now, `reply` the thread's own summary under the question, `was` its stored state.
 * Never a second ask: the task's status counts it, so the thread's `needs` count leaves it out.
 */
export interface ThreadHeldAsk {
  id: string;
  ask: string;
  reply?: string;
  was: string;
}

/**
 * A thread in needs whose decision a task already asks him (thread-task-ask.ts threadAskedIn). The
 * read that finds it shows the thread as `pending` (a state every client, an older phone included,
 * already keeps out of his sight, out of the counts and off the overdue clock) with this pointer on
 * it; the stored state stays needs, so it waits on him again the moment that task stops asking.
 * `via`: the node named the task (`owner`), or the thread and a linked task ask it in the same
 * words or reworded (`words`).
 */
export interface ThreadAskedIn {
  task: string;
  title: string;
  ask: string;
  via: 'owner' | 'words';
  decision?: string;
  /** That decision was answered there (by a lead, VP or Main for him) or withdrawn: nothing is asked, the thread stays quiet. */
  answered?: true;
}

/** The nearest future deadline of this thread's open tasks, never stored on the thread. */
export function threadDeadline(t: { tasks?: readonly string[] }, tasks: readonly DeadlineTask[], now = Date.now()): string | undefined {
  if (!t.tasks?.length) return undefined;
  const byId = deadlineIndex(tasks);
  let due = Infinity;
  for (const id of t.tasks) {
    for (const task of byId.get(id) ?? []) {
      const at = Date.parse(task.due_date ?? '');
      if (task.phase !== 'COMPLETE' && at > now && at < due) due = at;
    }
  }
  return Number.isFinite(due) ? new Date(due).toISOString() : undefined;
}

type DeadlineTask = { id: string; due_date?: string; phase?: string };

/**
 * The tasks by id, built once per `tasks` array: every thread of a node (and every card of the
 * Threads view) asks for its deadline against the same whole board, so a scan of the board per
 * thread cost threads x tasks (2026-11-20, the threads re-check on 7,900 tasks). Keyed by the array
 * and its length: a caller never replaces rows of `tasks` in place.
 */
const deadlineIndexes = new WeakMap<readonly DeadlineTask[], { size: number; byId: Map<string, DeadlineTask[]> }>();
function deadlineIndex(tasks: readonly DeadlineTask[]): ReadonlyMap<string, readonly DeadlineTask[]> {
  const cached = deadlineIndexes.get(tasks);
  if (cached && cached.size === tasks.length) return cached.byId;
  const byId = new Map<string, DeadlineTask[]>();
  for (const task of tasks) (byId.get(task.id) ?? byId.set(task.id, []).get(task.id)!).push(task);
  deadlineIndexes.set(tasks, { size: tasks.length, byId });
  return byId;
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
    out.push({ n: 0, messages: [], opener: o, known: ackedByHim || (!!t.ackedAt && t.ackedAt >= o.at) || readAfter(o, t.reactedAt) || t.messages.some((m) => readAfter(o, m.at)) });
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
    const later = t.messages.slice(j).some((m) => !!answer && readAfter(answer, m.at));
    const read = messages.some((m) => !!answer && !!m.readAt && m.readAt >= answer.at);
    const marked = !t.reactedAt && !t.messages.some((m) => m.readAt) && knownThrough >= i
      && (!t.known?.at || !answer || t.known.at >= answer.at);
    out.push({ n, messages, ...(answer ? { answer } : {}), known: !!answer && (later || read || ackedByHim || marked) });
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
 * What a card shows: its summary line on top, the answers he has not reacted to, and his messages
 * after the last answer still waiting for one (an older message no reply was ever found for is
 * history, not news).
 */
export interface CardView<M extends ViewMessage = ViewMessage> {
  summary: SummaryLine<M>;
  unread: ThreadExchange<M>[];
  waiting: ThreadExchange<M>[];
}

/**
 * The line on top of every card (2026-11-08, the user, on a card with only the node's answer and the
 * Conversation toggle: "no summary at all ... I should not need to open it"): the node's summary,
 * else Walnut's own stand-in until the node writes one: the first sentence of the node's latest
 * answer (or its first post), else what he asks (`ask`) in the node's words, else that there is no
 * answer yet. Never empty.
 */
export interface SummaryLine<M extends ViewMessage = ViewMessage> {
  text: string;
  by: 'node' | 'walnut';
  /** Where Walnut's stand-in came from. */
  from?: 'answer' | 'opener' | 'ask' | 'none';
  /** The node's summary predates his latest message (summaryBehindHim): the card says so until it is rewritten. */
  stale?: boolean;
  /** The exchange a stand-in from an answer or the opener was cut from: the writer of its words is the line's writer. */
  exchange?: ThreadExchange<M>;
}

/** How much of an answer Walnut's stand-in line keeps: its first sentence of at least STAND_IN_MIN characters, at most STAND_IN_MAX. */
export const STAND_IN_MAX = 160;
const STAND_IN_MIN = 12;

export function cardView<M extends ViewMessage>(t: ViewThread<M>, shared: ReadonlySet<string> = NONE): CardView<M> {
  const exchanges = exchangesOf(t);
  let lastSaid = -1;
  exchanges.forEach((x, i) => { if (x.answer || x.opener) lastSaid = i; });
  const unread = unreadOf(t, exchanges, shared);
  const waiting = exchanges.slice(lastSaid + 1).filter((x) => !x.answer && !x.opener);
  let summary: SummaryLine<M>;
  if (t.reply?.trim()) summary = { text: t.reply.trim(), by: 'node', ...(summaryBehindHim(t) ? { stale: true } : {}) };
  else {
    // The newest of the node's own words on the thread, never one reply shared with another thread.
    const said = exchanges.filter((x) => (x.answer || x.opener) && !x.messages.some((m) => shared.has(m.id)));
    const src = said[said.length - 1];
    const text = src ? plainLine(src.answer?.text ?? src.opener!.text) : '';
    // The answer itself stays on the card whole: the line is its headline, not a replacement.
    if (src && text) summary = { text, by: 'walnut', from: src.opener ? 'opener' : 'answer', exchange: src };
    else if (t.ask?.trim()) summary = { text: t.ask.trim(), by: 'walnut', from: 'ask' };
    // Nothing from the node yet: say so, never echo his own words back (2026-11-01, the user: "you
    // definitely haven't answered ... you don't need to put it in this thread").
    else summary = { text: 'No answer yet', by: 'walnut', from: 'none' };
  }
  return { summary, unread, waiting };
}

/** The node's words he has not reacted to that no summary superseded (the stand-in line not counted). */
function unreadOf<M extends ViewMessage>(t: ViewThread<M>, exchanges: ThreadExchange<M>[], shared: ReadonlySet<string>): ThreadExchange<M>[] {
  return exchanges.filter((x) => (x.answer || x.opener) && !x.known && !x.messages.some((m) => shared.has(m.id)) && !supersededBySummary(t, x));
}

/** Markdown and markup to one plain paragraph of at most STAND_IN_MAX characters (by code point). */
export function plainLine(text: string): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .split('\n')
    .filter((l) => !/^\s*About\b/.test(l))
    .map((l) => l.replace(/^\s*(?:#+|>+|[-*+]|\d+[.)])\s+/, '').replace(/[*_`~]+/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Its first sentence, when one ends early enough: a headline, the answer below has the rest.
  const end = flat.slice(STAND_IN_MIN).search(/[\u3002\uff01\uff1f]|[.!?](?=\s|$)/);
  const head = end >= 0 && STAND_IN_MIN + end < STAND_IN_MAX ? flat.slice(0, STAND_IN_MIN + end + 1) : flat;
  const points = Array.from(head);
  return points.length <= STAND_IN_MAX ? head : `${points.slice(0, STAND_IN_MAX - 1).join('').trimEnd()}\u2026`;
}

/**
 * The node owes this thread a summary: it has none while its own words are on the thread, or an
 * answer came after the summary that the summary does not cover (supersededBySummary). Pure; the
 * `threads-tidy` reminder asks for it.
 */
export function summaryOwed(t: ViewThread): boolean {
  if (summaryBehindHim(t)) return true;
  const xs = exchangesOf(t);
  const said = xs.filter((x) => x.answer || x.opener);
  if (!said.length) return false;
  const s = summaryAt(t);
  if (!t.reply?.trim()) return true;
  if (!s) return false;
  return said.some((x) => !!x.answer && x.answer.at > s && !supersededBySummary(t, x));
}

/**
 * He wrote in the thread after its summary was written (2026-11-08, the user, on a card that kept
 * the node's old summary after he had answered it: "I already replied, but this thread is not
 * updated at all ... Walnut needs to make sure it doesn't happen"): the summary no longer says where
 * it stands, whatever the node then said in its chat. A thread with no summary he wrote in owes one
 * too. A summary written before replyAt existed gets its time stamped at the first write after
 * (threads-model.ts stampLegacyReplyAt), so a state-only write never makes it current.
 */
export function summaryBehindHim(t: ViewThread): boolean {
  const lastHis = t.messages.reduce((a, m) => (m.at > a ? m.at : a), '');
  if (!lastHis) return false;
  if (!t.reply?.trim()) return true;
  const s = summaryAt(t);
  return !s || s < lastHis;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * An answer written in the same turn as a summary, or one the summary was rewritten after, is that
 * summary's background: within this of the summary it was covered by it.
 */
export const SUMMARY_COVERS_MS = 10 * 60_000;

/**
 * When the node last rewrote the thread's summary. A thread written before `replyAt` existed reads
 * its last change when the node made it, which may be later than the summary itself (a state-only
 * write), so supersededBySummary trusts it only against the thread's first post.
 */
export function summaryAt(t: Pick<ViewThread, 'reply' | 'replyAt' | 'updatedAt' | 'by'>): string | undefined {
  if (!t.reply?.trim()) return undefined;
  if (t.replyAt) return t.replyAt;
  return t.by && t.by !== 'human' ? t.updatedAt : undefined;
}

/**
 * The card shows the newest of the node's words, never an older answer under a newer summary
 * (2026-11-07, the user, on a card that showed the new summary and the superseded answer under it).
 * A summary written after his message covers the answer to it when the answer came before the
 * summary or in the same turn (within SUMMARY_COVERS_MS); a thread the node opened, once it wrote a
 * summary after its first post. The answer still reads in the conversation.
 */
export function supersededBySummary(t: ViewThread, x: Pick<ThreadExchange, 'messages' | 'answer' | 'opener'>): boolean {
  const s = summaryAt(t);
  if (!s) return false;
  // Every summary was written after the thread's first post.
  if (x.opener) return s >= x.opener.at;
  if (!x.answer) return false;
  // An old summary cannot cover a late answer arriving after the user's reaction.
  const reaction = threadReactionAt(t);
  if (reaction && s <= reaction && x.answer.at > reaction) return false;
  if (t.messages.some((m) => m.readAt) && s < x.answer.at) return false;
  // A thread no write has touched since replyAt existed: the node's last change stands in, newer
  // than the answer. Any write stamps replyAt first (stampLegacyReplyAt), so an answer that came
  // later is judged by the stamped time, never by a state or title write after it (review
  // 2026-11-07). Checked on the user's real threads: each answer this hides there is one the newer
  // summary covers (his third card).
  if (!t.replyAt) return s > x.answer.at;
  const asked = x.messages[x.messages.length - 1]?.at ?? '';
  return s > asked && Date.parse(x.answer.at) - Date.parse(s) <= SUMMARY_COVERS_MS;
}

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

/**
 * Is this thread put aside now? Until its date, unless real news came since he snoozed it: a
 * message of his, or an answer of the node's (2026-11-02, the user: "in thread has a snoozed
 * section, also a snoozed button"). A move to needs or answered takes the snooze off in the model.
 */
export function snoozedNow(t: ViewThread, now: number = Date.now()): boolean {
  const s = t.snoozed;
  if (!s || t.closed || !(Date.parse(s.until) > now)) return false;
  return !newsSince(t, s.at);
}

/** Open here and not waiting on him already: a thread the task's own ask can go on (thread-report-ask.ts), or the status question asks about (status-threads.ts). */
export function openNotWaiting(t: { closed?: unknown; movedTo?: unknown; state: string }): boolean {
  return !t.closed && !t.movedTo && t.state !== 'needs';
}

/**
 * In his Watching group now (2026-11-23, the user: a watch is "its own category ... at the same time
 * it is in Watching", the way a task's watch is): open, here (not moved to another node), watched.
 */
export function watchedNow(t: Pick<ViewThread, 'watched' | 'closed'> & { movedTo?: unknown }): boolean {
  return !!t.watched && !t.closed && !t.movedTo;
}

/**
 * His Watching group: every thread he (or the node) watches, whatever its state or group, oldest
 * watch first, so a new watch lands at the bottom and a drag places one (`watched.at`, the task
 * Watching's order). Each is still drawn in its own group as well. Pure.
 */
export function watchingOf<T extends Pick<ViewThread, 'watched' | 'closed'> & { id: string; movedTo?: unknown }>(threads: readonly T[]): T[] {
  return threads.filter(watchedNow).sort((a, b) => a.watched!.at.localeCompare(b.watched!.at) || a.id.localeCompare(b.id));
}

/** A message of his or an answer of the node's came after `at`. */
function newsSince(t: ViewThread, at: string): boolean {
  return t.messages.some((m) => m.at > at || (!!m.answer && m.answer.at > at));
}

/**
 * Does his Threads view show this thread? Only when it has something for him: he must decide
 * (needs) or the result is in (answered). A new thread, one he just wrote in (working) and one in
 * progress are the node's move, out of his sight with the node's chat answer on it too (2026-11-01,
 * the user: "if i reply to a thread, it shoud go out of the thread immediately instead of just show
 * working"; 2026-11-07, of a working card showing only who took it: "before it replies, what is the
 * use?"), until it is overdue with something for him; pending stays out (the node judged it no news).
 */
export function shownToHim<M extends ViewMessage>(t: ViewThread<M> & { state: string }, shared: ReadonlySet<string> = NONE, now: number = Date.now()): boolean {
  if (t.closed) return false;
  if (t.state === 'pending' || snoozedNow(t, now)) return false;
  if (t.state === 'needs') return true;
  if (t.state === 'answered') return hasThreadNews(t, shared);
  // New or working: the node's move, out of sight even with its chat answer on it (2026-11-07, the
  // user: about 20 s later the real reply comes, "before it replies, what is the use?"), until the
  // node has let it sit past the reminder and there is something for him on it.
  return overdueShown(t, shared, now);
}

/** The reaction receipt survives splitting out the follow-up; older files infer it from his messages. */
export function threadReactionAt(t: ViewThread): string {
  return t.messages.reduce((last, m) => m.at > last ? m.at : last, t.reactedAt ?? '');
}

/** Real words after his reaction, not a state, title, task link or move. */
export function hasThreadNews(t: ViewThread, shared: ReadonlySet<string> = NONE): boolean {
  const reaction = threadReactionAt(t);
  const summary = summaryAt(t);
  // His reaction reads the summary only when it came after he could read it (readAfter); his own
  // Acknowledge (a human known mark) always does.
  const reacted = summary && t.reply?.trim() && !readAfter({ at: summary, text: t.reply }, reaction) ? '' : reaction;
  const summaryRead = t.known?.by === 'human' && t.known.at && t.known.at > reacted ? t.known.at : reacted;
  if (t.reply?.trim() && summary && summary > summaryRead && (t.replyAt || !t.known && !t.reactedAt)) return true;
  return exchangesOf(t).some((x) => (x.answer || x.opener) && !x.known
    && !x.messages.some((m) => shared.has(m.id)));
}

/** A thread in the node's hands (new, working) with nothing new this long is overdue: Walnut wakes the node. */
export const REPLY_DUE_MS = 30 * 60_000;
/** An unchanged ask is checked at most once a day, never on the reply reminder's clock. */
export const NEEDS_QUIET_MS = 24 * 3600_000;
/** After the wake, this long more with nothing new and his view says so plainly. */
export const OVERDUE_SHOW_MS = 30 * 60_000;

export interface ThreadOverdue {
  /** `reply`: in the node's hands with no reply on the thread; `needs`: waiting on him with nothing new. */
  why: 'reply' | 'needs';
  /** The last thing that happened on it (his message, the node's write or answer, its first post). */
  since: string;
  /** When Walnut wakes the node; `showAt`: when his view says so. */
  dueAt: string;
  showAt: string;
  /** He wrote and no answer of the node's came after it. */
  unanswered: boolean;
  /** A linked task is due within a day: one check before it, even after a prior quiet check. */
  deadline?: string;
}

/**
 * Has this thread waited too long for the node? (2026-11-07, the user: "one that has had no reply
 * for this long, something must be wrong: the AI should go and answer it, and if not, our system
 * reminds.") In the node's hands (new, working) REPLY_DUE_MS after the last thing on it, or waiting on
 * him (needs) NEEDS_QUIET_MS with nothing new: Walnut wakes the node once per stretch
 * (thread-recheck.ts), with at least a day between quiet checks. A linked task's deadline permits
 * one check in the day before it. OVERDUE_SHOW_MS later the card uses the same rule.
 * Answered waits on his reaction,
 * pending is the node's call and a snoozed thread is put aside: none is ever overdue. Null when not due yet.
 */
export function threadOverdue(t: ViewThread & { state: string }, now: number = Date.now(), deadline?: string): ThreadOverdue | null {
  // The task's own ask on it keeps the ask's own clock (needs-recheck.ts), never a second one.
  if (t.closed || snoozedNow(t, now) || t.heldAsk) return null;
  const why = t.state === 'new' || t.state === 'working' ? 'reply' : t.state === 'needs' ? 'needs' : null;
  // A thread waiting on him for a decision letter: the letter's own 4-hour check asks its task (sessions/letter-recheck.ts).
  if (!why || (why === 'needs' && t.letter && !t.letter.done && !t.letter.off)) return null;
  let lastHis = '';
  let last = t.opener?.at ?? '';
  for (const m of t.messages) {
    if (m.at > lastHis) lastHis = m.at;
    if (m.at > last) last = m.at;
    if (m.answer && m.answer.at > last) last = m.answer.at;
  }
  if (t.by && t.by !== 'human' && t.updatedAt && t.updatedAt > last) last = t.updatedAt;
  if (!last) return null;
  const at = Date.parse(last);
  const deadlineMs = Date.parse(deadline ?? '');
  const beforeDue = deadlineMs - NEEDS_QUIET_MS;
  // A node write inside the deadline window already checked it. Otherwise one
  // before-deadline check uses the existing reminder timestamp as its receipt.
  if (why === 'needs' && Number.isFinite(at) && at < beforeDue && deadlineMs > now && now >= beforeDue
    && !(t.recheck && Date.parse(t.recheck.at) >= deadlineMs - NEEDS_QUIET_MS && !t.recheck.pending)) {
    return { why, since: last, dueAt: new Date(beforeDue).toISOString(), showAt: new Date(beforeDue + OVERDUE_SHOW_MS).toISOString(), unanswered: false, deadline };
  }
  // A checked-only write must not rearm an ask on the reply clock. A successful needs
  // reminder also holds the daily gap across writes and restarts; failed sends keep their retry.
  const checked = why === 'needs' && t.recheck && t.recheck.since !== last && !t.recheck.pending ? Date.parse(t.recheck.at) : NaN;
  const due = Math.max(at, Number.isFinite(checked) ? checked : at) + (why === 'reply' ? REPLY_DUE_MS : NEEDS_QUIET_MS);
  if (!Number.isFinite(at) || now < due) return null;
  const unanswered = !!lastHis && !t.messages.some((m) => !!m.answer && m.answer.at > lastHis);
  return { why, since: last, dueAt: new Date(due).toISOString(), showAt: new Date(due + OVERDUE_SHOW_MS).toISOString(), unanswered };
}

/**
 * A new or working thread the node let sit past the reminder shows when there is something for him
 * on it: his message with no reply (the card says so), or an answer he has not seen. One whose
 * answers he already knew stays the node's to tidy.
 */
function overdueShown<M extends ViewMessage>(t: ViewThread<M> & { state: string }, shared: ReadonlySet<string>, now: number): boolean {
  const o = threadOverdue(t, now);
  if (!o || o.why !== 'reply' || now < Date.parse(o.showAt)) return false;
  return o.unanswered || unreadOf(t, exchangesOf(t), shared).length > 0;
}

/** The plain line his card carries for an overdue thread once it is his to see; null otherwise. */
export function overdueLine(t: ViewThread & { state: string }, name: string, now: number = Date.now(), fmt: (iso: string) => string = (iso) => iso, deadline?: string): string | null {
  const o = threadOverdue(t, now, deadline);
  if (!o || now < Date.parse(o.showAt)) return null;
  const woke = t.recheck && t.recheck.since === o.since && !t.recheck.pending ? ` \u00b7 Walnut reminded ${name} ${fmt(t.recheck.at)}` : '';
  const head = o.deadline ? `A linked task is due ${fmt(o.deadline)}` : o.why === 'needs' ? `Nothing new from ${name} on this` : `${o.unanswered ? 'No reply' : 'Nothing new'} from ${name}`;
  return `${head} \u00b7 last activity ${fmt(o.since)}${woke}`;
}

/**
 * When the threads his view shows last had news: the newest change, answer or first post among
 * them (the Threads tab's dot is for news after he last looked); a thread back from a snooze has
 * news at its date. Null when none is shown.
 */
export function newsAt<M extends ViewMessage>(threads: ReadonlyArray<ViewThread<M> & { state: string; updatedAt: string }>, shared: ReadonlySet<string> = NONE, now: number = Date.now()): string | null {
  let last: string | null = null;
  for (const t of threads) {
    if (!shownToHim(t, shared, now)) continue;
    let at = t.updatedAt;
    // Only a snooze that ran its course: one news ended early was news then, not again at its date.
    const s = t.snoozed;
    if (s && !t.closed && Date.parse(s.until) <= now && s.until > at && !newsSince(t, s.at)) at = s.until;
    if (t.opener && t.opener.at > at) at = t.opener.at;
    for (const m of t.messages) if (m.answer && m.answer.at > at) at = m.answer.at;
    if (!last || at > last) last = at;
  }
  return last;
}

/** What a node's Threads hold for him, the one count every surface shows (2026-11-03, the user, on
 *  a VP's header that read "1 To read · 18 Working" while a thread waited on him: "this here should
 *  show need action ... also show thread and number"; on the Org list: "thread is better than need
 *  u ... thread should be the first one in the list"). Made by thread-groups.ts threadCounts, from
 *  the threads his Threads draw in Needs you or Done, a result waiting for him (threadsForHim). */
export interface ThreadCounts {
  /** Threads that wait on him (threadsForHim): the badge, the header's and the Threads tab's count, the top of the chat's N. */
  shown: number;
  /** Of those, the ones waiting on him (state needs). */
  needs: number;
  /** Of those, the ones he (or the node) watches. Absent when none. */
  watched?: number;
  /** The newest waiting on him, else the newest watched, else the newest shown. */
  title?: string;
  id?: string;
  /** The thread `title` names is watched (a surface marks it with the eye). */
  titleWatched?: boolean;
  /** Of `shown`, the threads of tasks below listed above them (thread-popup.ts): never in `needs`. Absent when none. */
  below?: number;
}

/** His reply on it has not reached the task that owns it yet (threads-model.ts deliveryOpen). */
export function replyOnItsWay(t: ViewThread): boolean {
  return t.messages.some((m) => m.delivery?.state === 'pending' || m.delivery?.state === 'claimed');
}

/**
 * A thread of a task below is listed above it for one of two reasons, never mixed up (2026-11-21,
 * the user, after replying on such a card in the top of his VP's chat: "i send it, but the thread
 * don't go away"):
 *   his      it waits on him there (needs): counted, in Needs you, on the top of the chat;
 *   on its way  his reply on it has not reached the task yet: the task's move, drawn in Working with
 *            his words (so the reply he sent does not vanish), never counted, never on the top.
 * Counts and the top read only `his`, through thread-groups.ts threadsForHim.
 */
export function aboveForHim<M extends ViewMessage>(t: ViewThread<M> & { state: string }, shared: ReadonlySet<string> = NONE, now: number = Date.now()): boolean {
  // Its owner's own ask (thread-report-ask.ts) reaches the leaders through that task's status: never a second card above.
  return !t.closed && !t.heldAsk && t.state === 'needs' && shownToHim(t, shared, now);
}

/** A thread of a task below is listed above it (thread-popup.ts): his, or his reply on it on its way (aboveForHim). */
export function listedAbove<M extends ViewMessage>(t: ViewThread<M> & { state: string }, shared: ReadonlySet<string> = NONE, now: number = Date.now()): boolean {
  if (t.closed) return false;
  return aboveForHim(t, shared, now) || replyOnItsWay(t);
}

/**
 * The threads his Threads view lists, in the order given: his own that have something for him
 * (shownToHim, an answer shared with another of them judged over all of them, the closed ones
 * included), and the threads of tasks below that are listed above them (listedAbove). Every count
 * is the part of this list that waits on him (thread-groups.ts threadsForHim): an overdue
 * thread, or one below whose reply is on its way, is listed and never counted. Pure.
 */
export function listedForHim<T extends ViewThread & { id: string; state: string }>(threads: readonly T[], now: number = Date.now()): T[] {
  const shared = sharedAnswers(threads.filter((t) => !t.owner));
  return threads.filter((t) => (t.owner ? listedAbove(t, NONE, now) : shownToHim(t, shared, now)));
}

/**
 * The order his Threads list them in: newest change first. `needsFirst` (experiment top_thread):
 * the ones waiting on him lead, then the rest, each newest change first, so the top of the chat
 * shows the same first thread. A watch changes no place here: Watching is its own list (watchingOf). Pure.
 */
export function orderedForHim<T extends { state: string; updatedAt: string }>(threads: readonly T[], opts: { needsFirst?: boolean } = {}): T[] {
  const byChange = [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!opts.needsFirst) return byChange;
  return [...byChange.filter((t) => t.state === 'needs'), ...byChange.filter((t) => t.state !== 'needs')];
}

/** "1 thread", "3 threads": the words every surface counts them in. */
export function threadCountLabel(n: number): string {
  return `${n} thread${n === 1 ? '' : 's'}`;
}

/** A row's line about its Threads: how many his view shows (the header's and the tab's number),
 *  then the newest waiting on him (else the newest shown). */
export function threadLine(c: ThreadCounts): string {
  return c.title ? `${threadCountLabel(c.shown)}: ${c.title}` : threadCountLabel(c.shown);
}
