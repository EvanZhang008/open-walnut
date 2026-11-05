/**
 * The words a closed tool card shows, as the whole-session find counts them
 * (src/lib/tool-header-text.ts, shared with the cards in SessionMessage.tsx).
 */
import { describe, expect, it } from 'vitest';
import { toolHeaderText, toolInputSummary } from '../../src/lib/tool-header-text';

describe('toolInputSummary', () => {
  it('reads an AskUserQuestion call as its questions, not its JSON', () => {
    const input = {
      questions: [
        { question: 'Which color?', options: [{ label: 'Red' }] },
        { question: '' },
        { question: 'Ship it?' },
      ],
    };
    expect(toolInputSummary('AskUserQuestion', input)).toBe('Which color? \u00b7 Ship it?');
    expect(toolHeaderText({ name: 'AskUserQuestion', input })).toBe('AskUserQuestion Which color? \u00b7 Ship it?');
  });

  it('gives an AskUserQuestion with no questions no summary', () => {
    expect(toolInputSummary('AskUserQuestion', { questions: 'nope' })).toBe('');
  });

  it('reads any other call as key: value pairs', () => {
    expect(toolInputSummary('Read', { file_path: '/a.ts', description: 'x' })).toBe('file_path: /a.ts');
  });
});
