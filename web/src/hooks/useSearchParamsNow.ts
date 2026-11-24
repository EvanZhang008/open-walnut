/**
 * `useSearchParams` whose own writes show at once.
 *
 * The router renders every navigation as a React transition (BrowserRouter's default), so after a
 * page writes a search param (an Org node picked, a note opened) the old view stays on screen, and
 * takes clicks, until the new one has rendered. On a busy machine that was more than half a second:
 * 2026-11-24, a click on a section of the Org node just left folded or opened it on THAT node, and
 * the node picked a moment before showed with the section the other way. Here the page's own write
 * is shown by an urgent render, so what is on screen is always what was picked last; the router's
 * URL catches up behind it, and from then on the URL is the one source again.
 *
 * Any other move of the URL ends the pick at once: the address bar no longer holding it, read on
 * every render, and Back or Forward, which may land on the very entry the pick was made on before
 * the router ever rendered the pick, so the router renders nothing new and only the popstate tells
 * (an Apps detail opened and closed fast stayed open, 2026-11-24). Back can also come while the
 * router's render of the pick is still waiting to commit; that render already ended the pick, so the
 * Back's end must force a render of its own, or the page keeps the detail until the router's render
 * commits (a plugin's detail stayed open over 15 s, 2026-11-24). Only the router showing the picked
 * URL hands over: an older pick's navigation committed late never shows over a newer one.
 *
 * Every page that writes search params uses this (tests/web/search-params-now-guard.test.ts).
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createSearchParams, useSearchParams, type SetURLSearchParams } from 'react-router-dom';

/** The page's last write, as search text. */
export interface ParamsPick {
  next: string;
}

/**
 * The params to show: the page's pick while the address bar holds it and the router does not show
 * it yet, else the router's. `stale` says the pick is over.
 */
export function paramsShown(pick: ParamsPick | null, routed: string, live: string): { shown: string; stale: boolean } {
  if (!pick) return { shown: routed, stale: false };
  if (live !== pick.next || routed === pick.next) return { shown: routed, stale: true };
  return { shown: pick.next, stale: false };
}

/** The address bar's search, in URLSearchParams' own text form. */
function liveSearch(): string {
  try { return new URLSearchParams(window.location.search).toString(); } catch { return ''; }
}

export function useSearchParamsNow(): [URLSearchParams, SetURLSearchParams] {
  const [routed, setRouted] = useSearchParams();
  const routedText = routed.toString();
  const [pick, setPick] = useState<ParamsPick | null>(null);
  // Forces the render that ends a pick on Back. Set alone, `null` can be dropped as "no change":
  // React compares it with the value a router render still in progress already gave the pick.
  const [, repaint] = useReducer((n: number) => n + 1, 0);
  const { shown, stale } = paramsShown(pick, routedText, liveSearch());
  // The URL moved: the router shows it now (a state update while rendering, as React allows).
  if (stale) setPick(null);
  // Back or Forward ends the pick even when the router renders nothing new (it may land where it
  // was, or its render of the pick may still be waiting).
  useEffect(() => {
    if (!pick) return;
    const end = () => { setPick(null); repaint(); };
    window.addEventListener('popstate', end);
    return () => window.removeEventListener('popstate', end);
  }, [pick]);
  // One object per text: the hand-over from the pick to the router's equal URL re-runs no effect
  // that depends on the params.
  const last = useRef<{ text: string; params: URLSearchParams } | null>(null);
  const params = useMemo(() => {
    if (last.current?.text === shown) return last.current.params;
    const made = shown === routedText ? routed : new URLSearchParams(shown);
    last.current = { text: shown, params: made };
    return made;
  }, [shown, routedText, routed]);
  const latest = useRef(shown);
  latest.current = shown;
  const set = useCallback<SetURLSearchParams>((init, opts) => {
    const next = createSearchParams(typeof init === 'function' ? init(new URLSearchParams(latest.current)) : init);
    setRouted(next, opts);
    // After the write: the address bar holds it now, and the pick shows while the router catches up.
    latest.current = next.toString();
    setPick({ next: latest.current });
  }, [setRouted]);
  return [params, set];
}
