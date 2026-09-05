/**
 * The optimistic read flag: the one piece of arithmetic this console owns.
 *
 * Server-side, a mailbox's unread count comes from the PROVIDER and only moves on the next mailbox
 * refresh, so nothing on the server can make the badge drop the moment a message is opened. That
 * leaves the browser holding four numbers that have to move together (the row's flags, the open
 * reader's copy of it, the mailbox badge, the account total) and holding all four back when the
 * provider refuses. It is split into its own file because it is the part that is worth reading in
 * one sitting.
 */
import { mailFailure, markMailMessageRead, providerIdOf, type MailMessageDto } from '@/api/mail';
import { log } from '@/utils/log';
import { SEEN, patch, publishBadge, store } from './mail-store';

/**
 * Mark the opened message read, if the provider says it can.
 *
 * `capabilities.markRead` is DATA read from `/providers`, never a guess: a provider that cannot
 * change the flag answers 409 and the console must not pretend, or the mailbox drifts from what
 * every other mail client shows.
 */
export function markReadIfAllowed(message: MailMessageDto): Promise<void> {
  if (message.flags.includes(SEEN)) return Promise.resolve();
  const provider = store.state.providers.find((one) => one.id === providerIdOf(message.accountId));
  if (!provider?.capabilities.markRead) return Promise.resolve();

  applySeen(message, true);
  return markMailMessageRead(message.accountId, message.messageId, true)
    .then((answer) => {
      // The server's own row wins: it carries the provider's flags, not our guess.
      replaceMessage(answer.message);
    })
    .catch((error) => {
      const failure = mailFailure(error);
      applySeen(message, false);
      log.warn('mail', 'read flag refused, rolling the badge back', {
        accountId: message.accountId,
        messageId: message.messageId,
        code: failure.code,
        error: failure.message,
      });
    });
}

function withSeen(message: MailMessageDto, seen: boolean): MailMessageDto {
  const flags = message.flags.filter((flag) => flag !== SEEN);
  return { ...message, flags: seen ? [...flags, SEEN] : flags };
}

function mapMessage(list: MailMessageDto[], messageId: string, fn: (one: MailMessageDto) => MailMessageDto) {
  return list.some((one) => one.messageId === messageId)
    ? list.map((one) => (one.messageId === messageId ? fn(one) : one))
    : list;
}

/** The row, the open reader, the search results, the mailbox badge and the account total. */
function applySeen(message: MailMessageDto, seen: boolean): void {
  const state = store.state;
  const delta = seen ? -1 : 1;
  const mailboxes = state.mailboxes[message.accountId];
  patch({
    messages: mapMessage(state.messages, message.messageId, (one) => withSeen(one, seen)),
    search: {
      ...state.search,
      messages: mapMessage(state.search.messages, message.messageId, (one) => withSeen(one, seen)),
    },
    open: state.open?.messageId === message.messageId && state.open.message
      ? { ...state.open, message: withSeen(state.open.message, seen) }
      : state.open,
    ...(mailboxes ? {
      mailboxes: {
        ...state.mailboxes,
        [message.accountId]: mailboxes.map((mailbox) => (
          mailbox.mailboxId === message.mailboxId
            ? { ...mailbox, unread: Math.max(0, mailbox.unread + delta) }
            : mailbox
        )),
      },
    } : {}),
    accounts: state.accounts.map((account) => (
      account.accountId === message.accountId
        ? { ...account, unread: Math.max(0, account.unread + delta) }
        : account
    )),
  });
  publishBadge();
}

function replaceMessage(message: MailMessageDto): void {
  const state = store.state;
  patch({
    messages: mapMessage(state.messages, message.messageId, () => message),
    search: {
      ...state.search,
      messages: mapMessage(state.search.messages, message.messageId, () => message),
    },
    open: state.open?.messageId === message.messageId ? { ...state.open, message } : state.open,
  });
}
