import { describe, it, expect } from 'vitest';
import {
  resolveContextWindow, shortModelId, isRecognizedClaudeModel,
  rememberAutoCompactWindow, recallAutoCompactWindow,
  rememberEnvMaxContextTokens, recallEnvMaxContextTokens,
  rememberModelWindow, recallModelWindow, resetContextWindowCaches,
  ANTHROPIC_DEFAULT_WINDOW, EXTENDED_WINDOW,
} from '../../src/providers/context-window.js';

// The percentages this module decides are the ones on the session badge. The
// incident it exists for (inc-1787517631989-wpy5i3, 2026-08-23): one session on
// a custom proxy model showed 70% → 25% → 10% as three different denominators
// arrived, and 9% on the badge next to "99.4K / 400K (25%)" in the picker.
//
// The denominator is the MODEL'S ABSOLUTE MAX. The auto-compact window is a
// setting, not a property of the model, so it never moves this number.

describe('resolveContextWindow', () => {
  it('prefers the window the CLI itself reported for this model', () => {
    // result.modelUsage[model].contextWindow. Live-verified on 2.1.240: 1M for
    // gpt-5.6-sol, opus-5[1m] and fable[1m] alike.
    expect(resolveContextWindow({
      cliModelWindow: 1_000_000,
      hostModelWindow: 400_000,
      envMaxContextTokens: 272_000,
      model: 'gpt-5.6-sol',
      observedTokens: 99_366,
    })).toEqual({ window: 1_000_000, source: 'cli-model-usage' });
  });

  it('an auto-compact clamp does NOT shrink the denominator', () => {
    // The reversal: 99K of a 1M model is 10%, whatever the compact setting says.
    // Folding the clamp in is what made the badge and the picker disagree.
    const resolved = resolveContextWindow({ cliModelWindow: 1_000_000, model: 'claude-fable-5[1m]' });
    expect(resolved?.window).toBe(1_000_000);
  });

  it('falls back to what an earlier session on this host+model learned', () => {
    expect(resolveContextWindow({ hostModelWindow: 1_000_000, model: 'gpt-5.6-sol' }))
      .toEqual({ window: 1_000_000, source: 'host-model-cache' });
  });

  it('uses CLAUDE_CODE_MAX_CONTEXT_TOKENS for a model the CLI does not recognize', () => {
    // The CLI's own words for an unrecognized model: "set
    // CLAUDE_CODE_MAX_CONTEXT_TOKENS to its real window".
    expect(resolveContextWindow({ envMaxContextTokens: 1_000_000, model: 'gpt-5.6-sol' }))
      .toEqual({ window: 1_000_000, source: 'env-max-tokens' });
  });

  it('IGNORES that env var for a recognized Claude model — the CLI does too', () => {
    // Trusting it here would invent a 1M window for a 200K model.
    expect(resolveContextWindow({ envMaxContextTokens: 1_000_000, model: 'claude-sonnet-4-6' }))
      .toEqual({ window: ANTHROPIC_DEFAULT_WINDOW, source: 'model-string' });
    expect(resolveContextWindow({ envMaxContextTokens: 1_000_000, model: 'global.anthropic.claude-fable-5[1m]' }))
      .toEqual({ window: EXTENDED_WINDOW, source: 'model-string' });
  });

  it('returns NOTHING for a custom model with no CLI-sourced window', () => {
    // The regression: an Anthropic-shaped 200K guess made 99K read as 50%,
    // which collapsed to 10% one turn later. No number beats a wrong number.
    expect(resolveContextWindow({ model: 'gpt-5.6-sol', observedTokens: 99_366 })).toBeNull();
    expect(resolveContextWindow({ model: 'bedrock_mantle/openai.gpt-5.6-sol' })).toBeNull();
    expect(resolveContextWindow({})).toBeNull();
  });

  it('reads the [1m] marker, and the 200K default for plain Anthropic ids', () => {
    expect(resolveContextWindow({ model: 'claude-sonnet-4-6[1m]' }))
      .toEqual({ window: EXTENDED_WINDOW, source: 'model-string' });
    expect(resolveContextWindow({ model: 'claude-sonnet-4-6' }))
      .toEqual({ window: ANTHROPIC_DEFAULT_WINDOW, source: 'model-string' });
    // Family name without the "claude-" prefix still reads as Anthropic.
    expect(resolveContextWindow({ model: 'opus[1m]' }))
      .toEqual({ window: EXTENDED_WINDOW, source: 'model-string' });
  });

  it('trusts observed tokens over a lost [1m] suffix', () => {
    expect(resolveContextWindow({ model: 'claude-sonnet-4-6', observedTokens: 250_000 })?.window)
      .toBe(EXTENDED_WINDOW);
  });

  it('ignores zero / negative / non-finite windows', () => {
    expect(resolveContextWindow({ cliModelWindow: 0, hostModelWindow: 1_000_000 })?.source)
      .toBe('host-model-cache');
    expect(resolveContextWindow({ cliModelWindow: Number.NaN, model: 'claude-sonnet-4-6' })?.source)
      .toBe('model-string');
    expect(resolveContextWindow({ envMaxContextTokens: -1, model: 'gpt-5.6-sol' })).toBeNull();
  });
});

