/**
 * The picker's average speed (speedAverage in turn-speed-format.ts): the session's token-weighted
 * tok/s on the model it runs on now, matched by id, then by display name.
 */
import { describe, it, expect } from 'vitest';
import { speedAverage } from '../../web/src/components/sessions/turn-speed-format';
import { formatModelName } from '../../web/src/utils/model-name';

const name = (m: string) => formatModelName(m) || undefined;

describe('average speed', () => {
  const totals = {
    'openai.gpt-6.2-sol': { outputTokens: 12_800, generationMs: 100_000, turns: 42 },
    'claude-opus-5-5': { outputTokens: 3_000, generationMs: 20_000, turns: 3 },
    'claude-opus-5-5[1m]': { outputTokens: 1_000, generationMs: 20_000, turns: 1 },
  };

  const tps = (...args: Parameters<typeof speedAverage>) => speedAverage(...args)?.tps ?? null;

  it('reads the model\'s own entry', () => {
    expect(speedAverage(totals, 'openai.gpt-6.2-sol')).toEqual({ tps: '128 tok/s', turns: 42 });
    expect(tps(totals, 'claude-opus-5-5', name)).toBe('150 tok/s');
  });

  it('another window of the same version sums its entries; an alias or another model matches none', () => {
    expect(speedAverage(totals, 'global.anthropic.claude-opus-5-5', name)).toEqual({ tps: '100 tok/s', turns: 4 });
    // "opus" does not say which version ran: no Opus version's average is its.
    expect(tps({ ...totals, 'claude-opus-5-1': { outputTokens: 9_000, generationMs: 10_000, turns: 9 } }, 'opus', name)).toBeNull();
    expect(tps(totals, 'claude-sonnet-5-5', name)).toBeNull();
  });

  it('nothing counted yet reads null, so the toggle shows the last turn', () => {
    expect(tps(undefined, 'claude-opus-5-5')).toBeNull();
    expect(tps(totals, undefined)).toBeNull();
    expect(tps({ m: { outputTokens: 10, generationMs: 100, turns: 1 } }, 'm')).toBeNull();
  });
});
