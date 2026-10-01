/**
 * The grouped inbox's sentences. The unread places (badge tooltip, header count title, IMPORTANT head
 * title) all call `unreadExplain()`, so pinning it here pins all of them.
 */
import { describe, expect, it } from 'vitest';
import {
  bulkResultText, groupRowAria, groupsErrorText, importantCardBody, importantCardTitle, importantSavedText,
  markLabel, moreLabel, progressLabel, readOnlyTitle, readerWhyText, renamedText, rulesErrorText, sortProgressText,
  sortingText, unreadExplain, unreadWord,
} from '../../web/src/apps/mail/mail-groups-copy';

describe('unreadExplain', () => {
  it('says Important, the groups, then the provider number', () => {
    expect(unreadExplain({ importantUnread: 3, groupedUnread: 16, providerUnread: 19, cachedUnread: 19 }))
      .toBe('3 unread in Important.\n16 unread in groups.\n19 unread in Inbox as the server reports.');
  });

  it('adds the cached number only when it differs from the provider (real shape: 17 vs 19)', () => {
    expect(unreadExplain({ importantUnread: 3, groupedUnread: 14, providerUnread: 19, cachedUnread: 17 }))
      .toBe("3 unread in Important.\n14 unread in groups.\n19 unread in Inbox as the server reports.\nWalnut's copy holds 17 unread.");
  });

  it('groups thousands', () => {
    expect(unreadExplain({ importantUnread: 1234, groupedUnread: 0, providerUnread: 25204, cachedUnread: 25204 }))
      .toContain(`${(1234).toLocaleString()} unread in Important.`);
  });
});

describe('header and row words', () => {
  it('says the count and the sorting state', () => {
    expect(unreadWord(19)).toBe('19 unread');
    expect(sortingText(3)).toBe('Sorting 3 new');
  });

  it('labels a group line for a screen reader, open or closed', () => {
    expect(groupRowAria('Ticket updates', 6, false)).toBe('Ticket updates, 6 unread. Open group');
    expect(groupRowAria('Ticket updates', 0, true)).toBe('Ticket updates, 0 unread. Close group');
  });

  it('says the rows past the first three', () => {
    expect(moreLabel(3)).toBe('3 more');
    expect(moreLabel(1204)).toBe(`${(1204).toLocaleString()} more`);
  });

  it('names read-only accounts one sentence each', () => {
    expect(readOnlyTitle(['Work mail'])).toBe("Mail in Work mail can't be marked read from Walnut.");
  });

  it('says where a mail is and why in the reader head', () => {
    expect(readerWhyText('Ticket updates', 'Automated ticket status change')).toBe('In Ticket updates · Automated ticket status change');
    expect(readerWhyText('Important', '')).toBe('In Important');
  });

  it('says what the group cards change', () => {
    expect(importantCardTitle('Ticket updates')).toBe('Treat Ticket updates as important?');
    expect(importantCardBody('Ticket updates')).toBe(
      'Mail Walnut groups as Ticket updates goes to Important from now on. You can change this in Settings, Mail rules.',
    );
    expect(importantSavedText('Ticket updates')).toBe('Saved. Mail in Ticket updates now goes to Important.');
    expect(renamedText('Tickets')).toBe('Renamed to Tickets.');
  });
});

describe('bulk read sentences', () => {
  it('walks the progress labels', () => {
    expect(markLabel(11)).toBe('Mark 11 read');
    expect(progressLabel('read', null, 11)).toBe('Marking…');
    expect(progressLabel('read', 6, 11)).toBe('Marking 6 of 11…');
    expect(progressLabel('unread', 6, 11)).toBe('Undoing 6 of 11…');
  });

  it('says a full success (named by group), a partial and a total failure', () => {
    expect(bulkResultText({ kind: 'read', changed: 11, failed: 0 })).toBe('Marked 11 read.');
    expect(bulkResultText({ kind: 'read', changed: 6, failed: 0, groupLabel: 'Ticket updates' })).toBe('Marked 6 read in Ticket updates.');
    expect(bulkResultText({ kind: 'read', changed: 1176, failed: 24, firstReason: 'the provider refused.' }))
      .toBe(`Marked ${(1176).toLocaleString()} read. 24 couldn't be changed: the provider refused.`);
    expect(bulkResultText({ kind: 'read', changed: 0, failed: 3, firstReason: 'offline' }))
      .toBe("Walnut couldn't mark these read: offline.");
  });

  it('says the undo outcomes and a stop', () => {
    expect(bulkResultText({ kind: 'unread', changed: 11, failed: 0 })).toBe('Marked 11 unread again.');
    expect(bulkResultText({ kind: 'unread', changed: 9, failed: 2, firstReason: 'busy' }))
      .toBe("Marked 9 unread again. 2 couldn't be changed: busy.");
    expect(bulkResultText({ kind: 'unread', changed: 0, failed: 2, firstReason: 'busy' }))
      .toBe("Walnut couldn't undo this: busy.");
    expect(bulkResultText({ kind: 'read', changed: 240, failed: 0, stopped: true })).toBe('Stopped. Marked 240 read.');
  });

  it('never leaves an empty reason', () => {
    expect(bulkResultText({ kind: 'read', changed: 0, failed: 1, firstReason: '' }))
      .toBe("Walnut couldn't mark these read: the server did not say why.");
  });
});

describe('state lines', () => {
  it('tells the first backfill from an update', () => {
    expect(sortProgressText(1200, 3615, true)).toBe(`Sorting your mail… ${(1200).toLocaleString()} of ${(3615).toLocaleString()}`);
    expect(sortProgressText(400, 3615, false)).toBe(`Updating groups… 400 of ${(3615).toLocaleString()}`);
  });

  it('names the line of a rules error when it has one', () => {
    expect(rulesErrorText(7)).toBe('Your rules file has an error (line 7), so Walnut is using the last rules that worked.');
    expect(rulesErrorText(undefined)).toBe('Your rules file has an error, so Walnut is using the last rules that worked.');
  });

  it('falls back to all mail in words', () => {
    expect(groupsErrorText('Group counts are taking too long.'))
      .toBe("Walnut couldn't sort this inbox: Group counts are taking too long. Showing all mail.");
  });
});