describe('isRecognizedClaudeModel', () => {
  it('sees through transport / region / provider decoration', () => {
    expect(isRecognizedClaudeModel('global.anthropic.claude-opus-5[1m]')).toBe(true);
    expect(isRecognizedClaudeModel('bedrock_mantle/openai.gpt-5.6-sol')).toBe(false);
    expect(isRecognizedClaudeModel('fable')).toBe(true);
    expect(isRecognizedClaudeModel(undefined)).toBe(false);
  });
});

describe('host+model window cache', () => {
  // The exact window only arrives at a turn END, so without this cache every
  // session spends its first turn on a guess (or, for a proxy model, on no
  // percentage) and then jumps.
  it('answers for later sessions on the same host+model only', () => {
    resetContextWindowCaches();
    expect(recallModelWindow(null, 'gpt-5.6-sol')).toBeUndefined();
    rememberModelWindow(null, 'gpt-5.6-sol', 1_000_000);
    expect(recallModelWindow(null, 'gpt-5.6-sol')).toBe(1_000_000);
    expect(recallModelWindow(null, 'GPT-5.6-SOL')).toBe(1_000_000); // case-insensitive
    expect(recallModelWindow('clouddev', 'gpt-5.6-sol')).toBeUndefined();
    expect(recallModelWindow(null, 'claude-sonnet-4-6')).toBeUndefined();
  });

  it('ignores nonsense and a missing model', () => {
    resetContextWindowCaches();
    rememberModelWindow(null, 'x', 0);
    rememberModelWindow(null, undefined, 1_000_000);
    expect(recallModelWindow(null, 'x')).toBeUndefined();
    expect(recallModelWindow(null, undefined)).toBeUndefined();
  });
});

describe('CLAUDE_CODE_MAX_CONTEXT_TOKENS cache (host-scoped)', () => {
  it('shares per host', () => {
    resetContextWindowCaches();
    rememberEnvMaxContextTokens(null, 1_000_000);
    expect(recallEnvMaxContextTokens(null)).toBe(1_000_000);
    expect(recallEnvMaxContextTokens('clouddev')).toBeUndefined();
  });
});

describe('auto-compact clamp cache (host-scoped)', () => {
  // Live WS capture right after a server restart: one fable[1m] session reported
  // window 1000000 (20%) while another reported 400000 (89%) — the second had
  // completed its get_settings read, the first had not. The clamp is a HOST
  // property, so the first read answers for every session on that host.
  it('shares a clamp across sessions on the same host, and only that host', () => {
    resetContextWindowCaches();
    expect(recallAutoCompactWindow(null)).toBeUndefined();
    rememberAutoCompactWindow(null, 400_000);
    expect(recallAutoCompactWindow(null)).toBe(400_000);
    expect(recallAutoCompactWindow(undefined)).toBe(400_000); // undefined ≡ local
    expect(recallAutoCompactWindow('clouddev')).toBeUndefined(); // remote is separate
    rememberAutoCompactWindow('clouddev', 200_000);
    expect(recallAutoCompactWindow('clouddev')).toBe(200_000);
    expect(recallAutoCompactWindow(null)).toBe(400_000);
  });

  it('ignores a nonsense clamp', () => {
    resetContextWindowCaches();
    rememberAutoCompactWindow(null, 0);
    rememberAutoCompactWindow(null, Number.NaN);
    rememberAutoCompactWindow(null, -5);
    expect(recallAutoCompactWindow(null)).toBeUndefined();
  });
});

describe('shortModelId', () => {
  it('keeps a version dot inside the model id', () => {
    // The old rule was `replace(/^.*\./, '')` — greedy, so it ate "gpt-5." and
    // the composer badge read "6-sol 9%" (2026-08-23 screenshot).
    expect(shortModelId('gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(shortModelId('openai.gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(shortModelId('bedrock_mantle/openai.gpt-5.6-sol')).toBe('gpt-5.6-sol');
  });

  it('strips region + provider prefixes and the revision suffix, keeping [1m]', () => {
    expect(shortModelId('global.anthropic.claude-fable-5[1m]')).toBe('claude-fable-5[1m]');
    expect(shortModelId('us.anthropic.claude-opus-4-6-v1')).toBe('claude-opus-4-6');
    expect(shortModelId('us.anthropic.claude-sonnet-4-6-v1:0')).toBe('claude-sonnet-4-6');
    expect(shortModelId('us.anthropic.claude-opus-4-6-v1[1m]')).toBe('claude-opus-4-6[1m]');
    expect(shortModelId('us-gov-west-1.anthropic.claude-opus-4-6')).toBe('claude-opus-4-6');
  });

  it('leaves anything it does not recognize alone', () => {
    expect(shortModelId('claude-haiku-4-5')).toBe('claude-haiku-4-5');
    expect(shortModelId('my-lab.custom-model-2.1')).toBe('my-lab.custom-model-2.1');
    expect(shortModelId('default')).toBe('default');
  });
});
