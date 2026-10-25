import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { createElement, act } from '../../web/node_modules/react/index.js';
import { createRoot } from '../../web/node_modules/react-dom/client.js';
import type { SessionUsage } from '../../web/src/api/session-usage';
import type { SessionUsageView } from '../../web/src/hooks/useSessionBudgetUsage';
import { ApiError } from '../../web/src/api/client';

// Geometry and focus trapping are verified by the real browser. These tests cover
// the dialog's pure React state, request outcomes and exact visible copy.
vi.mock('@/hooks/useDialogFocus', () => ({ useDialogFocus: () => {} }));
// The cost breakdown is the picker's own block, tested on its own.
vi.mock('../../web/src/components/sessions/SessionCostBlock', () => ({ SessionCostBlock: () => null }));
const { SessionUsageDialog, SessionBudgetStatus } = await import('../../web/src/components/sessions/SessionUsageDialog');
let root: ReturnType<typeof createRoot>;
let host: HTMLElement;
let state: SessionUsageView;
const close = vi.fn();
const initial = (): SessionUsage => ({
  sessionId: 'dialog-session', title: 'A long-running review', engine: 'opencode', checkEverySec: 30, checkedAt: null,
  budget: { limitUsd: 10, spentUsd: 4, state: 'active', revision: 1, reason: null, updatedAt: null, responses: 9, unpricedResponses: 0,
    unpricedModel: null, pausedAt: null, pauseId: null, stopError: null, engine: 'opencode' },
});
async function render() { await act(async () => { root.render(createElement(SessionUsageDialog, { sessionId: 'dialog-session', usage: state, onClose: close })); }); }
function props(node: Element): Record<string, (...args: any[]) => void> {
  const key = Object.keys(node).find(name => name.startsWith('__reactProps$'))!;
  return (node as unknown as Record<string, Record<string, (...args: any[]) => void>>)[key];
}
const input = () => document.querySelector<HTMLInputElement>('.session-usage-edit-row input')!;
async function type(value: string) { await act(async () => { props(input()).onChange({ target: { value } }); }); }
async function submit() { await act(async () => { props(document.querySelector('form')!).onSubmit({ preventDefault() {} }); }); }
const text = () => document.querySelector('.session-usage-dialog')!.textContent!;

beforeAll(() => {
  const dom = parseHTML('<html><body></body></html>');
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
});
beforeEach(() => {
  close.mockReset(); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  state = { data: initial(), loading: false, saving: false, error: null, refresh: vi.fn().mockResolvedValue(initial()), save: vi.fn().mockResolvedValue(initial()) };
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe('session Usage & Budget dialog', () => {
  it('opens with immediate loading and closes on Escape without waiting for a request', async () => {
    state.data = null; state.loading = true; await render();
    expect(text()).toContain('Checking the budget');
    const event = new window.Event('keydown', { cancelable: true }); Object.assign(event, { key: 'Escape' });
    document.dispatchEvent(event); expect(close).toHaveBeenCalledTimes(1); expect(event.defaultPrevented).toBe(true);
  });
  it('shows the priced spend, what is left, and how often the engine is checked', async () => {
    await render();
    expect(document.querySelector('.session-usage-total strong')!.textContent).toBe('$4.00');
    expect(text()).toContain('Remaining: $6.00');
    expect(text()).toContain('9 requests');
    expect(text()).toContain('Checked at the end of each turn and every 30 s, so a long turn can pass the limit before it stops.');
    expect(text()).toContain('Never resets.');
    state.data = { ...initial(), budget: { ...initial().budget, state: 'paused', reason: 'unpriced', unpricedModel: 'new-model', unpricedResponses: 1 } };
    await render();
    expect(text()).toContain('Paused: a request on new-model has no price');
    expect(text()).toContain('1 without a price');
  });
  it('preserves typed limit on polls and retains the original revision until a conflict refresh', async () => {
    await render(); await type('17.35');
    state.data = { ...initial(), budget: { ...initial().budget, limitUsd: 15, revision: 2 } }; await render();
    expect(input().value).toBe('17.35');
    (state.save as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ApiError(409, 'Conflict'));
    (state.refresh as ReturnType<typeof vi.fn>).mockResolvedValue(state.data);
    await submit(); expect(state.save).toHaveBeenCalledWith(17.35, 1);
    expect(input().value).toBe('17.35'); expect(text()).toContain('your edit is kept');
    (state.save as ReturnType<typeof vi.fn>).mockResolvedValue({ ...state.data, budget: { ...state.data!.budget, limitUsd: 17.35, revision: 3 } });
    await submit(); expect(state.save).toHaveBeenLastCalledWith(17.35, 2); expect(text()).toContain('No message was sent.');
  });
  it('shows saving immediately, retains failed edits and supports a deliberate retry', async () => {
    await render(); await type('20');
    (state.save as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Offline'));
    await submit(); expect(text()).toContain('Could not save the budget.'); expect(input().value).toBe('20');
    let finish!: (data: SessionUsage) => void;
    (state.save as ReturnType<typeof vi.fn>).mockImplementation(() => { state.saving = true; return new Promise<SessionUsage>(resolve => { finish = resolve; }); });
    await submit(); await render(); expect(text()).toContain('Saving…'); expect(input().disabled).toBe(true);
    const saved = { ...initial(), budget: { ...initial().budget, limitUsd: 20, revision: 2 } };
    state.saving = false; state.data = saved;
    await act(async () => { finish(saved); }); await render();
    expect(text()).toContain('Budget saved. No message was sent.');
  });
  it('removes the total lifetime limit with null, not a fresh allowance or a prompt', async () => {
    await render();
    const remove = [...document.querySelectorAll('button')].find(button => button.textContent === 'Remove limit')!;
    await act(async () => { props(remove).onClick(); });
    expect(state.save).toHaveBeenCalledWith(null, 1);
  });
  it('puts only a configured pause by the composer', async () => {
    await act(async () => { root.render(createElement(SessionBudgetStatus, { data: { ...initial(), budget: { ...initial().budget, limitUsd: null, state: 'unlimited' } }, onOpen: close })); });
    expect(host.textContent).toBe('');
    await act(async () => { root.render(createElement(SessionBudgetStatus, { data: { ...initial(), budget: { ...initial().budget, state: 'paused', reason: 'limit', spentUsd: 10.2 } }, onOpen: close })); });
    expect(host.textContent).toContain('Paused at budget: $10.20 of $10.00');
  });
});
