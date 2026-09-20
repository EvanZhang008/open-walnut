/**
 * Round 3 of the mail right-click slice, as the pure rules behind each fix.
 *
 * One case per graded id, and each one fails on the shape the reviewer measured:
 *
 * - R3-01 the two heading lines were drawn as two more menu rows, with no rule closing the block.
 * - R3-03 the "why is this disabled" sentence rode INSIDE the first row of the group it explains.
 * - R3-04 the header chip read `{n} unread · showing`, a sentence that stops mid-phrase, over a list
 *   whose row count can honestly differ from `n`.
 * - R3-05 an HTML-only message quoted as the attribution line and nothing under it.
 * - R3-06 `Open message` was drawn on the row the reader already shows, and warned about marking read
 *   on rows that were already read.
 */
import { describe, it, expect } from 'vitest';
import {
  contextMenuHeadingEnds,
  contextMenuReasonRows,
} from '../../web/src/components/common/ContextMenu';
import { normalizeContextMenuItems, type ContextMenuItem } from '../../web/src/utils/context-menu';
import { bodyQuoteText, quoteTextFromHtml } from '../../web/src/apps/mail/mail-quote-text';
import { heldRowsSentence, unreadChipLabel } from '../../web/src/apps/mail/mail-unread-filter';
import {
  OPEN_MARKS_READ_TITLE, messageMenuItems,
} from '../../web/src/apps/mail/mail-context-items';

const WHY = 'This account cannot send; add SMTP settings';

/** The shape a message row's menu has on an account that cannot send: two info lines, then the items. */
function sendlessMenu(): ContextMenuItem[] {
  return normalizeContextMenuItems([
    { key: 'target', info: true, label: 'Harbour Office · Pontoon works' },
    { key: 'target-account', info: true, label: 'Fixture Mail' },
    { key: 'read', label: 'Mark as read', onSelect: () => {} },
    { divider: true },
    { key: 'open', label: 'Open message', onSelect: () => {} },
    { divider: true },
    { key: 'reply', label: 'Reply', disabled: true, title: WHY, onSelect: () => {} },
    { key: 'reply-all', label: 'Reply all', disabled: true, title: WHY, onSelect: () => {} },
    { key: 'forward', label: 'Forward', disabled: true, title: WHY, onSelect: () => {} },
    { divider: true },
    { key: 'task', label: 'Make a task', onSelect: () => {} },
  ]);
}

describe('R3-01 the heading is a title BLOCK, not two more menu rows', () => {
  it('marks only the LAST line of a run, so the rule closes the block once', () => {
    const rows = sendlessMenu();
    expect([...contextMenuHeadingEnds(rows)]).toEqual([1]);
    // The row under the block is an action, which is what the rule has to separate it from.
    expect(rows[2]?.label).toBe('Mark as read');
  });

  it('marks a single heading line too, because a one-line block still needs its rule', () => {
    const rows = normalizeContextMenuItems([
      { key: 'target', info: true, label: 'Harbour Office · Pontoon works' },
      { key: 'open', label: 'Open message', onSelect: () => {} },
    ]);
    expect([...contextMenuHeadingEnds(rows)]).toEqual([0]);
  });

  it('marks nothing in a menu with no heading at all', () => {
    const rows = normalizeContextMenuItems([{ key: 'open', label: 'Open Drafts', onSelect: () => {} }]);
    expect(contextMenuHeadingEnds(rows).size).toBe(0);
  });
});

describe('R3-03 the reason is ONE row under the group it explains', () => {
  it('lands after the LAST row of the run, not inside the first', () => {
    const rows = sendlessMenu();
    const at = contextMenuReasonRows(rows);
    const forward = rows.findIndex((one) => one.key === 'forward');
    expect([...at.keys()]).toEqual([forward]);
    expect(at.get(forward)).toBe(WHY);
  });

  it('gives two runs of the same reason one row each, so neither group is unexplained', () => {
    const rows = normalizeContextMenuItems([
      { key: 'a', label: 'A', disabled: true, title: WHY, onSelect: () => {} },
      { key: 'b', label: 'B', onSelect: () => {} },
      { key: 'c', label: 'C', disabled: true, title: WHY, onSelect: () => {} },
      { key: 'd', label: 'D', disabled: true, title: WHY, onSelect: () => {} },
    ]);
    expect([...contextMenuReasonRows(rows).keys()]).toEqual([0, 3]);
  });

  it('says nothing for an enabled row whose title is a note about what the click costs', () => {
    const rows = normalizeContextMenuItems([
      { key: 'open', label: 'Open message', title: 'Opening a message marks it read', onSelect: () => {} },
    ]);
    expect(contextMenuReasonRows(rows).size).toBe(0);
  });
});

