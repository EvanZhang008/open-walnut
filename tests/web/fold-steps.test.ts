/**
 * A quiet fold's line (web/src/components/sessions/fold-steps.ts): counts only,
 * "Received 12 messages · Sent 3 · Ran 8 tools". 2026-10-28, the user, of a line
 * that named every sender, notice and command and ran past the screen: no titles
 * or commands. 2026-10-31, the user, of a line that named its senders: "just
 * Received 1 message". The opened fold shows each step with its sender and target.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { envelopeSteps, foldStepsPhrase, type FoldStep } from '@/components/sessions/fold-steps';
import { parseSessionEnvelopes } from '../../src/lib/history-session-envelope';

// The first argument names the sender in the test only: a step carries none.
const note = (_sender: string, title?: string): FoldStep => ({ kind: 'received', from: 'peer-note', ...(title ? { title } : {}) });
const notice = (_about: string, title: string): FoldStep => ({ kind: 'received', from: 'notification', title });
const bash = (command: string): FoldStep => ({ kind: 'calls', tools: [{ name: 'Bash', input: { command } }] });
const ack: FoldStep = { kind: 'ack' };
const thought: FoldStep = { kind: 'thought' };
const sent: FoldStep = { kind: 'sent' };

describe('foldStepsPhrase', () => {
  it('reads the reported dense stretch as three counts, no names, titles or commands', () => {
    const steps: FoldStep[] = [
      notice('Walnut VP', 'Team update (last note 18 min ago), from your teams\' own status'),
      notice('Board tags', 'Stopped without completing its task'),
      bash('git cat-file -p HEAD'), sent, ack,
      note('Walnut VP', 'Bun migration is top priority'), thought, ack,
      ...Array.from({ length: 10 }, (_, i) => note(`Sender ${i}`, 'A title long enough to matter')),
      bash('ls'), { kind: 'calls', tools: [{ name: 'Read', input: { file_path: '/a/b.ts' } }, { name: 'Grep', input: {} }] },
      sent, { kind: 'inbox' },
      ...Array.from({ length: 4 }, () => bash('bun test')),
    ];
    const line = foldStepsPhrase(steps);
    expect(line).toBe('Received 13 messages · Sent 3 · Ran 8 tools');
    for (const word of ['Bun migration', 'Team update', 'git', 'acknowledged', 'thought', 'Sender', 'Walnut VP', 'Board tags', 'inbox']) {
      expect(line).not.toContain(word);
    }
  });

  it('uses the singular for one and leaves out what did not happen', () => {
    expect(foldStepsPhrase([note('Team lead', 'Migration is top priority'), ack])).toBe('Received 1 message');
    expect(foldStepsPhrase([{ kind: 'received', from: 'other' }])).toBe('Received 1 message');
    expect(foldStepsPhrase([{ kind: 'sent', to: 'Brief task' }, { kind: 'sent', to: 'Task status foundation' }]))
      .toBe('Sent 2');
    expect(foldStepsPhrase([sent])).toBe('Sent 1');
    expect(foldStepsPhrase([bash('ls')])).toBe('Ran 1 tool');
    expect(foldStepsPhrase([note('A'), bash('ls'), thought, bash('pwd')])).toBe('Received 1 message · Ran 2 tools');
  });

  it('a title with its own dot or comma never reads as the line\'s separator or list', () => {
    expect(foldStepsPhrase([{ kind: 'sent', to: 'Brief: the letter, in three sections \u00b7 Tabs' }, { kind: 'sent', to: 'Docs' }, bash('ls')]))
      .toBe('Sent 2 \u00b7 Ran 1 tool');
  });

  it('names no one, whatever the steps carry (2026-10-31, the user: "just Received 1 message")', () => {
    const named: FoldStep[] = [note('Product regressions the browser suite caught'), { kind: 'sent', to: 'Brief task' }, { kind: 'inbox' }, bash('ls')];
    expect(foldStepsPhrase(named)).toBe('Received 1 message · Sent 2 · Ran 1 tool');
    expect(foldStepsPhrase(named)).not.toMatch(/ (from|to) /);
  });

  it('a letter to the inbox counts as sent', () => {
    expect(foldStepsPhrase([{ kind: 'inbox' }, sent])).toBe('Sent 2');
  });

  it('a stretch with nothing received, sent or run reads by what it was', () => {
    expect(foldStepsPhrase([{ kind: 'update' }])).toBe('An update');
    expect(foldStepsPhrase([{ kind: 'update' }, { kind: 'update' }])).toBe('2 updates');
    expect(foldStepsPhrase([ack])).toBe('Acknowledged');
    expect(foldStepsPhrase([thought])).toBe('Thinking');
    expect(foldStepsPhrase([])).toBe('Thinking');
    expect(foldStepsPhrase([{ kind: 'context', skill: true }])).toBe('Thinking');
  });

  // 2026-10-31, Main's chat: "Received 13 messages from CEO, from Trigger: Main daily
  // reflection +8". The org notices carry about="CEO" (Main itself), and the line read
  // that subject as their sender. The same structure, neutral names.
  it('the reported Main chat: notices about the session itself and a routine run name no one', () => {
    const text = [
      '<walnut-message kind="notification" from="Walnut" outcome="task-routing-policy" note="current default instructions">\nWalnut changed your default instructions.\n</walnut-message>',
      '<walnut-message kind="notification" from="Walnut" about="CEO" about-task="main-task-1" outcome="org-update">\nOrg update since 2 h ago\n</walnut-message>',
      '<walnut-message kind="trigger" from="Trigger: Main daily reflection">\nRoutine ran on schedule\n</walnut-message>',
    ].join('\n\n');
    const line = foldStepsPhrase(envelopeSteps(parseSessionEnvelopes(text)));
    expect(line).toBe('Received 3 messages');
  });

  it('no envelope kind lends its sender or its subject to the line', () => {
    // Every kind the parser accepts, read from its source, so a new one is covered.
    const src = readFileSync(new URL('../../src/lib/history-session-envelope.ts', import.meta.url), 'utf8');
    const kinds = [...(src.match(/const TAG_KINDS = new Set\(\[([^\]]+)\]\)/)?.[1] ?? '').matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
    expect(kinds).toEqual(expect.arrayContaining(['peer-note', 'reply', 'notification', 'trigger', 'app-state']));
    for (const kind of kinds) {
      const text = `<walnut-message kind="${kind}" from="Sender Task [abcd1234]" from-task="t-from" about="Subject Task [abcd5678]" about-task="t-about" title="A title" outcome="done">\nbody\n</walnut-message>`;
      const segments = parseSessionEnvelopes(text);
      expect(segments.some((x) => x.kind === 'envelope'), kind).toBe(true);
      const line = foldStepsPhrase(envelopeSteps(segments));
      expect(line, kind).toBe('Received 1 message');
    }
  });
});

