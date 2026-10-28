/**
 * Who wrote a node's instructions, as the org chart's form says it (instructions-source.ts):
 * 2026-10-27, the user: "all human action can be done by agent also", so the page names an
 * agent that wrote them, and when.
 */
import { describe, it, expect } from 'vitest';
import { instructionsSource } from '../../web/src/components/org/instructions-source';
import { orgInstructionsAuthor } from '../../src/core/org/instructions-author';

const now = Date.parse('2026-10-27T12:00:00Z');
const at = '2026-10-27T11:55:00Z';

describe('the words beside a node\'s instructions', () => {
  it('names the user, an agent, or an unknown agent, with the time', () => {
    expect(instructionsSource({ edited: false, typed: 'x', stored: { text: 'Ship it.', at }, now })).toBe('by you, 5 min ago');
    expect(instructionsSource({ edited: false, typed: 'x', stored: { text: 'Ship it.', at, by: 'human' }, now })).toBe('by you, 5 min ago');
    expect(instructionsSource({ edited: false, typed: 'x', stored: { text: 'Ship it.', at, by: 'task:t1', by_name: 'the CEO' }, now })).toBe('by the CEO, 5 min ago');
    expect(instructionsSource({ edited: false, typed: 'x', stored: { text: 'Ship it.', at, by: 'agent' }, now })).toBe('by an agent, 5 min ago');
  });

  it('says "yours" for unsaved words, and nothing with nothing stored', () => {
    expect(instructionsSource({ edited: true, typed: 'New words', stored: { text: 'Ship it.', at, by: 'task:t1', by_name: 'the CEO' }, now })).toBe('yours');
    expect(instructionsSource({ edited: true, typed: '  ', stored: { text: 'Ship it.', at }, now })).toBe('');
    expect(instructionsSource({ edited: false, typed: '', stored: { text: '', at, by: 'human' }, now })).toBe('');
    expect(instructionsSource({ edited: false, typed: '', stored: undefined, now })).toBe('');
  });

  it('a row an older Walnut wrote (no writer) is the user\'s', () => {
    expect(orgInstructionsAuthor({})).toEqual({ byUser: true, who: 'you' });
    expect(orgInstructionsAuthor({ by: 'task:t2', by_name: '  ' })).toEqual({ byUser: false, who: 'an agent' });
  });
});
