import { useEffect, useRef } from 'react';
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
 * A plain click opens the task on Home (openTaskOnHome, the one task open;
 * there is no task page); in a pop-out window that opens it in the app's own
 * window, so the pop-out keeps what it shows. Modifier clicks keep the browser's open-in-new-tab
 * behavior, and the href's `/tasks/<id>` lands on Home there too.
 */
export function useTaskLinkClickFallback(navigate: (to: string) => void): void {
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(() => {
    // The pill a press began on. A surface that redraws its words between the press and the
    // release (a label or a message landing, React writing innerHTML) replaces the pill under the
    // pointer, and then neither Chromium nor WebKit sends any click at all: the press did nothing
    // (2026-11-13, a details popup's chip that "kept the panel"). A release on a pill of the same
    // task, with the pressed one gone, opens it.
    let pressed: { el: HTMLAnchorElement; id: string; x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      const pill = (e.target as Element | null)?.closest?.(PILL) as HTMLAnchorElement | null;
      const id = pill?.dataset.taskId;
      pressed = pill && id && e.button === 0 && !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
        ? { el: pill, id, x: e.clientX, y: e.clientY } : null;
    };
    const onUp = (e: PointerEvent) => {
      const was = pressed;
      pressed = null;
      if (!was || was.el.isConnected || e.button !== 0) return;
      if (Math.hypot(e.clientX - was.x, e.clientY - was.y) >= 4) return;
      const under = document.elementFromPoint(e.clientX, e.clientY)?.closest(PILL) as HTMLAnchorElement | null;
      if (under?.dataset.taskId !== was.id) return;
      openTaskOnHome(was.id, navigateRef.current);
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.(PILL) as HTMLAnchorElement | null;
      const taskId = anchor?.dataset.taskId;
      if (!taskId) return;
      e.preventDefault();
      openTaskOnHome(taskId, navigateRef.current);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('click', onClick);
    };
  }, []);
}

const PILL = 'a.task-link[data-task-id]';
