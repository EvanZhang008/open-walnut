/**
 * REGRESSION: a fresh session's first message was invisible until the turn ended.
 *
 * Reproduced from prod logs (session bfa52d80, 2026-09-03): spawn 21:53:12.3,
 * panel history fetches at :13.2 and :13.6 (both empty — the transcript did not
 * exist yet), CLI wrote the user line at :15.8, first thinking block at :19.8,
 * and the NEXT history fetch was at 21:55:33 — after the turn. The panel had no
 * refetch trigger between "opened" and "turn ended". A second session (c7c028a4)
 * showed the same empty opening fetches and only displayed the prompt because
 * the user re-opened the panel 90 s later — the "sometimes it shows" report.
 *
 * The fix refetches on the turn's first MODEL-output block (the CLI writes the
 * user line before calling the model), never on system blocks (hook/init
 * notifications land ~20 ms BEFORE the user line — measured :15.826 vs :15.848).
 */
import { describe, it, expect } from 'vitest';
import {
  isModelOutputBlock,
  liveTurnHasModelOutput,
  turnPromptMissing,
  shouldRefetchForTurnPrompt,
  PROMPT_REFETCH_RETRY_DELAYS_MS,
} from '@/components/sessions/turn-prompt-refetch';
import type { StreamingBlock } from '@/stream/stream-reducer';

const sys = (message = 'hook_started'): StreamingBlock => ({ type: 'system', variant: 'info', message });
const thinking = (content = 'hmm'): StreamingBlock => ({ type: 'thinking', content });
const text = (content = 'On it.'): StreamingBlock => ({ type: 'text', content });
const tool = (): StreamingBlock => ({ type: 'tool_call', toolUseId: 'toolu_1', name: 'Read', status: 'calling' });
const permission = (): StreamingBlock => ({ type: 'permission', requestId: 'r1', toolName: 'Bash' });

const user = (t: string, injected = false) => ({ role: 'user' as const, text: t, injected });
const asst = (t: string) => ({ role: 'assistant' as const, text: t });

describe('isModelOutputBlock', () => {
  it('counts text / thinking / tool_call / permission as model output', () => {
    expect(isModelOutputBlock(text())).toBe(true);
    expect(isModelOutputBlock(thinking())).toBe(true);
    expect(isModelOutputBlock(tool())).toBe(true);
    expect(isModelOutputBlock(permission())).toBe(true);
  });
  it('does NOT count system notifications — they stream before the user line lands', () => {
    expect(isModelOutputBlock(sys())).toBe(false);
    expect(isModelOutputBlock(sys('session_state_changed'))).toBe(false);
  });
});

describe('liveTurnHasModelOutput', () => {
  it('only inspects blocks past the completed-turn boundary', () => {
    // A previous turn's text sits at index 0; the live turn (from 1) is system-only.
    expect(liveTurnHasModelOutput([text(), sys(), sys()], 1)).toBe(false);
    expect(liveTurnHasModelOutput([text(), sys(), thinking()], 1)).toBe(true);
  });
  it('is false for an empty or system-only live turn (the incident\'s screenshot state)', () => {
    expect(liveTurnHasModelOutput([], 0)).toBe(false);
    expect(liveTurnHasModelOutput([sys(), sys()], 0)).toBe(false);
  });
});

describe('turnPromptMissing', () => {
  it('is true when history is empty and nothing optimistic is shown', () => {
    expect(turnPromptMissing([], 0, 0)).toBe(true);
  });
  it('is false once a typed user row exists at/after the watermark', () => {
    expect(turnPromptMissing([user('fix the paste bug')], 0, 0)).toBe(false);
  });
  it('ignores user rows BEFORE the watermark — a new turn needs its own prompt', () => {
    const history = [user('turn 1'), asst('done'), user('turn 2'), asst('done')];
    expect(turnPromptMissing(history, 4, 0)).toBe(true);
    expect(turnPromptMissing([...history, user('turn 3')], 4, 0)).toBe(false);
  });
  it('does not accept injected rows or blank text as the prompt', () => {
    expect(turnPromptMissing([user('<skill dump>', true)], 0, 0)).toBe(true);
    expect(turnPromptMissing([user('   ')], 0, 0)).toBe(true);
    expect(turnPromptMissing([asst('hello')], 0, 0)).toBe(true);
  });
  it('is false when an optimistic bubble already stands for the prompt', () => {
    expect(turnPromptMissing([], 0, 1)).toBe(false);
  });
  it('clamps a watermark past the array end (post-/compact shrink)', () => {
    expect(turnPromptMissing([user('x')], 50, 0)).toBe(true);
  });
});

describe('shouldRefetchForTurnPrompt — the incident timeline', () => {
  const base = { messages: [], watermark: 0, optimisticCount: 0, alreadyFiredThisTurn: false };

  it('stays quiet while only system blocks have streamed (user line may not be on disk yet)', () => {
    expect(shouldRefetchForTurnPrompt({ ...base, blocks: [sys(), sys()], completedLen: 0 })).toBe(false);
  });
  it('fires on the first thinking block with empty history — the exact 21:53:19.8 moment', () => {
    expect(shouldRefetchForTurnPrompt({ ...base, blocks: [sys(), sys(), thinking()], completedLen: 0 })).toBe(true);
  });
  it('fires on a first tool call too (no-thinking models)', () => {
    expect(shouldRefetchForTurnPrompt({ ...base, blocks: [sys(), tool()], completedLen: 0 })).toBe(true);
  });
  it('fires once per turn — the latch suppresses every later render', () => {
    expect(shouldRefetchForTurnPrompt({ ...base, blocks: [thinking(), text()], completedLen: 0, alreadyFiredThisTurn: true })).toBe(false);
  });
  it('does not fire when the panel opened late and the prompt is already in history', () => {
    expect(shouldRefetchForTurnPrompt({ ...base, blocks: [thinking()], completedLen: 0, messages: [user('the launch prompt')] })).toBe(false);
  });
  it('does not fire for a composer send — its optimistic bubble already shows the prompt', () => {
    expect(shouldRefetchForTurnPrompt({ ...base, blocks: [thinking()], completedLen: 0, optimisticCount: 1 })).toBe(false);
  });
  it('fires for a later turn whose prompt came from elsewhere (phone / Walnut / other tab)', () => {
    const history = [user('turn 1'), asst('answer 1')];
    // Turn 2 started (watermark = 2), its prompt was sent from another surface,
    // and the first model block of turn 2 has arrived.
    expect(shouldRefetchForTurnPrompt({
      ...base, messages: history, watermark: 2,
      blocks: [text('answer 1'), tool()], completedLen: 1,
    })).toBe(true);
  });
});

describe('retry schedule', () => {
  it('is bounded and short — the turn-end refetch is the final fallback', () => {
    expect(PROMPT_REFETCH_RETRY_DELAYS_MS.length).toBeLessThanOrEqual(3);
    expect(Math.max(...PROMPT_REFETCH_RETRY_DELAYS_MS)).toBeLessThanOrEqual(10_000);
  });
});
