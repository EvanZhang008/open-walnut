/**
 * The first of a task's Threads above its chat (experiment top_thread; 2026-11-20, the user: "Only
 * one type, is just called thread ... top only show one but will show how many left, but thread
 * will show all ... also top can be hide, and when hide people can also have a button show it").
 *
 * Not a card of its own kind: the same list the Threads view draws (thread-view.ts listedForHim, in
 * its needs-first order), one thread at a time, through the same card (OrgThreads ThreadItem) with
 * its own reply box. "1 / N" and the arrows step through all of them; N is the count the header and
 * the Threads tab show. A thread that leaves the list (his reply makes it working) gives its place
 * to the next one. Hidden, it is one line that counts them, with Show; that choice is kept
 * (usePageView), for every chat alike.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { orgDisplayTitle } from '@open-walnut/org-tree';
import { sharedAnswers } from '@open-walnut/thread-view';
import type { ImageAttachment } from '@/api/chat';
import { useTaskListSelect } from '@/contexts/TasksContext';
import { useSessionSend } from '@/hooks/useSessionSend';
import { isBoolean, usePageView } from '@/utils/view-memory';
import { ThreadItem } from './OrgThreads';
import type { OrgThreadsState } from './useOrgThreads';
import { TOP_HIDDEN_VIEW, hiddenLine, topIndex, topThreads } from './top-thread-model';
import type { OrgThread } from '@/api/org-threads';
import '@/styles/top-thread.css';

const NO_IDS: readonly string[] = [];
const NO_TASKS: readonly Task[] = [];

/**
 * The rows of the tasks a thread names (its chips, its deadline), re-rendering only when one of
 * them changes: the card above a chat never reads the whole list, which changes on every task write.
 */
function useNamedTasks(ids: readonly string[] | undefined): readonly Task[] {
  const want = ids ?? NO_IDS;
  const kept = useRef<readonly Task[]>(NO_TASKS);
  return useTaskListSelect(({ tasks }) => {
    const next = want.length ? tasks.filter((x) => want.includes(x.id)) : NO_TASKS;
    const prev = kept.current;
    if (prev.length === next.length && prev.every((x, j) => x === next[j])) return prev;
    kept.current = next;
    return next;
  }) ?? NO_TASKS;
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
  const tasks = useNamedTasks(t?.tasks);
  if (!t) return null;
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
    <div className="top-thread" data-testid="top-thread" data-count={n} data-thread-id={t.id}>
      <div className="top-thread-bar">
        <button type="button" className="top-thread-step" data-testid="top-thread-prev" aria-label="Previous thread" disabled={i === 0} onClick={() => step(i - 1)}>{'‹'}</button>
        <span className="top-thread-pos" data-testid="top-thread-pos">{i + 1} / {n}</span>
        <button type="button" className="top-thread-step" data-testid="top-thread-next" aria-label="Next thread" disabled={i === n - 1} onClick={() => step(i + 1)}>{'›'}</button>
        {n - i - 1 > 0 && <span className="top-thread-left" data-testid="top-thread-left">{n - i - 1} more</span>}
        <button type="button" className="top-thread-hide" data-testid="top-thread-hide" aria-expanded={true} onClick={() => setHidden(true)}
          title="Hide it to one line that counts the threads">Hide <span aria-hidden="true">{'˄'}</span></button>
      </div>
      <ul className="org-thread-list top-thread-list" data-testid="top-thread-list">
        <ThreadItem key={t.id} t={t} all={all ?? []} shared={shared} tasks={tasks} state={threads} onFollowUp={followUp}
          name={orgDisplayTitle(task)} now={at} snoozed={false} owner={task} />
      </ul>
    </div>
  );
}
