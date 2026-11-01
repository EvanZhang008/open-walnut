/**
 * What Walnut added to a person's message besides its notes in front: the context
 * blocks it put first. The phone's transcript rows carry them (`added`,
 * `textWithoutContext`), as the web chat shows them. Message hints are never among
 * them, nor in a CLI-injected row (2026-11-01, the user: "just remove this").
 */
import { describe, expect, it } from 'vitest';
import { cliAddedOf, hookContextText, walnutAddedOf } from '../../src/lib/walnut-added.js';
import { createEnvelopeKit } from '../../src/core/peers/envelope-kit.js';

const kit = createEnvelopeKit();
const note = kit.buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut', outcome: 'moved' }, body: 'This task moved.' });
const context = '[Conversation context]\nEarlier: the review was done.\n[/Conversation context]\n\n';

describe('walnutAddedOf', () => {
  it('names each context block, and gives the text without the blocks, its note kept', () => {
    const text = `${note}\n\n${context}Please tidy the notes.`;
    const added = walnutAddedOf(text);
    expect(added.items).toEqual([
      { kind: 'context', name: 'Conversation context', label: 'Context', text: 'Earlier: the review was done.' },
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

describe('hint blocks are never shown', () => {
  it('a hook context and a CLI-injected line leave their blocks out', async () => {
    const { renderHintBlock } = await import('../../src/core/hints/hint-format.js');
    const lang = renderHintBlock('reply-language', 'Talk to the user in Chinese.');
    const hook = hookContextText([`Open items: none.\n\n${lang}`], 'SessionStart')!;
    expect(hook).toBe('Hook context (SessionStart hook):\n\nOpen items: none.');
    // A context of nothing but hints is no row.
    expect(hookContextText([lang], 'SessionStart')).toBeNull();
    // A Walnut message the CLI delivered, with its hint, is that message.
    expect(cliAddedOf(`${note}\n\n${lang}`)).toBe('message');
    const ctx = cliAddedOf(`Some context.\n\n${lang}`);
    expect(ctx && ctx !== 'message' ? ctx.text : '').toBe('Some context.');
    expect(cliAddedOf(lang)).toBeNull();
  });

  it('the words around a block stay exactly as they were', async () => {
    const { renderHintBlock, replaceHintBlocks } = await import('../../src/core/hints/hint-format.js');
    const lang = renderHintBlock('reply-language', 'Talk to the user in Chinese.');
    // A memory note quoting the escaped tag, and one typed literally, as the hook context holds them.
    const words = 'Memory: the escape turns <system-reminder> into &lt;system-reminder and &amp;lt;system-reminder.'
    const out = replaceHintBlocks(`${words}\n\n${lang}`, () => 'PLAIN')
    expect(out).toBe(`${words}\n\nPLAIN`)
    // A raw NUL or a percent sign is just text.
    expect(replaceHintBlocks(`a \u0000%zz\u0000 b ${lang}`, () => 'P')).toBe('a \u0000%zz\u0000 b P')
    const hook = hookContextText([`${words}\n\n${lang}`], 'SessionStart')!
    expect(hook).toBe(`Hook context (SessionStart hook):\n\n${words}`)
  });
});
