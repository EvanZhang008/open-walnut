/**
 * Every message the user sends to an Org node (Main, a VP, a lead) is filed as one of its
 * Threads (threads-model.ts), on the send path itself (hints/hint-send.ts), so no request is
 * left to an agent's memory. The node is told in the same message which thread it went to and
 * which threads are open (the `threads` message hint), so it can put a message about an open
 * subject under that thread and keep each one current.
 *
 * What counts: words a person typed into the node's chat (the web, the phone, the CLI, the
 * relay), and the note he wrote answering one of its letters. Not a peer's or Walnut's message,
 * not a slash command, not a letter answered by a choice alone (that answers the node's own
 * question).
 */
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import { walnutLetterLanguage } from '../human-inbox/walnut-letters/languages.js';
import { stripReferenceCards } from '../sessions/reference-cards.js';
import {
  fileMessage, isOpen, lastUserAt, movedAway, newThreadId, newThreadMessageId, reactedSince, sortedThreads,
  type FileMessageInput, type ThreadCloseHow, type ThreadsFile, type ThreadState, type ThreadVia, type ThreadWriter,
} from './threads-model.js';
import { exchangesOf, pinnedNow, snoozedNow, summaryBehindHim, summaryOwed } from './thread-view.js';

/** Open threads named to the node with each message (the newest). */
export const HINT_OPEN_MAX = 12;
/** A close older than this is not news to the node. */
const CLOSE_NEWS_MS = 3 * 24 * 3600_000;

export interface UserWords {
  text: string;
  images: string[];
  via: ThreadVia;
  /** A letter answer: the letter's subject. */
  about?: string;
  /** A letter answer: the letter's id. */
  letter?: string;
}

const ATTACHMENT_HEADER_RE = /^\[(?:Images|Files) attached[^\]\n]*\]\n((?:- [^\n]+\n?)*)\n?/;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|heic)$/i;
const LETTER_BY_USER_RE = /^\[Letter reply\] Your user answered a letter you sent them/;

/** The person's own words in a message as the session receives it, or null when there are none to file. */
export function userWordsOf(message: string, opts: { inChat: boolean }): UserWords | null {
  const raw = message.replace(/\r\n/g, '\n');
  if (!raw.trim() || raw.startsWith('/')) return null;
  // Pictures lead the line under their header, a letter answer's too (letter-ops.ts).
  let text = raw;
  const images: string[] = [];
  for (let i = 0; i < 4; i++) {
    const m = ATTACHMENT_HEADER_RE.exec(text);
    if (!m) break;
    for (const line of m[1].split('\n')) {
      const p = line.replace(/^- /, '').trim();
      if (p && IMAGE_EXT_RE.test(p)) images.push(p);
    }
    text = text.slice(m[0].length);
  }
  if (LETTER_BY_USER_RE.test(text)) return letterWords(text, images);
  // A message from another task or Walnut, sent under a person's source.
  if (/^\s*<walnut-message[\s>]/.test(text) || text.startsWith('[Letter reply]')) return null;
  if (!opts.inChat) return null;
  text = stripReferenceCards(text).trim();
  if (!text && !images.length) return null;
  return { text, images, via: 'chat' };
}

