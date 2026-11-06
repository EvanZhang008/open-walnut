import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WALNUT_HOME } from '../../../src/constants.js';
import {
  _resetSplitReservations, releaseSplitReservation, builderLabel, chooseBuilder, isReviewerTask, MAX_BEHIND, pickSplitEngine, recentPickCounts, recordPick, SPLIT_WINDOW_MS, splitApplies, splitBuilders, splitCredits,
} from '../../../src/core/agents/engine-split.js';

const picksFile = path.join(WALNUT_HOME, 'cache', 'engine-split.json');

describe('splitBuilders', () => {
  it('is off without two usable entries', () => {
    expect(splitBuilders(undefined)).toEqual([]);
    expect(splitBuilders({ defaults: {} })).toEqual([]);
    expect(splitBuilders({ defaults: { engine_split: [{ engine: 'codex' }] } })).toEqual([]);
    expect(splitBuilders({ defaults: { engine_split: [{ engine: 'codex' }, { engine: 'nope' }] } })).toEqual([]);
    // Switched off in Settings: the entries are kept, nothing is shared.
    expect(splitBuilders({ defaults: { engine_split: ["claude", "codex"], engine_split_off: true } })).toEqual([]);
    expect(splitBuilders({ defaults: { engine_split: ["claude", "codex"], engine_split_off: false } })).toHaveLength(2);
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
  const run = (builders: ReturnType<typeof splitBuilders>, n: number, start: string[] = []) => {
    const seq = [...start];
    for (let i = 0; i < n; i++) seq.push(chooseBuilder(builders, splitCredits(builders, seq))!.key);
    return seq.slice(start.length);
  };
  it('alternates on equal weights and favors the earlier entry on a tie', () => {
    expect(chooseBuilder(two, splitCredits(two, []))?.key).toBe('claude');
    expect(run(two, 6)).toEqual(['claude', 'codex', 'claude', 'codex', 'claude', 'codex']);
  });

  it('follows the weights over many picks', () => {
    const weighted = splitBuilders({ defaults: { engine_split: [{ engine: 'claude', weight: 2 }, 'codex'] } });
    const seq = run(weighted, 30);
    expect(seq.filter((k) => k === 'claude')).toHaveLength(20);
    expect(seq.filter((k) => k === 'codex')).toHaveLength(10);
  });

  it(`an entry added later, or one a host could not run, catches up by at most ${MAX_BEHIND} extra turns, then takes turns`, () => {
    const history = Array.from({ length: 80 }, (_, i) => (i % 2 ? 'codex' : 'claude'));
    const three = splitBuilders({ defaults: { engine_split: ['claude', 'codex', 'gemini'] } });
    const next = run(three, 12, history);
    // A burst of a few, never 40 in a row; then each entry about a third.
    let streak = 0;
    for (const k of next) { if (k !== 'gemini') break; streak++; }
    expect(streak).toBeLessThanOrEqual(MAX_BEHIND + 2);
    expect(next.slice(4)).toEqual(['claude', 'codex', 'gemini', 'claude', 'codex', 'gemini', 'claude', 'codex']);
    // Codex left out on one host for 30 starts, then offered again: a short catch-up, not 30 in a row.
    const away = Array.from({ length: 30 }, () => 'claude');
    const back = run(two, 8, away);
    expect(back.slice(0, 4)).toEqual(['codex', 'codex', 'codex', 'codex']);
    expect(back.slice(4)).toEqual(['claude', 'codex', 'claude', 'codex']);
    expect(back).toContain('claude');
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
    // A reviewer subtask takes no turn; a top-level task titled "Review ..." is work and does.
    expect(splitApplies({ ...plain, parent_task_id: 'p', title: 'Review round 2: settings (GPT)' }, {})).toBe(false)
    expect(splitApplies({ ...plain, title: 'Review the onboarding flow' }, {})).toBe(true)
    expect(isReviewerTask({ parent_task_id: 'p', title: 'Fix review comments' })).toBe(false)
    // A verifier is a reviewer too (the user's rules call them verifier tasks).
    expect(isReviewerTask({ parent_task_id: 'p', title: 'Final verify: engine split (Sol)' })).toBe(true)
    expect(isReviewerTask({ parent_task_id: 'p', title: 'Verifier round 2' })).toBe(true)
    expect(isReviewerTask({ parent_task_id: 'p', title: 'Fix the verifier crash' })).toBe(false)
    // Work that verifies something is work, not a review: only "Verify:" names one.
    expect(isReviewerTask({ parent_task_id: 'p', title: 'Verify the iOS build on device' })).toBe(false)
    for (const source of ['engine-switch', 'transfer', 'auto-recover', 'restart', 'folder-gone', 'start-queue']) {
      expect(splitApplies(plain, { source })).toBe(false);
    }
  });
});

describe('picks', () => {
  beforeEach(async () => { await fs.rm(picksFile, { force: true }); _resetSplitReservations(); });
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
    const first = await pickSplitEngine(two, yes, now, 'a');
    expect(first?.key).toBe('claude');
    await recordPick(first!.key, 'a', first!.at, now);
    const second = await pickSplitEngine(two, yes, now, 'b');
    expect(second?.key).toBe('codex');
    expect(second?.shares).toEqual({ claude: 1, codex: 0 });
    await recordPick(second!.key, 'b', second!.at, now);
    await recordPick('claude', 'c', new Date(now).toISOString(), now);
    // Codex is next by share, but the host has not said it runs Codex: Claude Code takes it.
    expect((await pickSplitEngine(two, async () => null, now, 'd'))?.key).toBe('claude');
    _resetSplitReservations();
    expect((await pickSplitEngine(two, async () => false, now, 'e'))?.key).toBe('claude');
    _resetSplitReservations();
    const down = await pickSplitEngine(two, async () => { throw new Error('down'); }, now, 'f');
    expect(down?.key).toBe('claude');
    expect(down?.skipped).toEqual([{ key: 'codex', reason: 'the host has not said whether it runs it' }]);
  });

  it('two starts at once take different entries, and an unrecorded pick stops counting after a while', async () => {
    const now = Date.now();
    const yes = async () => true;
    const [a, b] = await Promise.all([pickSplitEngine(two, yes, now, 'ta'), pickSplitEngine(two, yes, now, 'tb')]);
    expect(new Set([a?.key, b?.key])).toEqual(new Set(['claude', 'codex']));
    await recordPick(a!.key, 'ta', a!.at, now);
    // b never records (its start failed): three minutes on, only the recorded pick counts.
    expect(Object.fromEntries(await recentPickCounts(now + 180_000))).toEqual({ [a!.key]: 1 });
  });

  it('a released reservation (its start lost the race to keep the pick) takes no turn', async () => {
    const now = Date.now();
    const yes = async () => true;
    const lost = await pickSplitEngine(two, yes, now, 'race');
    releaseSplitReservation('race', lost!.key);
    expect((await pickSplitEngine(two, yes, now, 'next'))?.key).toBe(lost!.key);
  });

  it('a task picked again (its old entry was removed) counts its new pick before it is recorded', async () => {
    const now = Date.now();
    const yes = async () => true;
    // The file still holds the task's old pick of an entry the split no longer lists.
    await recordPick('claude:retired', 'again', new Date(now - 1000).toISOString(), now);
    const first = await pickSplitEngine(two, yes, now, 'again');
    const second = await pickSplitEngine(two, yes, now, 'other');
    expect(second?.key).not.toBe(first?.key);
  });
});
