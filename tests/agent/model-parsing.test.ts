/**
 * Tests for model string parsing, sanitization, and context window detection.
 *
 * These functions sit on the critical path between Claude CLI output and
 * the UI displaying context window usage %. A bug here silently produces
 * wrong numbers (e.g. 125% instead of 25%) with no error — hence the
 * thorough coverage.
 *
 * Key invariant: the [1m] context-window marker must NEVER be stripped
 * by ANSI-cleaning code. ANSI bold is `\x1b[1m` (with ESC prefix);
 * Claude Code's context marker is a bare `[1m]` suffix (no ESC).
 *
 * Two SEPARATE window layers — do not conflate them (these tests cover the first):
 *  1. API side (getContextWindowSize, catalog-driven since dd16928): the window comes
 *     from MODEL_CATALOG[].context_window keyed by catalog id. `[1m]` is meaningless here.
 *  2. CLI side (claude-code-session.ts / web useSessionUsage.ts): a spawned `claude -p`
 *     session's window, where the CLI's `[1m]` marker IS authoritative.
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeInitModel,
  CONTEXT_WINDOW_1M,
  CONTEXT_WINDOW_DEFAULT,
} from '../../src/agent/providers/defaults.js';
import { getContextWindowSize } from '../../src/agent/model.js';

// Catalog IDs, not decorated strings — getContextWindowSize resolves through
// MODEL_CATALOG. Kept as named constants so a catalog rename fails loudly here.
const CATALOG_1M_VARIANT = 'global.anthropic.claude-opus-4-6-v1-1m'; // 1M via context-1m beta
const CATALOG_1M_NATIVE = 'global.anthropic.claude-opus-5';         // natively 1M, no beta
const CATALOG_200K = 'global.anthropic.claude-opus-4-6-v1';         // plain variant = 200K

// ── sanitizeInitModel ──

describe('sanitizeInitModel', () => {
  describe('clean model strings (no ANSI)', () => {
    it('preserves plain Bedrock model ID', () => {
      expect(sanitizeInitModel('global.anthropic.claude-opus-4-6-v1'))
        .toBe('global.anthropic.claude-opus-4-6-v1');
    });

    it('preserves model with [1m] context marker', () => {
      expect(sanitizeInitModel('global.anthropic.claude-opus-4-6-v1[1m]'))
        .toBe('global.anthropic.claude-opus-4-6-v1[1m]');
    });

    it('preserves short model ID', () => {
      expect(sanitizeInitModel('claude-opus-4-6'))
        .toBe('claude-opus-4-6');
    });

    it('preserves sonnet model', () => {
      expect(sanitizeInitModel('global.anthropic.claude-sonnet-4-6-v1'))
        .toBe('global.anthropic.claude-sonnet-4-6-v1');
    });

    it('preserves haiku model', () => {
      expect(sanitizeInitModel('claude-haiku-4-5-20251001'))
        .toBe('claude-haiku-4-5-20251001');
    });

    it('preserves model with [1m] and different versions', () => {
      expect(sanitizeInitModel('global.anthropic.claude-sonnet-4-6-v1[1m]'))
        .toBe('global.anthropic.claude-sonnet-4-6-v1[1m]');
    });
  });

  describe('ANSI escape stripping', () => {
    it('strips \\x1b[1m (bold) from end — THE bug that caused 125%', () => {
      // Claude CLI sometimes appends ANSI bold to the model field
      expect(sanitizeInitModel('global.anthropic.claude-opus-4-6-v1\x1b[1m'))
        .toBe('global.anthropic.claude-opus-4-6-v1');
    });

    it('strips \\x1b[0m (reset) from end', () => {
      expect(sanitizeInitModel('global.anthropic.claude-opus-4-6-v1\x1b[0m'))
        .toBe('global.anthropic.claude-opus-4-6-v1');
    });

    it('strips multiple ANSI sequences', () => {
      expect(sanitizeInitModel('\x1b[1mglobal.anthropic.claude-opus-4-6-v1\x1b[0m'))
        .toBe('global.anthropic.claude-opus-4-6-v1');
    });

    it('strips ANSI color codes', () => {
      expect(sanitizeInitModel('\x1b[32mglobal.anthropic.claude-opus-4-6-v1\x1b[0m'))
        .toBe('global.anthropic.claude-opus-4-6-v1');
    });

    it('strips ANSI but preserves [1m] context marker', () => {
      // Critical: model has BOTH real ANSI and a [1m] suffix
      expect(sanitizeInitModel('\x1b[1mglobal.anthropic.claude-opus-4-6-v1[1m]\x1b[0m'))
        .toBe('global.anthropic.claude-opus-4-6-v1[1m]');
    });

    it('strips \\x1b[1m before [1m] suffix — ANSI bold wrapping 1M model', () => {
      expect(sanitizeInitModel('global.anthropic.claude-opus-4-6-v1\x1b[1m[1m]'))
        .toBe('global.anthropic.claude-opus-4-6-v1[1m]');
    });
  });

  describe('validation — rejects malformed strings', () => {
    it('rejects orphan ] (the exact bug: second regex stripped [1m, left ])', () => {
      expect(sanitizeInitModel('global.anthropic.claude-opus-4-6-v1]'))
        .toBeUndefined();
    });

    it('rejects unknown bracket suffix like [2m]', () => {
      expect(sanitizeInitModel('global.anthropic.claude-opus-4-6-v1[2m]'))
        .toBeUndefined();
    });

    it('rejects orphan [', () => {
      expect(sanitizeInitModel('global.anthropic.claude-opus-4-6-v1['))
        .toBeUndefined();
    });

    it('rejects strings with spaces', () => {
      expect(sanitizeInitModel('claude opus 4-6'))
        .toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(sanitizeInitModel(''))
        .toBeUndefined();
    });
  });
});

// NB: the `stripModelSuffix` describe block was deleted. That helper was removed in
// dd16928 ("catalog-driven model resolution") — the adapters no longer strip a suffix
// off the model before the API call, because resolveForCall() now maps a catalog id to
// its real API id via ModelEntry.model_id. Nothing imports it; the tests only proved a
// deleted regex still worked.

// ── getContextWindowSize ──

describe('getContextWindowSize', () => {
  it('returns 1M for the catalog 1M variant', () => {
    expect(getContextWindowSize(CATALOG_1M_VARIANT))
      .toBe(CONTEXT_WINDOW_1M);
  });

  it('returns 1M for a natively-1M catalog model (Opus 5 — no -1m variant exists)', () => {
    expect(getContextWindowSize(CATALOG_1M_NATIVE))
      .toBe(CONTEXT_WINDOW_1M);
  });

  it('returns 200K for the plain (non-1M) catalog variant', () => {
    expect(getContextWindowSize(CATALOG_200K))
      .toBe(CONTEXT_WINDOW_DEFAULT);
  });

  it('returns 200K for a [1m]-decorated string — that is a CLI marker, not a catalog id', () => {
    // The API-side helper is catalog-driven (dd16928): `[1m]` is the Claude CLI's own
    // display/resume marker and never appears in a catalog id, so it resolves as unknown
    // → 200K. CLI-side session windows are computed separately (claude-code-session.ts /
    // useSessionUsage.ts), which is where the [1m] marker IS still honoured.
    expect(getContextWindowSize(`${CATALOG_200K}[1m]`))
      .toBe(CONTEXT_WINDOW_DEFAULT);
  });

  it('returns 200K for undefined', () => {
    expect(getContextWindowSize(undefined))
      .toBe(CONTEXT_WINDOW_DEFAULT);
  });

  it('returns 200K for malformed orphan-] model', () => {
    // This is what the bug produced: the ] left behind after bad stripping
    expect(getContextWindowSize('global.anthropic.claude-opus-4-6-v1]'))
      .toBe(CONTEXT_WINDOW_DEFAULT);
  });

  // ── totalInput auto-upgrade to 1M ──
  // ⚠️ REGRESSION GUARD: observed usage must OUTRANK the catalog label. A catalog-first
  // early return (the shape between dd16928 and this fix) disables the net for every
  // catalogued model — i.e. nearly all of them — and reinstates the 434% bug.

  it('auto-upgrades a CATALOGUED 200K model when totalInput exceeds its window', () => {
    // A resume that lost the '-1m' variant id still reports its real usage; 868K tokens
    // cannot fit a 200K window, so the window is the truth and the label is stale.
    expect(getContextWindowSize(CATALOG_200K, 868_000))
      .toBe(CONTEXT_WINDOW_1M);
  });

  it('auto-upgrades an UNKNOWN model when totalInput exceeds 200K', () => {
    expect(getContextWindowSize('vendor/model-not-in-catalog', 868_000))
      .toBe(CONTEXT_WINDOW_1M);
  });

  it('stays 200K when totalInput fits the catalog window', () => {
    expect(getContextWindowSize(CATALOG_200K, 150_000))
      .toBe(CONTEXT_WINDOW_DEFAULT);
  });

  it('stays 1M for a 1M catalog model even when totalInput is low', () => {
    expect(getContextWindowSize(CATALOG_1M_VARIANT, 50_000))
      .toBe(CONTEXT_WINDOW_1M);
  });

  it('auto-upgrades when model is undefined but totalInput > 200K', () => {
    expect(getContextWindowSize(undefined, 300_000))
      .toBe(CONTEXT_WINDOW_1M);
  });

  it('never DOWNGRADES a >1M catalog window (gpt-5.4 is 1.05M)', () => {
    // Math.max guard: a 1.04M prompt exceeds nothing here, but if the net ever fires on
    // an above-1M model it must not clamp the window down to a flat 1M.
    expect(getContextWindowSize('gpt-5.4')).toBe(1_050_000);
    expect(getContextWindowSize('gpt-5.4', 1_060_000)).toBe(1_050_000);
  });
});

// ── Context % math ──
//
// These lock in the DENOMINATOR, which is where the 125%/434% display bugs lived.
// They no longer chain sanitizeInitModel() into getContextWindowSize(): those are two
// different layers and that composition never happens in production. sanitizeInitModel's
// output lands in ClaudeCodeSession._initModel, which feeds the CLI-side `is1M` check
// (claude-code-session.ts) — NOT the catalog-driven API-side helper tested here.

describe('context % math (denominator regressions)', () => {
  it('249K tokens on a 1M catalog model = 25%, not 125%', () => {
    const windowSize = getContextWindowSize(CATALOG_1M_VARIANT);
    const totalInput = 249_366;
    expect(Math.round(totalInput / windowSize * 100)).toBe(25);
    // The bug would produce: 249366/200000*100 = 125
    expect(Math.round(totalInput / CONTEXT_WINDOW_DEFAULT * 100)).toBe(125);
  });

  it('resume lost the 1M variant id but totalInput auto-corrects — 868K = 87%, not 434%', () => {
    // Simulates: session started on the '-1m' catalog id, a later resume reported the
    // plain 200K id. Observed usage (868K) is impossible in a 200K window → upgrade.
    const totalInput = 868_000;
    const windowSize = getContextWindowSize(CATALOG_200K, totalInput);
    expect(windowSize).toBe(CONTEXT_WINDOW_1M);
    expect(Math.round(totalInput / windowSize * 100)).toBe(87);
    // The old bug would produce: 868000/200000*100 = 434
    expect(Math.round(totalInput / CONTEXT_WINDOW_DEFAULT * 100)).toBe(434);
  });

  it('sanitized-but-uncatalogued init strings fall back to 200K rather than throwing', () => {
    // A CLI init string is NOT a catalog id; the helper must degrade quietly to the
    // default window (the caller supplies totalInput when it has one).
    const sanitized = sanitizeInitModel('\x1b[1mglobal.anthropic.claude-opus-4-6-v1[1m]\x1b[0m');
    expect(sanitized).toBe('global.anthropic.claude-opus-4-6-v1[1m]');
    expect(getContextWindowSize(sanitized)).toBe(CONTEXT_WINDOW_DEFAULT);
  });
});
