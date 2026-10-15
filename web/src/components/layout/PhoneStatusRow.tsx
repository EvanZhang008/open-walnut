/**
 * One line under the phone top bar when the console cannot talk to Walnut
 * (spec 4.5 R, 4.7 "Mac no longer answering"). At most one of the two shows:
 * - `Your Mac is not answering. Showing what this phone last saw.` with
 *   `Open quick view` (the host server's own page), when the server that
 *   answers is a host server alone;
 * - `Not connected. Retrying...` with `Retry`, after 5 s without a socket.
 * Panes keep their last data underneath; nothing here reloads the page.
 */
import { useLayoutEffect, useRef } from 'react';
import { useResyncState, runPhoneResync } from '@/hooks/usePhoneResync';

/**
 * The row's height joins the bar's in --phone-topbar-h (phone-layout.css), so the
 * page, the drawer and every overlay start below it: drawn over the page it hid
 * the search field and New task (N2-04, C63, C88).
 */
function usePublishRowHeight(shown: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const el = ref.current;
    if (!shown || !el) { root.style.removeProperty('--phone-status-h'); return; }
    const write = () => root.style.setProperty('--phone-status-h', `${Math.ceil(el.getBoundingClientRect().height)}px`);
    write();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(write) : null;
    ro?.observe(el);
    return () => { ro?.disconnect(); root.style.removeProperty('--phone-status-h'); };
  }, [shown]);
  return ref;
}

/** The host server serves its quick view on any page path while it is alone. */
export const QUICK_VIEW_HREF = '/';

export function PhoneStatusRow() {
  const { offline, macAway, syncing } = useResyncState();
  const ref = usePublishRowHeight(macAway || offline);
  if (macAway) {
    return (
      <div ref={ref} className="phone-status-row is-mac-away" role="status" data-testid="phone-status-mac-away">
        <span className="phone-status-row-text">Your Mac is not answering. Showing what this phone last saw.</span>
        <a className="phone-status-row-btn" href={QUICK_VIEW_HREF} onClick={(e) => { e.preventDefault(); window.location.assign(QUICK_VIEW_HREF); }}>
          Open quick view
        </a>
      </div>
    );
  }
  if (!offline) return null;
  return (
    <div ref={ref} className="phone-status-row is-offline" role="status" data-testid="phone-status-offline">
      <span className="phone-status-row-text">Not connected. Retrying...</span>
      <button
        type="button"
        className="phone-status-row-btn"
        disabled={syncing}
        onClick={() => { void runPhoneResync('retry'); }}
      >
        Retry
      </button>
    </div>
  );
}
