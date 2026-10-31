/**
 * A quiet fold's line (web/src/components/sessions/fold-steps.ts): counts and
 * whom from and to, "Received 12 messages from Docs lead, from Walnut +9 · Sent 3 to
 * Brief task · Ran 8 tools". 2026-10-28, the user, of a line that named every
 * sender, notice and command and ran past the screen: no titles or commands, at
 * most two names a piece. 2026-10-30, the user, of a "Sent 2" that never said
 * which session: the parties are named. The opened fold shows each step.
 */
import { describe, expect, it } from 'vitest';
import { foldStepsPhrase, type FoldStep } from '@/components/sessions/fold-steps';

const note = (name: string, title?: string): FoldStep => ({ kind: 'received', from: 'peer-note', name, ...(title ? { title } : {}) });
const notice = (name: string, title: string): FoldStep => ({ kind: 'received', from: 'notification', name, title });
const bash = (command: string): FoldStep => ({ kind: 'calls', tools: [{ name: 'Bash', input: { command } }] });
const ack: FoldStep = { kind: 'ack' };
const thought: FoldStep = { kind: 'thought' };
const sent: FoldStep = { kind: 'sent' };

describe('foldStepsPhrase', () => {
  it('reads the reported dense stretch as three counts, two names a piece, no titles or commands', () => {
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
    expect(line).toBe('Received 13 messages from Walnut VP, from Board tags +10 · Sent 3 to your inbox +2 · Ran 8 tools');
    for (const word of ['Bun migration', 'Team update', 'git', 'acknowledged', 'thought', 'Sender']) {
      expect(line).not.toContain(word);
    }
  });

  it('uses the singular for one and leaves out what did not happen', () => {
    expect(foldStepsPhrase([note('Team lead', 'Migration is top priority'), ack])).toBe('Received 1 message from Team lead');
    expect(foldStepsPhrase([{ kind: 'received', from: 'other' }])).toBe('Received 1 message');
    expect(foldStepsPhrase([{ kind: 'sent', to: 'Brief task' }, { kind: 'sent', to: 'Task status foundation' }]))
      .toBe('Sent 2 to Brief task, to Task status foundation');
    expect(foldStepsPhrase([sent])).toBe('Sent 1');
    expect(foldStepsPhrase([bash('ls')])).toBe('Ran 1 tool');
    expect(foldStepsPhrase([note('A'), bash('ls'), thought, bash('pwd')])).toBe('Received 1 message from A · Ran 2 tools');
  });

  it('a title with its own dot or comma never reads as the line\'s separator or list', () => {
    expect(foldStepsPhrase([{ kind: 'sent', to: 'Brief: the letter, in three sections \u00b7 Tabs' }, { kind: 'sent', to: 'Docs' }, bash('ls')]))
      .toBe('Sent 2 to Brief: the letter, in three sections / Tabs, to Docs \u00b7 Ran 1 tool');
  });

  it('a letter to the inbox counts as sent', () => {
    expect(foldStepsPhrase([{ kind: 'inbox' }, sent])).toBe('Sent 2 to your inbox +1');
  });

  it('a stretch with nothing received, sent or run reads by what it was', () => {
    expect(foldStepsPhrase([{ kind: 'update' }])).toBe('An update');
    expect(foldStepsPhrase([{ kind: 'update' }, { kind: 'update' }])).toBe('2 updates');
    expect(foldStepsPhrase([ack])).toBe('Acknowledged');
    expect(foldStepsPhrase([thought])).toBe('Thinking');
    expect(foldStepsPhrase([])).toBe('Thinking');
    expect(foldStepsPhrase([{ kind: 'context', skill: true }])).toBe('Thinking');
  });
});
