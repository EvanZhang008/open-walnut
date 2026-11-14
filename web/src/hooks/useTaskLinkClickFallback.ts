import { useEffect, useRef } from 'react';
import { openTaskInApp } from '@/popout/openPopout';
import { openTaskOnHome } from '@/utils/open-session';

/**
 * Last-resort handler for task pills (`a.task-link`) on surfaces that render
 * markdown without wiring useEntityClickHandler: the plan popover, subagent
 * stream text, letters and cards added later. Without it such a click follows
 * `href="/tasks/<id>"` as a real page load, which reloads the SPA and drops every
 * open panel. Bare task ids in any reply now render as pills
 * (utils/bare-task-ids.ts), so pills reach far more surfaces than the ones that
 * were wired for them.
 *
 * Listens on `document` in the bubble phase, so it runs after React's own root
 * listener and acts only when no surface handler already called preventDefault.
 * A plain click opens the task on Home (utils/task-path.ts: there is no task
 * page); in a pop-out window it opens Home in a tab of its own, so the pop-out
 * keeps what it shows. Modifier clicks keep the browser's open-in-new-tab
 * behavior, and the href's `/tasks/<id>` lands on Home there too.
 */
export function useTaskLinkClickFallback(navigate: (to: string) => void, inPopout = false): void {
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const inPopoutRef = useRef(inPopout);
  inPopoutRef.current = inPopout;
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target as Element | null;
      const anchor = target?.closest?.('a.task-link[data-task-id]') as HTMLAnchorElement | null;
      const taskId = anchor?.dataset.taskId;
      if (!taskId) return;
      e.preventDefault();
      openTaskLink(taskId, inPopoutRef.current, navigateRef.current);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);
}

/** A task pill's plain click: Home, in a tab of its own from a pop-out. */
export function openTaskLink(taskId: string, inPopout: boolean, navigate: (to: string) => void): void {
  if (inPopout) openTaskInApp(taskId);
  else openTaskOnHome(taskId, navigate);
}
