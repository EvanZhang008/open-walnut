import { useLayoutEffect, useRef, type MutableRefObject } from 'react';

/**
 * A ref holding `value` as of the last COMMITTED render, for event handlers and effects that
 * must act on what the page shows.
 *
 * The task list lands in a transition (`useTasks` adopts each fetch in `startTransition`), and
 * React may render a transition, then drop that render when an urgent update (a click) comes
 * first, and commit the click on the state before it. A ref written during render keeps the
 * dropped render's value, so a handler acts on a list the page does not have yet, and the
 * commit that follows undoes it. 2026-11-03 (C24, CI on a 4-core runner): a session menu's
 * Details read the task from the uncommitted list and opened its detail; the click committed
 * on the old, empty list, and "the focused task left the list" closed the detail at once.
 *
 * Written in a layout effect, so it is current before any passive effect of the same commit
 * and before the next event. Never read it during render (a memo, the render body, a function they
 * call): there it still holds the commit before; pass the value itself, or close over it. `tests/web/committed-ref-guard.test.ts` fails on a render-time
 * mirror of the task list.
 */
export function useCommittedRef<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => { ref.current = value; }, [value]);
  return ref;
}
