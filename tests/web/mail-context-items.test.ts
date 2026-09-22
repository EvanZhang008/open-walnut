/**
 * The message row menu as DATA: which rows exist, in which order, and with exactly which words.
 *
 * Five dimensions decide the list, and every one of them has a way of going quietly wrong:
 *
 * - markRead false -> the read toggle is ABSENT, not disabled. A greyed headline presents the whole
 *   menu as "nothing works here", which is the same bad outcome as the 409 it would earn.
 * - send false -> the three send rows are DISABLED with the reason, because SMTP settings are
 *   something the human can go and fix, and hiding them turns that into a puzzle.
 * - taskId -> `Open task` instead of `Make a task`, so a triage pass never makes a second task.
 * - merged -> the title's third field names the account; a single-account window has nothing to say.
 * - outbound -> mail this person WROTE is a different menu: a draft has no read toggle and nothing to
 *   reply to, and a sent message can be forwarded but not replied to.
 *
 * Plus the two things a copy review cannot catch: no row may name an action the server has no route
 * for (Delete, Move, Archive, Flag, Star, mark-all, Unsubscribe), and the deep link has to survive its
 * own parse on the way back in.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  COPY_LINK_TITLE,
  OPEN_MARKS_READ_TITLE,
  REPLY_CLOSES_TITLE,
  mailRowLink,
  menuSearchAddress,
  messageMenuItems,
  truncateForMenu,
} from '../../web/src/apps/mail/mail-context-items';
import { CANNOT_SEND_TITLE } from '../../web/src/apps/mail/compose/send-status';
import { __resetMailStore, patch } from '../../web/src/apps/mail/mail-store';
import type {
  MailAccountDto,
  MailCapabilities,
  MailMessageDto,
  MailProviderSummary,
} from '../../web/src/api/mail';
import type { ContextMenuItem } from '../../web/src/utils/context-menu';

const WRITER = 'fixture:writer@example.invalid';
const READER = 'inbound:reader@example.invalid';

const CAPS: MailCapabilities = {
  search: true,
  watch: true,
  drafts: true,
  markRead: true,
  flags: false,
  threads: false,
  send: true,
  sendAsReply: true,
  bodies: 'both',
  attachments: 'metadata',
};

function provider(id: string, over: Partial<MailCapabilities> = {}): MailProviderSummary {
  return { id, label: `Provider ${id}`, capabilities: { ...CAPS, ...over }, setupFields: [] };
}

function account(accountId: string, displayName: string): MailAccountDto {
  return {
    accountId,
    providerId: accountId.split(':')[0]!,
    displayName,
    address: accountId.split(':')[1]!,
    state: 'active',
    unread: 0,
  };
}

function row(over: Partial<MailMessageDto> = {}): MailMessageDto {
  return {
    accountId: WRITER,
    messageId: 'INBOX:1:31',
    mailboxId: 'INBOX',
    from: { name: 'Harbour Office', address: 'office@example.invalid' },
    to: [{ name: 'Writer', address: 'writer@example.invalid' }],
    subject: 'Pontoon works next week',
    snippet: 'The crews start on the ninth.',
    sentAt: 1_700_000_000_000,
    flags: [],
    attachments: [],
    hasBody: true,
    ...over,
  };
}

/** Every action recorded, so a row can be proved to act on its OWN pair. */
let acted: string[] = [];

