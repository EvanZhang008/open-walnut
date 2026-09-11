/**
 * The strings the mail list and reader put on screen: a message's age, an attachment's size,
 * and the note a clipped body carries.
 *
 * Two rules under test rather than formatting taste. A stamp inside the last week reads as an
 * age ("3d ago"), because that is the window where "when" means "how long ago"; beyond it the
 * age stops being useful and the actual date is what the reader wants. And a size is never
 * printed raw: `formatSize` from the shared formatter is the one place bytes become KB/MB, so
 * an attachment chip and a truncation note cannot disagree.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  attachmentLabel,
  formatMailTime,
  senderLabel,
  truncatedNotice,
} from '../../web/src/apps/mail/mail-format';

const NOW = Date.parse('2026-09-05T12:00:00Z');

function at(now: number) {
  vi.useFakeTimers();
  vi.setSystemTime(now);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('formatMailTime', () => {
  it('reads as an age inside the last week', () => {
    at(NOW);
    expect(formatMailTime(NOW - 20_000)).toBe('just now');
    expect(formatMailTime(NOW - 12 * 60_000)).toBe('12m ago');
    expect(formatMailTime(NOW - 5 * 3_600_000)).toBe('5h ago');
    expect(formatMailTime(NOW - 3 * 86_400_000)).toBe('3d ago');
  });

  it('reads as a date once the age stops being useful', () => {
    at(NOW);
    const old = NOW - 40 * 86_400_000;
    // Compared against the same locale call rather than a literal: the branch is what matters,
    // and the month name depends on the machine's locale data.
    expect(formatMailTime(old)).toBe(
      new Date(old).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }),
    );
    expect(formatMailTime(old)).not.toContain('ago');
  });

  it('answers with nothing for a stamp a provider never sent', () => {
    at(NOW);
    expect(formatMailTime(0)).toBe('');
    expect(formatMailTime(Number.NaN)).toBe('');
  });

  it('never reports a future stamp as an age', () => {
    at(NOW);
    // A sender's clock can be ahead; "in -3 minutes" is worse than "just now".
    expect(formatMailTime(NOW + 3 * 60_000)).toBe('just now');
  });
});

describe('attachmentLabel', () => {
  it('names the file and its size', () => {
    expect(attachmentLabel({ filename: 'agenda.pdf', bytes: 18_234 })).toBe('agenda.pdf (17.8 KB)');
  });

  it('falls back to a generic name and omits an unknown size', () => {
    expect(attachmentLabel({ bytes: 2_048 })).toBe('Attachment (2.0 KB)');
    expect(attachmentLabel({ filename: 'notes.txt' })).toBe('notes.txt');
  });
});

describe('truncatedNotice', () => {
  it('says where the body stopped', () => {
    expect(truncatedNotice(524_288)).toBe('Body truncated at 512.0 KB');
  });
});

describe('senderLabel', () => {
  it('prefers the display name and falls back to the address', () => {
    expect(senderLabel({ name: 'Alice Smith', address: 'alice@example.invalid' })).toBe('Alice Smith');
    expect(senderLabel({ address: 'alice@example.invalid' })).toBe('alice@example.invalid');
    expect(senderLabel(undefined)).toBe('Unknown sender');
  });
});

describe('hasBodyContent', () => {
  it('counts an html part only when something in it would paint', async () => {
    const { hasBodyContent } = await import('../../web/src/apps/mail/mail-reader-format');
    // A complete document whose every cell was stripped on the way here: nested empty tables, a
    // title, a style block. Nothing paints, so it is an empty body, not a blank frame.
    const shell = '<!DOCTYPE html><html><head><title>Weekly</title><style>td{color:red}</style></head>'
      + '<body style="background:#f1f4f7"><div><table><tbody><tr></tr></tbody></table></div>&nbsp;\n</body></html>';
    expect(hasBodyContent({ html: shell })).toBe(false);
    expect(hasBodyContent({ html: shell.replace('<tr></tr>', '<tr><td>Fares</td></tr>') })).toBe(true);
    expect(hasBodyContent({ html: shell.replace('<tr></tr>', '<tr><td><img src="cid:logo"></td></tr>') })).toBe(true);
    expect(hasBodyContent({ html: '   ', text: '' })).toBe(false);
    expect(hasBodyContent({ text: 'plain' })).toBe(true);
  });
});
