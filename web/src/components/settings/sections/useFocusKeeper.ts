/**
 * Settings > Remote Hosts: the focus never falls to the page (2026-11-04 review: Refresh, Copy
 * diagnostics, Session limits > Add and Update to this build each left it on body). The page's
 * busy buttons keep it themselves (SettingsButton `holdFocus`); this is the net under every other
 * press: a press on a control in the pane watches the focus for a while, and a focus that fell to
 * the page, or sits on a control that turned disabled (WebKit keeps it there and drops it later
 * with no event), goes back to the pressed control if it can still take it, else to the control
 * that took its place: the same control drawn again (a header action moved into the sticky bar
 * is a new element with the same test id), else the one at its place in the nearest part still
 * on the page (its row, its Details, its group).
 *
 * A press anywhere else (or on no control) ends the watch: a click on blank space may put the
 * focus on the page, and that is the person's own doing. A lost focus waits one tick first: the
 * page's own landing (Escape closing a host's fields puts the focus on its More, a frame later)
 * goes first, and the net never takes the focus somewhere else before it (review: WebKit, under
 * load, ran the net first, and the focus went to another row's button).
 */
import { useEffect } from 'react';
import { focusLanded } from '@/utils/focus-landed';

const CONTROL = 'button, a[href], input, select, textarea, summary, [role="switch"], [role="radio"], [role="checkbox"], [role="button"], [tabindex="0"]';
/** The parts a lost focus falls back to, nearest first. */
const HOME = '[data-row-key], .rh-details, .rh-this-host-part, .rh-join, .settings-group-block, .settings-fold, .settings-card';
/** Menus the pane opens (portalled to body): a press there keeps the watch as it is. */
const MENUS = '.rh-add-menu, .task-kebab-project-flyout';
const WATCH_MS = 15_000;
const TICK_MS = 120;

function usable(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement) || !el.isConnected) return false;
  if ((el as HTMLButtonElement).disabled === true) return false;
  if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  return el.getClientRects().length > 0;
}

const controlsIn = (home: Element) => [...home.querySelectorAll(CONTROL)].filter(usable);

interface Watch { el: HTMLElement; id: string | null; homes: Array<{ home: Element; index: number }>; until: number }

function watchOf(el: HTMLElement, root: Element): Watch {
  const homes: Watch['homes'] = [];
  for (let at = el.parentElement?.closest(HOME); at && root.contains(at); at = at.parentElement?.closest(HOME)) {
    homes.push({ home: at, index: Math.max(0, controlsIn(at).indexOf(el)) });
  }
  return { el, id: el.getAttribute('data-testid'), homes, until: Date.now() + WATCH_MS };
}

/** Where a fallen focus goes: the pressed control, else the one now in its place. */
function fallback(w: Watch, root: Element): HTMLElement | null {
  if (usable(w.el)) return w.el;
  if (w.id) {
    const again = [...root.querySelectorAll(`[data-testid="${CSS.escape(w.id)}"]`)].find(usable);
    if (again) return again;
  }
  for (const { home, index } of w.homes) {
    if (!home.isConnected) continue;
    const list = controlsIn(home);
    if (list.length) return list[Math.min(index, list.length - 1)];
    if (home instanceof HTMLElement) return home;
  }
  return null;
}

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file']);

/** `rootOf()`: the element whose presses are watched (the pane), looked up on each press. */
export function useFocusKeeper(rootOf: () => Element | null): void {
  useEffect(() => {
    let watch: Watch | null = null;
    // When the focus was first seen lost (0 while it is not).
    let lostAt = 0;
    const arm = (target: EventTarget | null) => {
      const root = rootOf();
      const t = target instanceof Element ? target : null;
      if (t?.closest(MENUS)) return;
      const el = t?.closest<HTMLElement>(CONTROL) ?? null;
      watch = root && el && root.contains(el) ? watchOf(el, root) : null;
      lostAt = 0;
    };
    const onPointer = (e: PointerEvent) => arm(e.target);
    // A key presses a control, never a field being typed in (a space typed in a field is no press).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t && (t.isContentEditable || t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(t.type)))) return;
      arm(e.target);
    };
    const timer = window.setInterval(() => {
      if (!watch) return;
      if (Date.now() > watch.until) { watch = null; return; }
      const a = document.activeElement;
      const root = rootOf();
      // A removed element can stay the active one for a while in WebKit: that is lost too.
      const stranded = !a || a === document.body || !a.isConnected || (!!root && root.contains(a) && (a as HTMLButtonElement).disabled === true);
      if (!stranded) { lostAt = 0; return; }
      if (!lostAt) { lostAt = Date.now(); return; }
      if (!root) return;
      const to = fallback(watch, root);
      if (!to) return;
      lostAt = 0;
      if (to === watch.el) to.focus({ preventScroll: true });
      else focusLanded(to);
      if (document.activeElement === to && to !== watch.el) watch = { ...watchOf(to, root), until: watch.until };
    }, TICK_MS);
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
