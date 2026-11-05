import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WALNUT_HOME } from '../../../src/constants.js';
import {
  builderLabel, chooseBuilder, pickSplitEngine, recentPickCounts, recordPick, SPLIT_WINDOW_MS, splitApplies, splitBuilders,
} from '../../../src/core/agents/engine-split.js';

const picksFile = path.join(WALNUT_HOME, 'cache', 'engine-split.json');

describe('splitBuilders', () => {
  it('is off without two usable entries', () => {
    expect(splitBuilders(undefined)).toEqual([]);
    expect(splitBuilders({ defaults: {} })).toEqual([]);
    expect(splitBuilders({ defaults: { engine_split: [{ engine: 'codex' }] } })).toEqual([]);
    expect(splitBuilders({ defaults: { engine_split: [{ engine: 'codex' }, { engine: 'nope' }] } })).toEqual([]);
  });

  it('reads entries, strings, weights and Claude models, and drops duplicates', () => {
    const b = splitBuilders({ defaults: { engine_split: ['claude', { engine: 'codex', weight: 2 }, { engine: 'claude', model: 'gpt-6.1-sol' }, 'codex'] } });
    expect(b.map((x) => [x.key, x.weight])).toEqual([['claude', 1], ['codex', 2], ['claude:gpt-6.1-sol', 1]]);
    expect(builderLabel(b[2])).toBe('Claude Code · gpt-6.1-sol');
  });

  it('ignores a model on an ACP engine (its model comes from engines.<id>.model)', () => {
    const b = splitBuilders({ defaults: { engine_split: ['claude', { engine: 'codex', model: 'gpt-x' }] } });
    expect(b[1]).toEqual({ key: 'codex', engine: 'codex', weight: 1 });
  });
});

describe('chooseBuilder', () => {
  const two = splitBuilders({ defaults: { engine_split: ['claude', 'codex'] } });
  it('alternates on equal weights and favors the earlier entry on a tie', () => {
    expect(chooseBuilder(two, new Map())?.key).toBe('claude');
    expect(chooseBuilder(two, new Map([['claude', 1]]))?.key).toBe('codex');
    expect(chooseBuilder(two, new Map([['claude', 3], ['codex', 3]]))?.key).toBe('claude');
  });

  it('follows the weights over many picks', () => {
    const weighted = splitBuilders({ defaults: { engine_split: [{ engine: 'claude', weight: 2 }, 'codex'] } });
    const counts = new Map<string, number>();
    for (let i = 0; i < 30; i++) {
      const k = chooseBuilder(weighted, counts)!.key;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    expect(counts.get('claude')).toBe(20);
    expect(counts.get('codex')).toBe(10);
  });
});

describe('splitApplies', () => {
  const plain = { project: 'Walnut' };
  it('applies to an ordinary start that names nothing', () => {
    expect(splitApplies(plain, {})).toBe(true);
    expect(splitApplies(plain, { model: 'default' })).toBe(true);
  });
  it('a named engine, model or effort is the per-task override', () => {
    expect(splitApplies(plain, { engine: 'claude' })).toBe(false);
    expect(splitApplies(plain, { model: 'opus' })).toBe(false);
    expect(splitApplies(plain, { effort: 'high' })).toBe(false);
  });
  it('leaves org nodes, asks, routine runs, plugin tasks and replays alone', () => {
    expect(splitApplies({ ...plain, org_role: 'lead' }, {})).toBe(false);
    expect(splitApplies({ project: 'Ask Walnut' }, {})).toBe(false);
    expect(splitApplies({ ...plain, walnut_agent: true }, {})).toBe(false);
    expect(splitApplies({ ...plain, routine_start: {} }, {})).toBe(false);
    expect(splitApplies({ ...plain, plugin_only: 'x' }, {})).toBe(false);
    for (const source of ['engine-switch', 'transfer', 'auto-recover', 'restart', 'folder-gone', 'start-queue']) {
      expect(splitApplies(plain, { source })).toBe(false);
    }
  });
});

describe('picks', () => {
  beforeEach(async () => { await fs.rm(picksFile, { force: true }); });
  const two = splitBuilders({ defaults: { engine_split: ['claude', 'codex'] } });

  it('counts recent picks only, one per task', async () => {
    const now = Date.parse('2026-11-05T12:00:00Z');
    await recordPick('codex', 't-old', new Date(now - SPLIT_WINDOW_MS - 1000).toISOString(), now - SPLIT_WINDOW_MS - 1000);
    await recordPick('claude', 't1', new Date(now - 1000).toISOString(), now);
    await recordPick('codex', 't1', new Date(now - 500).toISOString(), now);
    await recordPick('codex', 't2', new Date(now).toISOString(), now);
    expect(Object.fromEntries(await recentPickCounts(now))).toEqual({ codex: 2 });
  });

  it('alternates across real starts and skips an engine the host has not reported installed', async () => {
    const now = Date.now();
    const yes = async () => true;
    const first = await pickSplitEngine(two, yes, now);
    expect(first?.key).toBe('claude');
    await recordPick(first!.key, 'a', first!.at, now);
    const second = await pickSplitEngine(two, yes, now);
    expect(second?.key).toBe('codex');
    expect(second?.shares).toEqual({ claude: 1, codex: 0 });
    await recordPick(second!.key, 'b', second!.at, now);
    await recordPick('claude', 'c', new Date(now).toISOString(), now);
    // Codex is next by share, but the host has not said it runs Codex: Claude Code takes it.
    expect((await pickSplitEngine(two, async () => null, now))?.key).toBe('claude');
    expect((await pickSplitEngine(two, async () => false, now))?.key).toBe('claude');
    expect((await pickSplitEngine(two, async () => { throw new Error('down'); }, now))?.key).toBe('claude');
  });
});
