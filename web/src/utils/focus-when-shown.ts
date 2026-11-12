import { useEffect, useRef } from 'react';

/**
 * Focus a box once it can take focus. A box in a hidden page (Home stays mounted, hidden, while
 * another route shows: App.tsx `visible`) or a collapsed column silently swallows focus(), so the
 * caret stayed on <body> and what the person typed next went nowhere (2026-11-03: New task from a
 * mail opened its draft while Home was still hidden, and the caret was not in the prompt). Tries
 * every frame until the box is shown and focused, for at most `maxMs` of wall time (frames are slow
 * on a loaded machine, so a frame count is no budget); at the end it focuses the box anyway, as
 * before this waited. The first try is at once, so a box already on screen has the caret in the
 * frame it first paints. Returns the cancel.
 *
 * The person's own next press ends the request, whether it is still retrying or only waiting for
 * its one look on the next frame: from then on focus is theirs to place (`onPressed` hears it). A
 * key does not: typed while the caret is still nowhere, it is the very key the box is wanted for. Without that a retry
 * took the caret back from whatever they reached for. 2026-11-12: × on the composer's question chip
 * asks for the caret, and a right-click on a mark inside the next frame (a loaded machine) opened
 * the mark's menu, which took focus; the look on the next frame put it back in the composer, and the
 * menu, which closes when focus leaves it, was gone before its item could be clicked.
 */
export function focusWhenShown(
  get: () => HTMLTextAreaElement | HTMLInputElement | null,
  onFocused?: (el: HTMLTextAreaElement | HTMLInputElement) => void,
  maxMs = 3000,
  onPressed?: () => void,
): () => void {
  const until = Date.now() + maxMs;
  let raf = 0;
  let pending = true;
  // A press already on its way when the request began (asked from a window-capture handler of
  // that press) still reaches the document after it: it is the ask, not the person's next move.
  const askedAt = performance.now();
  const stop = () => {
    if (!pending) return;
    pending = false;
    cancelAnimationFrame(raf);
    document.removeEventListener('pointerdown', onPress, true);
  };
  const onPress = (e: Event) => {
    if (e.timeStamp < askedAt) return;
    stop();
    onPressed?.();
  };
  const attempt = (first = false) => {
    const el = get();
    const last = Date.now() >= until;
    if (el && (el.offsetParent !== null || last)) {
      el.focus();
      if (document.activeElement === el || last) {
        onFocused?.(el);
        // The first try runs inside the commit, before the rest of its effects: one of them may
        // still take focus (the old first try ran a frame later, after all of them), so look once
        // more on the next frame and keep trying if the box lost it.
        if (first && !last) raf = requestAnimationFrame(() => { if (document.activeElement !== get()) attempt(); else stop(); });
        else stop();
        return;
      }
    }
    if (last) stop();
    else raf = requestAnimationFrame(() => attempt());
  };
  // Capture phase, on the document: heard before any handler below can move focus.
  document.addEventListener('pointerdown', onPress, true);
  attempt(true);
  return stop;
}

/**
 * A component's request for the caret (a nonce bumped by "focus here", or `true` for "focus on
 * open"): focusWhenShown once per request. React runs an effect again without its deps changing
 * when it reconnects a subtree (StrictMode in development, a Suspense boundary showing its
 * content again, <Activity>), and a bare effect then took the caret back to a box the person had
 * left long ago (2026-11-04: a click on a task row put the caret back in another column).
 * A falsy request clears it, so the same value later is a new request. The callbacks are read
 * when the request runs, not tracked.
 */
export function useFocusRequest(
  request: unknown,
  get: () => HTMLTextAreaElement | HTMLInputElement | null,
  onFocused?: (el: HTMLTextAreaElement | HTMLInputElement) => void,
): void {
  const done = useRef<unknown>(undefined);
  const live = useRef({ get, onFocused });
  live.current = { get, onFocused };
  useEffect(() => {
    if (!request) { done.current = undefined; return; }
    if (Object.is(done.current, request)) return;
    // A request counts as served only once a frame has passed with the caret placed. An effect torn
    // down before that (StrictMode's mount, unmount, mount, in the same commit) has not served it: a
    // sibling's cleanup in between may have moved focus (the Ask drawer's focus return put the caret
    // back on the mail row), so the effect's second run asks again.
    let settled = false;
    let raf = 0;
    const cancel = focusWhenShown(() => live.current.get(), (el) => {
      done.current = request;
      live.current.onFocused?.(el);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { settled = true; });
    }, undefined, () => {
      // The person pressed somewhere first: the request is answered by them, never asked again.
      done.current = request;
      settled = true;
    });
    return () => {
      cancel();
      cancelAnimationFrame(raf);
      if (!settled && Object.is(done.current, request)) done.current = undefined;
    };
  }, [request]);
}
