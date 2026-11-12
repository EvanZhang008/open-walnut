/**
 * A visible pointer for proof videos: a dot that follows the mouse and a ripple on each
 * press, so a person watching the clip sees where a test moved and clicked (headless
 * browsers draw no cursor of their own).
 *
 * It never changes what a test reads:
 * - one host element, `<pw-pointer>`, a child of <html> (outside <body>, so `body *`,
 *   `#root` and React's tree never see it), with no text, aria-hidden, and
 *   pointer-events none, so hit tests and Playwright's actionability checks pass
 *   through it;
 * - the dot and ripples live in a CLOSED shadow root, so `div`, class and role
 *   selectors never match them, and moving the dot mutates nothing a document
 *   MutationObserver sees (observers do not cross a shadow boundary);
 * - listeners are passive and capture-phase on window, never preventing or stopping
 *   an event;
 * - it fades with the Web Animations API, no timers, so a page clock (page.clock)
 *   has nothing of it to run, and a screenshot with `animations: 'disabled'` sees the
 *   finished fade: no dot.
 *
 * Every context of a PW_VIDEO run gets it (pw-video.ts); PW_POINTER=0 turns that off.
 * A spec that wants it without recording: `await showPointer(page)` (or a context).
 */

/** The init script, run at document start in every frame of a context. */
export const POINTER_OVERLAY_JS = `(() => {
  if (window.top !== window || window.__pwPointer) return;
  window.__pwPointer = true;
  let host = null;
  let dot = null;
  let root = null;
  let fade = null;
  // Mounted once, as early as the page allows, so a test's MutationObserver on the document
  // sees at most this one insertion. (document.open(), which page.setContent runs, erases the
  // window's listeners too: such a page shows no pointer.)
  const mount = () => {
    if (!host) {
      host = document.createElement('pw-pointer');
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483647;';
      root = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = ':host{all:initial;}'
        + '.dot{position:fixed;left:0;top:0;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;'
        + 'background:rgba(255,64,64,.8);box-shadow:0 0 0 2px #fff,0 1px 4px rgba(0,0,0,.5);'
        + 'pointer-events:none;opacity:0;transition:transform 90ms linear;will-change:transform;}'
        + '.ripple{position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;'
        + 'border:3px solid rgba(255,64,64,.9);pointer-events:none;}';
      dot = document.createElement('div');
      dot.className = 'dot';
      root.append(style, dot);
    }
    if (!host.isConnected && document.documentElement) document.documentElement.appendChild(host);
  };
  if (document.documentElement) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
  const show = (x, y) => {
    mount();
    dot.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    if (fade) fade.cancel();
    fade = dot.animate([{ opacity: 1 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], { duration: 2500, fill: 'forwards' });
  };
  const ripple = (x, y) => {
    mount();
    const r = document.createElement('div');
    r.className = 'ripple';
    r.style.left = x + 'px';
    r.style.top = y + 'px';
    root.appendChild(r);
    const a = r.animate([{ transform: 'scale(.3)', opacity: 1 }, { transform: 'scale(1.4)', opacity: 0 }], { duration: 550, easing: 'ease-out', fill: 'forwards' });
    a.onfinish = () => r.remove();
  };
  const opts = { capture: true, passive: true };
  addEventListener('mousemove', (e) => show(e.clientX, e.clientY), opts);
  addEventListener('mousedown', (e) => { show(e.clientX, e.clientY); ripple(e.clientX, e.clientY); }, opts);
  addEventListener('touchstart', (e) => { const t = e.touches[0]; if (t) { show(t.clientX, t.clientY); ripple(t.clientX, t.clientY); } }, opts);
})();`

interface ContextLike { addInitScript(script: { content: string }): Promise<unknown> }

/** Draw the pointer in this page (or every page of this context) from its next document on. */
export async function showPointer(target: ContextLike): Promise<void> {
  await target.addInitScript({ content: POINTER_OVERLAY_JS })
}