function actions() {
  return {
    onSetRead: (message: MailMessageDto, read: boolean) =>
      acted.push(`read ${message.accountId} ${message.messageId} ${read}`),
    onOpen: (message: MailMessageDto) => acted.push(`open ${message.accountId} ${message.messageId}`),
    onReply: (message: MailMessageDto, all: boolean) =>
      acted.push(`reply ${message.accountId} ${message.messageId} ${all}`),
    onForward: (message: MailMessageDto) => acted.push(`forward ${message.accountId} ${message.messageId}`),
    onMakeTask: (message: MailMessageDto) => acted.push(`task ${message.accountId} ${message.messageId}`),
    onOpenTask: (taskId: string) => acted.push(`open-task ${taskId}`),
    onSearchSender: (address: string) => acted.push(`search ${address}`),
    onCopyLink: (message: MailMessageDto) => acted.push(`copy ${message.accountId} ${message.messageId}`),
    onSummarize: (message: MailMessageDto) => acted.push(`summarize ${message.accountId} ${message.messageId}`),
    onDraftReply: (message: MailMessageDto) => acted.push(`ai-reply ${message.accountId} ${message.messageId}`),
    onAskAbout: (message: MailMessageDto) => acted.push(`ask ${message.accountId} ${message.messageId}`),
    onUnsubscribe: (message: MailMessageDto) => acted.push(`unsubscribe ${message.accountId} ${message.messageId}`),
    onFinishUnsubscribe: (message: MailMessageDto, reason?: string) =>
      acted.push(`finish-unsubscribe ${message.accountId} ${message.messageId} ${reason ?? ''}`),
  };
}

interface BuildOver {
  message?: Partial<MailMessageDto>;
  providers?: MailProviderSummary[];
  accounts?: MailAccountDto[];
  outbound?: boolean;
  draftsView?: boolean;
  merged?: boolean;
  /** A message is open in the reader unless a case says otherwise (the composer takes that pane). */
  readerOpen?: boolean;
  /** The reader is holding THIS row. False by default: the menu's every other case is another row. */
  readerHasRow?: boolean;
}

function build(over: BuildOver = {}): ContextMenuItem[] {
  return messageMenuItems({
    message: row(over.message),
    providers: over.providers ?? [provider('fixture'), provider('inbound', { markRead: false, send: false })],
    accounts: over.accounts ?? [account(WRITER, 'Fixture Mail'), account(READER, 'Inbound Only')],
    outbound: over.outbound ?? false,
    draftsView: over.draftsView ?? false,
    merged: over.merged ?? false,
    readerOpen: over.readerOpen ?? true,
    readerHasRow: over.readerHasRow ?? false,
    actions: actions(),
  });
}

/** The words on screen, dividers as a dash, in order. */
function labels(items: ContextMenuItem[]): string[] {
  return items.map((one) => (one.divider ? '-' : String(one.label)));
}

/**
 * The TITLE block's own info rows.
 *
 * `info` alone is no longer the same question: the Walnut group is named by an info row too, so a bare
 * `filter(one => one.info)` counts it and the heading's "one line or two" rule stops being graded.
 */
function heading(items: ContextMenuItem[]): ContextMenuItem[] {
  return items.filter((one) => one.info && one.key?.startsWith('target'));
}

/** Only the rows a human can press, which is what "the first item" means. */
function pressable(items: ContextMenuItem[]): ContextMenuItem[] {
  return items.filter((one) => !one.divider && !one.info && !one.section && !one.disabled);
}

beforeEach(() => {
  acted = [];
  __resetMailStore();
  patch({ providersKnown: true });
});

