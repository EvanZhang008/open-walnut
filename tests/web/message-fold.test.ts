/**
 * The folded session-message card's title when the sender gave none
 * (web/src/components/sessions/message-fold.ts): the first sentence of its own
 * words, as one plain line.
 */
import { describe, expect, it } from 'vitest';
import { FOLD_TITLE_MAX, fallbackTitle, foldKey, noticeText, noticeTitle } from '../../web/src/components/sessions/message-fold';

describe('fallbackTitle', () => {
  it('is the first sentence once it can stand alone', () => {
    expect(fallbackTitle('Ack: now the only worker for the event. State at 18:57Z: the shift completed.'))
      .toBe('Ack: now the only worker for the event.');
  });

  it('keeps a short opener with the sentence after it, so the title says something', () => {
    expect(fallbackTitle('Done. The migration ran twice without error.'))
      .toBe('Done. The migration ran twice without error.');
  });

  it('reads the first line with words, without markdown noise', () => {
    expect(fallbackTitle('\n\n## **Root cause** found in `tmp.ts`\n\nmore')).toBe('Root cause found in tmp.ts');
    expect(fallbackTitle('- [the PR](https://example.com/pr/1) is merged')).toBe('the PR is merged');
    expect(fallbackTitle('```\ncode first\n```')).toBe('code first');
  });

  it('cuts a long line at the cap, by code point', () => {
    const t = fallbackTitle(`${'word '.repeat(60)}`)!;
    expect([...t].length).toBe(FOLD_TITLE_MAX);
    expect(t.endsWith('…')).toBe(true);
    const cjk = fallbackTitle('\u4e2d'.repeat(200))!;
    expect([...cjk].length).toBe(FOLD_TITLE_MAX);
  });

  it('ends a CJK sentence at its own full stop, which takes no space after it', () => {
    // U+4E2D / U+6587: two CJK ideographs; U+3002: the ideographic full stop.
    expect(fallbackTitle(`${'\u4e2d'.repeat(24)}\u3002${'\u6587'.repeat(10)}`)).toBe(`${'\u4e2d'.repeat(24)}\u3002`);
  });

  it('is nothing for nothing', () => {
    expect(fallbackTitle(undefined)).toBeUndefined();
    expect(fallbackTitle('   \n  ')).toBeUndefined();
  });
});

describe('noticeTitle', () => {
  it('drops the child a subtask notice names (the sender line names it) and keeps the outcome', () => {
    const long = 'Pulse orphan cleanup: class A (17) delete via Lambda, class B (rest) by hand, then verify each "x" row';
    expect(noticeTitle(`Your subtask "${long}" (mun152w6-c369) stopped without completing its task; its last turn `
      + 'was started by the user. It is waiting for input. Its last message is quoted below.'))
      .toBe('Stopped without completing its task; its last turn was started by the user.');
    expect(noticeTitle('Your subtask "Ship it" (pw-task-001) completed its task. Its last message is quoted below.'))
      .toBe('Completed its task.');
  });

  it('shows the whole outcome without the child, and leaves any other notice whole', () => {
    expect(noticeText('Your subtask "Ship it" (pw-task-001) completed its task. Its last message is quoted below.'))
      .toBe('Completed its task. Its last message is quoted below.');
    expect(noticeText('It is now WAITING ON A HUMAN. Check back later.')).toBe('It is now WAITING ON A HUMAN. Check back later.');
  });

  it('keeps any other notice as its first sentence', () => {
    expect(noticeTitle('It is now WAITING ON A HUMAN (permission prompt or question). Do NOT send it messages.'))
      .toBe('It is now WAITING ON A HUMAN (permission prompt or question).');
    expect(noticeTitle(undefined)).toBeUndefined();
  });
});

describe('foldKey', () => {
  it('is stable for the same text and differs for different text', () => {
    expect(foldKey('<walnut-message kind="reply">a')).toBe(foldKey('<walnut-message kind="reply">a'));
    expect(foldKey('a')).not.toBe(foldKey('b'));
  });
});
