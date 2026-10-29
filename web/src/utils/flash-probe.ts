/**
 * Flash probe: a cheap recorder of what makes a chat timeline visibly jump.
 *
 * 2026-10-29: the Org page's CEO chat "flashed" now and then in the Mac app and
 * the user could not catch it by eye. This writes what happened to the browser
 * log instead, for a reader to correlate afterwards:
 *   - rewrite: a rendered body's children were replaced while it stayed mounted
 *     (an innerHTML write), with how many images went with them;
 *   - jump:    the scroll position moved 120px or more with no input from the
 *     reader in the 600ms before (a pin, a layout shift, a reload);
 *   - resize:  the timeline's own box changed height by 24px or more (something
 *     above or below it appeared or went away).
 * One line per timeline per 5s at most, only when an image went, the view
 * jumped or the box resized.
 *
 * Temporary: off by itself after FLASH_PROBE_UNTIL, and `walnut:flash-probe` =
 * '0' in localStorage turns it off sooner.
 */
import { log } from '@/utils/log';

export const FLASH_PROBE_UNTIL = Date.parse('2026-11-05T00:00:00Z');
const FLUSH_MS = 5000;
const JUMP_PX = 120;
const INPUT_QUIET_MS = 600;
const RESIZE_PX = 24;
const MAX_SAMPLES = 4;

export function flashProbeEnabled(now = Date.now()): boolean {
  if (now >= FLASH_PROBE_UNTIL) return false;
  try { return localStorage.getItem('walnut:flash-probe') !== '0'; } catch { return true; }
}

interface Sample { at: string; kind: string; [k: string]: unknown }

/** Watch one scrolling timeline; returns the stop function. */
export function startFlashProbe(scroller: HTMLElement, sessionId: string): () => void {
  if (!flashProbeEnabled() || typeof MutationObserver === 'undefined') return () => {};
  let bodyWrites = 0;
  let imgsReplaced = 0;
  let jumps = 0;
  let resizes = 0;
  const samples: Sample[] = [];
  const note = (s: Sample) => { if (samples.length < MAX_SAMPLES) samples.push(s); };
  const stamp = () => new Date().toISOString().slice(11, 23);

  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type !== 'childList' || m.removedNodes.length === 0 || m.addedNodes.length === 0) continue;
      const target = m.target as HTMLElement;
      // A body rewritten in place: it stays, its children are swapped wholesale.
      if (!target.classList?.contains('markdown-body') && !target.classList?.contains('provenance-body')) continue;
      let imgs = 0;
      m.removedNodes.forEach((n) => {
        if (n.nodeType !== 1) return;
        const e = n as Element;
        imgs += (e.tagName === 'IMG' ? 1 : 0) + e.querySelectorAll('img').length;
      });
      bodyWrites++;
      imgsReplaced += imgs;
      if (imgs) note({ at: stamp(), kind: 'rewrite', imgs, nodes: m.removedNodes.length });
    }
  });
  mo.observe(scroller, { subtree: true, childList: true });

  let lastInput = 0;
  const onInput = () => { lastInput = Date.now(); };
  const inputs = ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const;
  for (const ev of inputs) scroller.addEventListener(ev, onInput, { passive: true, capture: true });
  let lastTop = scroller.scrollTop;
  let lastSh = scroller.scrollHeight;
  const onScroll = () => {
    const top = scroller.scrollTop;
    const sh = scroller.scrollHeight;
    if (Math.abs(top - lastTop) >= JUMP_PX && Date.now() - lastInput > INPUT_QUIET_MS) {
      jumps++;
      note({ at: stamp(), kind: 'jump', from: Math.round(lastTop), to: Math.round(top), shFrom: Math.round(lastSh), shTo: Math.round(sh) });
    }
    lastTop = top;
    lastSh = sh;
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });

  let lastHeight = scroller.clientHeight;
  const ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => {
      const h = scroller.clientHeight;
      if (Math.abs(h - lastHeight) >= RESIZE_PX) {
        resizes++;
        note({ at: stamp(), kind: 'resize', from: lastHeight, to: h });
      }
      lastHeight = h;
    })
    : null;
  ro?.observe(scroller);

  const flush = () => {
    // Body writes alone are a streaming reply growing; they ride along, never log alone.
    if (!imgsReplaced && !jumps && !resizes) { bodyWrites = 0; return; }
    log.info('flash-probe', 'timeline churn', {
      sessionId, path: window.location.pathname, bodyWrites, imgsReplaced, jumps, resizes, samples: samples.slice(),
    });
    bodyWrites = 0; imgsReplaced = 0; jumps = 0; resizes = 0; samples.length = 0;
  };
  const timer = window.setInterval(flush, FLUSH_MS);

  return () => {
    flush();
    window.clearInterval(timer);
    mo.disconnect();
    ro?.disconnect();
    scroller.removeEventListener('scroll', onScroll);
    for (const ev of inputs) scroller.removeEventListener(ev, onInput, { capture: true });
  };
}
