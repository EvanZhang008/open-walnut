import type { MailMessageDto, MailRouteDto } from '@/api/mail';
import { patch, store } from './mail-store';
import { applyAreaToGroupedRows, applyRouteToGroupedRows } from './mail-groups-store';

// A late receipt of an older delivery under a reused id must not land on the new reply.
export const sameDelivery = (row: { deliveryVersion?: string }, version: string | undefined): boolean =>
  (row.deliveryVersion ?? '') === (version ?? '');

export function onMailRouteChanged(data: unknown): void {
  const event = data as { source?: { kind?: string; account?: string; message?: string; version?: string }; route?: MailRouteDto } | null;
  const source = event?.source;
  const route = event?.route;
  if (source?.kind !== 'mail' || !source.account || !source.message || !route || !Number.isFinite(route.at)) return;
  const version = typeof source.version === 'string' ? source.version : undefined;
  const stamp = (one: MailMessageDto) => {
    if (one.accountId !== source.account || one.messageId !== source.message || !sameDelivery(one, version)
      || (one.route && one.route.at > route.at)) return one;
    return { ...one, route, routingUnavailable: false };
  };
  const state = store.state;
  const open = state.open;
  patch({
    messages: state.messages.map(stamp),
    search: { ...state.search, messages: state.search.messages.map(stamp) },
    open: open?.message && open.accountId === source.account && open.messageId === source.message
      ? { ...open, message: stamp(open.message) } : open,
  });
  applyRouteToGroupedRows({ accountId: source.account, messageId: source.message, ...(version !== undefined ? { version } : {}) }, route);
}

/**
 * The person just confirmed an area for one message: every list, the search results and the open message
 * show it at once, so the row and the reader head read the same line before the next list load.
 */
export function onMailAreaConfirmed(source: { account: string; message: string; version?: string }, area: { id: string; name: string }): void {
  const stamp = (one: MailMessageDto) => (one.accountId !== source.account || one.messageId !== source.message
    || !sameDelivery(one, source.version) || one.routingArea ? one : { ...one, routingArea: area });
  const state = store.state;
  const open = state.open;
  patch({
    messages: state.messages.map(stamp),
    search: { ...state.search, messages: state.search.messages.map(stamp) },
    open: open?.message && open.accountId === source.account && open.messageId === source.message
      ? { ...open, message: stamp(open.message) } : open,
  });
  applyAreaToGroupedRows({ accountId: source.account, messageId: source.message, ...(source.version !== undefined ? { version: source.version } : {}) }, area);
}
