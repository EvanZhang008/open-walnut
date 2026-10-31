/**
 * Run `fn` once the element's own CSS transitions are over, never on a guessed
 * timer alone. A timer of the transition's length fires mid-glide when frames
 * come late (WebKit started a 160 ms grow a frame late and the timer read the
 * card at 445 of its 520 px, 2026-10-31), so whatever it measures is short.
 *
 * Waits `minMs` first (the style change has to land and start its transitions),
 * then for every CSS transition still running on `el` itself and one frame
 * after, at most `maxMs` in all. Endless animations (a state's breathing edge) are not transitions and
 * never hold it. Returns a cancel.
 */
export function afterOwnTransitions(el: Element | null, fn: () => void, minMs: number, maxMs = 1000): () => void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    window.clearTimeout(cap);
    fn();
  };
  const cap = window.setTimeout(run, Math.max(minMs, maxMs));
  const isTransition = (a: Animation) => (typeof CSSTransition !== 'undefined' ? a instanceof CSSTransition : 'transitionProperty' in a);
  const check = () => {
    if (done) return;
    const running = el && typeof el.getAnimations === 'function'
      ? el.getAnimations().filter((a) => isTransition(a) && a.playState === 'running')
      : [];
    // One frame more after the last one: WebKit settles `finished` a frame
    // before the final value is laid out.
    if (running.length === 0) { requestAnimationFrame(run); return; }
    // A transition cut short or retargeted rejects; a retarget starts a new one,
    // so look again rather than take a rejection for the end.
    void Promise.all(running.map((a) => a.finished.catch(() => undefined))).then(check);
  };
  const first = window.setTimeout(check, minMs);
  return () => { done = true; window.clearTimeout(cap); window.clearTimeout(first); };
}
