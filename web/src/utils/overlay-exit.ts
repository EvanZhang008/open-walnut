/**
 * Closing fades for the overlay family (styles/overlay-family.css, motion.css): a menu, popover or
 * tooltip portalled into <body> fades out and shrinks a little as it closes, and a dialog's scrim
 * fades with its panel, as a menu or a sheet does on a Mac, instead of vanishing in one frame.
 *
 * React removes a closed overlay from the document at once, and the 67 overlays each close their own
 * way, so the fade is done here, once, for all of them: when a family member leaves <body>, a copy of
 * it is put back in its place, inert, hidden from assistive tech and from the pointer, and fades out
 * on the compositor (opacity and scale only) before it is dropped.
 *
 * Nothing here reads the layout at the close: a read in the middle of React's commit would lay the
 * whole page out once more (35 to 50 ms a layout on Org in the Mac app's WebKit). The copy is put
 * back in a microtask, after the commit, where the frame's own layout picks it up; its scroll
 * offsets come from the last scroll inside the overlay (a detached element reads 0), recorded by a
 * passive scroll listener while it was open.
 *
 * Not copied: an overlay that holds a live frame, video or canvas (a copy would reload or blank it),
 * one past MAX_NODES elements (the copy would cost a slow frame at the close), one hidden by its own
 * style, and every overlay while motion is reduced (utils/motion.ts).
 */
import { EASE, MOTION_MS, fullMotion } from './motion';

/** The family's kinds, as overlay-family.css names them. */
export const OVERLAY_SELECTOR = '.wn-overlay, .wn-dialog, .wn-scrim, .wn-tip';
const LIVE_CONTENT = 'iframe, video, canvas, embed, object';
const MAX_NODES = 1500;
export const EXIT_MS = MOTION_MS.fast;

/** The family member a node removed from <body> is: itself, or the first element in it. */
export function overlayRoot(node: Node): HTMLElement | null {
  if (!(node instanceof HTMLElement)) return null;
  if (node.matches(OVERLAY_SELECTOR)) return node;
  const first = node.firstElementChild;
  return first instanceof HTMLElement && first.matches(OVERLAY_SELECTOR) ? node : null;
}

/** The last scroll offsets of each element that scrolled inside an open overlay. */
const scrolled = new WeakMap<Element, [number, number]>();

function rememberScroll(e: Event) {
  const el = e.target;
  if (el instanceof Element && el.closest(OVERLAY_SELECTOR)) scrolled.set(el, [el.scrollTop, el.scrollLeft]);
}

/** Overlays still on their way in (their opening transition runs): closed then, they just go. */
const opening = new WeakSet<Element>();

function onTransition(e: TransitionEvent) {
  const el = e.target;
  if (!(el instanceof Element) || e.propertyName !== 'opacity' || !el.matches(OVERLAY_SELECTOR)) return;
  if (e.type === 'transitionstart') opening.add(el);
  else opening.delete(el);
}

const stillOpening = (root: HTMLElement) =>
  opening.has(root) || (root.firstElementChild !== null && opening.has(root.firstElementChild));

/** Copy the overlay as it was drawn; null when it gets no fade. */
export function copyForExit(el: HTMLElement): HTMLElement | null {
  if (el.hidden || el.style.display === 'none' || el.style.visibility === 'hidden') return null;
  if (el.getElementsByTagName('*').length > MAX_NODES) return null;
  if (el.querySelector(LIVE_CONTENT)) return null;
  const clone = el.cloneNode(true) as HTMLElement;
  clone.removeAttribute('id');
  for (const withId of Array.from(clone.querySelectorAll('[id]'))) withId.removeAttribute('id');
  clone.setAttribute('aria-hidden', 'true');
  clone.inert = true;
  clone.dataset.overlayExit = '';
  clone.style.pointerEvents = 'none';
  // Nothing that reads the page may take the copy for an open menu or dialog (a check for an open
  // menu swallows a shortcut, Cmd+Z, Escape), and a copied radio must not join a live group.
  for (const node of [clone, ...Array.from(clone.querySelectorAll('[role], [aria-modal], [name]'))]) {
    node.removeAttribute('role');
    node.removeAttribute('aria-modal');
    node.removeAttribute('name');
  }
  // The opening transition (overlay-family.css @starting-style) has nothing to do on a copy: a
  // copied panel inside a copied scrim would fade in while its scrim fades out.
  for (const member of [clone, ...Array.from(clone.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR))]) member.style.transition = 'none';
  return clone;
}

/** Give the copy the scroll offsets its original last had (elements matched by document order). */
function restoreScroll(original: HTMLElement, clone: HTMLElement) {
  const from = [original, ...Array.from(original.getElementsByTagName('*'))];
  let to: Element[] | null = null;
  from.forEach((node, i) => {
    const at = scrolled.get(node);
    if (!at) return;
    to ??= [clone, ...Array.from(clone.getElementsByTagName('*'))];
    const target = to[i];
    if (target) { target.scrollTop = at[0]; target.scrollLeft = at[1]; }
  });
}

function fadeOut(clone: HTMLElement) {
  const options: KeyframeAnimationOptions = { duration: EXIT_MS, easing: EASE.in, fill: 'forwards' };
  const fade = clone.animate([{ opacity: 1 }, { opacity: 0 }], options);
  // A dialog's panel shrinks a little inside its fading scrim; a menu or popover shrinks itself.
  const panel = clone.matches('.wn-dialog') ? clone : clone.querySelector<HTMLElement>('.wn-dialog');
  const shrinking = panel ?? (clone.matches('.wn-overlay') ? clone : null);
  shrinking?.animate([{ scale: '1' }, { scale: panel ? '0.97' : '0.98' }], options);
  let done = false;
  const drop = () => { if (!done) { done = true; clone.remove(); } };
  fade.finished.then(drop, drop);
  // A window in the background draws no frames: the motion waits there, and ends (and is
  // dropped) the moment the window shows again, so no timer stands in for its end.
}

let installed = false;

/**
 * At boot: give every family member that leaves <body> its closing fade. <body> is where every
 * overlay is portalled (React removes a portal's nodes with `container.removeChild`), so only
 * <body>'s own removeChild is wrapped; every other removal in the document is untouched.
 */
export function installOverlayExit(body: HTMLElement = document.body): void {
  if (installed || !body || typeof Element.prototype.animate !== 'function') return;
  installed = true;
  document.addEventListener('scroll', rememberScroll, { capture: true, passive: true });
  for (const type of ['transitionstart', 'transitionend', 'transitioncancel'] as const) document.addEventListener(type, onTransition, true);
  const removeChild = body.removeChild;
  body.removeChild = function removeChildWithExit<T extends Node>(this: HTMLElement, child: T): T {
    const found = child.parentNode === this && fullMotion() ? overlayRoot(child) : null;
    const root = found && !found.hasAttribute('data-overlay-exit') && !stillOpening(found) ? found : null;
    // Its neighbours, to put the copy back in the same place: right after the one before it, so
    // a dialog the same click opens (appended after it) stays on top of the fading copy.
    const after = root ? child.previousSibling : null;
    const before = root ? child.nextSibling : null;
    const removed = removeChild.call(this, child) as T;
    if (root) {
      const body = this;
      queueMicrotask(() => {
        if (root.isConnected) return;
        const clone = copyForExit(root);
        if (!clone) return;
        try {
          const at = after && after.parentNode === body ? after.nextSibling : before && before.parentNode === body ? before : null;
          body.insertBefore(clone, at);
          restoreScroll(root, clone);
          fadeOut(clone);
        } catch {
          clone.remove();
        }
      });
    }
    return removed;
  };
}
