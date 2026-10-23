/**
 * The transcript pill's "Ask in chat": the selected passage becomes a Markdown
 * quote that leads the main conversation's next message, with a blank line left
 * for the user's own words.
 */
import { describe, it, expect } from 'vitest';
import { buildPassagePrefill } from '@/components/sessions/diffPrefill';

describe('buildPassagePrefill', () => {
  it('quotes one line and leaves a blank line after it', () => {
    expect(buildPassagePrefill('The reader trusts the newest version.')).toBe('> The reader trusts the newest version.\n\n');
  });

  it('keeps a multi-paragraph passage as one quote', () => {
    expect(buildPassagePrefill('First line.\nSecond line.\n\nNew paragraph.'))
      .toBe('> First line.\n> Second line.\n>\n> New paragraph.\n\n');
  });

  it('trims the edges, trailing spaces and CRLF line ends of a selection', () => {
    expect(buildPassagePrefill('\n  Lead in.  \r\nNext.\t\n\n')).toBe('> Lead in.\n> Next.\n\n');
  });

  it('keeps non-ASCII text as it is', () => {
    // "Transient error classes missed" in Chinese.
    expect(buildPassagePrefill('\u4e34\u65f6\u9519\u8bef')).toBe('> \u4e34\u65f6\u9519\u8bef\n\n');
  });
});
