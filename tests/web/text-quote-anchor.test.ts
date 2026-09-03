/**
 * Quote-pin anchoring: `locateQuote` is the whole feature's load-bearing logic —
 * given the message's rendered plain text and a stored TextQuoteSelector, WHERE
 * does the pinned passage sit now?
 *
 * It is pure on purpose (string in, offsets out), so every rule that decides
 * between two identical phrases, and the whitespace-tolerant retry that survives
 * a markdown⇄rich re-render, is pinned here without a DOM.
 */
import { describe, it, expect } from 'vitest';
import { locateQuote } from '@/utils/text-quote-anchor';

/** The located substring, which is what a reader of the test cares about. */
function located(text: string, quote: Parameters<typeof locateQuote>[1]): string | null {
  const at = locateQuote(text, quote);
  return at ? text.slice(at.start, at.end) : null;
}

describe('locateQuote — a single occurrence', () => {
  const text = 'The migration runs in three phases. Phase two rewrites the index in place.';

  it('finds the passage and returns its exact offsets', () => {
    const at = locateQuote(text, { exact: 'rewrites the index in place' });
    expect(at).not.toBeNull();
    expect(text.slice(at!.start, at!.end)).toBe('rewrites the index in place');
  });

  it('ignores context that no longer agrees, when the passage is unambiguous', () => {
    // The message was edited around the passage; the passage itself still exists,
    // so the pin must still resolve (context only breaks ties).
    expect(located(text, {
      exact: 'three phases',
      prefix: 'a completely different sentence ',
      suffix: ' and other words',
    })).toBe('three phases');
  });

  it('matches at the very start and the very end of the text', () => {
    expect(locateQuote(text, { exact: 'The migration' })).toEqual({ start: 0, end: 13 });
    const tail = locateQuote(text, { exact: 'in place.' });
    expect(tail).toEqual({ start: text.length - 9, end: text.length });
  });
});

describe('locateQuote — several occurrences', () => {
  // "done" three times: only the recorded context can say which one was pinned.
  const text = 'step one done, step two done, step three done.';

  it('resolves the tie with the prefix', () => {
    const at = locateQuote(text, { exact: 'done', prefix: 'step two ' })!;
    expect(at.start).toBe(text.indexOf('done', text.indexOf('two')));
  });

  it('resolves the tie with the suffix', () => {
    const at = locateQuote(text, { exact: 'done', suffix: ', step three' })!;
    expect(at.start).toBe(text.indexOf('done', text.indexOf('two')));
  });

  it('prefers the occurrence whose context agrees best, not merely one that does', () => {
    // Both candidates share the ", step" suffix start; the prefix decides.
    const at = locateQuote(text, { exact: 'done', prefix: 'step one ', suffix: ', step' })!;
    expect(at.start).toBe(text.indexOf('done'));
  });

  it('falls back to the first occurrence when no context was recorded', () => {
    expect(locateQuote(text, { exact: 'done' })!.start).toBe(text.indexOf('done'));
  });
});

describe('locateQuote — whitespace-normalised retry', () => {
  it('finds a passage whose line breaks and indentation changed', () => {
    // What an MD⇄Rich re-render does: same words, different layout whitespace.
    const rendered = 'Phase two\n    rewrites the\tindex in place, then verifies.';
    expect(located(rendered, { exact: 'rewrites the index in place' }))
      .toBe('rewrites the\tindex in place');
  });

  it('maps offsets back onto the ORIGINAL text, not the normalised copy', () => {
    const rendered = 'a\n\n\nb   c   d end';
    const at = locateQuote(rendered, { exact: 'b c d' })!;
    expect(rendered.slice(at.start, at.end)).toBe('b   c   d');
  });

  it('breaks a tie with context whose whitespace no longer matches', () => {
    // The passage still matches byte-for-byte, so only the tie-break is at risk:
    // the stored prefix has one space where the re-render now has two. Comparing
    // context byte-exactly scored both candidates ~1 and silently picked the FIRST
    // occurrence — the pin quietly moved to the wrong sentence.
    const rendered = 'first  hit  here\nsecond  hit  there';
    const at = locateQuote(rendered, { exact: 'hit', prefix: 'second ' })!;
    expect(at.start).toBe(rendered.lastIndexOf('hit'));
  });

  it('tolerates a stored passage that carried its own odd whitespace', () => {
    expect(located('one two three', { exact: 'two   three' })).toBe('two three');
  });
});

describe('locateQuote — nothing to anchor to', () => {
  it('returns null when the passage is gone', () => {
    expect(locateQuote('the reply was rewritten', { exact: 'a sentence that left' })).toBeNull();
  });

  it('rejects an empty or whitespace-only passage', () => {
    expect(locateQuote('some text', { exact: '' })).toBeNull();
    expect(locateQuote('some text', { exact: '   \n ' })).toBeNull();
  });

  it('returns null for an empty haystack', () => {
    expect(locateQuote('', { exact: 'anything' })).toBeNull();
  });
});
