/**
 * The first of a task's Threads above its chat (experiment top_thread; 2026-11-20, the user: "Only
 * one type, is just called thread ... top only show one but will show how many left, but thread
 * will show all ... also top can be hide, and when hide people can also have a button show it").
 *
 * Not a card of its own kind: the threads that wait on him (thread-groups.ts threadsForHim, in the
 * Threads view's needs-first order), one thread at a time, through the same card (OrgThreads
 * ThreadItem) with its own reply box. "1 / N" and the arrows step through all of them; N is the
 * count the header and the Threads tab show. A thread that leaves the list gives its place to the
 * next one by itself: his reply makes it the node's or the task's move at once, a card of a task
 * below included while his reply is still on its way there (2026-11-21, the user: "i send it, but
 * the thread don't go away ... I have to manually click next"); the Threads view keeps it in Working
 * with his words. Hidden, it is one line that counts them, with Show; that choice is kept
 * (usePageView), for every chat alike.
 *
 * Its height stays bound, so long words scroll inside their own block; a block cut off fades at its
 * end, and the bar offers "Show all", which opens the thread whole in the Threads view (scrolled to
 * it and marked, thread-focus.ts), as a click on its title does (2026-11-21, a review on his data:
 * the words stopped mid-line, and the title only folded the card in a room too small to show it).
 */
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Task } from '@open-walnut/core';
import { orgDisplayTitle } from '@open-walnut/org-tree';
import { sharedAnswers, threadCountLabel } from '@open-walnut/thread-view';
import type { ImageAttachment } from '@/api/chat';
import { useSessionSend } from '@/hooks/useSessionSend';
import { isBoolean, usePageView } from '@/utils/view-memory';
import { ThreadItem } from './OrgThreads';
import { useNamedTasks } from './useNamedTasks';
import { askThreadFocus, setTopThreads, useFocusedThread } from './thread-focus';
import { ReplyThreadContext } from '@/components/sessions/reply-thread-line';
import type { OrgThreadsState } from './useOrgThreads';
import { TOP_HIDDEN_VIEW, hiddenLine, topIndex, topThreads } from './top-thread-model';
import type { OrgThread } from '@/api/org-threads';
import '@/styles/top-thread.css';

/** The card's blocks of words that scroll inside themselves in the top (top-thread.css). */
const WORD_BLOCKS = '.org-thread-summary, .org-thread-unread, .org-thread-conversation, .ask-card-detail';

/**
 * Is any of the card's words cut off? Each block that has more below its end is marked
 * data-clipped (it fades there, top-thread.css), read again as the room, the words or the scroll
 * change. `key` names the card on show.
 */
function useClippedWords(root: RefObject<HTMLElement | null>, key: string | undefined): boolean {
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || !key) { setClipped(false); return; }
    const blocks = () => [...el.querySelectorAll<HTMLElement>(WORD_BLOCKS)];
    const check = () => {
      let any = false;
      for (const b of blocks()) {
        const more = b.scrollHeight - b.clientHeight > 1;
        if (more) any = true;
        if (more && b.scrollTop + b.clientHeight < b.scrollHeight - 1) b.dataset.clipped = 'true';
        else delete b.dataset.clipped;
      }
      setClipped(any);
    };
    check();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check);
    ro?.observe(el);
    for (const b of blocks()) { ro?.observe(b); for (const c of b.children) ro?.observe(c); }
    el.addEventListener('scroll', check, true);
    return () => { ro?.disconnect(); el.removeEventListener('scroll', check, true); };
  }, [root, key]);
  return clipped;
}

/** The list the top steps through and the clock it was read at, ticking while the chat is open. */
export function useTopThreads(threads: OrgThreadsState): { at: number; list: OrgThread[] } {
  const [now, setNow] = useState(() => Date.now());
  // "3 min ago" stays true, and a thread that comes back by time alone (a snooze's end, an overdue one) shows.
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(id); }, []);
  const all = threads.threads;
  // A re-read at a snooze's end must not wait for the clock's next tick (as OrgThreads).
  return useMemo(() => { const at = Math.max(now, Date.now()); return { at, list: topThreads(all, at) }; }, [all, now]);
}

