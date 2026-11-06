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
import { onParentKnown, toParent } from './ext-frame';
import { hostOf, type PanelPage } from './ext-panel-model';
import { SHOWN_AFTER_PAINT_MAX_MS, askSnapKey, askSnapOf, askViewSnapOf, snapSchedule } from './ext-snapshot';

/**
 * `rootRef` is the whole view (header, Continue list, conversation, composer); `key` the
 * conversation on show (and which drawer of it), which restarts the watch when it changes.
 * `agent` is the agent on show (`agentLabel` its name in the header), `''` while the view cannot tell yet (its agent list loading): the
 * words are kept under that agent, and the extension is told which agent the view is on, so its
 * next drawing is this agent's and never another's (round 3 code review, item 3).
 */
export function useAskSnapshots(rootRef: RefObject<HTMLDivElement | null>, page: PanelPage | null, key: string, surface: 'panel' | 'popup', agent: string, agentLabel = ''): void {
  const shownTold = useRef(false);
  useEffect(() => {
    if (!agent) return;
    // Nothing reaches the extension page before its first word (ext-frame.ts): told again then.
    const tell = () => toParent({ type: 'agent', agentId: agent, ...(agentLabel ? { name: agentLabel } : {}) });
    tell();
    return onParentKnown(tell);
  }, [agent, agentLabel]);
  const pageUrl = page?.url ?? '';
  const pageTitle = page?.title;
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !key) return;
    // After the view's own content has PAINTED: the word on the commit let the extension page take
    // its drawing away while the frame still showed its last painted frame (the boot splash).
    // A frame the browser does not draw (a window behind another) runs no animation frames: the
    // timer says it then, by when a drawn frame has painted anyway.
    const tellShown = () => {
      if (shownTold.current) return;
      shownTold.current = true;
      let sent = false;
      const send = () => { if (!sent) { sent = true; toParent({ type: 'shown' }); } };
      requestAnimationFrame(() => requestAnimationFrame(send));
      setTimeout(send, SHOWN_AFTER_PAINT_MAX_MS);
    };
    // The popup's body is its composer (the conversation goes on in the side panel).
    const viewOf = () => (surface === 'popup'
      ? (el.querySelector('.ext-popup-body textarea') ? 'compose' : undefined)
      : el.querySelector('[data-testid="ask-object-drawer"]')?.getAttribute('data-view'));
    // A new chat is up once its Continue list is what it will stay: the asks have loaded (the root's
    // `data-asks`). Before that the view would replace the drawing's rows with "Loading your
    // asks…" and then put them back (review R2-6), so the drawing stays until the rows are real.
    const check = () => {
      const v = viewOf();
      const asksReady = el.getAttribute('data-asks') !== 'loading';
      if ((v === 'compose' && asksReady) || (v === 'session' && el.querySelector('.session-msg'))) tellShown();
    };
    const snapKey = askSnapKey(surface, agent);
    let lastSent = '';
    const snap = () => {
      // Kept under no agent until the view knows its own: the next open draws the bare shell then.
      if (!agent) return;
      const v = viewOf();
      if (v !== 'compose' && v !== 'session') return;
      // A new chat whose asks are still loading has no Continue rows to tell yet: the drawing of
      // last time keeps its own.
      if (v === 'compose' && el.getAttribute('data-asks') === 'loading') return;
      const host = pageUrl ? hostOf(pageUrl) : '';
      const s = { ...askSnapOf(el, { url: pageUrl, ...(pageTitle ? { title: pageTitle } : {}) }, host), ...askViewSnapOf(el) };
      // A conversation whose messages have not loaded yet says nothing new: it must not replace
      // the drawing of last time with an empty chat.
      if (v === 'session' && s.messages.length === 0) return;
      const words = JSON.stringify(s);
      if (words === lastSent) return;
      lastSent = words;
      toParent({ type: 'snapshot', view: 'ask', key: snapKey, agentId: agent, snap: s });
    };
    const schedule = snapSchedule(snap);
    const obs = new MutationObserver(() => { check(); schedule.poke(); });
    obs.observe(el, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-view', 'placeholder', 'aria-checked', 'data-needs', 'data-asks'] });
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
  }, [rootRef, pageUrl, pageTitle, key, surface, agent]);
}
