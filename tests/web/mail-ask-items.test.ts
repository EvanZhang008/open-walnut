/**
 * The Walnut group of the message row menu (S4), as DATA.
 *
 * The group is three rows and a name, and nearly everything that can go wrong about it is a question
 * of WHICH rows exist, which is why it is graded here rather than in a browser:
 *
 * - it is the LAST group, under a divider, headed by an `info` row rather than a `section` one
 *   (`section` uppercases and carries no `title`, which is why the two title lines are `info` too);
 * - `Draft a reply with Walnut` follows `Reply` exactly: disabled with the SMTP reason on an account
 *   that cannot send, and absent altogether on mail this person wrote (a sent row, a draft row). The
 *   other two are always there, because reading a mail to a model needs no SMTP and answers a
 *   question about a draft as well as about an inbox row;
 * - every row takes `(accountId, messageId)` off the ROW, never off the selection: a merged list holds
 *   two accounts, and in one the same provider message id belongs to somebody else's mail;
 * - each of the three is marked `ai`, which is what draws the ✦ inside the label and puts
 *   `data-ai="true"` on the row. The mark is deliberately NOT `icon`: `icon` is a 14px column, and
 *   this menu draws no other icons, so an icon there would indent this group's words and leave the ten
 *   rows above them flush left (the rendered attribute is pinned by the Playwright specs).
 *
 * Plus the promise the rest of the menu already makes and this group must not break: a divider is never
 * left dangling, and no row names an action with no route behind it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ASK_ROWS,
  WALNUT_GROUP_LABEL,
  messageMenuItems,
} from '../../web/src/apps/mail/mail-context-items';
import { CANNOT_SEND_TITLE } from '../../web/src/apps/mail/compose/send-status';
import { MAIL_ASK_PRESETS, mailAskKey } from '../../web/src/apps/mail/mail-ask';
import { UNSUBSCRIBE_LABELS } from '../../web/src/apps/mail/mail-unsubscribe-state';
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

let acted: string[] = [];

interface BuildOver {
  message?: Partial<MailMessageDto>;
  providers?: MailProviderSummary[];
  accounts?: MailAccountDto[];
  outbound?: boolean;
  draftsView?: boolean;
  merged?: boolean;
  readerOpen?: boolean;
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
    actions: {
      onSetRead: () => acted.push('read'),
      onOpen: () => acted.push('open'),
      onReply: () => acted.push('reply'),
      onForward: () => acted.push('forward'),
      onMakeTask: () => acted.push('task'),
      onOpenTask: () => acted.push('open-task'),
      onSearchSender: () => acted.push('search'),
      onCopyLink: () => acted.push('copy'),
      onSummarize: (message) => acted.push(`summarize ${message.accountId} ${message.messageId}`),
      onDraftReply: (message) => acted.push(`draft-reply ${message.accountId} ${message.messageId}`),
      onAskAbout: (message) => acted.push(`ask ${message.accountId} ${message.messageId}`),
      onUnsubscribe: (message: MailMessageDto) => acted.push(`unsubscribe ${message.accountId} ${message.messageId}`),
      onFinishUnsubscribe: (message: MailMessageDto, reason?: string) =>
        acted.push(`finish-unsubscribe ${message.accountId} ${message.messageId} ${reason ?? ''}`),
    },
  });
}

/** The group's rows, in order: the divider, the name, then whichever of the three survived. */
function group(items: ContextMenuItem[]): ContextMenuItem[] {
  const at = items.findIndex((one) => one.key === 'walnut');
  return at < 0 ? [] : items.slice(at - 1);
}

const KEYS = ['ask-summarize', 'ask-draft-reply', 'ask-about'] as const;

beforeEach(() => {
  acted = [];
  __resetMailStore();
  patch({ providersKnown: true });
});

