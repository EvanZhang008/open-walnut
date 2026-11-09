/**
 * The transcript pill's "Quote" / "Comment": the selected passage becomes a
 * Markdown quote for the main conversation's next message, the user's comment
 * under it, with a blank line left for what comes next.
 */
import { describe, it, expect } from 'vitest';
import { buildPassagePrefill, buildTerminalPrefill } from '@/components/sessions/diffPrefill';

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

  it('puts a comment under the quote, trimmed, with a blank line after it', () => {
    expect(buildPassagePrefill('A passage.', '  Is this right?\r\nAsk.  ')).toBe('> A passage.\n\nIs this right?\nAsk.\n\n');
  });

  it('an empty comment is a plain quote', () => {
    expect(buildPassagePrefill('A passage.', '  \n ')).toBe('> A passage.\n\n');
  });

  it('keeps non-ASCII text as it is', () => {
    // "Transient error classes missed" in Chinese.
    expect(buildPassagePrefill('\u4e34\u65f6\u9519\u8bef')).toBe('> \u4e34\u65f6\u9519\u8bef\n\n');
  });
});

describe('buildTerminalPrefill', () => {
  it('names the terminal and fences the output as printed, trailing pad and blank edges gone', () => {
    expect(buildTerminalPrefill('\n  $ npm test   \n  FAIL x.test.ts  \n\n', 'Terminal 2')).toBe('From Terminal 2:\n```text\n  $ npm test\n  FAIL x.test.ts\n```\n');
  });

  it('uses a longer fence when the output holds one', () => {
    expect(buildTerminalPrefill('a\n```\nb', 'Terminal 1')).toBe('From Terminal 1:\n````text\na\n```\nb\n````\n');
  });

  it('keeps CRLF output as plain lines', () => {
    expect(buildTerminalPrefill('one\r\ntwo\r\n', 'Terminal 1')).toBe('From Terminal 1:\n```text\none\ntwo\n```\n');
  });
});
