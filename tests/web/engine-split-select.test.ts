/**
 * Settings › Sessions: "Share new tasks" (EngineSplitRow). The save must keep every sibling of
 * `defaults` (updateConfig replaces the whole key) and must not drop what the row does not
 * show: an entry's weight, and an entry that names a model.
 */
import { describe, it, expect } from 'vitest';
import type { Config } from '@open-walnut/core';
import { engineSplitProjectsSave, engineSplitSave, engineSplitSwitchSave, entryKey, entryOfKey, splitChecked, splitIsOff, splitModelEntries, splitProjectsOf, splitSize } from '@/components/settings/sections/engine-split-select';

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
    // Unchecking a model entry removes it; unchecking all clears the list.
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

  it('counts entries as the server reads them: a model on an ACP engine is no entry of its own', () => {
    const acp = new Set(['codex']);
    expect(splitSize('codex,codex:gpt-6.1-sol', acp)).toBe(1);
    expect(splitSize('claude,codex:gpt-6.1-sol', acp)).toBe(2);
    expect(splitSize('claude,claude:sonnet', acp)).toBe(2);
  });

  it('the switch turns the split off and on again with every entry kept', () => {
    const before = cfg([{ engine: 'claude', weight: 2 }, { engine: 'claude', model: 'gpt-6.1-sol' }]);
    expect(splitIsOff(before)).toBe(false);
    const off = engineSplitSwitchSave(before, false) as Pick<Config, 'defaults'>;
    expect(splitIsOff(off)).toBe(true);
    expect(off.defaults).toMatchObject({ priority: 'high', project: 'Marina', engine: 'codex' });
    expect(off.defaults.engine_split).toEqual([{ engine: 'claude', weight: 2 }, { engine: 'claude', model: 'gpt-6.1-sol' }]);
    expect(splitChecked(off, ORDER)).toBe('claude,claude:gpt-6.1-sol');
    // Editing the entries while off keeps it off.
    expect(splitIsOff(engineSplitSave(off, 'claude', ORDER) as Pick<Config, 'defaults'>)).toBe(true);
    const on = engineSplitSwitchSave(off, true) as Pick<Config, 'defaults'>;
    expect(splitIsOff(on)).toBe(false);
    expect('engine_split_off' in on.defaults).toBe(false);
    expect(on.defaults.engine_split).toEqual(off.defaults.engine_split);
  });
});

describe('the projects the split shares', () => {
  const base = { defaults: { priority: 'none', engine_split: [{ engine: 'claude' }, { engine: 'codex' }] } } as unknown as Parameters<typeof engineSplitProjectsSave>[0];
  it('reads none as every project, and drops blanks and repeats', () => {
    expect(splitProjectsOf(base)).toEqual([]);
    expect(splitProjectsOf({ defaults: { engine_split_projects: [' Walnut ', 'walnut', '', 'Walnut-Idea'] } } as never)).toEqual(['Walnut', 'Walnut-Idea']);
  });
  it('writes the list beside every other default, and removes the key when none is left', () => {
    const on = engineSplitProjectsSave(base, 'Walnut\nWalnut-Idea') as { defaults: Record<string, unknown> };
    expect(on.defaults).toEqual({ priority: 'none', engine_split: [{ engine: 'claude' }, { engine: 'codex' }], engine_split_projects: ['Walnut', 'Walnut-Idea'] });
    const off = engineSplitProjectsSave(on as never, '') as { defaults: Record<string, unknown> };
    expect(off.defaults).toEqual({ priority: 'none', engine_split: [{ engine: 'claude' }, { engine: 'codex' }] });
  });
});