describe('the ordinary inbox row', () => {
  it('lists the rows of spec 4 in order, the Walnut group last, titles included', () => {
    const items = build();
    expect(labels(items)).toEqual([
      'Harbour Office · Pontoon works next week',
      'Mark as read',
      '-',
      'Open message',
      '-',
      'Reply',
      'Reply all',
      'Forward',
      '-',
      'Make a task',
      '-',
      'Find mail from this sender',
      'Copy Walnut link',
      // S4: the rows that hand the mail to a model, last, under their own name. Every row above acts
      // on the mail itself.
      '-',
      'Walnut',
      'Summarize with Walnut',
      'Draft a reply with Walnut',
      'Ask Walnut about this…',
      // S8, under the three questions: the one Walnut row that acts on the world rather than asking
      // about it, so a stray click lands on it last.
      'Unsubscribe',
    ]);
    expect(items[0]!.info).toBe(true);
    expect(items[0]!.onSelect).toBeUndefined();
    expect(items[0]!.section).toBeUndefined();
    expect(items.find((one) => one.key === 'open')!.title).toBe(OPEN_MARKS_READ_TITLE);
    expect(items.find((one) => one.key === 'reply')!.title).toBe(REPLY_CLOSES_TITLE);
    expect(items.find((one) => one.key === 'copy-link')!.title).toBe(COPY_LINK_TITLE);
  });

  it('opens on the read toggle for the arrow keys: the title is not focusable', () => {
    const first = pressable(build())[0]!;
    expect(first.label).toBe('Mark as read');
  });

  it('gives every action the pair of the row it was built from, never a selection', () => {
    const items = build({ message: { accountId: READER, messageId: 'INBOX:2:11' } });
    for (const one of pressable(items)) one.onSelect?.();
    expect(acted).toEqual([
      `open ${READER} INBOX:2:11`,
      `task ${READER} INBOX:2:11`,
      'search office@example.invalid',
      `copy ${READER} INBOX:2:11`,
      // The Walnut rows take the pair off the ROW as well. `Draft a reply` is missing because this
      // account cannot send, so it is disabled and `pressable` drops it.
      `summarize ${READER} INBOX:2:11`,
      `ask ${READER} INBOX:2:11`,
    ]);
  });
});

describe('the read toggle states what the click will do', () => {
  it('says Mark as read on an unread row and Mark as unread on a read one', () => {
    expect(labels(build({ message: { flags: [] } }))[1]).toBe('Mark as read');
    expect(labels(build({ message: { flags: ['\\Seen'] } }))[1]).toBe('Mark as unread');
  });

  it('flips to the value the row does not hold', () => {
    build({ message: { flags: ['\\Seen'] } }).find((one) => one.key === 'read')!.onSelect!();
    expect(acted).toEqual([`read ${WRITER} INBOX:1:31 false`]);
  });

  it('is ABSENT, not disabled, when the provider cannot move the flag', () => {
    const items = build({ message: { accountId: READER, messageId: 'INBOX:2:12' } });
    expect(items.find((one) => one.key === 'read')).toBeUndefined();
    expect(labels(items).some((one) => one.startsWith('Mark as'))).toBe(false);
  });

  it('is drawn while the provider list is still unknown: no answer yet is not a no', () => {
    patch({ providersKnown: false });
    const items = build({ providers: [], message: { accountId: READER } });
    expect(items.find((one) => one.key === 'read')!.label).toBe('Mark as read');
  });

  it('disagrees per account inside ONE merged list', () => {
    const merged = { merged: true };
    expect(labels(build({ ...merged })).some((one) => one.startsWith('Mark as'))).toBe(true);
    expect(labels(build({ ...merged, message: { accountId: READER } })).some((one) => one.startsWith('Mark as')))
      .toBe(false);
  });
});

describe('the send gate', () => {
  it('disables the three send rows with the reason and keeps them in place', () => {
    const items = build({ message: { accountId: READER }, providers: [provider('inbound', { send: false })] });
    for (const key of ['reply', 'reply-all', 'forward']) {
      const one = items.find((item) => item.key === key)!;
      expect(one.disabled).toBe(true);
      expect(one.title).toBe(CANNOT_SEND_TITLE);
    }
    // The read toggle is untouched by the SEND gate: this provider can still move the flag. Nor are
    // the two Walnut rows that ask a question: reading a mail to a model needs no SMTP.
    expect(pressable(items).map((one) => one.label))
      .toEqual([
        'Mark as read', 'Open message', 'Make a task', 'Find mail from this sender', 'Copy Walnut link',
        'Summarize with Walnut', 'Ask Walnut about this…',
      ]);
  });

  it('reads the account, not the provider, when the account answers for itself', () => {
    const accounts = [{ ...account(WRITER, 'Fixture Mail'), capabilities: { send: false } }];
    const items = build({ accounts });
    expect(items.find((one) => one.key === 'reply')!.disabled).toBe(true);
  });
});

