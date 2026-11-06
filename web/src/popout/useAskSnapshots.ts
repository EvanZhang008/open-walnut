/**
 * The Ask view's words for the extension's panel page to draw while it loads next time
 * (ext-snapshot.ts), and the word that this view's own content is up, so that drawing goes.
 */
import { useEffect, useRef, type RefObject } from 'react';
import { flushHistoryWrites } from '@/cache/history-idb';
import { toParent } from './ext-frame';
import { hostOf, type PanelPage } from './ext-panel-model';
import { askSnapOf, snapKeyOf } from './ext-snapshot';

export function useAskSnapshots(chatRef: RefObject<HTMLDivElement | null>, page: PanelPage | null, key: string): void {
  const shownTold = useRef(false);
  const pageUrl = page?.url ?? '';
  const pageTitle = page?.title;
  useEffect(() => {
    const el = chatRef.current;
    if (!el || !pageUrl) return;
    const tellShown = () => { if (!shownTold.current) { shownTold.current = true; toParent({ type: 'shown' }); } };
    const viewOf = () => el.querySelector('[data-testid="ask-object-drawer"]')?.getAttribute('data-view');
    const check = () => {
      const v = viewOf();
      if (v === 'compose' || (v === 'session' && el.querySelector('.session-msg'))) tellShown();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const snap = () => {
      const v = viewOf();
      if (v !== 'compose' && v !== 'session') return;
      const s = askSnapOf(el, { url: pageUrl, ...(pageTitle ? { title: pageTitle } : {}) }, hostOf(pageUrl));
      // A conversation whose messages have not loaded yet says nothing new: it must not replace
      // the drawing of last time with an empty chat.
      if (v === 'session' && s.messages.length === 0) return;
      toParent({ type: 'snapshot', view: 'ask', key: snapKeyOf(pageUrl), snap: s });
    };
    const obs = new MutationObserver(() => { check(); clearTimeout(timer); timer = setTimeout(snap, 500); });
    obs.observe(el, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-view'] });
    check();
    timer = setTimeout(snap, 500);
    // A view that never draws a message (a conversation still starting) lets the drawing go anyway.
    const fallback = setTimeout(tellShown, 4000);
    // Closing the panel ends this page: what it holds goes to the browser's cache now, not after its debounce.
    const hide = () => { snap(); flushHistoryWrites(); };
    window.addEventListener('pagehide', hide);
    return () => { obs.disconnect(); clearTimeout(timer); clearTimeout(fallback); window.removeEventListener('pagehide', hide); };
  }, [chatRef, pageUrl, pageTitle, key]);
}
