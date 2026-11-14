/**
 * THE way a click on a task reference opens that task: Home, with the task's session open in
 * its column (or the task selected in the list when it has none), and nothing else. A task-ref
 * pill in agent text, a chip in a details popup, a thread, the Brief, a Board card, a letter, a
 * search result, an Org rail row: every one calls the function this hook returns.
 *
 * 2026-11-13, the user: "why I clcik the taskroute to it jump this task detail I want it direct
 * to go task, can we make sure it is coded like this we find so many same issue, We want to clcik
 * go to taht sesison in home that is it". The class of bug was a task-open callback threaded
 * through props (`onTaskClick`, `onOpenTask`, `onFocusChild`, ...): each page that hosted a
 * surface picked its own action for it (a second details popup, an Org side panel, a Board
 * column), so the same chip did different things in different places. There is no such prop any
 * more; tests/web/task-ref-click-guard.test.ts fails on one.
 *
 * A window that is not the app (the browser extension's panel) has no Home of its own and hands
 * the open to its own host through TaskOpenerContext; only web/src/popout/ may provide it.
 */
import { createContext, useContext, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { openTaskOnHome, type OpenTaskOptions } from '@/utils/open-session';

export type { OpenTaskOptions };
export type OpenTask = (taskId: string, opts?: OpenTaskOptions) => void;

/** A non-app window's own way to Home (the extension panel). Provided only under web/src/popout/. */
export const TaskOpenerContext = createContext<OpenTask | null>(null);

/**
 * A layer over Home (a dialog, a sheet, a details popup a component keeps itself) closes when a
 * task opens from anywhere, a pill inside it included: the task is what the person asked to see,
 * and Home under the layer is where it opens. `openTaskOnHome` sends `main:locate-task`.
 */
export function useYieldsToTaskOpen(close: () => void, active = true): void {
  useEffect(() => {
    if (!active) return;
    // Called bare: a close that takes an optional argument must not read the event as one.
    const onOpen = () => close();
    window.addEventListener('main:locate-task', onOpen);
    return () => window.removeEventListener('main:locate-task', onOpen);
  }, [close, active]);
}

/** Stable: one identity for the component's life, so memoized children keep theirs. */
export function useOpenTask(): OpenTask {
  const navigate = useNavigate();
  const host = useContext(TaskOpenerContext);
  // Lean: runs the latest render's navigate and host, holds no render alive.
  return useLeanCallback((taskId: string, opts?: OpenTaskOptions) => {
    if (host) host(taskId, opts);
    else openTaskOnHome(taskId, navigate, opts);
  }, []);
}
