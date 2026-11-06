/**
 * The Ask view's words for the extension's panel page to draw while it loads next time
 * (ext-snapshot.ts), and the word that this view's own content is up, so that drawing goes. The
 * side panel and the toolbar popup both send them, with or without a web page in the tab.
 *
 * The words are sent again whenever what the view shows changes (a new message, a reply streaming
 * in, another title), at most every SNAP_QUIET_MS of quiet and at least every SNAP_MAX_WAIT_MS
 * while it keeps changing, and only when they differ from the last ones sent: the drawing of the
 * next open is the conversation as it was left, not as it first loaded.
 */
import { useEffect, useRef, type RefObject } from 'react';
import { flushHistoryWrites } from '@/cache/history-idb';
import { toParent } from './ext-frame';
import { hostOf, type PanelPage } from './ext-panel-model';
import { askSnapKey, askSnapOf, askViewSnapOf, snapSchedule } from './ext-snapshot';

/**
 * `rootRef` is the whole view (header, Continue list, conversation, composer); `key` the
 * conversation on show, which restarts the watch when it changes.
 */
export function useAskSnapshots(rootRef: RefObject<HTMLDivElement | null>, page: PanelPage | null, key: string, surface: 'panel' | 'popup'): void {
  const shownTold = useRef(false);
  const pageUrl = page?.url ?? '';
  const pageTitle = page?.title;
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !key) return;
    const tellShown = () => { if (!shownTold.current) { shownTold.current = true; toParent({ type: 'shown' }); } };
    // The popup's body is its composer (the conversation goes on in the side panel).
    const viewOf = () => (surface === 'popup'
      ? (el.querySelector('.ext-popup-body textarea') ? 'compose' : undefined)
      : el.querySelector('[data-testid="ask-object-drawer"]')?.getAttribute('data-view'));
    const check = () => {
      const v = viewOf();
      if (v === 'compose' || (v === 'session' && el.querySelector('.session-msg'))) tellShown();
    };
    const snapKey = askSnapKey(surface, pageUrl);
    let lastSent = '';
    const snap = () => {
      const v = viewOf();
      if (v !== 'compose' && v !== 'session') return;
      const host = pageUrl ? hostOf(pageUrl) : '';
      const s = { ...askSnapOf(el, { url: pageUrl, ...(pageTitle ? { title: pageTitle } : {}) }, host), ...askViewSnapOf(el) };
      // A conversation whose messages have not loaded yet says nothing new: it must not replace
      // the drawing of last time with an empty chat.
      if (v === 'session' && s.messages.length === 0) return;
      const words = JSON.stringify(s);
      if (words === lastSent) return;
      lastSent = words;
      toParent({ type: 'snapshot', view: 'ask', key: snapKey, snap: s });
    };
    const schedule = snapSchedule(snap);
    const obs = new MutationObserver(() => { check(); schedule.poke(); });
    obs.observe(el, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-view', 'placeholder', 'aria-checked', 'data-needs'] });
    check();
    schedule.poke();
    // A view that never draws a message (a conversation still starting) lets the drawing go anyway.
    const fallback = setTimeout(tellShown, 4000);
    // Closing the panel ends this page: what it holds goes to the browser's cache now, not after its debounce.
    const hide = () => { schedule.flush(); flushHistoryWrites(); };
    // Hidden first (the panel closing, another tab): the words go while the extension page still listens.
    const hidden = () => { if (document.visibilityState === 'hidden') schedule.flush(); };
    window.addEventListener('pagehide', hide);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      obs.disconnect(); schedule.cancel(); clearTimeout(fallback);
      window.removeEventListener('pagehide', hide);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [rootRef, pageUrl, pageTitle, key, surface]);
}
