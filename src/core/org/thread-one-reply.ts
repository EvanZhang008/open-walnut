/**
 * One reply, one card (threads_each_question). Each question he asks is a thread of its own, so two
 * questions typed seconds apart are two threads, and the node's one reply answers both. A card with
 * no summary of its own shows that reply, so two such cards would show the same words; his view
 * counts a reply that sits under two threads as news on neither (thread-view.ts sharedAnswers), and
 * both cards go out of his sight with their answer. They are ONE thread (2026-11-25, the user, on
 * two cards holding one answer: "look all duplciated", "u need to combine them"), whichever way
 * each came to read answered:
 *
 *   - the answered check merges before it marks (thread-answered-check.ts markAnsweredGroup);
 *   - the node's own lines (a reply's card lines, the status question's lines) and the answers read
 *     from its chat go through `mergeOneReply` here, in the same locked write (threads-store.ts
 *     writeOwnThreads, setThreadAnswers), in either order;
 *   - the thread check joins what any other write left so, before it reads a node (thread-audit.ts).
 *   2026-11-26, real use: three questions on one matter within a minute; the node's card lines
 *   marked the last two answered with one reply and no summary, and for 84 minutes neither had a
 *   card, until the thread check came by and the node merged them.
 *
 * Only cards that say the same join: both open, here, reading answered with no summary of their own
 * (a card the node gave its own summary shows that, and stays its own card), each opened by his own
 * question whose answer is that one reply, with nothing of his still waiting there and nothing he
 * has read, acknowledged or reacted to (a card he may have read never takes another question in,
 * review 2026-11-26). A thread that holds a letter, a choice or the task's ask is left alone, and so
 * is one a split took out of another thread (review 2026-11-27: the merge would undo his split). The
 * oldest question's thread keeps; it still reads answered and is titled by every question it holds.
 */
import { eachQuestionNow, ownQuestionOf } from './thread-question.js';
import { mergeThreads, ThreadError, THREAD_TITLE_MAX, type OrgThread, type ThreadMessage, type ThreadsFile } from './threads-model.js';

const TITLE_JOIN = ' \u00b7 ';

/**
 * The kept thread's title once other questions merged into it: each question's title, in the order
 * he asked (review 2026-11-26: a card holding two unrelated questions read as the earliest alone).
 * It stays Walnut's stand-in unless the node wrote every one of them, so the status question still
 * asks the node for one title that covers the card. Titles that say the same are named once.
 * `all`: the threads as they were before the merge, the kept one first. Pure.
 */
export function titledForAll(file: ThreadsFile, all: ReadonlyArray<Pick<OrgThread, 'id' | 'title' | 'titled'>>): ThreadsFile {
  if (all.length < 2) return file;
  const seen = new Set<string>();
  const titles = all.map((t) => t.title.replace(/\s+/g, ' ').trim()).filter((t) => {
    const key = t.toLowerCase();
    if (!t || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (titles.length < 2) return file;
  const share = Math.floor((THREAD_TITLE_MAX - TITLE_JOIN.length * (titles.length - 1)) / titles.length);
  const cut = (t: string): string => (t.length <= share ? t : `${t.slice(0, Math.max(1, share - 1)).trimEnd()}\u2026`);
  const title = titles.map(cut).join(TITLE_JOIN).slice(0, THREAD_TITLE_MAX);
  const nodeWroteAll = all.every((t) => t.titled);
  return {
    ...file,
    threads: file.threads.map((t) => {
      if (t.id !== all[0].id) return t;
      // A title held for the kept question alone (titleHeld) names only that one: it goes with the old title.
      const { titled: _titled, titleHeld: _held, ...rest } = t;
      return { ...rest, title, ...(nodeWroteAll ? { titled: true } : {}) };
    }),
  };
}

interface SaysReply { thread: OrgThread; question: ThreadMessage; key: string }

/** `t` as a card that shows one reply as the answer to the question that opened it, or null when it may not join another. Pure. */
function saysReply(t: OrgThread): SaysReply | null {
  if (t.closed || t.movedTo || t.snoozed || t.state !== 'answered') return null;
  // A summary of its own is what its card shows: it says something the other does not.
  if (t.reply?.trim()) return null;
  // What it holds beyond his words stays where it is.
  if (t.letter || t.choice || t.reportAsk || t.watched) return null;
  if (t.ackedAt || t.known) return null;
  // Taken out of another thread on purpose: it stays its own.
  if (t.splitOut) return null;
  const question = ownQuestionOf(t);
  const answer = question?.answer;
  if (!question || !answer) return null;
  // Every word of his there has its answer, and he has read none of them yet.
  if (t.messages.some((m) => !m.answer || (!!m.readAt && m.readAt >= m.answer.at))) return null;
  if (t.reactedAt && t.reactedAt >= answer.at) return null;
  return { thread: t, question, key: `${answer.at}\n${answer.text}` };
}

export interface OneReplyMerge { into: string; from: string[] }

/**
 * The file with every group of cards that say one reply made one thread. `since`: the file as it was
 * before this write; only a group one of whose cards did not say that reply there is merged (a card
 * that came to say it in this write: its answer landed, or it turned answered), so a write that only
 * touches cards already side by side leaves them as they are. Without `since` every group is merged
 * (the thread check's pass, thread-audit.ts). A thread that refuses the merge is left as it was.
 * Nothing changes with the switch off. Pure but for the switch.
 */
export function mergeOneReply(file: ThreadsFile, at: string, since?: ThreadsFile): { file: ThreadsFile; merged: OneReplyMerge[] } {
  const none = { file, merged: [] as OneReplyMerge[] };
  if (!eachQuestionNow()) return none;
  const groups = new Map<string, SaysReply[]>();
  for (const t of file.threads) {
    const s = saysReply(t);
    if (!s) continue;
    const g = groups.get(s.key);
    if (g) g.push(s); else groups.set(s.key, [s]);
  }
  const saidBefore = since ? new Map(since.threads.map((t) => [t.id, saysReply(t)?.key])) : null;
  let next = file;
  const merged: OneReplyMerge[] = [];
  for (const g of groups.values()) {
    if (g.length < 2 || (saidBefore && g.every((s) => saidBefore.get(s.thread.id) === s.key))) continue;
    const [into, ...rest] = [...g].sort((a, b) => a.question.at.localeCompare(b.question.at));
    const from: SaysReply[] = [];
    for (const s of rest) {
      try {
        next = mergeThreads(next, s.thread.id, into.thread.id, 'agent', at).file;
        from.push(s);
      } catch (err) {
        if (!(err instanceof ThreadError)) throw err;
      }
    }
    if (!from.length) continue;
    // His words came in with their answer on them: the card reads answered, as each did.
    next = { ...next, threads: next.threads.map((t) => (t.id === into.thread.id ? { ...t, state: into.thread.state } : t)) };
    next = titledForAll(next, [into.thread, ...from.map((s) => s.thread)]);
    merged.push({ into: into.thread.id, from: from.map((s) => s.thread.id) });
  }
  return merged.length ? { file: next, merged } : none;
}
