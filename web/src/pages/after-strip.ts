/**
 * Run `fn` once the session strip, as last rendered, satisfies `ready` (a column just closed
 * is gone from it, say). The column handlers that write the strip whole (`openSessionOrToast`)
 * read it from a ref the render updates, so a write in the same tick as a close would bring
 * the closed column back; a timeout of 0 is not enough on a loaded machine, where the render
 * lands later. Polls every 16 ms (frames stop in a hidden page; timers do not), for at most
 * `maxMs`, then runs `fn` anyway.
 */
export function afterStrip(ready: () => boolean, fn: () => void, maxMs = 2000): () => void {
  const until = Date.now() + maxMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const tick = () => {
    if (done) return;
    if (ready() || Date.now() >= until) { done = true; fn(); return; }
    timer = setTimeout(tick, 16);
  };
  timer = setTimeout(tick, 0);
  return () => { done = true; if (timer) clearTimeout(timer); };
}
