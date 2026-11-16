/**
 * One mail as a content item (utils/content-actions.ts): what Talk to CEO and New task are told
 * about it. The subject is the title, the sender, date and account are the context, the body's
 * start is the excerpt, and the Walnut link opens this message in Mail (the server adds the
 * mail_read call that reads it whole). What the router decided rides as the summary, in the words
 * the reader's route line shows, so a router, the CEO or a VP asked about it reads the same decision
 * the person is looking at.
 */
import type { MailMessageDto } from '@/api/mail';
import type { ContentItem } from '@/utils/content-actions';
import { store } from './mail-store';
import { mailRouteView } from './mail-route-model';

/** "Router: Routed to Walnut VP · <its reason>", only for mail a router has or will decide on. */
function routeSummary(message: MailMessageDto): string {
  if (!message.route && !message.routingArea) return '';
  const view = mailRouteView(message.route, message.routingUnavailable, message.routingArea, message.routingCoverage);
  return view.text ? `Router: ${view.text}` : '';
}

function addressLine(who: MailMessageDto['from'] | undefined): string {
  const name = who?.name?.trim() ?? '';
  const address = who?.address?.trim() ?? '';
  if (name && address) return `${name} <${address}>`;
  return name || address;
}

function accountLabel(accountId: string): string {
  const account = store.state.accounts.find((one) => one.accountId === accountId);
  return account ? account.displayName?.trim() || account.address || '' : '';
}

export function mailContentItem(message: MailMessageDto, bodyText?: string | null): ContentItem {
  const at = Number.isFinite(message.sentAt) && message.sentAt > 0 ? new Date(message.sentAt).toISOString() : undefined;
  const from = addressLine(message.from);
  const where = accountLabel(message.accountId);
  const text = (bodyText ?? '').trim() || message.snippet?.trim() || '';
  const summary = routeSummary(message);
  return {
    source: 'Mail',
    title: message.subject?.trim() || '(no subject)',
    ...(summary ? { summary } : {}),
    ...(text ? { text } : {}),
    ...(from ? { from } : {}),
    ...(at ? { at } : {}),
    ...(where ? { where } : {}),
    open: `/mail?${new URLSearchParams({ account: message.accountId, message: message.messageId })}`,
  };
}
