/**
 * Every model row of the picker reads as a model's name, never as its raw id.
 *
 * 2026-11-21, the user's Opus 5.5 session at 1280 px: the model list showed "opus-5-5 1M" (the
 * synthetic row for the running model, named by stripping the id) beside "Opus 1M". The class:
 * any path that labels a row from an id (catalogRowLabel for catalog rows, shortModelLabel for
 * the running model's row, the mismatch line and the capability note). Each id shape the CLI and
 * the fallback registry send goes through both, and any label still shaped like an id fails.
 */
import { describe, it, expect } from 'vitest';
import { catalogRowLabel, shortModelLabel, effortTitle } from '../../web/src/components/sessions/ModelPicker';
import { shortAcpModelName, acpModelDisplayName } from '../../web/src/components/sessions/acp-model-id';
import { formatModelName } from '../../web/src/utils/model-name';
import type { SessionModelCatalogEntry } from '../../src/core/types';

/** Every shape of Claude-family id seen on the wire: bare, provider-prefixed, regional, dated, 1M. */
const IDS = [
  'opus', 'sonnet', 'haiku', 'fable', 'sonnet-1m', 'opus-1m',
  'claude-opus-5-5', 'opus-5-5', 'opus-5-5[1m]', 'claude-fable-5-2[1m]', 'claude-haiku-5-5-20261001',
  'global.anthropic.claude-opus-5-5', 'global.anthropic.claude-opus-5-5[1m]', 'us.anthropic.claude-sonnet-4-6[1m]',
  'us.anthropic.claude-sonnet-5-5-v1', 'global.anthropic.claude-fable-5-1-v2:0[1m]',
];

/** A lowercase model id ("claude-opus-5-5", "opus-5-5[1m]"), not a name a person reads. */
const RAW_MODEL_ID = /^[a-z0-9]+(?:[-_.][a-z0-9]+)+(?:\[1m\])?$/;

/** A label a person reads: no lowercase id, no provider prefix, no bracket, no "opus-5-5" version. */
function looksRaw(label: string): boolean {
  return RAW_MODEL_ID.test(label) || /claude-|anthropic\.|\[|\]/.test(label) || /^[a-z]+-\d/.test(label)
    || /[a-z]+-\d+-\d+/.test(label);
}

/** ACP ids as engines report them (provider prefix, effort in brackets or after a slash). */
const ACP_IDS = ['openai.gpt-6.2-sol[max]', 'openai.gpt-6-luna', 'gpt-5.6-sol[high]', 'anthropic/claude-sonnet-4-6/high', 'global.anthropic.claude-opus-5-5'];

const entry = (value: string, resolvedModel: string | undefined, displayName: string): SessionModelCatalogEntry =>
  ({ value, ...(resolvedModel ? { resolvedModel } : {}), displayName });

describe('model rows read as names', () => {
  it.each(IDS)('the running model %s is named, not printed', (id) => {
    const label = shortModelLabel(id);
    expect(looksRaw(label), `"${id}" reads "${label}"`).toBe(false);
  });

  it.each(IDS)('the composer pill names %s, not its id', (id) => {
    const label = formatModelName(id);
    expect(looksRaw(label), `"${id}" reads "${label}" on the pill`).toBe(false);
  });

  it.each(ACP_IDS)('an engine\'s model %s reads as a name on the pill and in the list', (id) => {
    for (const label of [shortAcpModelName(id), acpModelDisplayName(id) ?? '']) {
      expect(/anthropic\.|openai\.|\[|[a-z]+-\d+-\d+/.test(label), `"${id}" reads "${label}"`).toBe(false);
    }
  });

  it('an effort row says what its level does and when it applies', () => {
    expect(effortTitle('X-High', 'Extended exploration (select models only)'))
      .toBe('X-High: Extended exploration (select models only). Higher effort: more reasoning, slower and costlier; applies from the next message.');
    expect(effortTitle('Max')).toBe('Max. Higher effort: more reasoning, slower and costlier; applies from the next message.');
  });

  it('names the reported row by its version', () => {
    expect(shortModelLabel('global.anthropic.claude-opus-5-5[1m]')).toBe('Opus 5.5 1M');
    expect(shortModelLabel('us.anthropic.claude-sonnet-4-6[1m]')).toBe('Sonnet 4.6 1M');
    // A custom model with no family to name keeps its id, without the provider prefix.
    expect(shortModelLabel('mythos-1')).toBe('mythos-1');
  });

  it('every catalog row shape gets a name', () => {
    const rows: SessionModelCatalogEntry[] = [
      ...IDS.map((id) => entry(id, id, '')),
      ...IDS.map((id) => entry(id, undefined, id)),
      ...IDS.map((id) => entry(id, id, 'Opus')),
      entry('default', 'global.anthropic.claude-opus-5-5', 'Default'),
      entry('default', undefined, 'Default'),
      entry('opus', 'global.anthropic.claude-opus-5-5', 'Opus 5.5'),
    ];
    const raw = rows.map((r) => [r.value, r.displayName, catalogRowLabel(r)] as const).filter(([, , label]) => looksRaw(label) || /^[a-z]/.test(label));
    expect(raw).toEqual([]);
  });
});
