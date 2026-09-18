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
import { mailFailure, markMailMessageRead, type MailMessageDto } from '@/api/mail';
import { log } from '@/utils/log';
import { providerFor } from './mail-providers';
import { SEEN, pairKey, patch, publishBadge, store } from './mail-store';

/**
 * A MESSAGE's identity is (accountId, messageId), never the id alone.
 *
 * The id space belongs to the provider and Walnut may assume nothing about its shape, and the merged
 * smart lists are the first surface where two providers' id spaces share one column. Every match in
 * this file goes through here, the same way `mail-task-actions.ts` and `mail-unread-filter.ts`
 * already do: an id-only match let one account's already-read row make marking the OTHER account's
 * message read a silent no-op, and let a server answer overwrite a row with another account's sender
 * and subject.
 */
function handle(one: { accountId: string; messageId: string }): string {
  return pairKey(one.accountId, one.messageId);
}

/**
 * May this account's read flag be moved? Three answers, and the third is what this bug was about.
 *
 * `true`/`false` come from the provider's declared `capabilities.markRead`, which is DATA: a provider
 * that cannot change the flag answers 409 and the console must not pretend, or the mailbox drifts
 * from what every other mail client shows. But a provider list that never LOADED is not an empty
 * one, and treating the two the same is what made a click do nothing at all, silently, for hours
 * (see mail-providers.ts). When the list still cannot be read, the call goes out and the SERVER
 * decides: its refusal is the same 409 both callers below already roll back.
 */
async function mayMarkRead(accountId: string): Promise<boolean> {
  const { provider, known } = await providerFor(accountId);
  if (provider) return provider.capabilities.markRead === true;
  return !known;
}

/** Mark the opened message read, unless the provider is known not to be able to (`mayMarkRead`). */
export async function markReadIfAllowed(message: MailMessageDto): Promise<void> {
  if (message.flags.includes(SEEN)) return;
  if (!await mayMarkRead(message.accountId)) return;
  // Re-read the row AFTER the await, not the captured copy: while a provider answer was in flight
  // the row may already have been marked read (two opens of the same message, a live event), and
  // applying the badge arithmetic twice would leave the count short.
  if (heldSeen(message)) return;

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

/**
 * The reader's own read-flag control: mark the open message read, or unread again.
 *
 * The same four numbers as the automatic path, moved the same way and put back the same way, which
 * is why it shares `applySeen` rather than repeating it. Gated the same way too (`mayMarkRead`).
 *
 * Marking unread does NOT stop the automatic mark: reopening the message reads it again, which is
 * what every mail client does. Unread here means "leave it on my list", and the list is what it
 * changes.
 */
export async function setOpenMessageRead(read: boolean): Promise<void> {
  const opened = store.state.open?.message;
  if (!opened) return;
  if (!await mayMarkRead(opened.accountId)) return;
  // Re-read AFTER the await for the same reason the automatic path does: a second press, or the
  // automatic mark landing in between, would otherwise move the badge twice off a stale copy.
  const open = store.state.open;
  const message = open && handle(open) === handle(opened) ? open.message : undefined;
  if (!message || message.flags.includes(SEEN) === read) return;

  applySeen(message, read);
  return markMailMessageRead(message.accountId, message.messageId, read)
    .then((answer) => { replaceMessage(answer.message); })
    .catch((error) => {
      const failure = mailFailure(error);
      applySeen(message, !read);
      log.warn('mail', 'read flag refused, rolling the badge back', {
        accountId: message.accountId,
        messageId: message.messageId,
        code: failure.code,
        error: failure.message,
      });
    });
}

/** Is the row this console is holding for that message already read? */
function heldSeen(message: MailMessageDto): boolean {
  const state = store.state;
  const key = handle(message);
  const held = state.messages.find((one) => handle(one) === key)
    ?? state.search.messages.find((one) => handle(one) === key)
    ?? (state.open && handle(state.open) === key ? state.open.message : undefined)
    ?? message;
  return held.flags.includes(SEEN);
}

function withSeen(message: MailMessageDto, seen: boolean): MailMessageDto {
  const flags = message.flags.filter((flag) => flag !== SEEN);
  return { ...message, flags: seen ? [...flags, SEEN] : flags };
}

function mapMessage(
  list: MailMessageDto[],
  target: { accountId: string; messageId: string },
  fn: (one: MailMessageDto) => MailMessageDto,
) {
  const key = handle(target);
  return list.some((one) => handle(one) === key)
    ? list.map((one) => (handle(one) === key ? fn(one) : one))
    : list;
}

/** The row, the open reader, the search results, the mailbox badge and the account total. */
function applySeen(message: MailMessageDto, seen: boolean): void {
  const state = store.state;
  const delta = seen ? -1 : 1;
  const mailboxes = state.mailboxes[message.accountId];
  patch({
    messages: mapMessage(state.messages, message, (one) => withSeen(one, seen)),
    search: {
      ...state.search,
      messages: mapMessage(state.search.messages, message, (one) => withSeen(one, seen)),
    },
    open: state.open && handle(state.open) === handle(message) && state.open.message
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
    messages: mapMessage(state.messages, message, () => message),
    search: {
      ...state.search,
      messages: mapMessage(state.search.messages, message, () => message),
    },
    open: state.open && handle(state.open) === handle(message) ? { ...state.open, message } : state.open,
  });
}
