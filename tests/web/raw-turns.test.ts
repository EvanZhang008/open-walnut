import { describe, expect, it } from 'vitest';
import { rawTurnsOf } from '../../web/src/utils/raw-turns';
import type { SessionHistoryMessage } from '../../web/src/types/session';

const at = (s: number) => new Date(Date.UTC(2026, 10, 5, 0, 0, s)).toISOString();

describe('rawTurnsOf', () => {
  it('pairs each input as received with every output part in order', () => {
    const raw = 'hi\n\n<system-reminder>\nWalnut (reply-language): Chinese.\n</system-reminder>';
    const msgs: SessionHistoryMessage[] = [
      { role: 'assistant', text: 'tail of an earlier turn', timestamp: at(0) },
      { role: 'user', text: 'hi', rawText: raw, hints: [{ kind: 'reply-language', text: 'Chinese.' }], timestamp: at(1), msgId: 'u1' },
      { role: 'assistant', text: '好的', thinking: 'think', timestamp: at(2), tools: [{ name: 'Bash', input: { command: 'ls' }, result: 'x'.repeat(5000) }] },
      { role: 'user', text: 'skill dump', injected: true, timestamp: at(3) },
      { role: 'assistant', text: 'done', timestamp: at(4) },
      { role: 'user', text: 'plain', timestamp: at(5), msgId: 'u2' },
    ];
    const turns = rawTurnsOf(msgs);
    expect(turns).toHaveLength(3);
    expect(turns[0]).toMatchObject({ input: '', output: [{ kind: 'text', text: 'tail of an earlier turn' }] });
    expect(turns[1]).toMatchObject({ key: 'u1', input: raw, hinted: true, hintKinds: ['reply-language'] });
    expect(turns[1].output.map((p) => p.kind)).toEqual(['thinking', 'text', 'tool', 'text']);
    const tool = turns[1].output[2];
    expect(tool.input).toContain('"command": "ls"');
    expect(tool.result).toHaveLength(4000);
    expect(tool.resultCut).toBe(true);
    expect(turns[2]).toMatchObject({ input: 'plain', hinted: false, output: [] });
  });
});
