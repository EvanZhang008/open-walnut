import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';
vi.mock('../../../src/constants.js', () => createMockConstants('session-budget'));
const mocks = vi.hoisted(() => ({
  send: vi.fn(), sessions: vi.fn(), alive: vi.fn(), config: vi.fn(), capability: vi.fn(), connected: vi.fn(), letter: vi.fn(),
}));
vi.mock('../../../src/core/config-manager.js', () => ({ getConfig: mocks.config }));
vi.mock('../../../src/core/session-tracker.js', () => ({ getSessionByClaudeId: mocks.sessions, listNonTerminalSessions: mocks.alive }));
vi.mock('../../../src/core/human-inbox/store.js', () => ({ sendLetterOnce: mocks.letter }));
vi.mock('../../../src/providers/daemon-connection.js', () => {
  const conn = { connect: async () => {}, hasCapability: (c: string) => mocks.capability(c), send: (...a: unknown[]) => mocks.send(...a) };
  return { getDaemonConnection: async () => conn, getConnectedDaemonConnection: (host: string) => mocks.connected(host) ? conn : null };
});
import { resetPriceBookForTests } from '../../../src/core/usage/price-book.js';
import { configureSessionBudget, getSessionBudget, pauseLetterMarkdown, sweepSessionBudgets } from '../../../src/core/usage/session-budget.js';

const budget = { limitUsd: 10, spentUsd: 4, state: 'active', reason: null, revision: 1, updatedAt: null, responses: 3,
  unpricedResponses: 0, unpricedModel: null, pausedAt: null, pauseId: null, stopError: null, engine: 'claude' };
const SNAPSHOT = { source: 'litellm' as const, url: '', fetchedAt: '2026-10-23T00:00:00.000Z', models: {
  'claude-opus-5-5': { provider: 'anthropic', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 } } };

beforeEach(() => {
  vi.clearAllMocks();
  resetPriceBookForTests(SNAPSHOT);
  mocks.capability.mockImplementation((c: string) => c === 'budget-v2');
  mocks.sessions.mockResolvedValue({ claudeSessionId: 'example-session', title: 'Example task', taskId: 'task-1', engine: 'claude', cwd: '/w' });
  mocks.alive.mockResolvedValue([]);
  mocks.config.mockResolvedValue({ usage: { prices: { 'my-model': { input: 1, output: 2 } } }, hosts: { box: { hostname: 'box' } } });
  mocks.send.mockResolvedValue({ ok: true, result: { budget, checkedAt: null } });
  mocks.connected.mockReturnValue(true);
  mocks.letter.mockResolvedValue({ letter: {}, duplicate: false });
});

