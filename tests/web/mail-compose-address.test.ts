/**
 * Recipients: how typed and pasted text becomes chips, and who a reply goes to.
 *
 * Both halves are graded here because both are arithmetic with a wrong answer that a human pays
 * for. A split that gets it wrong sends the mail to two of the three people it was addressed to; a
 * reply-all that keeps your own address mails you your own reply, and one that does not dedupe
 * mails somebody twice.
 */
import { describe, expect, it } from 'vitest';
import {
  addressKey,
  chipsFrom,
  chipsOf,
  hasInvalidAddress,
  parseAddressChip,
  splitAddressText,
  validAddresses,
  withChips,
} from '../../web/src/apps/mail/compose/mail-address';
import {
  bodyWithQuote,
  quoteMarkdown,
  replyPrefill,
  replySubject,
} from '../../web/src/apps/mail/compose/reply-draft';

describe('one address', () => {
  it('reads a display name out of Name <address>', () => {
    const chip = parseAddressChip('Keeper Reports <keeper@example.invalid>');
    expect(chip).toMatchObject({ name: 'Keeper Reports', address: 'keeper@example.invalid', valid: true });
  });

  it('reads a bare address and an angled one with no name', () => {
    expect(parseAddressChip('alice@example.invalid')).toMatchObject({
      address: 'alice@example.invalid', valid: true,
    });
    expect(parseAddressChip('<bob@example.invalid>')).toMatchObject({
      address: 'bob@example.invalid', valid: true,
    });
    expect(parseAddressChip('alice@example.invalid').name).toBeUndefined();
  });

  it('unquotes a quoted display name, comma and all', () => {
    // Through `chipsFrom`, not the parser: the comma in a quoted name is exactly what the SPLIT gets
    // wrong, and a parser test cannot see that (it is handed the fragment the split produced).
    const chips = chipsFrom('"Reports, Keeper" <keeper@example.invalid>');
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({ name: 'Reports, Keeper', address: 'keeper@example.invalid', valid: true });
  });

  it('keeps an invalid address, in the words it was typed in', () => {
    const chip = parseAddressChip('alice at example.invalid');
    expect(chip.valid).toBe(false);
    expect(chip.raw).toBe('alice at example.invalid');
  });

  it('refuses a display name carrying a line break, which is header injection', () => {
    expect(parseAddressChip('Bad\nBcc: sneak@example.invalid <a@b.invalid>').valid).toBe(false);
  });

  it('refuses a domain with no dot and an address with no @', () => {
    expect(parseAddressChip('alice@localhost').valid).toBe(false);
    expect(parseAddressChip('alice.example.invalid').valid).toBe(false);
  });
});

describe('splitting typed and pasted text', () => {
  it('splits on commas, semicolons and newlines', () => {
    expect(splitAddressText('a@x.invalid, b@y.invalid; c@z.invalid\nd@w.invalid')).toEqual([
      'a@x.invalid', 'b@y.invalid', 'c@z.invalid', 'd@w.invalid',
    ]);
  });

  it('splits on whitespace only when every word is an address', () => {
    expect(splitAddressText('a@x.invalid b@y.invalid')).toEqual(['a@x.invalid', 'b@y.invalid']);
    // A display name has spaces in it, and splitting on them is how one recipient becomes three.
    expect(splitAddressText('Keeper Reports <keeper@example.invalid>')).toEqual([
      'Keeper Reports <keeper@example.invalid>',
    ]);
  });

  it('drops empty fragments from a trailing separator or a blank line', () => {
    expect(splitAddressText('a@x.invalid,\n\n; ')).toEqual(['a@x.invalid']);
  });

  it('leaves a separator alone when it is inside a quoted name or an angle pair', () => {
    // What a paste out of a mail client actually looks like. Splitting on the comma first produced a
    // chip called `"Doe` that the human then had to repair by hand.
    expect(splitAddressText('"Doe, Jane" <j@x.invalid>, "Roe; Sam" <s@y.invalid>')).toEqual([
      '"Doe, Jane" <j@x.invalid>', '"Roe; Sam" <s@y.invalid>',
    ]);
    expect(chipsFrom('"Doe, Jane" <j@x.invalid>, "Roe; Sam" <s@y.invalid>')
      .map((one) => `${one.name}|${one.address}|${one.valid}`)).toEqual([
      'Doe, Jane|j@x.invalid|true', 'Roe; Sam|s@y.invalid|true',
    ]);
    // A semicolon inside the angle pair is not a separator either.
    expect(splitAddressText('<weird;name@x.invalid>')).toEqual(['<weird;name@x.invalid>']);
  });

  it('turns a paste of two addresses into two chips', () => {
    const chips = chipsFrom('a@x.invalid, b@y.invalid');
    expect(chips.map((one) => one.address)).toEqual(['a@x.invalid', 'b@y.invalid']);
    expect(chips.every((one) => one.valid)).toBe(true);
  });

  it('keeps one invalid chip among many valid ones, and blocks the send', () => {
    const chips = chipsFrom('a@x.invalid, nope, c@z.invalid');
    expect(chips.map((one) => one.valid)).toEqual([true, false, true]);
    expect(hasInvalidAddress(chips)).toBe(true);
    // Only the valid ones are ever saved: the server refuses the whole draft otherwise.
    expect(validAddresses(chips).map((one) => one.address)).toEqual(['a@x.invalid', 'c@z.invalid']);
  });

  it('gives every chip its own key, so two identical entries still render apart', () => {
    const chips = chipsFrom('a@x.invalid\nnope\nnope');
    expect(new Set(chips.map((one) => one.key)).size).toBe(3);
  });
});

