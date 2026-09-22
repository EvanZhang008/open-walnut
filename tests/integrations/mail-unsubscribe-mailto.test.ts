/**
 * `parseUnsubscribeMailto`, as a table.
 *
 * This is the one pure function standing between a `List-Unsubscribe` header a stranger wrote and a mail
 * that goes out under the user's own name, so the interesting cases are all refusals: a target naming two
 * people, a target naming nobody, a target smuggling a second recipient through the query, and escapes
 * that change what the address is after they are decoded.
 *
 * Every fixture host is `.invalid` (RFC 2606) and nothing here opens a socket or touches a mailbox.
 */
import { describe, expect, it } from 'vitest';
import {
  parseUnsubscribeMailto,
  UNSUBSCRIBE_MAILTO_BODY_CHARS,
  UNSUBSCRIBE_MAILTO_SUBJECT_CHARS,
  UNSUBSCRIBE_WORD,
} from '../../src/integrations/mail/unsubscribe-mailto.js';

/** The mail a target parsed to, or the refusal. Keeps each case to one line. */
function read(target: string) {
  const parsed = parseUnsubscribeMailto(target);
  return parsed.ok ? { ok: true as const, ...parsed.mail } : { ok: false as const, reason: parsed.reason };
}

describe('the ordinary shapes a real list sends', () => {
  it('takes one recipient and the subject the header asked for', () => {
    expect(read('mailto:leave@lists.example.invalid?subject=unsubscribe%20abc123')).toEqual({
      ok: true,
      to: 'leave@lists.example.invalid',
      subject: 'unsubscribe abc123',
      body: UNSUBSCRIBE_WORD,
    });
  });

  it('falls back to the word "unsubscribe" for both fields when the header names neither', () => {
    expect(read('mailto:leave@lists.example.invalid')).toEqual({
      ok: true,
      to: 'leave@lists.example.invalid',
      subject: 'unsubscribe',
      body: 'unsubscribe',
    });
  });

  it('takes a body the header named, and keeps its line breaks', () => {
    const parsed = parseUnsubscribeMailto(
      'mailto:leave@lists.example.invalid?subject=Unsubscribe&body=Please%20remove%20me.%0D%0AToken%3A%20k9',
    );
    expect(parsed.ok && parsed.mail.subject).toBe('Unsubscribe');
    // CRLF normalised to LF; a body is allowed line breaks, unlike a subject.
    expect(parsed.ok && parsed.mail.body).toBe('Please remove me.\nToken: k9');
  });

  it('reads the RFC\'s other spelling of one recipient: the address in the query', () => {
    expect(read('mailto:?to=leave@lists.example.invalid&subject=off')).toEqual({
      ok: true,
      to: 'leave@lists.example.invalid',
      subject: 'off',
      body: UNSUBSCRIBE_WORD,
    });
  });

  it('is case-insensitive about the scheme and about the field names', () => {
    expect(read('MAILTO:leave@lists.example.invalid?SUBJECT=Off')).toEqual({
      ok: true, to: 'leave@lists.example.invalid', subject: 'Off', body: UNSUBSCRIBE_WORD,
    });
  });

  it('tolerates a trailing comma, which is a mail template typo and not a second person', () => {
    expect(read('mailto:leave@lists.example.invalid,')).toMatchObject({
      ok: true, to: 'leave@lists.example.invalid',
    });
  });
});

