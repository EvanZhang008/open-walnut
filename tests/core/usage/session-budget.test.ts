import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';
vi.mock('../../../src/constants.js', () => createMockConstants('session-budget'));
const mocks = vi.hoisted(() => ({ send: vi.fn(), sessions: vi.fn(), config: vi.fn(), capability: vi.fn() }));
vi.mock('../../../src/core/config-manager.js', () => ({ getConfig: mocks.config }));
vi.mock('../../../src/core/session-tracker.js', () => ({ getSessionByClaudeId: mocks.sessions }));
vi.mock('../../../src/providers/daemon-connection.js', () => ({ getDaemonConnection: async () => ({
  connect: async () => {}, hasCapability: mocks.capability, send: mocks.send,
}) }));
vi.mock('../../../src/core/usage/collection.js', () => ({ responseUsageStore: () => ({ getSessionUsage: () => ({
  verifiedCostUsd: null, verifiedCalls: 0, unverifiedCalls: 2, byModel: [], byAgent: [],
}) }) }));
import { configureSessionBudget, getSessionBudget } from '../../../src/core/usage/session-budget.js';
const budget = { limitUsd: 10, spentUsd: null, state: 'unverified', revision: 1, reason: 'cost_unverified', updatedAt: null };
const snapshot = { budget, usage: { verifiedCostUsd: null, verifiedCalls: 1, unverifiedCalls: 2, byModel: [], byAgent: [] }, checkedAt: null };
beforeEach(() => {
  vi.clearAllMocks(); mocks.capability.mockReturnValue(true);
  mocks.sessions.mockResolvedValue({ claudeSessionId: 'example-session', title: 'Example task', engine: 'claude' });
  mocks.config.mockResolvedValue({ usage: { proxy_log_dirs: { __local__: '/tmp/example-proxy' } } });
  mocks.send.mockResolvedValue({ ok: true, result: snapshot });
});
describe('session usage and budget relay', () => {
  it('returns host-aggregated usage and sends only policy data to the owning daemon', async () => {
    expect(await getSessionBudget('example-session')).toMatchObject({ sessionId: 'example-session', title: 'Example task', budget });
    expect(await configureSessionBudget('example-session', { limitUsd: 10, revision: 0 })).toMatchObject({ verifiedCostUsd: null });
    expect(mocks.send.mock.calls[1]).toEqual(['usage.budget.configure', expect.objectContaining({ sid: 'example-session', limitUsd: 10, revision: 0 }), 30_000]);
    expect(mocks.send.mock.calls[1][1]).not.toHaveProperty('records');
  });
  it('reports stale policy writes as conflicts and unavailable hosts without fabricated totals', async () => {
    mocks.send.mockResolvedValue({ ok: false, code: 'BUDGET_CONFLICT', error: 'Policy changed' });
    await expect(configureSessionBudget('example-session', { limitUsd: 10, revision: 0 })).rejects.toMatchObject({ status: 409, code: 'BUDGET_CONFLICT' });
    mocks.capability.mockReturnValue(false);
    await expect(getSessionBudget('example-session')).rejects.toMatchObject({ status: 503, code: 'budget_needs_upgrade' });
  });
  it('does not offer a budget for a missing session or an unsupported history engine', async () => {
    mocks.sessions.mockResolvedValue(null);
    await expect(getSessionBudget('absent-session')).rejects.toMatchObject({ status: 404 });
    mocks.sessions.mockResolvedValue({ claudeSessionId: 'example-session', engine: 'codex' });
    await expect(getSessionBudget('example-session')).rejects.toMatchObject({ code: 'budget_unsupported' });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
