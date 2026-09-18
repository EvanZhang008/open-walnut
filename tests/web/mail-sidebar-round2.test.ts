/**
 * The arithmetic and the words behind the second review round, each pinned by the case that found it.
 *
 * - THE COLLAPSE ROW'S SECOND NUMBER COUNTS FOLDERS (F2) AND SAYS SO (round 3, N1/C55). It printed the
 *   unread MAIL first ("58 folders, 200 unread" over a hover text saying 6); the bare `6 unread` that
 *   replaced it was then read as six unread messages while the row stood over 202, so the clause names
 *   its unit: `6 with unread`.
 * - THE FIRST NUMBER IS A REMAINDER, so it needs the word `more` (F3). The account has 64 folders and six
 *   are drawn above the line; "58 folders" printed a remainder as if it were a total.
 * - ROLE ROWS KEEP THE SERVER'S ORDER (F6 reversed in round 3, C9). Sorting them into one canonical role
 *   sequence re-ordered every install's rows, including the single account one this slice promised to
 *   leave DOM-identical.
 */
import { describe, it, expect } from 'vitest';
import type { MailboxDto } from '../../web/src/api/mail';
import {
  TAIL_TITLE_COLLAPSED,
  TAIL_TITLE_EXPANDED,
  importantFolders,
  roleRowsInServerOrder,
  tailClause,
  tailLabel,
  tailTitle,
} from '../../web/src/apps/mail/mail-smart';

const A = 'dense:harbour';
const B = 'dense:marina';

function mailbox(
  accountId: string,
  mailboxId: string,
  role: MailboxDto['role'],
  extra: Partial<MailboxDto> = {},
): MailboxDto {
  return { accountId, mailboxId, name: mailboxId, role, unread: 0, total: 0, ...extra };
}

/** Account A as the server hands it over: inbox first, then by NAME, which lands in role order by luck. */
function rolesA(): MailboxDto[] {
  return [
    mailbox(A, 'INBOX', 'inbox', { name: 'INBOX' }),
    mailbox(A, 'Archive', 'archive', { name: 'Archive' }),
    mailbox(A, 'Drafts', 'drafts', { name: 'Drafts' }),
    mailbox(A, 'Sent', 'sent', { name: 'Sent' }),
    mailbox(A, 'Spam', 'spam', { name: 'Spam' }),
    mailbox(A, 'Trash', 'trash', { name: 'Trash' }),
  ];
}

/** Account B, same six roles, and its own names sort into a DIFFERENT role order (Bin before Drafts). */
function rolesB(): MailboxDto[] {
  return [
    mailbox(B, 'inbox', 'inbox', { name: 'Inbox' }),
    mailbox(B, 'archive', 'archive', { name: 'Archived' }),
    mailbox(B, 'bin', 'trash', { name: 'Bin' }),
    mailbox(B, 'marina/drafts', 'drafts', { name: 'Drafts' }),
    mailbox(B, 'junk', 'spam', { name: 'Junk' }),
    mailbox(B, 'marina/all-mail/sent', 'sent', { name: 'Sent Mail' }),
  ];
}

