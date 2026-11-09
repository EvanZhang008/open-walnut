/**
 * Where a prefill lands in what is already typed (prefill-place.ts). The 'stack'
 * mode is the transcript's Quote / Comment: the user collects several quotes and
 * comments and sends them as one message, in the order added (2026-11-01, the
 * user: "nothing is sent until I press send").
 */
import { describe, it, expect } from 'vitest';
import { placePrefill } from '@/components/chat/prefill-place';
import { buildPassagePrefill } from '@/components/sessions/diffPrefill';

describe('placePrefill', () => {
  it('replace drops what was typed', () => {
    expect(placePrefill('replace', 'typed', 'P')).toEqual({ text: 'P', caret: 'block' });
  });

  it('keep-draft puts the block first and keeps the sentence after it', () => {
    expect(placePrefill('keep-draft', '  my words', '> q\n\n')).toEqual({ text: '> q\n\nmy words', caret: 'block' });
    expect(placePrefill('keep-draft', '', '> q\n\n')).toEqual({ text: '> q\n\n', caret: 'block' });
  });

  it('attach puts a terminal block after what is typed, as its own paragraph, in the order added', () => {
    expect(placePrefill('attach', '', 'B1\n')).toEqual({ text: 'B1\n', caret: 'end' });
    expect(placePrefill('attach', 'why does this fail?  \n', 'B1\n')).toEqual({ text: 'why does this fail?\n\nB1\n', caret: 'end' });
    const once = placePrefill('attach', '', 'B1\n').text;
    expect(placePrefill('attach', once, 'B2\n').text).toBe('B1\n\nB2\n');
  });

  it('append joins the sentence in progress with one space', () => {
    expect(placePrefill('append', 'look at  \n', '@[Task]')).toEqual({ text: 'look at @[Task]', caret: 'end' });
    expect(placePrefill('append', '', '@[Task]')).toEqual({ text: '@[Task]', caret: 'end' });
  });

  it('stack leads like keep-draft while the box holds no quote', () => {
    expect(placePrefill('stack', 'what does this mean', '> q1\n\n')).toEqual({ text: '> q1\n\nwhat does this mean', caret: 'block' });
    expect(placePrefill('stack', '', '> q1\n\n')).toEqual({ text: '> q1\n\n', caret: 'block' });
    // A ">" inside a line is not a quote.
    expect(placePrefill('stack', 'a > b', '> q1\n\n').caret).toBe('block');
  });

  it('a quote line inside a code fence is not a quote', () => {
    expect(placePrefill('stack', 'run this:\n```\n> npm test\n```\n', '> q1\n\n').caret).toBe('block');
    expect(placePrefill('stack', '```sh\n> npm test', '> q1\n\n').caret).toBe('block');
    expect(placePrefill('stack', '```\ncode\n```\n> q0\n', '> q1\n\n').caret).toBe('end');
  });

  it('stack appends once the box holds a quote, a blank line apart, caret at the end', () => {
    expect(placePrefill('stack', '> q1\n\nmy note  \n', '> q2\n\n')).toEqual({ text: '> q1\n\nmy note\n\n> q2\n\n', caret: 'end' });
    expect(placePrefill('stack', 'lead\n> q1\n\n', '> q2\n\n').text).toBe('lead\n> q1\n\n> q2\n\n');
  });

  it('three quotes and two comments stack in the order added, the typed words kept', () => {
    const blocks = [
      buildPassagePrefill('First passage.'),
      buildPassagePrefill('Second passage,\nover two lines.', 'Why two lines?'),
      buildPassagePrefill('Third passage.'),
      buildPassagePrefill('Fourth passage.', '  Is this still true?\n\nCheck the log.  '),
      // "Fifth passage" in Chinese.
      buildPassagePrefill('\u7b2c\u4e94\u6bb5'),
    ];
    let box = 'please review';
    for (const b of blocks) box = placePrefill('stack', box, b).text;
    expect(box).toBe([
      '> First passage.',
      '',
      'please review',
      '',
      '> Second passage,',
      '> over two lines.',
      '',
      'Why two lines?',
      '',
      '> Third passage.',
      '',
      '> Fourth passage.',
      '',
      'Is this still true?',
      '',
      'Check the log.',
      '',
      '> \u7b2c\u4e94\u6bb5',
      '',
      '',
    ].join('\n'));
  });
});
