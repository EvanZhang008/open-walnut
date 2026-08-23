import { describe, it, expect } from 'vitest';
import {
  resolveContextWindow, shortModelId,
  rememberAutoCompactWindow, recallAutoCompactWindow, resetAutoCompactWindowCache,
  ANTHROPIC_DEFAULT_WINDOW, EXTENDED_WINDOW,
} from '../../src/providers/context-window.js';

// The percentages this module decides are the ones on the session badge. The
// incident it exists for (inc-1787517631989-wpy5i3, 2026-08-23): one session on
// a custom proxy model showed 70% → 25% → 10% as three different denominators
// arrived, and 9% on the badge next to "99.4K / 400K (25%)" in the picker.

describe('resolveContextWindow', () => {
  it('prefers the CLI effective window — the number /context divides by', () => {
    expect(resolveContextWindow({
      cliEffectiveWindow: 400_000,
      cliRawWindow: 1_000_000, // raw 1M must NOT win: the session compacts at 400K
      autoCompactWindow: 400_000,
      model: 'global.anthropic.claude-fable-5[1m]',
      observedTokens: 99_366,
    })).toEqual({ window: 400_000, source: 'cli-effective' });
  });

  it('clamps the raw model window with the auto-compact env', () => {
    expect(resolveContextWindow({
      cliRawWindow: 1_000_000, autoCompactWindow: 400_000, model: 'gpt-5.6-sol',
    })).toEqual({ window: 400_000, source: 'raw-clamped' });
  });

  it('uses the raw window verbatim when no clamp is configured', () => {
    expect(resolveContextWindow({ cliRawWindow: 1_000_000, model: 'gpt-5.6-sol' }))
      .toEqual({ window: 1_000_000, source: 'cli-raw' });
  });

  it('returns NOTHING for a custom model with no CLI-sourced window', () => {
    // The regression: an Anthropic-shaped 200K guess made 99K read as 50%,
    // which collapsed to 10% one turn later. No number beats a wrong number.
    expect(resolveContextWindow({ model: 'gpt-5.6-sol', observedTokens: 99_366 })).toBeNull();
    expect(resolveContextWindow({ model: 'bedrock_mantle/openai.gpt-5.6-sol' })).toBeNull();
    expect(resolveContextWindow({})).toBeNull();
  });

  it('falls back to the clamp alone for an unknown model (bounds the window)', () => {
    expect(resolveContextWindow({ model: 'gpt-5.6-sol', autoCompactWindow: 400_000, observedTokens: 99_366 }))
      .toEqual({ window: 400_000, source: 'clamp-only' });
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

  it('clamps the string guess too', () => {
    expect(resolveContextWindow({ model: 'claude-fable-5[1m]', autoCompactWindow: 400_000 }))
      .toEqual({ window: 400_000, source: 'model-clamped' });
    // A clamp ABOVE the model window never inflates it.
    expect(resolveContextWindow({ model: 'claude-sonnet-4-6', autoCompactWindow: 400_000 }))
      .toEqual({ window: ANTHROPIC_DEFAULT_WINDOW, source: 'model-clamped' });
  });

  it('trusts observed tokens over a lost [1m] suffix', () => {
    expect(resolveContextWindow({ model: 'claude-sonnet-4-6', observedTokens: 250_000 })?.window)
      .toBe(EXTENDED_WINDOW);
  });

  it('ignores zero / negative / non-finite windows', () => {
    expect(resolveContextWindow({ cliEffectiveWindow: 0, cliRawWindow: 1_000_000 })?.source).toBe('cli-raw');
    expect(resolveContextWindow({ cliEffectiveWindow: Number.NaN, model: 'claude-sonnet-4-6' })?.source)
      .toBe('model-string');
    expect(resolveContextWindow({ cliRawWindow: 1_000_000, autoCompactWindow: -1 })?.window)
      .toBe(1_000_000);
  });
});

describe('auto-compact clamp cache (host-scoped)', () => {
  // Live WS capture right after a server restart: one fable[1m] session reported
  // window 1000000 (20%) while another reported 400000 (89%) — the second had
  // completed its get_settings read, the first had not. The clamp is a HOST
  // property, so the first read answers for every session on that host.
  it('shares a clamp across sessions on the same host, and only that host', () => {
    resetAutoCompactWindowCache();
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
    resetAutoCompactWindowCache();
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
