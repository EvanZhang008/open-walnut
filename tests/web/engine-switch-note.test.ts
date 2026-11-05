// The chat draws an engine switch's ready note as one quiet "Switched to X" row
// (web/src/components/sessions/engine-switch-note.ts), so the server's note and the web's
// reader must keep the same words.
import { describe, expect, it } from 'vitest';
import { switchReadyNote } from '../../src/core/sessions/engine-switch.js';
import { frameAsWalnut } from '../../src/core/sessions/send-frame.js';
import { parseSessionEnvelopes } from '../../src/lib/history-session-envelope.js';
import { engineCaps } from '../../src/core/agents/engine-registry.js';
import { engineSwitchNoteEngine } from '../../web/src/components/sessions/engine-switch-note';

describe('engine switch ready note in the chat', () => {
  for (const engine of ['pi', 'claude', 'codex', 'opencode', 'goose'] as const) {
    const name = engineCaps(engine).displayName;
    it(`reads the engine from the framed note (${engine})`, () => {
      const framed = frameAsWalnut(switchReadyNote(engine), 'engine-switch');
      const envelopes = (parseSessionEnvelopes(framed) ?? []).filter((s) => s.kind === 'envelope');
      expect(envelopes).toHaveLength(1);
      const env = (envelopes[0] as { envelope: Parameters<typeof engineSwitchNoteEngine>[0] }).envelope;
      expect(engineSwitchNoteEngine(env)).toBe(name);
    });
  }

  it('leaves every other note a card', () => {
    const other = frameAsWalnut('The user switched this task to Pi and has not written anything yet.', 'routine');
    const env = ((parseSessionEnvelopes(other) ?? []).find((s) => s.kind === 'envelope') as { envelope: Parameters<typeof engineSwitchNoteEngine>[0] }).envelope;
    expect(engineSwitchNoteEngine(env)).toBeNull();
    expect(engineSwitchNoteEngine({ kind: 'peer-note', peer: { title: 'Walnut (engine switch)' }, body: 'Run the tests.' } as never)).toBeNull();
  });
});
