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
      // A hint's label is the plain phrase the phone reads after "Walnut added:" (2026-10-31).
      { kind: 'hint', name: 'rich-output', label: 'a reminder that rich output is on (your Output mode setting)', text: 'rich output mode is still on.' },
      { kind: 'hint', name: 'question', label: 'a request to start the answer with [Q4], so it is filed under question 4', text: 'Tag your reply [Q4].' },
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

describe('hintSummary and the plain lines', () => {
  it('says what each hint asked and where it comes from, never a codename', async () => {
    const { hintSummary, hintPlainLine } = await import('../../src/lib/walnut-added.js');
    expect(hintSummary({ kind: 'reply-language', text: 'Talk to the user in Chinese; code stays English.' }))
      .toBe('a request to write to you in Chinese (your Reply language setting)');
    expect(hintSummary({ kind: 'reply-language', text: 'Answer briefly.' })).toBe('a reminder of your Reply language setting');
    // A rule the user wrote in their own words: the whole name, and never a wrong language.
    expect(hintSummary({ kind: 'reply-language', text: 'Reply in Simplified Chinese.' }))
      .toBe('a request to write to you in Simplified Chinese (your Reply language setting)');
    expect(hintSummary({ kind: 'reply-language', text: 'Reply in Chinese (Simplified).' }))
      .toBe('a request to write to you in Chinese (your Reply language setting)');
    expect(hintSummary({ kind: 'reply-language', text: 'Keep code in English, talk to me in Chinese.' }))
      .toBe('a reminder of your Reply language setting');
    expect(hintSummary({ kind: 'reply-language', text: 'Respond in Markdown, in Chinese.' }))
      .toBe('a request to write to you in Chinese (your Reply language setting)');
    expect(hintSummary({ kind: 'rich-output', text: 'rich output mode is off. Return to plain markdown replies.' }))
      .toBe('a note that rich output is off again (your Output mode setting)');
    expect(hintSummary({ kind: 'voice-reply', text: 'x' })).toContain('because you sent this by voice');
    expect(hintSummary({ kind: 'tone', text: 'Keep it short.' })).toBe('your hint "tone" (Settings, Sessions, Message hints)');
    // No dashed kind name ("question" is a plain word, so it may appear).
    for (const kind of ['reply-language', 'rich-output', 'voice-reply', 'session-context', 'engine-switch']) {
      expect(hintSummary({ kind, text: 'x' })).not.toContain(kind);
    }
    expect(hintPlainLine({ kind: 'reply-language', text: 'Talk to the user in Chinese.' }))
      .toBe('Walnut added a request to write to you in Chinese (your Reply language setting). Exact text: "Talk to the user in Chinese."');
  });

  it('a hook context and a CLI-injected line read their blocks as plain lines', async () => {
    const { renderHintBlock } = await import('../../src/core/hints/hint-format.js');
    const lang = renderHintBlock('reply-language', 'Talk to the user in Chinese.');
    const hook = hookContextText([`Open items: none.\n\n${lang}`], 'SessionStart')!;
    expect(hook).not.toContain('<system-reminder');
    expect(hook).toContain('Walnut added a request to write to you in Chinese');
    // A Walnut message the CLI delivered, with its hint, is that message.
    expect(cliAddedOf(`${note}\n\n${lang}`)).toBe('message');
    const ctx = cliAddedOf(`Some context.\n\n${lang}`);
    expect(ctx && ctx !== 'message' ? ctx.text : '').toBe('Some context.\n\nWalnut added a request to write to you in Chinese (your Reply language setting). Exact text: "Talk to the user in Chinese."');
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
    expect(hook).toContain(words)
  });
});

