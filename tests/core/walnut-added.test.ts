/**
 * What Walnut added to a person's message besides its notes in front: the hints
 * taken off the text and the context blocks it put first. The phone's
 * transcript rows carry them (`added`, `textWithoutContext`) so it can hide them
 * by default and show them on request, as the web chat does.
 */
import { describe, expect, it } from 'vitest';
import { cliAddedOf, hookContextText, walnutAddedOf } from '../../src/lib/walnut-added.js';
import { createEnvelopeKit } from '../../src/core/peers/envelope-kit.js';

const kit = createEnvelopeKit();
const note = kit.buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut', outcome: 'moved' }, body: 'This task moved.' });
const context = '[Conversation context]\nEarlier: the review was done.\n[/Conversation context]\n\n';
const rich = { kind: 'rich-output', text: 'rich output mode is still on.' };

describe('walnutAddedOf', () => {
  it('names each hint and context block, and gives the text without the blocks, its note kept', () => {
    const text = `${note}\n\n${context}Please tidy the notes.`;
    const added = walnutAddedOf(text, [rich, { kind: 'question', arg: '4', text: 'Tag your reply [Q4].' }]);
    expect(added.items).toEqual([
      { kind: 'context', name: 'Conversation context', label: 'Context', text: 'Earlier: the review was done.' },
      { kind: 'hint', name: 'rich-output', label: 'Rich output', text: 'rich output mode is still on.' },
      { kind: 'hint', name: 'question', label: 'Question Q4', text: 'Tag your reply [Q4].' },
    ]);
    expect(added.textWithoutContext).toBe(`${note}\n\nPlease tidy the notes.`);
  });

  it('leaves a plain message alone and drops the question-number banner', () => {
    expect(walnutAddedOf('Just words.')).toEqual({ items: [] });
    const q = walnutAddedOf('[Question Q2]\n[/Question Q2]\n\nWhy?');
    expect(q.items).toEqual([]);
    expect(q.textWithoutContext).toBe('Why?');
  });
});

describe('cliAddedOf', () => {
  it('names a skill, a hook and other context, draws a Walnut message as itself, and drops the interrupt marker', () => {
    expect(cliAddedOf('Base directory for this skill: /x/skills/notes/\n\n# Notes')).toEqual({
      kind: 'skill', label: 'Loaded skill notes', text: 'Base directory for this skill: /x/skills/notes/\n\n# Notes',
    });
    expect(cliAddedOf(hookContextText(['Open items: none.'], 'UserPromptSubmit')!)).toEqual({
      kind: 'hook', label: 'Added by the UserPromptSubmit hook', text: 'Open items: none.',
    });
    expect(cliAddedOf(hookContextText('x', undefined)!)).toMatchObject({ kind: 'hook', label: 'Added by a hook' });
    expect(cliAddedOf('This session is being continued from a previous conversation.')).toMatchObject({
      kind: 'context', label: 'Continuation summary',
    });
    expect(cliAddedOf('<walnut-message kind="peer-note" from="A [aaaaaaaa]">\nHi.\n</walnut-message>')).toBe('message');
    expect(cliAddedOf('[Request interrupted by user for tool use]')).toBeNull();
    expect(cliAddedOf('   ')).toBeNull();
    expect(hookContextText([' ', 3], 'Stop')).toBeNull();
  });
});