describe('the collapse row says how many folders, and how many hold unread (F2, F3)', () => {
  it('keeps `more` in both cases, because 58 is a remainder of 64', () => {
    expect(tailLabel(58, false)).toBe('58 more folders');
    expect(tailLabel(1, false)).toBe('1 more folder');
    expect(tailLabel(2, false)).toBe('2 more folders');
    expect(tailLabel(1_284, false)).toBe('1,284 more folders');
    expect(tailLabel(58, true)).toBe('Show fewer folders');
  });

  it('counts the FOLDERS that hold unread, never the mail in them', () => {
    // The measured shape: six of 58 hidden labels hold 200 unread between them. The row says six.
    expect(tailClause(6)).toBe('6 with unread');
    expect(tailClause(1)).toBe('1 with unread');
    expect(`${tailLabel(58, false)}, ${tailClause(6)}`).toBe('58 more folders, 6 with unread');
  });

  it('has no second clause at all when nothing hidden holds unread, and none when expanded', () => {
    expect(tailClause(0)).toBeNull();
    expect(tailClause(-3)).toBeNull();
    expect(tailClause(6, true)).toBeNull();
  });

  it('names the unit of the mail count in the hover text, where there is room for it', () => {
    const title = tailTitle(false, { folders: 6, unread: 200 });
    expect(title).toBe(`${TAIL_TITLE_COLLAPSED} 6 of them hold unread mail (200 messages).`);
    // The row's number and the hover text's number are the SAME number, which is the contradiction that
    // shipped: the element read 200 and its own title read 6.
    expect(title).toContain(`${tailClause(6)?.split(' ')[0]} of them`);
    // Singular agrees: `1 of them hold` was a grammar slip in the one case a person is most likely to read.
    expect(tailTitle(false, { folders: 1, unread: 1 })).toContain('1 of them holds unread mail (1 message).');
    expect(tailTitle(false, { folders: 2, unread: 9 })).toContain('2 of them hold unread mail (9 messages).');
    expect(tailTitle(false, { folders: 0, unread: 0 })).toBe(TAIL_TITLE_COLLAPSED);
    expect(tailTitle(true, { folders: 6, unread: 200 })).toBe(TAIL_TITLE_EXPANDED);
  });
});

/**
 * REVERSED in round 3, and this block is now the ratchet on the reversal (C9).
 *
 * Sorting the role rows into one canonical sequence re-ordered the rows of EVERY install, including the
 * single account one this slice promised to leave DOM-identical, and the spec asks for the server's order
 * inside an account section. Two accounts are made scannable by the role glyph each row already carries.
 */
describe('role rows keep the order the server gave them, in every account (C9)', () => {
  it('does not re-order two accounts into one canonical sequence', () => {
    // Proof the inputs really are two different orders, so this case cannot pass by accident.
    expect(rolesA().map((one) => one.role)).not.toEqual(rolesB().map((one) => one.role));
    expect(roleRowsInServerOrder(rolesA())).toEqual(rolesA());
    expect(roleRowsInServerOrder(rolesB())).toEqual(rolesB());
  });

  it('draws what the server gave, in the pane, for both accounts', () => {
    const mailboxes = {
      [A]: [...rolesA(), mailbox(A, 'harbour/label/offers', 'other', { name: 'Offers' })],
      [B]: rolesB(),
    };
    expect(importantFolders(mailboxes, A, { arrivals: {} }).shown.map((one) => one.mailboxId))
      .toEqual(rolesA().map((one) => one.mailboxId));
    expect(importantFolders(mailboxes, B, { arrivals: {} }).shown.map((one) => one.mailboxId))
      .toEqual(rolesB().map((one) => one.mailboxId));
    // The ordinary label is still the tail's business and never joins the role rows.
    expect(importantFolders(mailboxes, A, { arrivals: {} }).hidden.map((one) => one.mailboxId))
      .toEqual(['harbour/label/offers']);
  });

  it('keeps two folders of one role, and an unknown role, exactly where the server put them', () => {
    const rows = [
      mailbox(A, 'Archive/2025', 'archive', { name: 'Archive 2025' }),
      mailbox(A, 'Archive', 'archive', { name: 'Archive' }),
      mailbox(A, 'INBOX', 'inbox'),
    ];
    expect(roleRowsInServerOrder(rows).map((one) => one.mailboxId))
      .toEqual(['Archive/2025', 'Archive', 'INBOX']);
    const mailboxes = { [A]: [mailbox(A, 'Sent', 'sent'), mailbox(A, 'INBOX', 'inbox')] };
    expect(importantFolders(mailboxes, A, { arrivals: {} }).shown.map((one) => one.mailboxId))
      .toEqual(['Sent', 'INBOX']);
  });
});
