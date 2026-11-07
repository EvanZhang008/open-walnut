/**
 * The session model panel's two faults of 2026-11-06 (the user's Mac app, an Opus 5.5 session):
 * "Context 324.4K / 200K (162%)" on a model with a 1M window, and "Default (Opus 5.5)", "Opus 5.5"
 * and a ticked "Opus 5.5" in one model list.
 *
 * The catalog below is the one the session's CLI answered that day (GET /api/sessions/:id/models).
 */
import { describe, it, expect } from 'vitest';
import { sessionContextWindow } from '../../web/src/hooks/useSessionUsage';
import { oneRowPerModel, rowNamedLike, modelIdentity } from '../../web/src/components/sessions/model-row-dedupe';
import { catalogRowLabel } from '../../web/src/components/sessions/ModelPicker';
import { matchSessionModelCatalogEntry, sessionModelsAsCatalog, type SessionModelCatalogEntry } from '../../src/core/types';

const row = (value: string, resolvedModel: string, displayName: string): SessionModelCatalogEntry =>
  ({ value, resolvedModel, displayName });

const EVAN: SessionModelCatalogEntry[] = [
  row('default', 'global.anthropic.claude-opus-5-5', 'Default'),
  row('opus', 'global.anthropic.claude-opus-5-5', 'Opus 5.5'),
  row('global.anthropic.claude-fable-5-1[1m]', 'global.anthropic.claude-fable-5-1', 'Fable'),
  row('haiku', 'global.anthropic.claude-haiku-5-5', 'Haiku 5.5'),
  row('gpt-6-astra', 'gpt-6-astra', 'GPT-6 Astra'),
  row('gpt-6.1-sol', 'gpt-6.1-sol', 'GPT-6.1 Sol'),
  row('gpt-6-luna', 'gpt-6-luna', 'GPT-6 Luna'),
  row('claude-opus-5-5', 'claude-opus-5-5', 'Opus 5.5'),
];

/** What the picker lists for a session running `live`, as labels, a tick on the running row. */
function picked(models: SessionModelCatalogEntry[], live: string): string[] {
  const active = matchSessionModelCatalogEntry(models, live) ?? rowNamedLike(models, live);
  return oneRowPerModel(models, active?.value).map((m) => `${catalogRowLabel(m)}${m.value === active?.value ? ' ✓' : ''}`);
}

describe('one row per model', () => {
  it('the incident catalog lists Opus 5.5 once, on the row the session runs', () => {
    expect(picked(EVAN, 'claude-opus-5-5')).toEqual([
      'Fable 5.1', 'Haiku 5.5', 'GPT-6 Astra', 'GPT-6.1 Sol', 'GPT-6 Luna', 'Opus 5.5 ✓',
    ]);
    expect(picked(EVAN, 'global.anthropic.claude-opus-5-5')).toEqual([
      'Opus 5.5 ✓', 'Fable 5.1', 'Haiku 5.5', 'GPT-6 Astra', 'GPT-6.1 Sol', 'GPT-6 Luna',
    ]);
    // Running another model: the alias row stands for Opus 5.5, never the Default row.
    expect(picked(EVAN, 'gpt-6-luna').filter((l) => l.startsWith('Opus') || l.startsWith('Default'))).toEqual(['Opus 5.5']);
  });

  it('a 1M variant stays its own model', () => {
    const models = [row('opus', 'claude-opus-4-8', 'Opus'), row('opus-1m', 'claude-opus-4-8[1m]', 'Opus 1M')];
    expect(picked(models, 'opus')).toEqual(['Opus 4.8 ✓', 'Opus 4.8 1M']);
  });

  it('a short id of a listed model runs that row instead of drawing its own', () => {
    const models = [row('global.anthropic.claude-fable-5[1m]', 'global.anthropic.claude-fable-5[1m]', 'Fable')];
    expect(rowNamedLike(models, 'claude-fable-5[1m]')?.value).toBe('global.anthropic.claude-fable-5[1m]');
    expect(rowNamedLike(models, 'us.anthropic.claude-sonnet-4-6[1m]')).toBeNull();
  });

  it('a row asking for 1M stays apart from the plain row, even when its resolvedModel drops the marker', () => {
    const models = [
      row('global.anthropic.claude-fable-5-1', 'global.anthropic.claude-fable-5-1', 'Fable'),
      row('global.anthropic.claude-fable-5-1[1m]', 'global.anthropic.claude-fable-5-1', 'Fable'),
    ];
    expect(oneRowPerModel(models)).toHaveLength(2);
    expect(rowNamedLike(models, 'claude-fable-5-1[1m]')?.value).toBe('global.anthropic.claude-fable-5-1[1m]');
  });

  it('keeps a row that can be picked over a disabled one naming the same model', () => {
    const models = [
      { ...row('global.anthropic.claude-opus-5-5', 'global.anthropic.claude-opus-5-5', 'Opus'), disabled: true },
      row('opus', 'global.anthropic.claude-opus-5-5', 'Opus 5.5'),
    ];
    expect(oneRowPerModel(models).map((m) => m.value)).toEqual(['opus']);
    expect(rowNamedLike(models, 'claude-opus-5-5')?.value).toBe('opus');
  });

  it('rows that name no version are never folded', () => {
    const models = [row('my-proxy', 'my-proxy', 'Proxy'), row('my-proxy-2', 'my-proxy', 'Proxy')];
    expect(modelIdentity(models[0])).toBeNull();
    expect(oneRowPerModel(models)).toHaveLength(2);
    // The degraded fallback catalog (bare aliases, no resolvedModel) is untouched.
    const fallback = sessionModelsAsCatalog();
    expect(oneRowPerModel(fallback)).toEqual(fallback);
  });
});

