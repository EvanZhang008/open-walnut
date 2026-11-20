/**
 * The strip under a session's title bar (experiment action_needed_everywhere; 2026-11-19, the user:
 * "我点进去之后，如果它有 needs you，它直接就能显示在……title bar，或者在下面"): its task's Action
 * needed items, the same ones as its row, answered and snoozed in place. This session's own live
 * prompt only points at its card in the chat below (ActionNeeded variant="strip").
 *
 * Experiment top_thread: a task that keeps Threads (Main, a lead, a task with Threads on) shows its
 * first thread there instead (org/TopThread.tsx), under the items that are not threads yet (a live
 * prompt, an approval), which still lead as they do today and are not counted in its "1 / N".
 */
import { memo, useLayoutEffect, useRef } from 'react';
import type { Task } from '@open-walnut/core';
import { keepsThreads } from '@open-walnut/keeps-threads';
import { useExperimental } from '@/hooks/useExperimental';
import { useOrgThreads } from '@/components/org/useOrgThreads';
import { TopThread, useTopThreads } from '@/components/org/TopThread';
import { actionsNotThreads } from '@/components/org/top-thread-model';
import { ActionNeeded } from './ActionNeeded';

export const SessionActionStrip = memo(function SessionActionStrip({ task, sessionId }: { task: Task | null | undefined; sessionId: string }) {
  const on = useExperimental('action_needed_everywhere');
  const top = useExperimental('top_thread');
  const everyTask = useExperimental('task_threads');
  if (top && task && keepsThreads(task, everyTask)) return <SessionTop task={task} sessionId={sessionId} actions={on} />;
  if (!on || !task?.user_status?.actions?.length) return null;
  return <ActionNeeded task={task} variant="strip" sessionId={sessionId} />;
});

/**
 * The room the top may take: a third of the panel's body it sits in, kept as --session-top-room
 * while the body resizes (2026-11-20, the user: "one thing takes up all of my space ... at most a
 * third or a half"). A share of the body, never a fixed size; top-thread.css splits it.
 */
function useTopRoom(shown: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const body = el?.parentElement;
    if (!el || !body) return;
    const set = () => el.style.setProperty('--session-top-room', `${Math.floor(body.clientHeight / 3)}px`);
    set();
    const watch = new ResizeObserver(set);
    watch.observe(body);
    return () => watch.disconnect();
  }, [shown]);
  return ref;
}

/** The top of a chat whose task keeps Threads: the items that are not threads (when the strip is on), then the first thread. */
function SessionTop({ task, sessionId, actions }: { task: Task; sessionId: string; actions: boolean }) {
  const threads = useOrgThreads(task.id, true);
  // One list and one clock for both: what the top shows and what the strip leaves to it.
  const { at, list } = useTopThreads(threads);
  const items = actions && task.phase !== 'COMPLETE' ? actionsNotThreads(task.user_status?.actions ?? [], list) : [];
  const shown = items.length > 0 || list.length > 0;
  const room = useTopRoom(shown);
  // Nothing to show draws nothing: an empty first child would still move the chat under the glass header.
  if (!shown) return null;
  return (
    <div className="session-top" data-testid="session-top" ref={room}>
      {items.length > 0 && <ActionNeeded task={task} variant="strip" sessionId={sessionId} items={items} />}
      {list.length > 0 && <TopThread task={task} sessionId={sessionId} threads={threads} list={list} at={at} />}
    </div>
  );
}
