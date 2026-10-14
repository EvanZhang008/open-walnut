/**
 * `PW_MAIL_NAMES_ONLY=1`: mail from a listing that names people without their addresses.
 *
 * The shape a conversation-shaped provider (an Outlook mailbox) hands the base: every participant in
 * the listing is a display name with `address: ''`, and only the BODY read carries real addresses
 * (`MailBody.from/to/cc`, the base's gap fill). 2026-10-14: Reply and Reply all on such a message
 * opened with an empty `To`. The provider also declares `replyAddressesSender`, because its reply
 * reaches the original sender even when no read could name that sender's address.
 *
 * Four rows, one per path the composer has to handle:
 *
 * - NAMES_FILLED: the body names everyone. Its read is SLOW (`PW_MAIL_NAMES_SLOW_MS`, default
 *   2500), so a reply clicked from the row menu, or from the reader before the body lands, opens
 *   before the addresses exist and must fill them in when they arrive.
 * - NAMES_PATH: the body names the sender by a directory path only, which is no address: the composer
 *   says the provider addresses the reply, and Send still works.
 * - NAMES_CC: the body names the sender and two people in Cc, for Reply all.
 * - NAMES_MENU: an ordinary fast body, kept for the row menu's Reply, which must find it unread.
 *
 * NAMES_FILLED and NAMES_MENU live in ARCHIVE: the base prefetches the newest Inbox bodies on every
 * tick (which fills their addresses before anyone clicks, the common case), so only a folder the
 * prefetch never visits keeps a row whose body has not been read yet.
 *
 * Addresses are `*.invalid` (RFC 2606) and nothing here resolves.
 */
export const namesOnlyOn = process.env.PW_MAIL_NAMES_ONLY === '1';

export const NAMES_FILLED = 'Archive:11:1';
export const NAMES_PATH = 'INBOX:11:2';
export const NAMES_CC = 'INBOX:11:3';
export const NAMES_MENU = 'Archive:11:4';

const SLOW_MS = Number(process.env.PW_MAIL_NAMES_SLOW_MS ?? '') || 2500;
const ME = { name: 'Ctx Writer', address: '' };

export function namesOnlyMessages(now) {
  const one = (messageId, minutesAgo, over) => ({
    messageId,
    // A conversation id, as such a provider's durable key is: no Message-ID header exists.
    rfcMessageId: `conv-${messageId.replaceAll(':', '-')}`,
    mailboxId: 'INBOX',
    to: [ME],
    snippet: 'Please confirm the details.',
    sentAt: now - minutesAgo * 60 * 1000,
    attachments: [],
    unreadAtFirstSight: false,
    ...over,
  });
  return [
    one(NAMES_FILLED, 3, {
      mailboxId: 'Archive',
      from: { name: 'Alder Desk', address: '' },
      subject: 'Please confirm the shipment',
      bodyDelayMs: SLOW_MS,
      body: {
        format: 'text',
        text: 'Please confirm the shipment details by Friday.',
        from: { name: 'Alder Desk', address: 'alder@desk.example.invalid' },
        to: [{ name: 'Ctx Writer', address: 'ctx-writer@example.invalid' }],
      },
    }),
    one(NAMES_PATH, 4, {
      from: { name: 'Grove Team', address: '' },
      subject: 'Grove rota for next week',
      body: {
        format: 'text',
        text: 'The rota is attached.',
        from: { name: 'Grove Team', address: '/o=ExchangeLabs/ou=Exchange/cn=Recipients/cn=grove-team' },
        to: [{ name: 'Ctx Writer', address: 'ctx-writer@example.invalid' }],
      },
    }),
    one(NAMES_CC, 6, {
      from: { name: 'Cedar Office', address: '' },
      subject: 'Approval notice received',
      body: {
        format: 'text',
        text: 'We received the approval notice. Please reply to confirm.',
        from: { name: 'Cedar Office', address: 'cedar@office.example.invalid' },
        to: [{ name: 'Ctx Writer', address: 'ctx-writer@example.invalid' }],
        cc: [
          { address: 'casework@office.example.invalid' },
          { name: 'Dogwood Lee', address: 'dogwood@office.example.invalid' },
        ],
      },
    }),
    one(NAMES_MENU, 8, {
      mailboxId: 'Archive',
      from: { name: 'Elm Works', address: '' },
      subject: 'Invoice question',
      body: {
        format: 'text',
        text: 'Could you check the invoice total?',
        from: { name: 'Elm Works', address: 'ledger@elm.example.invalid' },
        to: [{ name: 'Ctx Writer', address: 'ctx-writer@example.invalid' }],
      },
    }),
  ];
}
