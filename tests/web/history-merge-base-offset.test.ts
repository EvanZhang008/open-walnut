/**
 * planDeltaMerge with baseOffset (lazy tail load).
 *
 * When the client holds only the last N messages of a longer history
 * (`?tail=` slice), the cursor space still counts the hidden prefix. The
 * length-consistency guard must compare `merged.length + baseOffset` against
 * the cursor — with offset 0 (the default) behavior is unchanged.
 */

import { describe, it, expect } from 'vitest';
import { planDeltaMerge } from '../../web/src/hooks/history-merge';
import type { SessionHistoryMessage } from '../../web/src/types/session';

const msg = (id: string): SessionHistoryMessage => ({
  role: 'assistant', text: `text-${id}`, timestamp: '', msgId: id,
});

describe('planDeltaMerge baseOffset', () => {
  it('offset 0 (default): unchanged behavior — cursor equals merged length', () => {
    const base = [msg('a'), msg('b')];
    const plan = planDeltaMerge(base, { messages: [msg('c')], cursor: 3 }, 2);
    expect(plan).toMatchObject({ kind: 'merged', cursor: 3 });
    if (plan.kind === 'merged') expect(plan.messages).toHaveLength(3);
  });

  it('tail-sliced base: cursor counts the hidden prefix, merge still succeeds', () => {
    // Source has 1000 messages; client holds the last 2 (offset 998).
    const base = [msg('m999'), msg('m1000')];
    const plan = planDeltaMerge(
      base,
      { messages: [msg('m1001')], cursor: 1001 },
      1000,
      { baseOffset: 998 },
    );
    expect(plan).toMatchObject({ kind: 'merged', cursor: 1001 });
    if (plan.kind === 'merged') {
      expect(plan.messages.map(m => m.msgId)).toEqual(['m999', 'm1000', 'm1001']);
    }
  });

  it('tail-sliced base WITHOUT the offset would rebuild (guard still has teeth)', () => {
    const base = [msg('m999'), msg('m1000')];
    const plan = planDeltaMerge(base, { messages: [msg('m1001')], cursor: 1001 }, 1000);
    expect(plan.kind).toBe('rebuild');
  });

  it('wrong offset trips the length guard → rebuild, never silent loss', () => {
    const base = [msg('m999'), msg('m1000')];
    const plan = planDeltaMerge(
      base,
      { messages: [msg('m1001')], cursor: 1001 },
      1000,
      { baseOffset: 990 }, // stale bookkeeping
    );
    expect(plan.kind).toBe('rebuild');
  });

  it('empty delta with offset: cursor advances, no rebuild', () => {
    const base = [msg('m999'), msg('m1000')];
    const plan = planDeltaMerge(
      base,
      { messages: [], cursor: 1000 },
      1000,
      { baseOffset: 998 },
    );
    expect(plan).toMatchObject({ kind: 'unchanged', cursor: 1000 });
  });

  it('identity overlap still wins over offset math (dup delta → rebuild)', () => {
    const base = [msg('m999'), msg('m1000')];
    const plan = planDeltaMerge(
      base,
      { messages: [msg('m1000')], cursor: 1001 },
      1000,
      { baseOffset: 998 },
    );
    expect(plan.kind).toBe('rebuild');
  });
});