describe('where the group sits', () => {
  it('is the last thing in the menu: a divider, the name Walnut, then its rows', () => {
    const items = build();
    expect(group(items).map((one) => (one.divider ? '-' : String(one.label)))).toEqual([
      '-',
      WALNUT_GROUP_LABEL,
      ASK_ROWS.summarize,
      ASK_ROWS.draftReply,
      ASK_ROWS.about,
      // S8's `Unsubscribe`, under the three questions: it acts on the world rather than asking about
      // it, so it sits where a stray click is least likely. Its own states are graded in
      // `mail-unsubscribe-items.test.ts`.
      UNSUBSCRIBE_LABELS.ready,
    ]);
    // Nothing follows it, so this really is the bottom of the menu.
    expect(items[items.length - 1]!.key).toBe('unsubscribe');
  });

  it('names the group with an info row, not a section row', () => {
    const name = build().find((one) => one.key === 'walnut')!;
    // `section` UPPERCASES and is not focusable either, but the two title lines above are `info` for
    // that reason and a menu with one of each reads as two different kinds of heading.
    expect(name.info).toBe(true);
    expect(name.section).toBeUndefined();
    expect(name.onSelect).toBeUndefined();
  });

  it('never leaves a dangling divider, whatever the menu dropped above it', () => {
    for (const items of [build(), build({ outbound: true }), build({ outbound: true, draftsView: true })]) {
      expect(items[0]!.divider).toBeUndefined();
      expect(items[items.length - 1]!.divider).toBeUndefined();
      const doubled = items.some((one, at) => !!one.divider && !!items[at + 1]?.divider);
      expect(doubled).toBe(false);
    }
  });
});

describe('which of the three rows exist', () => {
  it('draws all three on an ordinary inbox row of an account that can send', () => {
    const items = build();
    for (const key of KEYS) expect(items.find((one) => one.key === key), key).toBeTruthy();
    for (const key of KEYS) expect(items.find((one) => one.key === key)!.disabled, key).toBeFalsy();
  });

  it('disables Draft a reply with the SMTP reason on an account that cannot send', () => {
    const items = build({ message: { accountId: READER }, providers: [provider('inbound', { send: false })] });
    const draftReply = items.find((one) => one.key === 'ask-draft-reply')!;
    expect(draftReply.disabled).toBe(true);
    expect(draftReply.title).toBe(CANNOT_SEND_TITLE);
    // The same answer `Reply` gives, from the same gate: disabled rather than dropped, because SMTP
    // settings are something the person can go and fix.
    expect(items.find((one) => one.key === 'reply')!.title).toBe(CANNOT_SEND_TITLE);
    // Asking a question needs no SMTP, so the other two stay live.
    expect(items.find((one) => one.key === 'ask-summarize')!.disabled).toBeFalsy();
    expect(items.find((one) => one.key === 'ask-about')!.disabled).toBeFalsy();
  });

  it('reads the ACCOUNT, not only the provider, for the send gate', () => {
    const accounts = [{ ...account(WRITER, 'Fixture Mail'), capabilities: { send: false } }];
    expect(build({ accounts }).find((one) => one.key === 'ask-draft-reply')!.disabled).toBe(true);
  });

  it('drops Draft a reply on mail this person wrote: a sent row and a drafts row', () => {
    for (const over of [
      { outbound: true, message: { mailboxId: 'Sent', flags: ['\\Seen'] } },
      { outbound: true, draftsView: true, message: { mailboxId: 'Drafts', flags: [] } },
    ]) {
      const items = build(over);
      // ABSENT, not disabled, exactly as `Reply` is there: there is nobody to answer.
      expect(items.find((one) => one.key === 'ask-draft-reply')).toBeUndefined();
      expect(items.find((one) => one.key === 'reply')).toBeUndefined();
      // The other two still answer questions about mail this person wrote.
      expect(items.find((one) => one.key === 'ask-summarize')).toBeTruthy();
      expect(items.find((one) => one.key === 'ask-about')).toBeTruthy();
    }
  });

  it('keeps all three on the row the reader is already holding, and in a merged list', () => {
    for (const over of [{ readerHasRow: true }, { merged: true }, { readerOpen: false }]) {
      const items = build(over);
      for (const key of KEYS) expect(items.find((one) => one.key === key), `${key} ${JSON.stringify(over)}`)
        .toBeTruthy();
    }
  });

  it('says nothing about closing the reader: the drawer writes no draft and gives the pane back', () => {
    // `Reply` warns, because a composer saves a draft the moment it opens and takes the pane for good.
    expect(build({ readerOpen: true }).find((one) => one.key === 'reply')!.title).toBeTruthy();
    for (const key of KEYS) {
      expect(build({ readerOpen: true }).find((one) => one.key === key)!.title, key).toBeUndefined();
    }
  });
});