describe('the window a page shows with no live reading', () => {
  it('a stored 200K under a session holding more reads 1M', () => {
    const w = (...a: Parameters<typeof sessionContextWindow>) => sessionContextWindow(...a)?.window ?? null;
    expect(w(200_000, 'claude-opus-5-5', 324_400)).toBe(1_000_000);
    // ... and under a session whose auto-compact point is past 200K.
    expect(w(200_000, 'claude-opus-5-5', 50_000, 500_000)).toBe(1_000_000);
    expect(w(1_000_000, 'claude-opus-5-5', 324_400)).toBe(1_000_000);
    expect(w(200_000, 'claude-opus-4-8', 120_000)).toBe(200_000);
    // A proxy model is lifted to what it holds, never to a made-up 1M.
    expect(w(128_000, 'gpt-6.1-sol', 300_000)).toBe(300_000);
    expect(w(undefined, 'gpt-6.1-sol', 300_000)).toBeNull();
    expect(w(undefined, 'claude-sonnet-4-6', 250_000)).toBe(1_000_000);
    // The server's rule: a model with 1M built in reads 1M with nothing stored and few tokens.
    expect(w(undefined, 'claude-opus-5-5', 100_000)).toBe(1_000_000);
    expect(w(undefined, 'global.anthropic.claude-haiku-5-5', 0)).toBe(1_000_000);
    expect(w(undefined, 'claude-sonnet-4-6[1m]', 0)).toBe(1_000_000);
  });

  it('only a stored window the CLI reported, and not lifted, is exact', () => {
    expect(sessionContextWindow(1_000_000, 'claude-opus-5-5', 324_400, null, 'cli-model-usage')).toEqual({ window: 1_000_000, estimate: false });
    expect(sessionContextWindow(400_000, 'gpt-6.1-sol', 1_000, null, 'engine')).toEqual({ window: 400_000, estimate: false });
    // No source (an older Walnut), a name guess, a floor: estimates.
    expect(sessionContextWindow(1_000_000, 'claude-opus-5-5', 1_000)?.estimate).toBe(true);
    expect(sessionContextWindow(200_000, 'claude-opus-5-5', 1_000, null, 'model-string')?.estimate).toBe(true);
    expect(sessionContextWindow(undefined, 'claude-opus-5-5', 1_000)?.estimate).toBe(true);
    // An exact 200K that the session outgrew is lifted, and so no longer exact.
    expect(sessionContextWindow(200_000, 'claude-opus-4-8', 300_000, null, 'cli-model-usage')).toEqual({ window: 1_000_000, estimate: true });
  });
});
