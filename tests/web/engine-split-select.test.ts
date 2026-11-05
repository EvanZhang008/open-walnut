/**
 * Settings › Sessions: "Share new tasks" (EngineSplitRow). The save must keep every sibling of
 * `defaults` (updateConfig replaces the whole key) and must not drop what the row does not
 * show: an entry's weight, and an entry that names a model.
 */
import { describe, it, expect } from 'vitest';
import type { Config } from '@open-walnut/core';
import { engineSplitSave, splitChecked, splitModelEntries, splitSize } from '@/components/settings/sections/engine-split-select';

const ORDER = ['claude', 'codex', 'opencode'];
const cfg = (engine_split?: unknown): Pick<Config, 'defaults'> =>
  ({ defaults: { priority: 'high', project: 'Marina', engine: 'codex', ...(engine_split !== undefined ? { engine_split } : {}) } } as Pick<Config, 'defaults'>);

describe('engine split settings', () => {
  it('reads the checked engines in catalog order, strings and entries alike', () => {
    expect(splitChecked(cfg(), ORDER)).toBe('');
    expect(splitChecked(cfg(['codex', { engine: 'claude', weight: 2 }, { engine: 'claude', model: 'gpt-6.1-sol' }]), ORDER)).toBe('claude,codex');
  });

  it('saves with every sibling of defaults kept, weights and model entries kept', () => {
    const before = cfg([{ engine: 'claude', weight: 2 }, { engine: 'claude', model: 'gpt-6.1-sol' }]);
    const out = engineSplitSave(before, 'claude,codex', ORDER) as Pick<Config, 'defaults'>;
    expect(out.defaults).toMatchObject({ priority: 'high', project: 'Marina', engine: 'codex' });
    expect(out.defaults.engine_split).toEqual([{ engine: 'claude', weight: 2 }, { engine: 'codex' }, { engine: 'claude', model: 'gpt-6.1-sol' }]);
    const off = engineSplitSave(before, '', ORDER) as Pick<Config, 'defaults'>;
    expect(off.defaults.engine_split).toEqual([{ engine: 'claude', model: 'gpt-6.1-sol' }]);
  });

  it('counts model entries toward turning the split on', () => {
    const c = cfg([{ engine: 'claude', model: 'gpt-6.1-sol' }]);
    expect(splitModelEntries(c)).toHaveLength(1);
    expect(splitSize('claude', c)).toBe(2);
    expect(splitSize('claude', cfg())).toBe(1);
  });
});
