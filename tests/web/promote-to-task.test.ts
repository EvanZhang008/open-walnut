/**
 * "Turn this into task" — the title/description derivation rules.
 *
 * Asserted here rather than in the browser spec because the failure mode is a
 * BAD STRING, not a bad DOM: a task whose title is "```" or "- " (markdown
 * scaffolding), or a detail pane repeating its own title. Those read as data
 * quality, so they belong on the module.
 */

import { describe, it, expect } from 'vitest';
import { deriveTaskTitle, deriveTaskDescription } from '@/components/chat/promote-to-task';

describe('deriveTaskTitle', () => {
  it('takes the first line of a plain message', () => {
    expect(deriveTaskTitle('Re-key the session cache\nand drop the old prefix')).
      toBe('Re-key the session cache');
  });

  it('skips leading blank lines', () => {
    expect(deriveTaskTitle('\n\n  \nShip the calendar fix')).toBe('Ship the calendar fix');
  });

  it('strips markdown scaffolding from the title line', () => {
    expect(deriveTaskTitle('## Fix the daemon retry budget')).toBe('Fix the daemon retry budget');
    expect(deriveTaskTitle('- [ ] Wire the bridge relay')).toBe('Wire the bridge relay');
    expect(deriveTaskTitle('* Drop the stale watermark')).toBe('Drop the stale watermark');
    expect(deriveTaskTitle('3) Re-run the live matrix')).toBe('Re-run the live matrix');
    expect(deriveTaskTitle('> Quoted ask from the user')).toBe('Quoted ask from the user');
    expect(deriveTaskTitle('**Bold ask** with `code`')).toBe('Bold ask with code');
  });

  it('walks past a scaffolding-only first line to the first real words', () => {
    expect(deriveTaskTitle('```ts\nconst answer = 42\n```')).toBe('const answer = 42');
    expect(deriveTaskTitle('-\nActual work item')).toBe('Actual work item');
    expect(deriveTaskTitle('---\nAfter the rule')).toBe('After the rule');
    expect(deriveTaskTitle('###\nHeading marker only')).toBe('Heading marker only');
    expect(deriveTaskTitle('- [ ]\nEmpty checkbox first')).toBe('Empty checkbox first');
  });

  it('caps a long line with an ellipsis instead of a paragraph-long title', () => {
    const long = `Rework ${'the session snapshot gate '.repeat(8)}end to end`;
    const title = deriveTaskTitle(long);
    expect(title.length).toBeLessThanOrEqual(90);
    expect(title.endsWith('…')).toBe(true);
    // The cap must not slice mid-run and leave trailing whitespace before the ellipsis.
    expect(title).not.toMatch(/\s…$/);
  });

  it('falls back to a generic title when the message carries no words', () => {
    expect(deriveTaskTitle('')).toBe('Chat note');
    expect(deriveTaskTitle('```\n```')).toBe('Chat note');
    expect(deriveTaskTitle('   \n\t')).toBe('Chat note');
  });
});

describe('deriveTaskDescription', () => {
  it('keeps the whole message as the body', () => {
    const text = 'Re-key the session cache\nand drop the old prefix';
    expect(deriveTaskDescription(text, deriveTaskTitle(text))).toBe(text);
  });

  it('omits the body when the title already IS the whole message', () => {
    const text = 'Ship the calendar fix';
    expect(deriveTaskDescription(text, deriveTaskTitle(text))).toBeUndefined();
  });

  it('keeps the body when the title was truncated, so nothing is lost', () => {
    const text = `Rework ${'the session snapshot gate '.repeat(8)}end to end`;
    expect(deriveTaskDescription(text, deriveTaskTitle(text))).toBe(text);
  });

  it('omits the body for an empty message', () => {
    expect(deriveTaskDescription('   ', 'Chat note')).toBeUndefined();
  });
});