describe('a title is only said when it is true', () => {
  it('warns about closing the reader only while something is open, and for all three openers', () => {
    const open = build({ readerOpen: true });
    for (const key of ['reply', 'reply-all', 'forward']) {
      expect(open.find((one) => one.key === key)!.title, key).toBe(REPLY_CLOSES_TITLE);
    }
    // Nothing in the reader: these three close nothing, so the sentence is a lie and is dropped.
    const shut = build({ readerOpen: false });
    for (const key of ['reply', 'reply-all', 'forward']) {
      expect(shut.find((one) => one.key === key)!.title, key).toBeUndefined();
    }
  });

  it('keeps the send reason on a disabled opener whether or not the reader holds anything', () => {
    for (const readerOpen of [true, false]) {
      const items = build({ readerOpen, providers: [provider('fixture', { send: false })] });
      for (const key of ['reply', 'reply-all', 'forward']) {
        expect(items.find((one) => one.key === key)!.title, `${key} ${readerOpen}`)
          .toBe(CANNOT_SEND_TITLE);
      }
    }
  });

  it('never promises that opening marks read on an account whose provider cannot', () => {
    // The same capability the read toggle is read from: this menu used to drop the toggle for that
    // account and then explain, one row below, that opening does the write it had just refused.
    const items = build({ message: { accountId: READER, messageId: 'INBOX:2:12' } });
    expect(items.find((one) => one.key === 'read')).toBeUndefined();
    expect(items.find((one) => one.key === 'open')!.title).toBeUndefined();
    // Still said where it is true.
    expect(build().find((one) => one.key === 'open')!.title).toBe(OPEN_MARKS_READ_TITLE);
  });
});

describe('the task row', () => {
  it('offers Make a task with no taskId and Open task with one', () => {
    expect(build().find((one) => one.key === 'task')!.label).toBe('Make a task');
    const held = build({ message: { taskId: 'task-9' } });
    expect(held.find((one) => one.key === 'task')!.label).toBe('Open task');
    held.find((one) => one.key === 'task')!.onSelect!();
    expect(acted).toEqual(['open-task task-9']);
  });
});

describe('the title line', () => {
  it('names the account on its OWN line, only in a list that mixes them', () => {
    // A second `info` row, not a third field: the line clips from the right, so on live mail the
    // account (the one thing a merged list is asked about) was the first thing lost.
    expect(labels(build({ merged: true })).slice(0, 2))
      .toEqual(['Harbour Office · Pontoon works next week', 'Fixture Mail']);
    expect(labels(build({ merged: false }))[0]).toBe('Harbour Office · Pontoon works next week');
    expect(heading(build({ merged: false }))).toHaveLength(1);
    expect(heading(build({ merged: true }))).toHaveLength(2);
  });

  it('says nothing about an account in a merged list that holds only one', () => {
    const one = [account(WRITER, 'Fixture Mail')];
    expect(labels(build({ merged: true, accounts: one }))[0])
      .toBe('Harbour Office · Pontoon works next week');
    expect(heading(build({ merged: true, accounts: one }))).toHaveLength(1);
  });

  // R2-08 reversed the old rule here. The label used to be capped at 44 characters, measured: the
  // rendered label filled 254px of a 254px box, so CSS had clipped NOTHING and the JS cap had already
  // ellipsed both the sender and the subject, with 60px of the menu's 340px box unused. The BOX truncates
  // now (`nowrap` + `text-overflow: ellipsis`, full text in `title`) and these numbers are only a sanity
  // ceiling, so a long real subject stays whole and the account keeps its own line.
  it('keeps a long real subject whole and the account on its own line', () => {
    const subject = 'Winter works on the pontoon, the temporary ramp, and what the crews need';
    const items = build({ message: { subject }, merged: true });
    expect(items[0]!.label).toBe(`Harbour Office · ${subject}`);
    expect(items[0]!.title).toBe(`Harbour Office · ${subject}`);
    expect(items[1]!.label).toBe('Fixture Mail');
  });

  it('still keeps a very long person from squeezing the subject out', () => {
    const from = { name: 'Harbour Office Berth Allocations Desk', address: 'office@example.invalid' };
    const items = build({ message: { from }, merged: true });
    expect(items[0]!.label).toContain('Pontoon');
    expect(items[0]!.title)
      .toBe('Harbour Office Berth Allocations Desk · Pontoon works next week');
    // The ceiling is far above any real heading, and a pathological one still cannot reach the DOM whole.
    const rambling = build({ message: { subject: 'x'.repeat(400) }, merged: true });
    expect(String(rambling[0]!.label).length).toBeLessThan(200);
  });

  it('keeps a display name that is an address, and its hover text', () => {
    const long = [account(WRITER, 'mailbox.operations.harbour.office@example.invalid'), account(READER, 'r')];
    const items = build({ merged: true, accounts: long });
    expect(items[1]!.label).toBe('mailbox.operations.harbour.office@example.invalid');
    expect(items[1]!.title).toBe('mailbox.operations.harbour.office@example.invalid');
  });

  it('flattens a subject that carries a line break, so the row stays one line', () => {
    expect(truncateForMenu('Two\n lines  here', 40)).toBe('Two lines here');
  });
});

