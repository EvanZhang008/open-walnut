/**
 * The first page's words for the extension's drawing of the next open (panel-look.ts draws the
 * page in the same places while Walnut's view starts in its frame), and the word that this page is
 * up, so the drawing goes: once the composer and the task list have painted. The task panel's tab strip and first rows
 * are sent again whenever they change (ext-snapshot.ts snapSchedule), and only when they differ.
 */
import { useEffect, useRef, type RefObject } from 'react';
import { toParent } from './ext-frame';
import { homeSnapOf } from './ext-home-model';
import { SHOWN_AFTER_PAINT_MAX_MS, snapSchedule } from './ext-snapshot';

export function useHomeSnapshots(rootRef: RefObject<HTMLDivElement | null>, active: boolean): void {
  const shownTold = useRef(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !active) return;
    // Up once the composer has painted and the task list is what it will stay: its chunk loaded and
    // its tasks read (rows, or its empty words). Before that the view would put "Loading your
    // tasks…" over the drawing's rows and then the rows again (the jump of review R2-6).
    const listUp = () => {
      const list = el.querySelector('.ext-home-tasks');
      if (!list) return true;
      return !!list.querySelector('.todo-panel') && !list.querySelector('.ext-home-loading, .todo-panel-list .spinner');
    };
    const tellShown = () => {
      if (shownTold.current || !el.querySelector('.chat-input-textarea') || !listUp()) return;
      shownTold.current = true;
      let sent = false;
      const send = () => { if (!sent) { sent = true; toParent({ type: 'shown' }); } };
      requestAnimationFrame(() => requestAnimationFrame(send));
      setTimeout(send, SHOWN_AFTER_PAINT_MAX_MS);
    };
    let lastSent = '';
    const snap = () => {
      const s = homeSnapOf(el);
      // The list not drawn yet (its chunk, the tasks loading): the drawing of last time keeps its rows.
      if (!s || (s.rows.length === 0 && s.tabs.length === 0)) return;
      const words = JSON.stringify(s);
      if (words === lastSent) return;
      lastSent = words;
      toParent({ type: 'snapshot', view: 'home', snap: s });
    };
    const schedule = snapSchedule(snap);
    const obs = new MutationObserver(() => { tellShown(); schedule.poke(); });
    obs.observe(el, { childList: true, subtree: true, characterData: true });
    tellShown();
    schedule.poke();
    const fallback = setTimeout(() => { if (!shownTold.current) { shownTold.current = true; toParent({ type: 'shown' }); } }, 4000);
    const hide = () => schedule.flush();
    const hidden = () => { if (document.visibilityState === 'hidden') schedule.flush(); };
    window.addEventListener('pagehide', hide);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      obs.disconnect(); schedule.cancel(); clearTimeout(fallback);
      window.removeEventListener('pagehide', hide);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [rootRef, active]);
}