describe('adding to a field', () => {
  it('drops a duplicate, case-insensitively', () => {
    const first = withChips([], 'Alice@Example.invalid');
    const second = withChips(first, 'alice@example.invalid');
    expect(second).toHaveLength(1);
  });

  it('keeps two invalid entries, because they are not the same typo twice', () => {
    const chips = withChips(withChips([], 'nope'), 'also nope');
    expect(chips).toHaveLength(2);
  });

  it('rebuilds chips from addresses the server already parsed', () => {
    const chips = chipsOf([{ name: 'Alice', address: 'alice@example.invalid' }, { address: 'b@y.invalid' }]);
    expect(chips[0]!.raw).toBe('Alice <alice@example.invalid>');
    expect(chips[1]!.raw).toBe('b@y.invalid');
    expect(chips.every((one) => one.valid)).toBe(true);
  });

  it('keys an address by its lowercased form', () => {
    expect(addressKey({ address: '  Alice@Example.INVALID ' })).toBe('alice@example.invalid');
  });
});

const MESSAGE = {
  from: { name: 'Keeper Reports', address: 'keeper@example.invalid' },
  to: [
    { name: 'Me', address: 'me@example.invalid' },
    { address: 'team@example.invalid' },
  ],
  cc: [{ address: 'TEAM@example.invalid' }, { address: 'watcher@example.invalid' }],
  subject: 'Quarterly keeper report',
  sentAt: Date.parse('2026-09-04T09:00:00Z'),
  sentAtHeader: 'Fri, 4 Sep 2026 09:00:00 +0000',
};

describe('who a reply goes to', () => {
  it('answers the sender, and adds nobody without reply all', () => {
    const prefill = replyPrefill({ message: MESSAGE, accountAddress: 'me@example.invalid', all: false });
    expect(prefill.to.map((one) => one.address)).toEqual(['keeper@example.invalid']);
    expect(prefill.cc).toEqual([]);
  });

  it('honours Reply-To over From', () => {
    const prefill = replyPrefill({
      message: { ...MESSAGE, replyTo: [{ address: 'desk@example.invalid' }] },
      accountAddress: 'me@example.invalid',
      all: false,
    });
    expect(prefill.to.map((one) => one.address)).toEqual(['desk@example.invalid']);
  });

  it('reply all drops the account own address and dedupes the rest', () => {
    const prefill = replyPrefill({ message: MESSAGE, accountAddress: 'ME@example.invalid', all: true });
    expect(prefill.to.map((one) => one.address)).toEqual(['keeper@example.invalid']);
    // `me@` is this account, `TEAM@` is already in Cc once in a different case, and the sender is
    // in To rather than twice.
    expect(prefill.cc.map((one) => one.address)).toEqual(['team@example.invalid', 'watcher@example.invalid']);
  });

  it('never puts the sender in Cc as well as To', () => {
    const prefill = replyPrefill({
      message: {
        ...MESSAGE,
        to: [{ address: 'keeper@example.invalid' }, { address: 'other@example.invalid' }],
        cc: [{ address: 'watcher@example.invalid' }],
      },
      accountAddress: 'me@example.invalid',
      all: true,
    });
    expect(prefill.to.map((one) => one.address)).toEqual(['keeper@example.invalid']);
    expect(prefill.cc.map((one) => one.address)).toEqual(['other@example.invalid', 'watcher@example.invalid']);
  });

  it('adds Re: once, whatever the original carried', () => {
    expect(replySubject('Lunch')).toBe('Re: Lunch');
    expect(replySubject('Re: Lunch')).toBe('Re: Lunch');
    expect(replySubject('RE: Lunch')).toBe('RE: Lunch');
    expect(replySubject('   ')).toBe('Re:');
  });
});

describe('the quoted original', () => {
  it('attributes it with the original Date header and quotes every line', () => {
    const quote = quoteMarkdown({ message: MESSAGE, text: 'Lunch at one?\n\nAlice' });
    expect(quote).toContain('On Fri, 4 Sep 2026 09:00:00 +0000, Keeper Reports <keeper@example.invalid> wrote:');
    expect(quote).toContain('> Lunch at one?');
    // A blank line inside the quote stays a quoted blank line, not a break in the block.
    expect(quote).toContain('\n>\n');
  });

  it('formats a machine timestamp in the header slot as prose and never writes an empty address', () => {
    // A display-name-only provider hands an ISO stamp where a Date header would be, and a sender
    // with no address at all: the line must read like something a person wrote.
    const quote = quoteMarkdown({
      message: { ...MESSAGE, sentAtHeader: '2026-09-09T10:21:03-07:00', from: { name: 'Harbour Notices', address: '' } },
    });
    expect(quote).not.toContain('2026-09-09T');
    expect(quote).toMatch(/^On .*2026.*, Harbour Notices wrote:$/);
    expect(quote).not.toContain('<>');
  });

  it('attributes an html-only original without inventing a quote for it', () => {
    const quote = quoteMarkdown({ message: MESSAGE });
    // One line, the attribution, and NOT a single quoted line: this console has no html-to-text
    // pass, and inventing one would put a guess in somebody's outgoing mail. (The line does carry
    // an angle bracket, from the sender's own `Name <address>`.)
    expect(quote.split('\n')).toHaveLength(1);
    expect(quote).toMatch(/wrote:$/);
    expect(quote).not.toMatch(/^>/m);
  });

  it('puts the quote below what was typed, and nothing when there is no quote', () => {
    expect(bodyWithQuote('Sounds good.\n\n', 'On x, y wrote:\n\n> hello')).toBe(
      'Sounds good.\n\nOn x, y wrote:\n\n> hello\n',
    );
    expect(bodyWithQuote('Sounds good.', null)).toBe('Sounds good.');
  });
});
