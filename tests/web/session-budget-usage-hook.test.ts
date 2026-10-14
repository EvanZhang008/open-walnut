import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { createElement, act } from '../../web/node_modules/react/index.js';
import { createRoot } from '../../web/node_modules/react-dom/client.js';
import type { SessionUsage } from '../../web/src/api/session-usage';

const fetchUsage = vi.hoisted(() => vi.fn());
vi.mock('@/api/session-usage', () => ({ fetchSessionUsage: fetchUsage, patchSessionBudget: vi.fn() }));
const events = vi.hoisted(() => new Map<string, (event: unknown) => void>());
vi.mock('@/hooks/useWebSocket', () => ({ useEvent: (name: string, callback: (event: unknown) => void) => events.set(name, callback) }));
const { useSessionBudgetUsage } = await import('../../web/src/hooks/useSessionBudgetUsage');

let root: ReturnType<typeof createRoot> | undefined;
let sid: string;
let visible: boolean;
let hidden: boolean;
let sequence = 0;
let latest: ReturnType<typeof useSessionBudgetUsage>;
const data = (id = sid, limitUsd: number | null = null): SessionUsage => ({
  sessionId: id, title: 'Session allowance', verifiedCostUsd: 2, verifiedCalls: 4, unverifiedCalls: 0,
  byAgent: [], byModel: [], checkedAt: null,
  budget: { limitUsd, spentUsd: 2, revision: 1, state: limitUsd === null ? 'unlimited' : 'active', reason: null, updatedAt: null },
});
function Probe() { latest = useSessionBudgetUsage(sid, visible); return null; }
async function render() { await act(async () => { root!.render(createElement(Probe)); }); }
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

beforeAll(() => {
  const dom = parseHTML('<html><body></body></html>');
  Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
});
beforeEach(() => {
  vi.useFakeTimers(); sid = `budget-hook-${++sequence}`; visible = false; hidden = false;
  fetchUsage.mockReset(); events.clear(); fetchUsage.mockImplementation(async (id: string) => data(id));
  root = createRoot(document.createElement('div'));
});
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; vi.useRealTimers(); });

describe('session budget usage polling', () => {
  it('loads once with the panel and does not poll a closed unlimited session', async () => {
    await render(); expect(fetchUsage).toHaveBeenCalledTimes(1);
    await tick(30_000); expect(fetchUsage).toHaveBeenCalledTimes(1);
  });
  it('checks every five seconds in the dialog and slows configured closed budgets to fifteen seconds', async () => {
    fetchUsage.mockImplementation(async (id: string) => data(id, 10)); visible = true;
    await render(); await tick(5_000); expect(fetchUsage).toHaveBeenCalledTimes(2);
    visible = false; await render(); const atClose = fetchUsage.mock.calls.length;
    await tick(14_999); expect(fetchUsage).toHaveBeenCalledTimes(atClose);
    await tick(1); expect(fetchUsage).toHaveBeenCalledTimes(atClose + 1);
  });
  it('recovers a failed initial check, pauses while hidden and catches up on visibility and reconnect', async () => {
    fetchUsage.mockRejectedValueOnce(new Error('Offline'));
    await render(); expect(latest.error).toBe('Offline');
    await tick(15_000); expect(latest.data?.sessionId).toBe(sid);
    visible = true; await render(); const count = fetchUsage.mock.calls.length;
    hidden = true; await tick(15_000); expect(fetchUsage).toHaveBeenCalledTimes(count);
    hidden = false; await act(async () => { document.dispatchEvent(new window.Event('visibilitychange')); });
    expect(fetchUsage).toHaveBeenCalledTimes(count + 1);
    await act(async () => { events.get('_ws:reconnected')!({}); });
    expect(fetchUsage).toHaveBeenCalledTimes(count + 2);
  });
  it('does not show an old session while a replacement check is pending', async () => {
    await render(); const oldSid = sid;
    let finish!: (value: SessionUsage) => void;
    fetchUsage.mockImplementationOnce(() => new Promise<SessionUsage>(resolve => { finish = resolve; }));
    sid = `${sid}-next`; await render(); expect(latest.data).toBeNull();
    await act(async () => { finish(data(oldSid)); });
    expect(latest.data).toBeNull(); expect(latest.error).toContain('another session');
  });
  it('refreshes after a matching turn result, not another session, and stops polling on unmount', async () => {
    visible = true; await render();
    await act(async () => { events.get('session:result')!({ sessionId: 'other' }); });
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    await act(async () => { events.get('session:result')!({ sessionId: sid }); });
    expect(fetchUsage).toHaveBeenCalledTimes(2);
    await act(async () => { root!.unmount(); }); root = undefined;
    await tick(20_000); expect(fetchUsage).toHaveBeenCalledTimes(2);
  });
});
