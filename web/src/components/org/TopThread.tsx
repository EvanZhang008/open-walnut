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
 * (usePageView), for every chat alike. With threads_each_question on, the bar and the line also say
 * how many of the chat's threads are being worked on ("· 2 working"), and with none for him the line
 * shows alone and opens the Threads view (2026-11-25: his question in Working read as no thread).
 *
 * Its height stays bound, so long words scroll inside their own block; a block cut off fades at its
 * end, and the bar offers "Show all", which opens the thread whole in the Threads view (scrolled to
 * it and marked, thread-focus.ts), as a click on its title does (2026-11-21, a review on his data:
 * the words stopped mid-line, and the title only folded the card in a room too small to show it).
 */
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
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
import { TOP_HIDDEN_VIEW, decisionsElsewhere, hiddenAsk, hiddenLine, topIndex, topThreads, workingLabel, workingThreads } from './top-thread-model';
import { useExperimental } from '@/hooks/useExperimental';
import { useOpenThread } from './open-thread';
import type { ActionItem } from '@open-walnut/user-status';
import type { OrgThread } from '@/api/org-threads';
import { ICON_CHEVRON_LEFT, ICON_CHEVRON_RIGHT } from '@/components/common/Icons';
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

/**
 * The list the top steps through and the clock it was read at, ticking while the chat is open, and
 * the chat's threads being worked on (workingThreads), counted after them with threads_each_question
 * on (none while it is off: the top as before).
 */
export function useTopThreads(threads: OrgThreadsState): { at: number; list: OrgThread[]; working: OrgThread[] } {
  const [now, setNow] = useState(() => Date.now());
  // "3 min ago" stays true, and a thread that comes back by time alone (a snooze's end, an overdue one) shows.
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(id); }, []);
  const all = threads.threads;
  const eachQuestion = useExperimental('threads_each_question');
  // A re-read at a snooze's end must not wait for the clock's next tick (as OrgThreads).
  return useMemo(() => {
    const at = Math.max(now, Date.now());
    return { at, list: topThreads(all, at), working: eachQuestion ? workingThreads(all, at) : [] };
  }, [all, now, eachQuestion]);
}

/** Where the top stands in `list`: the thread on show, and how to move to another. */
export interface TopCursor { i: number; t: OrgThread | undefined; step(to: number): void; show(id: string): void }

/**
 * The thread on show: a passing cursor, not a view choice. Held by the chat's top (SessionTop), so
 * the strip beside it knows which thread is on screen and draws what the others hold.
 */
export function useTopCursor(list: readonly OrgThread[]): TopCursor {
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
  return {
    i, t,
    step: (to) => { const next = list[to]; if (next) { lastIndex.current = to; setAtId(next.id); } },
    show: setAtId,
  };
}

