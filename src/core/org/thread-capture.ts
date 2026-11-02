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
import { stripReferenceCards } from '../sessions/reference-cards.js';
import {
  fileMessage, isOpen, lastUserAt, newThreadId, newThreadMessageId, reactedSince, sortedThreads,
  type FileMessageInput, type ThreadCloseHow, type ThreadsFile, type ThreadState, type ThreadVia, type ThreadWriter,
} from './threads-model.js';
import { THREADS_KNOWN_RULE, THREADS_OPEN_RULE, THREADS_PENDING_RULE, THREADS_SUMMARY_RULE } from './thread-rules.js';
import { exchangesOf } from './thread-view.js';

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
}

const ATTACHMENT_HEADER_RE = /^\[(?:Images|Files) attached[^\]\n]*\]\n((?:- [^\n]+\n?)*)\n?/;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|heic)$/i;
const LETTER_BY_USER_RE = /^\[Letter reply\] Your user answered a letter you sent them/;

/** The person's own words in a message as the session receives it, or null when there are none to file. */
export function userWordsOf(message: string, opts: { inChat: boolean }): UserWords | null {
  const raw = message.replace(/\r\n/g, '\n');
  if (!raw.trim() || raw.startsWith('/')) return null;
  if (LETTER_BY_USER_RE.test(raw)) return letterWords(raw);
  // A message from another task or Walnut, sent under a person's source.
  if (/^\s*<walnut-message[\s>]/.test(raw) || raw.startsWith('[Letter reply]')) return null;
  if (!opts.inChat) return null;
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
  text = stripReferenceCards(text).trim();
  if (!text && !images.length) return null;
  return { text, images, via: 'chat' };
}

