/**
 * SessionPanel's glue for "Latest update" in the composer's "+" menu: the action
 * row and the popover it opens (LatestUpdatePopover). The row is there only
 * while the session has a recap to show; text and live updates come from the
 * recap-tip store, the same source as the Todo detail row.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PlusMenuAction, PlusMenuActionContext } from '@/components/chat/plus-menu-actions';
import { useRecapTip, type RecapTipFields } from '@/stores/recap-tip-store';
import { log } from '@/utils/log';
import { COMPOSER_ANCHOR_MAX_PX } from './useEngineSettingsEntry';
import { LatestUpdatePopover, type LatestUpdateCloseReason } from './LatestUpdatePopover';

export const LATEST_UPDATE_ACTION_ID = 'latest-update';
export const LATEST_UPDATE_LABEL = 'Latest update';
const LATEST_UPDATE_TITLE = 'What this session is about and what just happened, as its AI last summed it up';

const LATEST_UPDATE_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 6h16M4 12h10M4 18h7" />
    <circle cx="18" cy="17" r="3" />
  </svg>
);

/** The newer of the two stamps (ISO strings compare in time order). */
function newer(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export function useLatestUpdateEntry(input: {
  sessionId: string;
  session: RecapTipFields | null;
}): { action: PlusMenuAction | null; popover: ReactNode } {
  const { sessionId, session } = input;
  const tip = useRecapTip(sessionId, session);
  const overview = tip.overview?.trim() ?? '';
  const recap = tip.recap?.trim() ?? '';
  const has = !!overview || !!recap;
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLElement | null>(null);

  useEffect(() => () => setOpen(false), [sessionId]);

  const openPopover = useCallback(({ anchor, composer }: PlusMenuActionContext) => {
    anchorRef.current = anchor;
    composerRef.current = composer && composer.offsetHeight <= COMPOSER_ANCHOR_MAX_PX ? composer : null;
    setOpen(true);
    log.info('session-panel', 'latest update opened', { sessionId });
  }, [sessionId]);

  const close = useCallback((reason: LatestUpdateCloseReason) => {
    setOpen(false);
    log.info('session-panel', 'latest update closed', { sessionId, reason });
  }, [sessionId]);

  const action = useMemo<PlusMenuAction | null>(() => (has ? {
    id: LATEST_UPDATE_ACTION_ID,
    label: LATEST_UPDATE_LABEL,
    title: LATEST_UPDATE_TITLE,
    icon: LATEST_UPDATE_ICON,
    onSelect: openPopover,
  } : null), [has, openPopover]);

  const popover = open && has ? (
    <LatestUpdatePopover
      key={sessionId}
      overview={overview}
      recap={recap}
      at={newer(tip.overviewAt, tip.recapAt)}
      anchorRef={anchorRef}
      composerRef={composerRef}
      onClose={close}
    />
  ) : null;

  return { action, popover };
}