describe('the AI mark', () => {
  it('marks every Walnut row `ai`, and nothing else in the menu', () => {
    const items = build();
    expect(items.filter((one) => one.ai).map((one) => one.key)).toEqual([...KEYS, 'unsubscribe']);
  });

  it('carries the mark in `ai` and NOT in `icon`, so no row is indented for a column this menu has none of', () => {
    for (const key of KEYS) {
      const one = build().find((item) => item.key === key)!;
      expect(one.ai, key).toBe(true);
      expect(one.icon, key).toBeUndefined();
    }
    // Nothing above the group has an icon either, which is the whole reason the mark rides the label.
    expect(build().every((one) => one.icon === undefined)).toBe(true);
  });

  it('leaves the group name unmarked: the ✦ belongs to the rows that do something', () => {
    expect(build().find((one) => one.key === 'walnut')!.ai).toBeUndefined();
  });
});

describe('every row acts on its own row', () => {
  it('hands each handler the pair the menu was built from', () => {
    const items = build({ message: { accountId: READER, messageId: 'INBOX:2:11' } });
    for (const key of KEYS) items.find((one) => one.key === key)!.onSelect!();
    expect(acted).toEqual([
      `summarize ${READER} INBOX:2:11`,
      `draft-reply ${READER} INBOX:2:11`,
      `ask ${READER} INBOX:2:11`,
    ]);
  });

  it('keys the conversation on the PAIR, so one message id on two accounts is two chats', () => {
    // The merged list's own case: the dense fixture really does hold `shared-8042` on both accounts.
    expect(mailAskKey(WRITER, 'shared-8042')).not.toBe(mailAskKey(READER, 'shared-8042'));
    // And a JSON join, so `a:b` + `c` cannot collide with `a` + `b:c` (the rule `pairKey` states).
    expect(mailAskKey('a:b', 'c')).not.toBe(mailAskKey('a', 'b:c'));
  });
});

describe('what the rows ask', () => {
  it('sends something for Summarize and Draft a reply, and nothing at all for Ask', () => {
    expect(MAIL_ASK_PRESETS.summarize.length).toBeGreaterThan(20);
    expect(MAIL_ASK_PRESETS['draft-reply'].length).toBeGreaterThan(20);
    // '' is the whole implementation of "Ask… opens the composer and sends nothing".
    expect(MAIL_ASK_PRESETS.ask).toBe('');
  });

  it('tells the model that sending goes through the approval, in the draft-reply preset itself', () => {
    const preset = MAIL_ASK_PRESETS['draft-reply'];
    expect(preset).toContain('mail_request_send');
    expect(preset).toMatch(/do not send/i);
    expect(preset).toMatch(/approval/i);
    // The other two must not mention sending at all: a summary that offers to send is a surprise.
    expect(MAIL_ASK_PRESETS.summarize).not.toContain('mail_request_send');
  });
});

describe('no row names an action with no route behind it', () => {
  it('the group adds no verb the server cannot honour', () => {
    // `Unsubscribe` left this list in S8, which gave it a route of its own
    // (`POST /messages/:a/:m/unsubscribe`). Everything else here is still a verb with no route.
    const forbidden = ['Delete', 'Move', 'Archive', 'Flag', 'Star', 'Send'];
    for (const outbound of [true, false]) {
      for (const draftsView of outbound ? [true, false] : [false]) {
        const words = group(build({ outbound, draftsView }))
          .map((one) => (one.divider ? '' : String(one.label))).join(' | ');
        for (const banned of forbidden) expect(words, `${banned} ${outbound} ${draftsView}`).not.toContain(banned);
        expect(group(build({ outbound, draftsView })).some((one) => one.danger)).toBe(false);
      }
    }
  });
});
