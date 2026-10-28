/**
 * Who wrote a node's instructions, as the org chart's form says it (instructions-source.ts):
 * 2026-10-27, the user: "all human action can be done by agent also", so the page names an
 * agent that wrote them, and when.
 */
import { describe, it, expect } from 'vitest';
import { instructionsSource } from '../../web/src/components/org/instructions-source';
import { orgInstructionsAuthor } from '../../src/core/org/instructions-author';
import { DEFAULT_ORG_INSTRUCTIONS, orgInstructionsShown } from '../../src/core/org/core-instructions';

const now = Date.parse('2026-10-27T12:00:00Z');
const at = '2026-10-27T11:55:00Z';

describe('the words beside a node\'s instructions', () => {
  it('names the user, an agent, or an unknown agent, with the time', () => {
    const base = { followsDefault: false, edited: false, now };
    expect(instructionsSource({ ...base, stored: { text: 'Ship it.', at } })).toBe('by you, 5 min ago');
    expect(instructionsSource({ ...base, stored: { text: 'Ship it.', at, by: 'human' } })).toBe('by you, 5 min ago');
    // An agent's lines follow Walnut's default in the box, and the agent reads both.
    expect(instructionsSource({ ...base, stored: { text: 'Ship it.', at, by: 'task:t1', by_name: 'the CEO' } })).toBe('Walnut\'s default and lines by the CEO, 5 min ago');
    expect(instructionsSource({ ...base, stored: { text: 'Ship it.', at, by: 'agent' } })).toBe('Walnut\'s default and lines by an agent, 5 min ago');
    // Written at the user's request (override_user), they are the user's words.
    expect(instructionsSource({ ...base, stored: { text: 'Ship it.', at, by: 'task:t1', by_name: 'the CEO', for_user: true } })).toBe('by the CEO for you, 5 min ago');
  });

  it('says Walnut\'s default while the box follows it, and "yours" for unsaved words', () => {
    // 2026-10-27, the user: "inject the core instruction for each agent": the box opens on the default.
    expect(instructionsSource({ followsDefault: true, edited: false, stored: { text: 'Ship it.', at, by: 'task:t1', by_name: 'the CEO' }, now })).toBe('Walnut\'s default');
    expect(instructionsSource({ followsDefault: true, edited: false, stored: undefined, now })).toBe('Walnut\'s default');
    expect(instructionsSource({ followsDefault: false, edited: true, stored: { text: 'Ship it.', at, by: 'task:t1', by_name: 'the CEO' }, now })).toBe('yours');
    expect(instructionsSource({ followsDefault: false, edited: false, stored: { text: '', at, by: 'human' }, now })).toBe('yours');
  });

  it('a row an older Walnut wrote (no writer) is the user\'s', () => {
    expect(orgInstructionsAuthor({})).toEqual({ byUser: true, usersWords: true, who: 'you' });
    expect(orgInstructionsAuthor({ by: 'task:t2', by_name: '  ' })).toEqual({ byUser: false, usersWords: false, who: 'an agent' });
    expect(orgInstructionsAuthor({ by: 'task:t2', by_name: 'the CEO', for_user: true })).toEqual({ byUser: false, usersWords: true, who: 'the CEO' });
  });

  it('the box opens on what the agent reads', () => {
    const def = DEFAULT_ORG_INSTRUCTIONS.main;
    expect(orgInstructionsShown('main', undefined)).toBe(def);
    expect(orgInstructionsShown('main', { text: '  ', by: 'human' })).toBe(def);
    expect(orgInstructionsShown('main', { text: ' Own words. ', by: 'human' })).toBe('Own words.');
    expect(orgInstructionsShown('main', { text: 'Own words.' })).toBe('Own words.');
    expect(orgInstructionsShown('main', { text: 'Ship weekly.', by: 'task:t1' })).toBe(`${def}\n\nShip weekly.`);
    expect(orgInstructionsShown('main', { text: 'Ship weekly.', by: 'task:t1', for_user: true })).toBe('Ship weekly.');
    expect(orgInstructionsShown('lead', { text: 'Ship weekly.', by: 'agent' })).toBe(`${DEFAULT_ORG_INSTRUCTIONS.lead}\n\nShip weekly.`);
    // No org role: no default to show.
    expect(orgInstructionsShown(undefined, { text: 'Ship weekly.', by: 'agent' })).toBe('Ship weekly.');
  });
});