describe('session budget relay', () => {
  it('reads the host\'s budget and says how often it is checked', async () => {
    // The empty breakdown fields keep a window on the previous bundle from crashing when it opens the dialog.
    expect(await getSessionBudget('example-session')).toEqual({ sessionId: 'example-session', title: 'Example task', engine: 'claude', budget, checkedAt: null, checkEverySec: 2,
      verifiedCostUsd: null, verifiedCalls: 0, unverifiedCalls: 0, byModel: [], byAgent: [] });
    expect(mocks.send).toHaveBeenCalledWith('usage.budget.get', expect.objectContaining({ sid: 'example-session', engine: 'claude' }), 10_000);
  });

  it('sends the limit with the session\'s engine, place and the cost line\'s prices', async () => {
    mocks.sessions.mockResolvedValue({ claudeSessionId: 'oc-1', engine: 'opencode', cwd: '/w', acpRuntimeId: 'rt-1' });
    const out = await configureSessionBudget('oc-1', { limitUsd: 10, revision: 0 });
    expect(out.checkEverySec).toBe(30);
    const [cmd, params, timeout] = mocks.send.mock.calls[0];
    expect([cmd, timeout]).toEqual(['usage.budget.configure', 30_000]);
    expect(params).toMatchObject({ sid: 'oc-1', engine: 'opencode', cwd: '/w', runtimeId: 'rt-1', limitUsd: 10, revision: 0,
      prices: { snapshot: SNAPSHOT, overrides: { 'my-model': { input: 1, output: 2 } }, hash: expect.any(String) } });
  });

  it('reports conflicts, bad limits, old hosts and engines without per-request usage', async () => {
    mocks.send.mockResolvedValue({ ok: false, code: 'BUDGET_CONFLICT', error: 'changed' });
    await expect(configureSessionBudget('example-session', { limitUsd: 10, revision: 0 })).rejects.toMatchObject({ status: 409, code: 'BUDGET_CONFLICT' });
    mocks.send.mockResolvedValue({ ok: false, code: 'BAD_REQUEST', error: 'bad' });
    await expect(configureSessionBudget('example-session', { limitUsd: 10, revision: 0 })).rejects.toMatchObject({ status: 400 });
    // A first-version host keeps its own budgets; this server asks it to update instead of misreading it.
    mocks.capability.mockImplementation((c: string) => c === 'budget-v1');
    await expect(getSessionBudget('example-session')).rejects.toMatchObject({ status: 503, code: 'budget_needs_upgrade' });
    mocks.send.mockClear();
    mocks.sessions.mockResolvedValue({ claudeSessionId: 'g', engine: 'gemini' });
    await expect(getSessionBudget('g')).rejects.toMatchObject({ status: 400, code: 'budget_unsupported' });
    mocks.sessions.mockResolvedValue(null);
    await expect(getSessionBudget('none')).rejects.toMatchObject({ status: 404 });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe('pause letters', () => {
  const paused = { ...budget, sid: 'example-session', state: 'paused', reason: 'limit', spentUsd: 10.4, pauseId: 'p-1' };

  it('asks each connected budget-v2 host once, keeps worker ids current, and writes one letter per pause id', async () => {
    mocks.alive.mockResolvedValue([
      { claudeSessionId: 'oc-1', host: 'box', acpRuntimeId: 'rt-1' },
      { claudeSessionId: 'cl-1', acpRuntimeId: undefined },
    ]);
    mocks.send.mockImplementation(async (_cmd: string, params: Record<string, unknown>) => ({ ok: true,
      result: { budgets: params.runtimeIds && Object.keys(params.runtimeIds as object).length ? [paused] : [], pricesHash: params.prices ? 'pushed' : 'old' } }));
    const report = await sweepSessionBudgets();
    expect(report).toMatchObject({ hosts: 2, paused: 1, sent: 1 });
    const calls = mocks.send.mock.calls.filter(c => c[0] === 'usage.budget.list');
    // A host holding another price list is sent this one (once per host).
    expect(calls).toHaveLength(4);
    expect(calls.every(c => c[2] === 8_000)).toBe(true);
    expect(calls.find(c => (c[1] as { runtimeIds: object }).runtimeIds && 'oc-1' in (c[1] as { runtimeIds: object }).runtimeIds)).toBeTruthy();
    expect(calls.every(c => typeof (c[1] as { home?: string }).home === 'string')).toBe(true);
    expect(mocks.letter).toHaveBeenCalledTimes(1);
    expect(mocks.letter.mock.calls[0][1]).toEqual({ opKey: 'budget-paused:p-1' });
    expect(mocks.letter.mock.calls[0][0]).toMatchObject({ type: 'review', taskRefs: ['task-1'], subject: expect.stringContaining('$10.40') });
  });

  it('skips a host that is not connected or not on budget-v2, and one that does not answer', async () => {
    mocks.connected.mockImplementation((h: string) => h === 'box');
    mocks.capability.mockReturnValue(false);
    expect((await sweepSessionBudgets()).hosts).toBe(0);
    mocks.capability.mockImplementation((c: string) => c === 'budget-v2');
    mocks.send.mockRejectedValue(new Error('timeout'));
    expect(await sweepSessionBudgets()).toMatchObject({ hosts: 1, sent: 0 });
  });

  it('says why in the letter: the limit, or the model with no price', () => {
    expect(pauseLetterMarkdown(paused as never, 'Fix the build')).toContain('spent $10.40, at or over its $10.00 budget');
    const unpriced = pauseLetterMarkdown({ ...paused, reason: 'unpriced', unpricedModel: 'new-model', spentUsd: 1 } as never, 'T');
    expect(unpriced).toContain('**new-model**');
    expect(unpriced).toContain('add a price for that model');
    expect(pauseLetterMarkdown({ ...paused, stopError: 'pid gone' } as never, 'T')).toContain('could not be confirmed (pid gone)');
  });
});
