/**
 * Round three of the sidebar review, one case per finding, each pinned by what the finding cost.
 *
 * - N1 / C55 THE COLLAPSE CLAUSE NAMES ITS UNIT. `6 unread` fitted the row and was read as six unread
 *   messages while the row stood over 202 of them, one thirty-third of the truth with no unit on it.
 * - N5 OPENING A FOLDER ENDS ITS ARRIVAL. The `New` mark came back after the folder had been read.
 * - N3 A SENT LIST IS SCANNED FOR THE RECIPIENT. It printed the account's own name on every row.
 * - N10 / C9 THE PROVIDER'S OWN NAME IS THE LABEL (see `mail-sidebar-fixes`, `mail-sidebar-round2`).
 */
import { describe, it, expect } from 'vitest';
import type { MailAddress } from '../../web/src/api/mail';
import { rowRecipientLabel } from '../../web/src/apps/mail/mail-format';
import { arrivalsAfterOpen, tailClause, tailLabel } from '../../web/src/apps/mail/mail-smart';
import { pairKey } from '../../web/src/apps/mail/mail-store';

function to(...people: Array<[string | undefined, string]>): MailAddress[] {
  return people.map(([name, address]) => (name ? { name, address } : { address }));
}

describe('the collapse row names the unit of its second number (N1, C55)', () => {
  it('is the spec string, verbatim, at the measured density', () => {
    expect(`${tailLabel(58, false)}, ${tailClause(6)}`).toBe('58 more folders, 6 with unread');
    expect(`${tailLabel(1, false)}, ${tailClause(1)}`).toBe('1 more folder, 1 with unread');
  });

  it('never prints a bare count, at any count', () => {
    // The shape is the rule: a number and then the unit, never a number and then a state word that the
    // first clause has already claimed for folders.
    for (const folders of [1, 2, 6, 57, 1_284]) {
      const clause = tailClause(folders)!;
      expect(clause).toMatch(/^[\d,]+ with unread$/);
      expect(clause).not.toMatch(/^[\d,]+ unread$/);
    }
  });

  it('still says nothing at zero, and nothing while expanded', () => {
    expect(tailClause(0)).toBeNull();
    expect(tailClause(6, true)).toBeNull();
  });
});

describe('opening a folder ends its arrival (N5)', () => {
  // The store's own key, never a hand-spelled one: its separator is not a character you can type.
  const KEY = pairKey('dense:harbour', 'harbour/label/berths');
  const OTHER = pairKey('dense:harbour', 'harbour/label/offers');

  it('drops the pair that was opened and keeps every other one', () => {
    const next = arrivalsAfterOpen({ [KEY]: 4, [OTHER]: 2 }, KEY);
    expect(next).toEqual({ [OTHER]: 2 });
  });

  it('returns the SAME object when that pair never had an arrival', () => {
    const arrivals = { [OTHER]: 2 };
    expect(arrivalsAfterOpen(arrivals, KEY)).toBe(arrivals);
    expect(arrivalsAfterOpen({}, KEY)).toEqual({});
  });

  it('does not mutate the map it was given', () => {
    const arrivals = { [KEY]: 4 };
    arrivalsAfterOpen(arrivals, KEY);
    expect(arrivals).toEqual({ [KEY]: 4 });
  });
});

describe('a sent or drafts row says who the mail went to (N3)', () => {
  it('is the first recipient, with a count of the rest', () => {
    expect(rowRecipientLabel(to(['Marina Desk', 'desk@marina.example']))).toBe('Marina Desk');
    expect(rowRecipientLabel(to([undefined, 'desk@marina.example']))).toBe('desk@marina.example');
    expect(rowRecipientLabel(to(
      ['Marina Desk', 'desk@marina.example'],
      ['Berth Office', 'berths@marina.example'],
      [undefined, 'crew@marina.example'],
    ))).toBe('Marina Desk +2');
  });

  it('is EMPTY when nobody is known, so the row can say what it does not know', () => {
    // Measured on live mail: a sent folder does hold rows whose cached envelope never carried recipients.
    // The row drops the word `To` there and prints `Unknown recipient` (see `MailRow`), which is a claim
    // about the cache rather than about the message.
    expect(rowRecipientLabel([])).toBe('');
    expect(rowRecipientLabel(undefined)).toBe('');
  });

  it('never spends the row on every name it was sent to', () => {
    const many = to(...Array.from({ length: 11 }, (_, at) => [`Crew ${at}`, `c${at}@marina.example`] as [string, string]));
    const label = rowRecipientLabel(many);
    expect(label).toBe('Crew 0 +10');
    expect(label.split(',')).toHaveLength(1);
  });
});