describe('mail this person wrote is a different menu', () => {
  const draft = { outbound: true, draftsView: true, message: { mailboxId: 'Drafts', flags: [] } };
  const sent = { outbound: true, message: { mailboxId: 'Sent', flags: ['\\Seen'] } };

  it('a provider drafts row: continue editing, the task row and the link, nothing else', () => {
    const items = build(draft);
    expect(labels(items)).toEqual([
      'To Writer · Pontoon works next week',
      'Continue editing',
      '-',
      'Make a task',
      '-',
      'Copy Walnut link',
      // Two of the three Walnut rows. `Draft a reply with Walnut` goes with `Reply`: there is nobody
      // to answer on mail this person wrote and never sent.
      '-',
      'Walnut',
      'Summarize with Walnut',
      'Ask Walnut about this…',
    ]);
    // No read toggle: a draft carries no `\Seen`, so the row already draws an unread dot and flipping
    // it is a real provider write against mail nobody has sent. No Reply (to oneself) and no Forward
    // (of a message nobody received).
    expect(items.find((one) => one.key === 'read')).toBeUndefined();
    expect(items.find((one) => one.key === 'reply')).toBeUndefined();
    expect(items.find((one) => one.key === 'reply-all')).toBeUndefined();
    expect(items.find((one) => one.key === 'forward')).toBeUndefined();
    expect(items.find((one) => one.key === 'sender')).toBeUndefined();
  });

  it('a sent row keeps the read toggle, Open, Forward, the task row and the link', () => {
    const items = build(sent);
    expect(labels(items)).toEqual([
      'To Writer · Pontoon works next week',
      'Mark as unread',
      '-',
      'Open message',
      '-',
      'Forward',
      '-',
      'Make a task',
      '-',
      'Copy Walnut link',
      '-',
      'Walnut',
      'Summarize with Walnut',
      'Ask Walnut about this…',
    ]);
    expect(items.find((one) => one.key === 'reply')).toBeUndefined();
    expect(items.find((one) => one.key === 'reply-all')).toBeUndefined();
  });

  it('never offers the address search on an outbound row: the index holds no recipients', () => {
    // `messages_fts` (src/integrations/mail/store.ts) indexes subject, from_addr, snippet, body_text
    // and NO recipient column, so searching a sent row's recipient always answered `0 results`. Dropped
    // the same way the read toggle is dropped when the provider cannot move the flag.
    expect(menuSearchAddress(row(), true)).toBe('');
    expect(build(sent).find((one) => one.key === 'sender')).toBeUndefined();
    expect(build(draft).find((one) => one.key === 'sender')).toBeUndefined();
    // And the item is still there, still searching the SENDER, on an inbound row.
    build().find((one) => one.key === 'sender')!.onSelect!();
    expect(acted).toEqual(['search office@example.invalid']);
  });

  it('drops the search row when the row carries no address to search for', () => {
    expect(menuSearchAddress(row({ to: [] }), true)).toBe('');
    expect(build({ message: { from: undefined as never } }).find((one) => one.key === 'sender'))
      .toBeUndefined();
  });

  it('carries the row\'s own To into the heading of an outbound row', () => {
    // The row reads `To Ferry Desk`; the heading used to read the bare name, so a sent row's menu read
    // exactly like the menu of an inbound row from that person one line above it.
    const named = build({ outbound: true, message: { to: [{ address: 'crew@example.invalid' }] } });
    expect(String(named[0]!.label)).toMatch(/^To crew@example/);
    expect(named[0]!.title).toBe('To crew@example.invalid · Pontoon works next week');
    // No recipient in the cached envelope is a claim about the CACHE, so no `To` is put in front of it.
    expect(labels(build({ outbound: true, message: { to: [] } }))[0])
      .toBe('Unknown recipient · Pontoon works next week');
  });
});

