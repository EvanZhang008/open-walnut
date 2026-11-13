import { useLayoutEffect, useMemo, useState, type DependencyList } from 'react';

/**
 * `useCallback` without the leak: the same identity rule, a function that keeps no render alive.
 *
 * V8 (and JavaScriptCore) give every closure made in one render ONE shared scope object, holding
 * every variable any of them reads. A `useCallback` value is the closure of the render where its
 * deps last changed, so it keeps that whole render alive (its task list, its maps, every value it
 * computed). That render's scope in turn holds the cached callbacks it read, each born in an
 * earlier render, and so on: in a component with a hundred callbacks nearly every render it ever
 * drew stays reachable. 2026-11-13, heap snapshot of the Home page after 80 minutes of live use:
 * 183 of 187 TodoPanel render scopes were reachable from another one, each with that render's
 * task list and notes (78 to 362 copies of the note strings).
 *
 * `useLeanCallback(fn, deps)` returns a new function exactly when `deps` change, like
 * `useCallback`. That function is made by `makeLean` at module level, so its scope is a small
 * slot, never the component's render. Every identity of one call site reads one box that holds
 * the latest COMMITTED render's `fn` (written in a layout effect), so an identity someone still
 * holds (an old render's scope, a memoized row's onClick) keeps no render of its own: through it
 * only the latest committed render is reachable.
 *
 * A new identity runs the `fn` of the render that made it until that render commits, as
 * useCallback's does, so a call later in that render (a `useMemo` that calls it, a child calling
 * it while rendering) runs it. These components render inside startTransition, where React may
 * drop a render: a dropped render never writes the box, so it never reaches the handlers the page
 * holds (the C24 trap, `useCommittedRef.ts`).
 *
 * Behaviour differences from `useCallback`, on purpose:
 * - Every identity, old ones included, runs the latest committed render's `fn`, so values the
 *   deps leave out are never stale after a commit, and an old identity runs today's logic.
 * - A call during a render whose deps did not change runs the previous commit's `fn`.
 *
 * An object of handlers (`useMemo(() => ({ count, onOpen: () => … }), deps)`) has the same leak:
 * name each handler with `useLeanCallback` and put the names in the object, or build the object
 * in a module-level function that takes the values it needs (TodoPanel's `makeWorkerFoldCtl`).
 *
 * `tests/web/lean-callback-ratchet.test.ts` counts the plain `useCallback` calls and the
 * closure-holding memos left in web/src; the counts only fall.
 */
/** Any function, without letting an unannotated parameter turn into `any` (React's own
 *  `T extends Function` keeps that check; `any[]` here would silently drop it). */
type AnyFn = (...args: never[]) => unknown;

/** One per hook call site: the latest committed render's fn. */
interface Box<T extends AnyFn> { fn: T | undefined }
/** One per identity. `own` is the fn of the render that made it, kept only until that render
 *  commits; after that the identity reads the box, so an identity someone still holds keeps
 *  nothing of the render it was born in (a live A/B showed the earlier per-identity slot still
 *  chained renders: an old identity kept its last fn, whose render kept older identities). */
interface Lean<T extends AnyFn> { box: Box<T>; own: T | undefined; call: T }

function makeBox<T extends AnyFn>(): Box<T> { return { fn: undefined } }

/** Module level on purpose: `call`'s scope is this slot, nothing of the component. */
function makeLean<T extends AnyFn>(box: Box<T>, own: T): Lean<T> {
  const lean = { box, own, call: undefined } as unknown as Lean<T>;
  lean.call = ((...args: Parameters<T>) => (lean.own ?? lean.box.fn)!(...args)) as T;
  return lean;
}

export function useLeanCallback<T extends AnyFn>(fn: T, deps: DependencyList): T {
  const box = useState<Box<T>>(makeBox)[0];
  // The deps are the caller's, exactly as with useCallback.
  const lean = useMemo<Lean<T>>(() => makeLean(box, fn), deps); // eslint-disable-line react-hooks/exhaustive-deps
  // A new identity runs this render's fn until the render commits, as useCallback's does, so a
  // call later in the same render sees it. A render React drops (these components render inside
  // startTransition) never writes the box, so it never reaches the handlers the page holds.
  useLayoutEffect(() => { box.fn = fn; lean.own = undefined; });
  return lean.call;
}