/** A letter answer's note (letter-ops.ts buildLetterDeliveryText puts it last inside the fence). */
function letterWords(raw: string): UserWords | null {
  const fence = /(---letter-answer-[a-f0-9]{6,40}---)\n([\s\S]*?)\n\1 \(end of letter answer\)/.exec(raw);
  if (!fence) return null;
  const body = fence[2];
  const note = /(?:^|\n)note: ([\s\S]*)$/.exec(body)?.[1]?.replace(/\nuser's words: [\s\S]*$/, '').trim();
  if (!note) return null;
  const about = /(?:^|\n)subject: ([^\n]*)/.exec(body)?.[1]?.trim();
  return { text: note, images: [], via: 'letter', ...(about ? { about } : {}) };
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
  open: Array<{ id: string; title: string; state: ThreadState }>;
  /** Threads closed since the node was last told, and by whom. */
  closed: Array<{ id: string; title: string; how: ThreadCloseHow; by: ThreadWriter }>;
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
  const draft: FileMessageInput = {
    text: words.text, images: words.images, via: input.threadId ? 'follow-up' : words.via,
    ...(words.about ? { about: words.about } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.key ? { key: input.key } : {}),
    ...(input.sid ? { sid: input.sid } : {}),
    newThreadId: newThreadId(), messageId: newThreadMessageId(), at,
  };
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
    open: open.map((t) => ({ id: t.id, title: t.title, state: t.state })),
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
        }
        if (told) await store.noteClosesTold(task.id, closed.map((t) => t.id));
      } catch (err) {
        log.session.warn('org threads: message not filed', { taskId: task.id, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

function q(s: string): string { return JSON.stringify(s); }

/** What the `threads` hint tells the node about this message. */
export function threadHintText(s: ThreadHintState): string {
  const parts: string[] = [];
  if (s.duplicate) {
    parts.push(`this message repeats one already filed under the user's thread ${s.threadId} ${q(s.title)}.`);
  } else if (s.followUp) {
    parts.push(`the user sent this message as a follow-up in his thread ${s.threadId} ${q(s.title)} (your Threads page: his own requests to you). It is filed there.`);
  } else if (s.created) {
    parts.push(`Walnut filed this message of the user as a new thread ${s.threadId} on your Threads page (his own requests to you, beside your Brief)`
      + (s.follows ? `; it asks again about ${s.follows.id} ${q(s.follows.title)}, which he closed.` : '.'));
  } else {
    parts.push(`Walnut filed this message under the user's thread ${s.threadId} ${q(s.title)}.`);
  }
  if (s.open.length) {
    parts.push(`His other open threads: ${s.open.map((t) => `${t.id} ${q(t.title)} (${t.state})`).join('; ')}.`);
    if (s.created && !s.duplicate) {
      parts.push(`If this message is about the same thing as one of them, or only answers one (a yes, thanks, go on), put it under that thread now: thread_update {"id":"${s.threadId}","merge_into":"<that id>"}. Several asks about one subject are one thread.`);
    }
  }
  if (s.created && !s.duplicate) {
    parts.push('Then give the thread a short title of a few words, in the language you write to him, with thread_update (title, and ask: one line of what he wants).');
  }
  parts.push('As the work moves, keep it current with thread_update: state (working: you are on it, needs: waiting on him, answered: you answered and he may close it, pending: nothing new for him), reply (the summary the card shows), title as the subject moves, add_tasks (the tasks you hand it to). Walnut puts your chat reply under his message by itself.');
  parts.push(THREADS_SUMMARY_RULE, THREADS_PENDING_RULE, THREADS_KNOWN_RULE, THREADS_OPEN_RULE);
  if (s.closed.length) {
    parts.push(`Closed since you were last told: ${s.closed.map((t) => `${t.id} ${q(t.title)} (${t.by === 'human' ? 'he acknowledged it' : t.how === 'dropped' ? 'dropped' : 'closed'})`).join('; ')}.`);
  }
  return parts.join(' ');
}

/** A thread the node should look at again: why, in a few words. */
export interface TidyItem { id: string; title: string; state: ThreadState; why: 'reacted' | 'untitled' | 'state' }

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
    if (!isOpen(t)) continue;
    const xs = exchangesOf(t);
    const waiting = xs.filter((x) => (x.answer || x.opener) && !x.known);
    // The node looked at this thread since his last message (any update of its own): its call stands.
    const reviewed = !!t.by?.startsWith('task:') && t.updatedAt > lastHis;
    let why: TidyItem['why'] | null = null;
    const untitled = !t.titled && nowMs - Date.parse(t.createdAt) > UNTITLED_MS;
    // A pending thread is the node's call that nothing on it is news: only a stand-in title is asked about.
    if (t.state === 'pending') why = untitled ? 'untitled' : null;
    else if (!reviewed && waiting.some((x) => reactedSince(file, (x.answer ?? x.opener)!.at))) why = 'reacted';
    else if (untitled) why = 'untitled';
    else if (t.state === 'new' && xs.some((x) => x.answer)) why = 'state';
    if (why) items.push({ id: t.id, title: t.title, state: t.state, why });
    if (items.length >= TIDY_MAX) break;
  }
  if (!items.length) return null;
  return { items, key: items.map((i) => `${i.id}:${i.why}`).join(',') };
}

const TIDY_WHY: Record<TidyItem['why'], string> = {
  reacted: 'he wrote to you after your answer there: did he react to it? If not, say so with any thread_update (state answered) and it stays open',
  untitled: 'still under Walnut\'s stand-in title',
  state: 'you answered it, its state is still new',
};

/** What the `threads-tidy` reminder says. */
export function threadsTidyText(s: ThreadsTidyState): string {
  return `your Threads need cleaning: ${s.items.map((i) => `${i.id} ${q(i.title)} (${i.state}; ${TIDY_WHY[i.why]})`).join('; ')}. `
    + `${THREADS_KNOWN_RULE} ${THREADS_SUMMARY_RULE} ${THREADS_PENDING_RULE} thread_list shows each with your answers.`;
}