describe('R3-04 the chip finishes its sentence, and a held row is admitted', () => {
  it('says what it is showing when it is on, and only the count when it is off', () => {
    expect(unreadChipLabel('3', true)).toBe('3 unread · showing unread only');
    expect(unreadChipLabel('1,204', false)).toBe('1,204 unread');
    // The old copy is the failure: a pill that stops mid-phrase.
    expect(unreadChipLabel('3', true).endsWith('showing')).toBe(false);
  });

  it('explains a read row on an unread-only list, in the singular and the plural', () => {
    expect(heldRowsSentence(1)).toBe('One message you just dealt with is still listed.');
    expect(heldRowsSentence(2)).toBe('2 messages you just dealt with are still listed.');
    expect(heldRowsSentence(0)).toBe('');
    expect(heldRowsSentence(-1)).toBe('');
  });
});

describe('R3-05 an HTML-only message has text to quote', () => {
  it('derives the words from the markup, block by block', () => {
    const html = '<html><head><style>p{color:red}</style></head><body>'
      + '<h1>Mooring renewal</h1><p>The berth is held until the ninth.</p>'
      + '<p>Two crews, one&nbsp;pontoon.<br>Regards</p></body></html>';
    expect(quoteTextFromHtml(html)).toBe(
      'Mooring renewal\nThe berth is held until the ninth.\nTwo crews, one pontoon.\nRegards',
    );
  });

  it('never carries a style or script body into the quote', () => {
    const html = '<div><script>alert(1)</script><style>.a{}</style>Only this line.</div>';
    expect(quoteTextFromHtml(html)).toBe('Only this line.');
  });

  it('prefers the text half, falls back to the html half, and answers "" for neither', () => {
    expect(bodyQuoteText({ format: 'both', text: 'Plain.', html: '<p>Rich.</p>', bytes: 6, truncated: false }))
      .toBe('Plain.');
    // The exact shape the reviewer measured: format html, text '' (so the old code quoted nothing).
    expect(bodyQuoteText({ format: 'html', text: '', html: '<p>Rich.</p>', bytes: 11, truncated: false }))
      .toBe('Rich.');
    expect(bodyQuoteText(null)).toBe('');
    expect(bodyQuoteText({ format: 'html', html: '<p>  </p>', bytes: 9, truncated: false })).toBe('');
  });
});

describe('R3-06 no row that does nothing, and one warning that is true', () => {
  const CAPS = {
    search: true, watch: true, drafts: true, markRead: true, flags: false, threads: false,
    send: true, sendAsReply: true, bodies: 'both' as const, attachments: 'metadata' as const,
  };
  const providers = [{ id: 'fixture', label: 'Fixture', capabilities: CAPS, setupFields: [] }];
  const accounts = [{
    accountId: 'fixture:writer@example.invalid',
    providerId: 'fixture',
    displayName: 'Fixture Mail',
    address: 'writer@example.invalid',
    state: 'active' as const,
    unread: 0,
  }];

  function menu(over: { flags?: string[], readerHasRow?: boolean }): ContextMenuItem[] {
    return messageMenuItems({
      message: {
        accountId: 'fixture:writer@example.invalid',
        messageId: 'INBOX:1:31',
        mailboxId: 'INBOX',
        from: { name: 'Harbour Office', address: 'office@example.invalid' },
        to: [{ address: 'writer@example.invalid' }],
        subject: 'Pontoon works next week',
        snippet: 'The crews start on the ninth.',
        sentAt: 1_700_000_000_000,
        flags: over.flags ?? [],
        attachments: [],
        hasBody: true,
      },
      providers,
      accounts,
      outbound: false,
      draftsView: false,
      merged: false,
      readerOpen: over.readerHasRow === true,
      readerHasRow: over.readerHasRow === true,
      actions: {
        onSetRead: () => {}, onOpen: () => {}, onReply: () => {}, onForward: () => {},
        onMakeTask: () => {}, onOpenTask: () => {}, onSearchSender: () => {}, onCopyLink: () => {},
      },
    });
  }

  const words = (items: ContextMenuItem[]) =>
    items.filter((one) => !one.divider && !one.info).map((one) => String(one.label));

  it('drops `Open message` on the row the reader already holds', () => {
    expect(words(menu({ readerHasRow: true }))).not.toContain('Open message');
    // And it is still there for every other row, which is where the item belongs.
    expect(words(menu({}))).toContain('Open message');
  });

  it('leaves no double rule behind the dropped row', () => {
    const rows = menu({ readerHasRow: true });
    rows.forEach((one, at) => {
      if (one.divider) expect(rows[at + 1]?.divider, `two rules at ${at}`).not.toBe(true);
    });
    expect(rows[rows.length - 1]?.divider).not.toBe(true);
  });

  it('warns about marking read only on a row that is actually unread', () => {
    const unread = menu({ flags: [] }).find((one) => one.key === 'open');
    const read = menu({ flags: ['\\Seen'] }).find((one) => one.key === 'open');
    expect(unread?.title).toBe(OPEN_MARKS_READ_TITLE);
    expect(read?.title).toBeUndefined();
  });
});