describe('what it refuses, and the reason each refusal carries', () => {
  it('refuses two recipients in the path', () => {
    const parsed = parseUnsubscribeMailto('mailto:a@lists.example.invalid,b@lists.example.invalid');
    expect(parsed.ok).toBe(false);
    expect(parsed).toMatchObject({ reason: 'mailto-many-recipients' });
    // The sentence says how many, because "more than one" is the fact somebody reading the ledger wants.
    expect(!parsed.ok && parsed.detail).toContain('2 recipients');
  });

  it('refuses a second recipient smuggled through the query', () => {
    expect(read('mailto:a@lists.example.invalid?to=b@lists.example.invalid'))
      .toEqual({ ok: false, reason: 'mailto-many-recipients' });
  });

  it('refuses a cc or a bcc outright, even alongside exactly one recipient', () => {
    expect(read('mailto:a@lists.example.invalid?cc=watcher@elsewhere.example.invalid'))
      .toEqual({ ok: false, reason: 'mailto-many-recipients' });
    expect(read('mailto:a@lists.example.invalid?bcc=watcher@elsewhere.example.invalid'))
      .toEqual({ ok: false, reason: 'mailto-many-recipients' });
  });

  it('refuses a target with no address at all', () => {
    expect(read('mailto:')).toEqual({ ok: false, reason: 'mailto-unusable' });
    expect(read('mailto:?subject=unsubscribe')).toEqual({ ok: false, reason: 'mailto-unusable' });
  });

  it('refuses the header values that look like addresses and are not', () => {
    // Both are real values a provider passes through. Neither is something a send route would accept.
    expect(read('mailto:undisclosed-recipients:;')).toEqual({ ok: false, reason: 'mailto-unusable' });
    expect(read('mailto:leave@localhost')).toEqual({ ok: false, reason: 'mailto-unusable' });
    expect(read('mailto:not an address')).toEqual({ ok: false, reason: 'mailto-unusable' });
  });

  it('refuses a target that is not a mailto at all', () => {
    expect(read('https://lists.example.invalid/u/1')).toEqual({ ok: false, reason: 'mailto-unusable' });
    expect(read('')).toEqual({ ok: false, reason: 'mailto-unusable' });
  });

  it('refuses a comma hidden behind an escape, which is the split-then-decode case', () => {
    // `%2C` decodes to a comma, and splitting AFTER decoding would read this as one address that
    // `ADDRESS_SHAPE` happens to accept (a comma is neither `@` nor whitespace). It is two people.
    expect(read('mailto:a%2Cb@lists.example.invalid')).toEqual({ ok: false, reason: 'mailto-unusable' });
  });

  it('refuses a semicolon-separated pair, the other grammar that means two people', () => {
    expect(read('mailto:a@lists.example.invalid%3Bb@lists.example.invalid'))
      .toEqual({ ok: false, reason: 'mailto-unusable' });
  });
});

describe('what it does with the fields a sender chose', () => {
  it('drops every query field that is not subject, body or to', () => {
    const parsed = parseUnsubscribeMailto(
      'mailto:leave@lists.example.invalid?subject=off&in-reply-to=%3Cx%40y%3E&x-track=1&reply-to=z@y.invalid',
    );
    expect(parsed).toEqual({
      ok: true,
      mail: { to: 'leave@lists.example.invalid', subject: 'off', body: UNSUBSCRIBE_WORD },
    });
  });

  it('takes the FIRST subject and the first body when the header repeats them', () => {
    const parsed = parseUnsubscribeMailto(
      'mailto:leave@lists.example.invalid?subject=first&subject=second&body=one&body=two',
    );
    expect(parsed.ok && parsed.mail).toMatchObject({ subject: 'first', body: 'one' });
  });

  it('strips a line break out of the subject, because a subject spanning lines is header injection', () => {
    const parsed = parseUnsubscribeMailto(
      'mailto:leave@lists.example.invalid?subject=off%0D%0ABcc%3A%20victim%40elsewhere.invalid',
    );
    expect(parsed.ok && parsed.mail.subject).toBe('off Bcc: victim@elsewhere.invalid');
    expect(parsed.ok && parsed.mail.subject).not.toMatch(/[\r\n]/);
  });

  it('keeps a literal plus as a plus, because an unsubscribe subject is usually a token', () => {
    // RFC 6068 gives `+` no special meaning. Reading it as a space the way a form body would corrupts
    // the token that identifies the subscriber, so the list gets a mail it cannot match to anybody.
    const parsed = parseUnsubscribeMailto('mailto:leave@lists.example.invalid?subject=unsub+k9+aa');
    expect(parsed.ok && parsed.mail.subject).toBe('unsub+k9+aa');
  });

  it('survives an escape that is not one, rather than throwing', () => {
    const parsed = parseUnsubscribeMailto('mailto:leave@lists.example.invalid?subject=100%25%20off%zz');
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.mail.subject).toContain('%zz');
  });

  it('caps the subject and the body a sender can author in the user\'s name', () => {
    const parsed = parseUnsubscribeMailto(
      `mailto:leave@lists.example.invalid?subject=${'s'.repeat(4000)}&body=${'b'.repeat(4000)}`,
    );
    expect(parsed.ok && parsed.mail.subject).toHaveLength(UNSUBSCRIBE_MAILTO_SUBJECT_CHARS);
    expect(parsed.ok && parsed.mail.body).toHaveLength(UNSUBSCRIBE_MAILTO_BODY_CHARS);
  });

  it('treats a subject that decodes to whitespace as no subject at all', () => {
    expect(read('mailto:leave@lists.example.invalid?subject=%20%20&body=%20'))
      .toMatchObject({ subject: UNSUBSCRIBE_WORD, body: UNSUBSCRIBE_WORD });
  });
});