export function TopThread({ task, sessionId, threads, list, at }: {
  task: Task; sessionId: string; threads: OrgThreadsState;
  /** useTopThreads: what the top steps through, read at `at`. */
  list: readonly OrgThread[]; at: number;
}) {
  const { send } = useSessionSend(sessionId);
  const [hidden, setHidden] = usePageView(TOP_HIDDEN_VIEW.page, TOP_HIDDEN_VIEW.name, false, isBoolean);
  const all = threads.threads;
  const shared = useMemo(() => sharedAnswers(all ?? []), [all]);
  /** The thread on show: a passing cursor, not a view choice. */
  const [atId, setAtId] = useState<string | null>(null);
  const lastIndex = useRef(0);
  const i = topIndex(list, atId, lastIndex.current);
  const t = i >= 0 ? list[i] : undefined;
  // The thread on show stays on show while it is listed, wherever a newer one sorts in (his open
  // reply box and an unread fold are never swapped for another thread's under him); once it
  // leaves, the one that took its place is the one on show.
  useEffect(() => {
    if (i >= 0) lastIndex.current = i;
    if (t && t.id !== atId) setAtId(t.id);
  }, [i, t, atId]);
  // A thread line in this chat about one of these steps the top to it and marks it (thread-focus.ts);
  // hidden, the top lists none, so the line opens the Threads view as without it.
  useEffect(() => {
    setTopThreads(task.id, hidden ? null : list.map((x) => x.id));
    return () => setTopThreads(task.id, null);
  }, [task.id, hidden, list]);
  const rootRef = useRef<HTMLDivElement>(null);
  const focused = useFocusedThread(hidden ? undefined : task.id, list, rootRef, (x) => setAtId(x.id));
  const tasks = useNamedTasks(t?.tasks);
  // The chat's host brings its own Threads into view (reply-thread-line.tsx): there the card reads whole.
  const host = useContext(ReplyThreadContext);
  const clipped = useClippedWords(rootRef, hidden || !t ? undefined : `${t.id}:${t.updatedAt}`);
  if (!t) return null;
  const readWhole = host && host.chat === task.id ? () => { askThreadFocus(task.id, t.id); host.showOwn(); } : undefined;
  const n = list.length;
  const step = (to: number) => { const next = list[to]; if (next) { lastIndex.current = to; setAtId(next.id); } };
  const followUp = (threadId: string, text: string, images?: ImageAttachment[]) => send(sessionId, text, images, { threadId });
  if (hidden) {
    return (
      <div className="top-thread is-hidden" data-testid="top-thread" data-hidden="true" data-count={n}>
        <button type="button" className="top-thread-line" data-testid="top-thread-show" aria-expanded={false} onClick={() => setHidden(false)}
          title="Show the first thread above the chat">
          <i className={`top-thread-dot${list.some((x) => x.state === 'needs') ? ' is-needs' : ''}`} aria-hidden="true" />
          <span data-testid="top-thread-count">{hiddenLine(list)}</span>
          <span aria-hidden="true">{' · '}</span>
          <span className="top-thread-show">Show</span>
        </button>
      </div>
    );
  }
  return (
    <div ref={rootRef} className="top-thread" data-testid="top-thread" data-count={n} data-thread-id={t.id}>
      <div className="top-thread-bar">
        <button type="button" className="top-thread-step" data-testid="top-thread-prev" aria-label="Previous thread" disabled={i === 0} onClick={() => step(i - 1)}>{'‹'}</button>
        <span className="top-thread-pos" data-testid="top-thread-pos" title={`${i + 1} of ${threadCountLabel(n)} for you`}>{i + 1} / {n}</span>
        <button type="button" className="top-thread-step" data-testid="top-thread-next" aria-label="Next thread" disabled={i === n - 1} onClick={() => step(i + 1)}>{'›'}</button>
        {n - i - 1 > 0 && <span className="top-thread-left" data-testid="top-thread-left">{n - i - 1} more</span>}
        {clipped && readWhole && (
          <button type="button" className="top-thread-whole" data-testid="top-thread-whole" onClick={readWhole}
            title="Its words are cut off here: open it whole in the Threads view">Show all</button>
        )}
        <button type="button" className="top-thread-hide" data-testid="top-thread-hide" aria-expanded={true} onClick={() => setHidden(true)}
          title="Hide it to one line that counts the threads">Hide <span aria-hidden="true">{'˄'}</span></button>
      </div>
      <ul className="org-thread-list top-thread-list" data-testid="top-thread-list">
        <ThreadItem key={t.id} t={t} all={all ?? []} shared={shared} tasks={tasks} state={threads} onFollowUp={followUp}
          name={orgDisplayTitle(task)} now={at} snoozed={false} owner={task} focused={focused === t.id} {...(readWhole ? { onReadWhole: readWhole } : {})} />
      </ul>
    </div>
  );
}
