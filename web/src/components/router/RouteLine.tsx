/**
 * Where the router sent one item, for a plugin's own surface (a Slack message): the same two layers
 * Mail's reader shows (which router processed it, then what it decided), drawn by Mail's own line so
 * the two never word one route two ways (2026-11-16, the user: "can we have 2 status, first does it
 * go to processed by router abc, and then the decision"). Nothing renders for an item no router reads.
 */
import { useSyncExternalStore } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { MailRouteLine } from '@/apps/mail/MailRouteLine';
import type { RouteLineViewProps } from '../../../../packages/plugin-api/src/web';
import { readItemRoute, watchItemRoute } from './item-route-store';

/** The plugin API's own props (`walnut.ui.views.RouteLine`), one definition for both. */
export type RouteLineProps = RouteLineViewProps;

export function RouteLine({ kind, account, message, surface = 'row' }: RouteLineProps) {
  const subscribe = useLeanCallback((onChange: () => void) => watchItemRoute(kind, account, message, onChange), [kind, account, message]);
  const state = useSyncExternalStore(subscribe, () => readItemRoute(kind, account, message));
  // Not read yet, or no router reads this item: the surface shows nothing about routing.
  if (!state || (!state.route && !state.area && !state.unavailable)) return null;
  return (
    <span className="route-line-host" data-testid="plugin-route-line" data-route-kind={kind}>
      <MailRouteLine route={state.route} unavailable={state.unavailable} surface={surface}
        {...(state.area ? { routingArea: state.area } : {})} />
    </span>
  );
}