/** A letter answer's note (letter-ops.ts buildLetterDeliveryText puts it last inside the fence). */
function letterWords(raw: string, images: string[]): UserWords | null {
  const fence = /(---letter-answer-[a-f0-9]{6,40}---)\n([\s\S]*?)\n\1 \(end of letter answer\)/.exec(raw);
  if (!fence) return null;
  const body = fence[2];
  const note = /(?:^|\n)note: ([\s\S]*)$/.exec(body)?.[1]?.replace(/\nuser's words: [\s\S]*$/, '').trim() ?? '';
  if (!note && !images.length) return null;
  const about = /(?:^|\n)subject: ([^\n]*)/.exec(body)?.[1]?.trim();
  const letter = /(?:^|\n)letter: (lt-[A-Za-z0-9-]+)/.exec(body)?.[1];
  return { text: note, images, via: 'letter', ...(about ? { about } : {}), ...(letter ? { letter } : {}) };
}

export interface ThreadHintState {
  /** The thread this message went to. */
  threadId: string;
  title: string;
  /** A new thread was opened for it. */
  created: boolean;
  /** The user sent it from the thread's Follow up. */
  followUp: boolean;
  /** It asks again about this closed thread. */
  follows?: { id: string; title: string };
  /** This send was filed already (a retry with its id): nothing new. */
  duplicate: boolean;
  open: Array<{ id: string; title: string; state: ThreadState; snoozedUntil?: string; pinnedBy?: ThreadWriter }>;
  /** Threads closed since the node was last told, and by whom. */
  closed: Array<{ id: string; title: string; how: ThreadCloseHow; by: ThreadWriter }>;
  /** The Follow up named a thread that moved to another node with its work: filed there (thread-follow.ts). */
  movedTo?: { task: string; title: string };
}

export interface ThreadCapture {
  hint: ThreadHintState;
  /** Store the message. Call after the text is safely queued. `told`: the threads hint went out
   *  with it, so the closes it named are told. Never throws. */
  commit(opts: { told: boolean }): Promise<void>;
}

/**
 * Plan filing this message for the node `task`: read its threads, decide where the message goes
 * (exactly as the store will), and hand back what to tell the node plus the write. Null when the
 * task is not an Org node or the message holds none of the user's words.
 */
export async function prepareThreadCapture(input: {
  task: Pick<Task, 'id' | 'org_role'> | null | undefined;
  message: string;
  inChat: boolean;
  /** The Follow up button named this thread. */
  threadId?: string;
  /** The send's own id (the phone's qm- id), so a retry of it is filed once. */
  key?: string;
  /** The node session it goes to: its answer is read there (thread-answers.ts). */
  sid?: string;
  now?: number;
}): Promise<ThreadCapture | null> {
  const task = input.task;
  if (!task || (task.org_role !== 'main' && task.org_role !== 'lead')) return null;
  const words = userWordsOf(input.message, { inChat: input.inChat });
  if (!words) return null;
  const { isCompanion } = await import('../server-role.js');
  if (isCompanion()) return null;
  const store = await import('./threads-store.js');
  const cur = await store.readThreads(task.id);
  const at = new Date(input.now ?? Date.now()).toISOString();
  const messageId = newThreadMessageId();
  const draft: FileMessageInput = {
    text: words.text, images: words.images, via: input.threadId ? 'follow-up' : words.via,
    ...(words.about ? { about: words.about } : {}),
    ...(words.letter ? { letter: words.letter } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    // A Follow up carries a key of its own, so a send of it on to the node holding the thread now
    // (it moved between this plan and the write) finds it filed (thread-follow.ts deliverMovedFollowUp).
    ...(input.key || input.threadId ? { key: input.key ?? `fu-${messageId}` } : {}),
    ...(input.sid ? { sid: input.sid } : {}),
    newThreadId: newThreadId(), messageId, at,
    // The title the store will give a picture alone, in the letter language.
    lang: await walnutLetterLanguage(),
  };
  // A Follow up on a thread that moved on: his message goes to the node holding it now, filed in
  // the thread there; this node is told it is not its own (thread-follow.ts).
  const away = input.threadId ? cur.threads.find((t) => t.id === input.threadId && movedAway(t)) : undefined;
  if (away?.movedTo) {
    const holder = await store.threadHolder(away.movedTo.task, away.id).catch(() => null);
    const movedTo = { task: holder?.node ?? away.movedTo.task, title: holder?.title ?? away.movedTo.title };
    const message = input.message;
    const key = draft.key!;
    return {
      hint: { threadId: away.id, title: away.title, created: false, duplicate: false, followUp: true, open: [], closed: [], movedTo },
      async commit() {
        const { deliverMovedFollowUp } = await import('./thread-follow.js');
        await deliverMovedFollowUp({ node: movedTo.task, threadId: away.id, title: away.title, message, key, from: task.id, filed: false });
      },
    };
  }
  // The same pure step the store runs, on the copy read now: the node is told what will be.
  const planned = fileMessage(cur, draft);
  const nowMs = Date.parse(at);
  const closed = cur.threads.filter((t) => t.closed && !t.closed.told && nowMs - Date.parse(t.closed.at) < CLOSE_NEWS_MS);
  const open = sortedThreads(planned.file.threads).filter((t) => isOpen(t) && t.id !== planned.thread.id).slice(0, HINT_OPEN_MAX);
  const follows = planned.thread.follows ? cur.threads.find((t) => t.id === planned.thread.follows) : undefined;
  const hint: ThreadHintState = {
    threadId: planned.thread.id, title: planned.thread.title, created: planned.created, duplicate: planned.duplicate,
    followUp: !!input.threadId && !planned.created,
    ...(follows ? { follows: { id: follows.id, title: follows.title } } : {}),
    open: open.map((t) => ({ id: t.id, title: t.title, state: t.state, ...(snoozedNow(t, nowMs) ? { snoozedUntil: t.snoozed!.until } : {}), ...(pinnedNow(t) ? { pinnedBy: t.pinned!.by } : {}) })),
    closed: closed.map((t) => ({ id: t.id, title: t.title, how: t.closed!.how, by: t.closed!.by })),
  };
  return {
    hint,
    async commit({ told }) {
      try {
        if (!planned.duplicate) {
          const filed = await store.fileThreadMessage(task.id, draft);
          // Its ids were chosen ahead, so only a thread that moved in between (the Follow up's
          // target merged or closed a moment ago) lands elsewhere than the node was told.
          if (filed.thread.id !== planned.thread.id) {
            log.session.warn('org threads: filed elsewhere than told', { taskId: task.id, told: planned.thread.id, filed: filed.thread.id });
          }
          // The thread moved to another node between the plan and the write: that node gets his message.
          if (filed.node !== task.id && !filed.duplicate) {
            const { deliverMovedFollowUp } = await import('./thread-follow.js');
            await deliverMovedFollowUp({ node: filed.node, threadId: filed.thread.id, title: filed.thread.title, message: input.message, key: draft.key!, from: task.id, filed: true });
          }
        }
        if (told) await store.noteClosesTold(task.id, closed.map((t) => t.id));
      } catch (err) {
        log.session.warn('org threads: message not filed', { taskId: task.id, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

function q(s: string): string { return JSON.stringify(s); }

/**
 * What the `threads` hint tells the node about this message: where it was filed, and for a new
 * thread the open ones it might belong to. Only the facts of this message; the rules for keeping
 * threads are in the node's prompt (session-context.ts THREADS_LINE). 2026-11-06, the user: "The
 * text itself should be concise also"; it was 5.4 KB a message, 63% of it rules the prompt has.
 */
export function threadHintText(s: ThreadHintState): string {
  let text: string;
  if (s.movedTo) return `a follow-up in thread ${s.threadId} ${q(s.title)}, which moved to ${s.movedTo.title} (${s.movedTo.task}) with its work: filed there, and ${s.movedTo.title} reads it. Not yours to act on; at most tell him it is with ${s.movedTo.title} now.`;
  if (s.duplicate) text = `already filed under thread ${s.threadId} ${q(s.title)}.`;
  else if (s.followUp) text = `a follow-up in thread ${s.threadId} ${q(s.title)}, filed there.`;
  else if (s.created) {
    text = `filed as new thread ${s.threadId}${s.follows ? ` (asks again about closed ${s.follows.id} ${q(s.follows.title)})` : ''}.`;
    text += s.open.length
      ? ` Open: ${s.open.map((t) => `${t.id} ${q(t.title)}`).join('; ')}. Same subject as one: thread_update merge_into; else give it a short title.`
      : ' Give it a short title (thread_update).';
  } else text = `filed under thread ${s.threadId} ${q(s.title)}.`;
  if (s.closed.length) text += ` Closed since: ${s.closed.map((t) => `${t.id}${t.by === 'human' ? ' (by him)' : ''}`).join(', ')}.`;
  return text;
}

/** A thread the node should look at again: why, in a few words. */
export interface TidyItem { id: string; title: string; state: ThreadState; why: 'reacted' | 'untitled' | 'state' | 'summary' }

export interface ThreadsTidyState {
  items: TidyItem[];
  /** What the list says, as one key: a new item is a new thing to say. */
  key: string;
}

/** A thread Walnut titled is left to the node this long before it is reminded. */
const UNTITLED_MS = 10 * 60_000;
export const TIDY_MAX = 8;

/**
 * Pure: the open threads that need the node's decision now. He wrote to the node after an answer
 * it gave in another thread (did he react to it? then mark it known, or close it if finished); a
 * thread still under Walnut's stand-in title; a thread still "new" though the node answered it.
 */
export function threadsTidyOf(file: ThreadsFile, nowMs = Date.now()): ThreadsTidyState | null {
  const items: TidyItem[] = [];
  const lastHis = lastUserAt(file) ?? '';
  for (const t of sortedThreads(file.threads)) {
    // A thread he put aside is not asked about until it is back (its date, or news).
    if (!isOpen(t) || snoozedNow(t, nowMs)) continue;
    const xs = exchangesOf(t);
    const waiting = xs.filter((x) => (x.answer || x.opener) && !x.known);
    // The node looked at this thread since his last message (any update of its own): its call stands.
    const reviewed = !!t.by?.startsWith('task:') && t.updatedAt > lastHis;
    let why: TidyItem['why'] | null = null;
    const untitled = !t.titled && nowMs - Date.parse(t.createdAt) > UNTITLED_MS;
    // A pending thread is the node's call that nothing on it is news: only a stand-in title is asked about.
    if (t.state === 'pending') why = untitled ? 'untitled' : null;
    // A summary he wrote past comes first (2026-11-08, the user: "Walnut needs to make sure it doesn't happen").
    else if (summaryBehindHim(t)) why = 'summary';
    else if (!reviewed && waiting.some((x) => reactedSince(file, (x.answer ?? x.opener)!.at))) why = 'reacted';
    else if (untitled) why = 'untitled';
    else if (t.state === 'new' && xs.some((x) => x.answer)) why = 'state';
    // A card he sees always leads with the node's summary (thread-view.ts summaryOwed; 2026-11-08).
    else if (summaryOwed(t)) why = 'summary';
    if (why) items.push({ id: t.id, title: t.title, state: t.state, why });
  }
  if (!items.length) return null;
  // Summaries first (stable within each group), then the cap.
  items.sort((a, b) => Number(b.why === 'summary') - Number(a.why === 'summary'));
  items.splice(TIDY_MAX);
  return { items, key: items.map((i) => `${i.id}:${i.why}`).join(',') };
}

const TIDY_WHY: Record<TidyItem['why'], string> = {
  summary: 'summary missing or older than his message or your answer: rewrite it',
  reacted: 'did he react to your answer?',
  untitled: 'needs a title',
  state: 'answered, still new',
};

/** What the `threads-tidy` reminder says: one line, the threads by why (the rules are in the prompt). */
export function threadsTidyText(s: ThreadsTidyState): string {
  const groups = (Object.keys(TIDY_WHY) as TidyItem['why'][])
    .map((why) => ({ why, ids: s.items.filter((i) => i.why === why).map((i) => i.id) }))
    .filter((g) => g.ids.length)
    .map((g) => `${g.ids.join(', ')} (${TIDY_WHY[g.why]})`);
  return `threads to tidy: ${groups.join('; ')}.`;
}
