/**
 * "@" trigger detection (web/src/components/chat/mention-trigger.ts): strict by
 * default, and allowed to grow across single spaces only while the palette is
 * already open for that same "@".
 */
import { describe, it, expect } from 'vitest';
import { detectMention, MENTION_QUERY_MAX_WORDS } from '@/components/chat/mention-trigger';

const caretAtEnd = (text: string, openAt = -1) => detectMention(text, text.length, openAt);

describe('detectMention', () => {
  it('fires at input start and after whitespace, not inside a word', () => {
    expect(caretAtEnd('@oau')).toEqual({ atIndex: 0, query: 'oau' });
    expect(caretAtEnd('look at @oau')).toEqual({ atIndex: 8, query: 'oau' });
    expect(caretAtEnd('mail a@b')).toBeNull();
  });

  it('closed palette: a space ends the query', () => {
    expect(caretAtEnd('@oauth returns')).toBeNull();
    expect(caretAtEnd('see @src/a.ts then')).toBeNull();
  });

  it('open palette for this "@": single spaces are part of the query', () => {
    expect(caretAtEnd('@oauth returns unauthorized', 0)).toEqual({ atIndex: 0, query: 'oauth returns unauthorized' });
    expect(caretAtEnd('hey @oauth returns', 4)).toEqual({ atIndex: 4, query: 'oauth returns' });
  });

  it('open palette for a DIFFERENT "@" does not rescue a spaced query', () => {
    expect(caretAtEnd('@a b', 3)).toBeNull();
  });

  it('newline, double space, leading space or a runaway query end it', () => {
    expect(caretAtEnd('@oauth\nnext', 0)).toBeNull();
    expect(caretAtEnd('@oauth  two', 0)).toBeNull();
    expect(caretAtEnd('@ oauth', 0)).toBeNull();
    const words = Array.from({ length: MENTION_QUERY_MAX_WORDS + 1 }, (_, i) => `w${i}`).join(' ');
    expect(caretAtEnd(`@${words}`, 0)).toBeNull();
    expect(caretAtEnd(`@${'x'.repeat(70)} y`, 0)).toBeNull();
  });
});