export function TopThread({ task, sessionId, threads, list, at, cursor, decisions = [], working = [] }: {
  task: Task; sessionId: string; threads: OrgThreadsState;
  /** useTopThreads: what the top steps through, read at `at`. */
  list: readonly OrgThread[]; at: number;
  /** useTopThreads: the chat's threads being worked on, counted after `list` (empty: the top as before). */
  working?: readonly OrgThread[];
  /** useTopCursor over `list`. */
  cursor: TopCursor;
  /** The task's Action needed items the strip leaves to the threads: the bar points to one held elsewhere. */
  decisions?: readonly ActionItem[];
}) {
  const { send } = useSessionSend(sessionId);
  const [hidden, setHidden] = usePageView(TOP_HIDDEN_VIEW.page, TOP_HIDDEN_VIEW.name, false, isBoolean);
  const all = threads.threads;
  const shared = useMemo(() => sharedAnswers(all ?? []), [all]);
  const { i, t, step } = cursor;
  // A thread line in this chat about one of these steps the top to it and marks it (thread-focus.ts);
  // hidden, the top lists none, so the line opens the Threads view as without it.
  useEffect(() => {
    setTopThreads(task.id, hidden ? null : list.map((x) => x.id));
    return () => setTopThreads(task.id, null);
  }, [task.id, hidden, list]);
  const rootRef = useRef<HTMLDivElement>(null);
  const focused = useFocusedThread(hidden ? undefined : task.id, list, rootRef, (x) => cursor.show(x.id));
  const tasks = useNamedTasks(t?.tasks);
  // The chat's host brings its own Threads into view (reply-thread-line.tsx): there the card reads whole.
  const host = useContext(ReplyThreadContext);
  const openThread = useOpenThread();
  const clipped = useClippedWords(rootRef, hidden || !t ? undefined : `${t.id}:${t.updatedAt}`);
  // Nothing for him, some being worked on: the one line alone, shown or hidden alike; with no card
  // to show, a click opens the Threads view on the first of them (its Working group opens).
  if (!t) {
    const first = working[0];
    if (!first) return null;
    const openWorking = () => {
      if (host && host.chat === task.id) { askThreadFocus(task.id, first.id); host.showOwn(); }
      else openThread(task.id, first.id);
    };
    return (
      <div className="top-thread is-hidden" data-testid="top-thread" data-hidden={hidden ? 'true' : 'false'} data-count={0} data-working={working.length}>
        <FoldedLine testId="top-thread-show" title="Open the Threads being worked on" needs={false} action="Open" onShow={openWorking}>
          <span className="top-thread-line-count" data-testid="top-thread-count">{hiddenLine(list, working.length)}</span>
        </FoldedLine>
      </div>
    );
  }
  const readWhole = host && host.chat === task.id ? () => { askThreadFocus(task.id, t.id); host.showOwn(); } : undefined;
  const n = list.length;
  const elsewhere = decisionsElsewhere(list, i, decisions);
  // Each click goes on to the next one after the thread on show, then round to the first.
  const nextDecision = elsewhere.find((k) => k > i) ?? elsewhere[0];
  const followUp = (threadId: string, text: string, images?: ImageAttachment[]) => send(sessionId, text, images, { threadId });
  if (hidden) {
    const asking = hiddenAsk(list, decisions);
    return (
      <div className="top-thread is-hidden" data-testid="top-thread" data-hidden="true" data-count={n} data-working={working.length}>
        <FoldedLine testId="top-thread-show" title="Show the first thread above the chat" needs={!!asking} onShow={() => setHidden(false)}>
          <span className="top-thread-line-count" data-testid="top-thread-count">{hiddenLine(list, working.length)}</span>
          {/* The question it waits on stays in sight in this one line, never redrawn by the strip. */}
          {asking && <><span aria-hidden="true">{' · '}</span><span className="top-thread-line-title" data-testid="top-thread-hidden-title">{asking.title}</span></>}
        </FoldedLine>
      </div>
    );
  }
  return (
    <div ref={rootRef} className="top-thread" data-testid="top-thread" data-count={n} data-working={working.length} data-thread-id={t.id}>
      <div className="top-thread-bar">
        <button type="button" className="top-thread-step" data-testid="top-thread-prev" aria-label="Previous thread" disabled={i === 0} onClick={() => step(i - 1)}>{ICON_CHEVRON_LEFT}</button>
        <span className="top-thread-pos" data-testid="top-thread-pos" title={`${i + 1} of ${threadCountLabel(n)} for you`}>{i + 1} / {n}</span>
        <button type="button" className="top-thread-step" data-testid="top-thread-next" aria-label="Next thread" disabled={i === n - 1} onClick={() => step(i + 1)}>{ICON_CHEVRON_RIGHT}</button>
        {n - i - 1 > 0 && <span className="top-thread-left" data-testid="top-thread-left">{n - i - 1} more</span>}
        {/* The chat's threads being worked on, after the ones for him (threads_each_question). */}
        {working.length > 0 && <><span className="top-thread-sep" aria-hidden="true">{'·'}</span><span data-testid="top-thread-working">{workingLabel(working.length)}</span></>}
        {elsewhere.length > 0 && (
          <button type="button" className="btn btn-link btn-sm top-thread-elsewhere" data-testid="top-thread-elsewhere" onClick={() => { if (nextDecision !== undefined) step(nextDecision); }}
            title="A decision of this task is on another thread: show it">
            <i className="top-thread-dot is-needs" aria-hidden="true" />
            {elsewhere.length === 1 ? `Decision on ${elsewhere[0]! + 1} / ${n}` : `${elsewhere.length} decisions on other threads`}<span className="wn-dir-mark" aria-hidden="true">{ICON_CHEVRON_RIGHT}</span>
          </button>
        )}
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

/** One folded line above the chat, its dot (red when it waits on him), its words and Show (`action`:
 *  Open when it opens the Threads view instead): the top's hidden line and the strip's
 *  (actions/SessionActionStrip.tsx) are the same line. */
export function FoldedLine({ testId, title, needs, onShow, action = 'Show', children }: { testId: string; title: string; needs: boolean; onShow: () => void; action?: 'Show' | 'Open'; children: ReactNode }) {
  return (
    <button type="button" className="top-thread-line" data-testid={testId} aria-expanded={false} onClick={onShow} title={title}>
      <i className={`top-thread-dot${needs ? ' is-needs' : ''}`} aria-hidden="true" />
      {children}
      <span aria-hidden="true">{' · '}</span>
      <span className="top-thread-show">{action}</span>
    </button>
  );
}
