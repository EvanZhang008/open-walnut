/**
 * Settings › Sessions: "Share new tasks" (EngineSplitRow). The save must keep every sibling of
 * `defaults` (updateConfig replaces the whole key) and must not drop what the row does not
 * show: an entry's weight, and an entry that names a model.
 */
import { describe, it, expect } from 'vitest';
import type { Config } from '@open-walnut/core';
import { engineSplitSave, entryKey, entryOfKey, splitChecked, splitModelEntries, splitSize } from '@/components/settings/sections/engine-split-select';

const ORDER = ['claude', 'codex', 'opencode'];
const cfg = (engine_split?: unknown): Pick<Config, 'defaults'> =>
  ({ defaults: { priority: 'high', project: 'Marina', engine: 'codex', ...(engine_split !== undefined ? { engine_split } : {}) } } as Pick<Config, 'defaults'>);

describe('engine split settings', () => {
  it('reads every entry: plain engines in catalog order, then the model entries in config order', () => {
    expect(splitChecked(cfg(), ORDER)).toBe('');
    expect(splitChecked(cfg(['codex', { engine: 'claude', weight: 2 }, { engine: 'claude', model: 'gpt-6.1-sol' }]), ORDER)).toBe('claude,codex,claude:gpt-6.1-sol');
  });

  it('saves with every sibling of defaults kept, and weights kept', () => {
    const before = cfg([{ engine: 'claude', weight: 2 }, { engine: 'claude', model: 'gpt-6.1-sol' }]);
    const out = engineSplitSave(before, 'claude,codex,claude:gpt-6.1-sol', ORDER) as Pick<Config, 'defaults'>;
    expect(out.defaults).toMatchObject({ priority: 'high', project: 'Marina', engine: 'codex' });
    expect(out.defaults.engine_split).toEqual([{ engine: 'claude', weight: 2 }, { engine: 'codex' }, { engine: 'claude', model: 'gpt-6.1-sol' }]);
    // Unchecking a model entry removes it; turning the split off clears every entry.
    expect((engineSplitSave(before, 'claude', ORDER) as Pick<Config, 'defaults'>).defaults.engine_split).toEqual([{ engine: 'claude', weight: 2 }]);
    expect((engineSplitSave(before, '', ORDER) as Pick<Config, 'defaults'>).defaults.engine_split).toEqual([]);
  });

  it('adds an entry on a model, keyed as the split keys it (a model id may hold a colon)', () => {
    expect(entryKey({ engine: 'claude', model: 'sonnet' })).toBe('claude:sonnet');
    expect(entryOfKey('claude:us.vendor.model-v1:0')).toEqual({ engine: 'claude', model: 'us.vendor.model-v1:0' });
    const out = engineSplitSave(cfg(['claude']), 'claude,claude:sonnet', ORDER) as Pick<Config, 'defaults'>;
    expect(out.defaults.engine_split).toEqual([{ engine: 'claude' }, { engine: 'claude', model: 'sonnet' }]);
    expect(splitModelEntries(out)).toHaveLength(1);
  });

  it('counts every entry toward turning the split on', () => {
    expect(splitSize('claude,claude:gpt-6.1-sol')).toBe(2);
    expect(splitSize('claude')).toBe(1);
    expect(splitSize('')).toBe(0);
  });
});