describe('no row names an action the server has no route for', () => {
  /**
   * Each one is a real mail-client verb with NO route in `src/integrations/mail/routes.ts`.
   *
   * `Unsubscribe` left this list when S8 gave it one (`POST /messages/:a/:m/unsubscribe`, in
   * routes-write.ts). It is now the only row in this menu that may be DISABLED on a message with
   * nothing to act on rather than dropped, which is graded in `mail-unsubscribe-items.test.ts`.
   */
  const FORBIDDEN = ['Delete', 'Move', 'Archive', 'Flag', 'Star', 'Mark all as read'];

  it('across every combination of the five dimensions', () => {
    const dims = [true, false];
    for (const markRead of dims) {
      for (const send of dims) {
        for (const taskId of dims) {
          for (const merged of dims) {
            for (const outbound of dims) {
              for (const draftsView of outbound ? dims : [false]) {
                const items = build({
                  providers: [provider('fixture', { markRead, send })],
                  accounts: [account(WRITER, 'Fixture Mail')],
                  message: { ...(taskId ? { taskId: 'task-9' } : {}), flags: outbound ? [] : ['\\Seen'] },
                  merged,
                  outbound,
                  draftsView,
                });
                const words = labels(items).join(' | ');
                for (const banned of FORBIDDEN) expect(words).not.toContain(banned);
                // Nothing is ever offered as destructive, so no row may be styled as one either.
                expect(items.some((one) => one.danger)).toBe(false);
              }
            }
          }
        }
      }
    }
  });
});

describe('the Walnut link survives its own parse', () => {
  /** What `MailApp`'s `useMailDeepLink` does with the query it is handed. */
  function parsed(link: string): { account: string | null; message: string | null } {
    const params = new URLSearchParams(new URL(link).search);
    return { account: params.get('account'), message: params.get('message') };
  }

  it('round-trips ids carrying + / = # and a space', () => {
    const accountId = 'fixture:a+b/c=d';
    const messageId = 'INBOX:1:a+b/c=d# e';
    const link = mailRowLink(accountId, messageId, 'http://127.0.0.1:3456');
    expect(link.startsWith('http://127.0.0.1:3456/mail?')).toBe(true);
    // The `+` must have been percent-encoded on the way out, or the parse above reads it as a space.
    expect(link).not.toContain('+b');
    expect(parsed(link)).toEqual({ account: accountId, message: messageId });
  });

  it('is an absolute link on this console, not a bare path', () => {
    const link = mailRowLink(WRITER, 'INBOX:1:31', 'http://127.0.0.1:3456');
    expect(link).toBe(
      'http://127.0.0.1:3456/mail?account=fixture%3Awriter%40example.invalid&message=INBOX%3A1%3A31',
    );
  });
});
