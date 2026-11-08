/**
 * The page a live block of a strict question's turn reads on (web/src/utils/stream-block-page.ts).
 * 2026-11-07, the Tree Mode round 7 walk: a card about the question's turn, which the saved
 * conversation has no row for, was sent to Main and showed there while the question page answered.
 */
import { describe, it, expect } from 'vitest';
import { TRANSCRIPT_TWIN, hasTranscriptTwin, pageOfStreamBlock } from '../../web/src/utils/stream-block-page';
import type { StreamingBlock } from '../../web/src/stream/stream-reducer';

const ROOT = 'root';
const Q = 'q:6';
const strict = (k: string) => k === Q;

const text: StreamingBlock = { type: 'text', content: 'plain words' } as StreamingBlock;
const tool: StreamingBlock = { type: 'tool_call', toolUseId: 't1', name: 'Read', input: {}, status: 'done' } as unknown as StreamingBlock;
const card: StreamingBlock = { type: 'system', variant: 'info', message: 'Retrying' };
const savedCard: StreamingBlock = { type: 'system', variant: 'compact', message: 'Context compacted', uuid: 'u1' };
const prompt: StreamingBlock = { type: 'permission', requestId: 'r1', toolName: 'Bash' };

describe('pageOfStreamBlock', () => {
  it('its answer tag places a block first', () => {
    expect(pageOfStreamBlock(text, Q, ROOT, strict, ROOT)).toBe(Q);
  });

  it('in a strict question\'s turn, a card the saved conversation has no row for reads on the question\'s page, the rest in Main', () => {
    expect(pageOfStreamBlock(text, null, Q, strict, ROOT)).toBe(ROOT);
    expect(pageOfStreamBlock(tool, null, Q, strict, ROOT)).toBe(ROOT);
    expect(pageOfStreamBlock(savedCard, null, Q, strict, ROOT)).toBe(ROOT);
    expect(pageOfStreamBlock(card, null, Q, strict, ROOT)).toBe(Q);
    // A prompt must be answered: it stays in Main, where the reader may stand, never on a page
    // they left (review of this change).
    expect(pageOfStreamBlock(prompt, null, Q, strict, ROOT)).toBe(ROOT);
  });

  it('any other place is kept as it is', () => {
    for (const b of [text, tool, card, savedCard, prompt]) {
      expect(pageOfStreamBlock(b, null, 'q:7', strict, ROOT)).toBe('q:7');
      expect(pageOfStreamBlock(b, null, ROOT, strict, ROOT)).toBe(ROOT);
    }
  });

  it('every block type says whether the saved conversation keeps a row for it', () => {
    // A new StreamingBlock type does not compile until TRANSCRIPT_TWIN names it; this pins the
    // current answers so a change to one is a decision.
    expect(Object.keys(TRANSCRIPT_TWIN).sort()).toEqual(['permission', 'system', 'text', 'thinking', 'tool_call', 'user_line']);
    expect([text, tool, savedCard].every(hasTranscriptTwin)).toBe(true);
    expect([card, prompt].some(hasTranscriptTwin)).toBe(false);
  });
});
