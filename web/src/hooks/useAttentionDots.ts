/**
 * Who speaks for the attention banner when no card on the PAGE shows it:
 *   railSettingsDot  a host needs attention and no in-page card shows it
 *                    (placement none, or another route), except on the
 *                    remote hosts pane, where the user is looking at the rows.
 *   bellReason       the same host rule, plus the local Claude Code notice
 *                    when neither the task panel nor the slot carries it (the
 *                    draft card has no local section).
 * The notification panel being open changes nothing here: it is a passing
 * overlay, and opening it must not make the rail blink.
 */
import type { SystemHealth } from '@/hooks/useSystemHealth';
import { useLocalDismissed } from '@/utils/host-banner-dismiss';
import {
  bellDotReason, railDotShows, useBannerRowsDeferred, useHostAttentionNeeded, useHostBannerPlacement, type BellReason,
  type HostBannerPlacement,
} from '@/utils/host-banner-placement';
import { localNoticeShows } from '@/utils/local-claude-banner';

export interface AttentionDotsInput {
  pathname: string;
  hash: string;
  health: SystemHealth | undefined;
  healthLoading: boolean;
}

export interface AttentionDots {
  railSettingsDot: boolean;
  bellReason: BellReason;
}

/** The rule, pure: hostOn / localOn say the problem exists; the page decides whether a card covers it. */
export function attentionDotsOf(i: {
  hostOn: boolean; localOn: boolean; where: HostBannerPlacement; pathname: string; hash: string;
  /** The card on screen holds a new host row back (spec 5.5): the bell says it meanwhile. */
  deferred?: boolean;
}): AttentionDots {
  const hostUncovered = railDotShows(i.hostOn, i.where, i.pathname, i.hash);
  const localUncovered = i.localOn && ((i.where !== 'tasks' && i.where !== 'slot') || i.pathname !== '/');
  const bellHosts = hostUncovered || (!!i.deferred && i.hostOn);
  return { railSettingsDot: hostUncovered, bellReason: bellDotReason(bellHosts, localUncovered) };
}

export function useAttentionDots({ pathname, hash, health, healthLoading }: AttentionDotsInput): AttentionDots {
  const hostOn = useHostAttentionNeeded();
  const where = useHostBannerPlacement();
  // The same list the card's local x writes, so a dismiss clears the dot in the same frame.
  const localDismissed = useLocalDismissed();
  const localOn = localNoticeShows(health, localDismissed, healthLoading) !== null;
  const deferred = useBannerRowsDeferred();
  return attentionDotsOf({ hostOn, localOn, where, pathname, hash, deferred });
}
