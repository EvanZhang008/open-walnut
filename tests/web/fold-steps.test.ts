/**
 * A quiet fold's line (web/src/components/sessions/fold-steps.ts): counts only,
 * "Received 12 messages · Sent 3 · Ran 8 tools". 2026-10-28, the user, of a line
 * that named every sender, notice and command and ran past the screen: show how
 * many were received, sent and run, nothing more. The opened fold shows each step.
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
    for (const word of ['Walnut VP', 'Bun migration', 'git', 'acknowledged', 'thought', 'Sender']) {
      expect(line).not.toContain(word);
    }
  });

  it('uses the singular for one and leaves out what did not happen', () => {
    expect(foldStepsPhrase([note('Team lead', 'Migration is top priority'), ack])).toBe('Received 1 message');
    expect(foldStepsPhrase([sent])).toBe('Sent 1');
    expect(foldStepsPhrase([bash('ls')])).toBe('Ran 1 tool');
    expect(foldStepsPhrase([note('A'), bash('ls'), thought, bash('pwd')])).toBe('Received 1 message · Ran 2 tools');
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
});
