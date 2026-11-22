/**
 * The words of an empty, loading or unavailable state (web/src/components/common/state-words.ts).
 * 2026-11-22 review: failures showed raw reasons ("Reason: Session history file not found",
 * "HTTP 502") as their hint; a raw reason now folds behind "Details", a plain one stays the hint.
 */
import { describe, it, expect } from 'vitest';
import { readsPlain, stateWords } from '../../web/src/components/common/state-words';

describe('state words', () => {
  it('splits one string into a title and a hint', () => {
    expect(stateWords('No messages yet. Send one below.')).toEqual({ title: 'No messages yet', hint: 'Send one below.' });
    expect(stateWords('Nothing pinned.')).toEqual({ title: 'Nothing pinned' });
  });

  it('keeps a plain sentence as the hint', () => {
    expect(readsPlain('Needs your Mac. This session runs through your Mac; its conversation is there.')).toBe(true);
    expect(readsPlain('The calendar app is not signed in.')).toBe(true);
  });

  it('folds a raw reason', () => {
    for (const raw of ['HTTP 502', 'Session history file not found', 'ENOENT: no such file, open /a/b.jsonl',
      'Error: fetch failed', 'Unexpected token < in JSON at position 0', 'request timed out after 15000 ms', 'x'.repeat(200) + '.']) {
      expect(readsPlain(raw), raw).toBe(false);
    }
  });
});
