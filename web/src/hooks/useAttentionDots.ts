/**
 * The rail's marks for a host or Claude Code problem (host-attention.ts):
 *   railSettingsDot  a host needs attention, except on the remote hosts pane,
 *                    where the user is looking at the rows.
 *   bellReason       the same host rule, plus this machine's Claude Code notice.
 * No card on the page ever carries these problems, so no page state hides a dot.
 * The notification panel being open changes nothing here: it is a passing
 * overlay, and opening it must not make the rail blink.
 */
import type { SystemHealth } from '@/hooks/useSystemHealth';
import { useLocalDismissed } from '@/utils/host-banner-dismiss';
import { bellDotReason, railDotShows, useHostAttentionNeeded, type BellReason } from '@/utils/host-attention';
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

/** The rule, pure: hostOn / localOn say the problem exists. */
export function attentionDotsOf(i: { hostOn: boolean; localOn: boolean; pathname: string; hash: string }): AttentionDots {
  const hosts = railDotShows(i.hostOn, i.pathname, i.hash);
  return { railSettingsDot: hosts, bellReason: bellDotReason(hosts, i.localOn) };
}

export function useAttentionDots({ pathname, hash, health, healthLoading }: AttentionDotsInput): AttentionDots {
  const hostOn = useHostAttentionNeeded();
  // The same list the panel's local x writes, so a dismiss clears the dot in the same frame.
  const localDismissed = useLocalDismissed();
  const localOn = localNoticeShows(health, localDismissed, healthLoading) !== null;
  return attentionDotsOf({ hostOn, localOn, pathname, hash });
}
