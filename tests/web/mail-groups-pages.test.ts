/**
 * The grouped inbox's page rules (spec 9.3a, 8.3): pages keyed apart from All mail, a refetched
 * first page merged by the server's keyset order so older pages survive a live refresh, and a
 * sender order that stays frozen while its numbers change.
 */
import { describe, expect, it } from 'vitest';
import type { MailMessageDto } from '../../web/src/api/mail';
import {
  appendOlder, compareListOrder, mergeFirstPage, mergeKeepShown, pageKey, rowId, withFlags, withoutRows,
} from '../../web/src/apps/mail/mail-groups-pages';

function row(messageId: string, sentAt: number, accountId = 'marina'): MailMessageDto {
  return {
    messageId, accountId, mailboxId: 'INBOX', rfcMessageId: `<${messageId}@example.invalid>`,
    from: { name: 'Harbour Desk', address: 'desk@marina.example.invalid' }, to: [], subject: messageId,
    snippet: '', sentAt, flags: [], attachments: [], hasBody: false,
  };
}

const ids = (rows: MailMessageDto[]) => rows.map((one) => one.messageId);

describe('pageKey', () => {
  it('keeps Important, a group and a sender apart from each other', () => {
    expect(pageKey('smart:inbox', 'important')).toBe('smart:inbox|important|');
    expect(pageKey('acct/marina/INBOX', 'notifications', 'issues@tickets.example.invalid'))
      .toBe('acct/marina/INBOX|notifications|issues@tickets.example.invalid');
    expect(pageKey('smart:inbox', 'important')).not.toBe(pageKey('smart:inbox', 'notifications'));
  });
});

describe('compareListOrder', () => {
  it('matches sent_at DESC, message_id DESC, account_id DESC', () => {
    const sorted = [row('a', 1), row('b', 3), row('c', 3), row('c', 3, 'ferry')].sort(compareListOrder);
    expect(sorted.map((one) => `${one.messageId}/${one.accountId}`)).toEqual(['c/marina', 'c/ferry', 'b/marina', 'a/marina']);
  });
});

describe('mergeFirstPage', () => {
  const loaded = [row('m9', 90), row('m8', 80), row('m7', 70), row('m6', 60), row('m5', 50)];

  it('keeps every older page below the fresh range', () => {
    const fresh = [row('n10', 100), row('m9', 90), row('m8', 80)];
    expect(ids(mergeFirstPage(loaded, fresh, false))).toEqual(['n10', 'm9', 'm8', 'm7', 'm6', 'm5']);
  });

  it('drops a row inside the fresh range that the fresh page no longer holds', () => {
    const fresh = [row('m9', 90), row('m7', 70)];
    expect(ids(mergeFirstPage(loaded, fresh, false))).toEqual(['m9', 'm7', 'm6', 'm5']);
  });

  it('takes the fresh page whole when it ended the list', () => {
    expect(ids(mergeFirstPage(loaded, [row('m9', 90)], true))).toEqual(['m9']);
  });

  it('never repeats a row', () => {
    const fresh = [row('m9', 90), row('m8', 80), row('m7', 70)];
    const merged = mergeFirstPage(loaded, fresh, false);
    expect(new Set(merged.map(rowId)).size).toBe(merged.length);
  });

  it('keeps what is loaded for an empty page that claims more', () => {
    expect(mergeFirstPage(loaded, [], false)).toBe(loaded);
  });
});

describe('row edits', () => {
  it('appends older rows without duplicates', () => {
    expect(ids(appendOlder([row('a', 3), row('b', 2)], [row('b', 2), row('c', 1)]))).toEqual(['a', 'b', 'c']);
  });

  it('flips one pair only, by account AND id', () => {
    const rows = [row('same', 2, 'marina'), row('same', 2, 'ferry')];
    const next = withFlags(rows, { accountId: 'ferry', messageId: 'same' }, () => ['\\Seen']);
    expect(next[0]!.flags).toEqual([]);
    expect(next[1]!.flags).toEqual(['\\Seen']);
    expect(withFlags(rows, { accountId: 'x', messageId: 'same' }, () => [])).toBe(rows);
  });

  it('drops only the named pairs', () => {
    const rows = [row('a', 2), row('b', 1)];
    expect(ids(withoutRows(rows, new Set([rowId(rows[0]!)])))).toEqual(['b']);
    expect(withoutRows(rows, new Set())).toBe(rows);
  });
});

describe('mergeKeepShown (an open group keeps what it showed)', () => {
  it('keeps a row the unread-only refetch no longer returns, with the flags it has now', () => {
    const read = { ...row('b', 20), flags: ['\\Seen'] };
    const merged = mergeKeepShown([row('a', 30), read, row('c', 10)], [row('a', 30), row('c', 10)]);
    expect(ids(merged)).toEqual(['a', 'b', 'c']);
    expect(merged[1]!.flags).toEqual(['\\Seen']);
  });

  it('adds new mail in the server order and lets the fresh copy win', () => {
    const fresh = [row('n', 40), { ...row('a', 30), subject: 'updated' }];
    const merged = mergeKeepShown([row('a', 30), row('c', 10)], fresh);
    expect(ids(merged)).toEqual(['n', 'a', 'c']);
    expect(merged[1]!.subject).toBe('updated');
  });

  it('keeps two accounts\' rows with the same id apart', () => {
    const merged = mergeKeepShown([row('x', 5, 'marina')], [row('x', 5, 'ferry')]);
    expect(merged.map((one) => one.accountId).sort()).toEqual(['ferry', 'marina']);
  });
});
