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
  /** He put it aside until `until` (threads-model.ts ThreadSnoozed). */
  snoozed?: { until: string; at: string };
  /** He (or the node) pinned it to the top of his view (threads-model.ts ThreadPinned). */
  pinned?: { at: string; by?: string };
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
 * What a card shows: its summary line on top, the answers he has not reacted to, and his messages
 * after the last answer still waiting for one (an older message no reply was ever found for is
 * history, not news).
 */
export interface CardView<M extends ViewMessage = ViewMessage> {
  summary: SummaryLine;
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
export interface SummaryLine {
  text: string;
  by: 'node' | 'walnut';
  /** Where Walnut's stand-in came from. */
  from?: 'answer' | 'opener' | 'ask' | 'none';
  /** The node's summary predates his latest message (summaryBehindHim): the card says so until it is rewritten. */
  stale?: boolean;
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
  let summary: SummaryLine;
  if (t.reply?.trim()) summary = { text: t.reply.trim(), by: 'node', ...(summaryBehindHim(t) ? { stale: true } : {}) };
  else {
    // The newest of the node's own words on the thread, never one reply shared with another thread.
    const said = exchanges.filter((x) => (x.answer || x.opener) && !x.messages.some((m) => shared.has(m.id)));
    const src = said[said.length - 1];
    const text = src ? plainLine(src.answer?.text ?? src.opener!.text) : '';
    // The answer itself stays on the card whole: the line is its headline, not a replacement.
    if (src && text) summary = { text, by: 'walnut', from: src.opener ? 'opener' : 'answer' };
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
  // A pinned thread stays in his sight: never in the Snoozed section.
  if (!s || t.closed || pinnedNow(t) || !(Date.parse(s.until) > now)) return false;
  return !newsSince(t, s.at);
}

/** Pinned to the top of his view now (2026-11-03, the user: "have a pin thread feature"): open and pinned. */
export function pinnedNow(t: Pick<ViewThread, 'pinned' | 'closed'>): boolean {
  return !!t.pinned && !t.closed;
}

/** The pinned threads first (the newest pin on top), the rest after them in the order given. */
export function pinnedFirst<T extends Pick<ViewThread, 'pinned' | 'closed'>>(threads: readonly T[]): T[] {
  const pinned = threads.filter(pinnedNow).sort((a, b) => b.pinned!.at.localeCompare(a.pinned!.at));
  return pinned.length ? [...pinned, ...threads.filter((t) => !pinnedNow(t))] : [...threads];
}

/** The states a thread is out of his sight in, unless pinned or an answer waits (threads-model.ts HIDDEN_STATES). */
const QUIET_STATES: ReadonlySet<string> = new Set(['new', 'working', 'pending']);

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
  // Pinned: in his sight whatever its state, until he unpins or acknowledges it.
  if (pinnedNow(t)) return true;
  if (t.state === 'pending' || snoozedNow(t, now)) return false;
  if (t.state === 'needs' || t.state === 'answered') return true;
  // New or working: the node's move, out of sight even with its chat answer on it (2026-11-07, the
  // user: about 20 s later the real reply comes, "before it replies, what is the use?"), until the
  // node has let it sit past the reminder and there is something for him on it.
  return overdueShown(t, shared, now);
}

/** A thread in the node's hands (new, working) with nothing new this long is overdue: Walnut wakes the node. */
export const REPLY_DUE_MS = 30 * 60_000;
/** A thread waiting on him (needs) with nothing new this long: the node checks it still stands. */
export const NEEDS_QUIET_MS = 4 * 3600_000;
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
}

/**
 * Has this thread waited too long for the node? (2026-11-07, the user: "one that has had no reply
 * for this long, something must be wrong: the AI should go and answer it, and if not, our system
 * reminds.") In the node's hands (new, working) REPLY_DUE_MS after the last thing on it, or waiting on
 * him (needs) NEEDS_QUIET_MS with nothing new: Walnut wakes the node once per stretch
 * (thread-recheck.ts), and OVERDUE_SHOW_MS later his view says so. Answered waits on his reaction,
 * pending is the node's call and a snoozed thread is put aside: none is ever overdue. Null when not due yet.
 */
export function threadOverdue(t: ViewThread & { state: string }, now: number = Date.now()): ThreadOverdue | null {
  if (t.closed || snoozedNow(t, now)) return null;
  const why = t.state === 'new' || t.state === 'working' ? 'reply' : t.state === 'needs' ? 'needs' : null;
  if (!why) return null;
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
  const due = at + (why === 'reply' ? REPLY_DUE_MS : NEEDS_QUIET_MS);
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
export function overdueLine(t: ViewThread & { state: string }, name: string, now: number = Date.now(), fmt: (iso: string) => string = (iso) => iso): string | null {
  const o = threadOverdue(t, now);
  if (!o || now < Date.parse(o.showAt)) return null;
  const woke = t.recheck && t.recheck.since === o.since && !t.recheck.pending ? ` \u00b7 Walnut reminded ${name} ${fmt(t.recheck.at)}` : '';
  const head = o.why === 'needs' ? `Nothing new from ${name} on this` : `${o.unanswered ? 'No reply' : 'Nothing new'} from ${name}`;
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
    // A pinned thread in the node's hands (new, working, pending) shows only for the pin: a change
    // of it (his own message merged in, the node saying it works on it) is no news; its answers are.
    let at = pinnedNow(t) && QUIET_STATES.has(t.state) ? '' : t.updatedAt;
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
 *  u ... thread should be the first one in the list"). */
export interface ThreadCounts {
  /** Threads his view shows (shownToHim): the Threads tab's count. */
  shown: number;
  /** Of those, the ones waiting on him (state needs). */
  needs: number;
  /** Of those, the ones he (or the node) pinned. Absent when none. */
  pinned?: number;
  /** The newest waiting on him, else the newest pinned, else the newest shown. */
  title?: string;
  id?: string;
  /** The thread `title` names is pinned (a surface marks it). */
  titlePinned?: boolean;
}

/** The counts of one node's Threads. Pure; the web's header and the server's status read the same. */
export function threadCounts<M extends ViewMessage>(threads: ReadonlyArray<ViewThread<M> & { id: string; title: string; state: string; updatedAt: string }>, now: number = Date.now()): ThreadCounts {
  const shared = sharedAnswers(threads);
  const shown = threads.filter((t) => shownToHim(t, shared, now));
  const needs = shown.filter((t) => t.state === 'needs');
  const pinned = pinnedFirst(shown.filter(pinnedNow));
  const newest = (list: typeof shown) => list.reduce<(typeof shown)[number] | undefined>((a, t) => (!a || t.updatedAt > a.updatedAt ? t : a), undefined);
  const top = newest(needs) ?? pinned[0] ?? newest(shown);
  return {
    shown: shown.length, needs: needs.length, ...(pinned.length ? { pinned: pinned.length } : {}),
    ...(top ? { title: top.title, id: top.id, ...(pinnedNow(top) ? { titlePinned: true } : {}) } : {}),
  };
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
