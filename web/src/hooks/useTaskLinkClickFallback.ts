import { useEffect, useRef } from 'react';

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
 * The destination is the one the anchor names and useEntityClickHandler's own
 * fallback uses: the in-app task route. Modifier clicks keep the browser's
 * open-in-new-tab behavior.
 */
export function useTaskLinkClickFallback(navigate: (to: string) => void): void {
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = e.target as Element | null;
      const anchor = target?.closest?.('a.task-link[data-task-id]') as HTMLAnchorElement | null;
      const taskId = anchor?.dataset.taskId;
      if (!taskId) return;
      e.preventDefault();
      navigateRef.current(`/tasks/${encodeURIComponent(taskId)}`);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);
}
