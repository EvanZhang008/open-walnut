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
const { SessionUsageDialog, SessionBudgetStatus } = await import('../../web/src/components/sessions/SessionUsageDialog');
let root: ReturnType<typeof createRoot>;
let host: HTMLElement;
let state: SessionUsageView;
const close = vi.fn();
const initial = (): SessionUsage => ({
  sessionId: 'dialog-session', title: 'A long-running review', verifiedCostUsd: 4, verifiedCalls: 9, unverifiedCalls: 0,
  byAgent: [{ agent: 'main', costUsd: 3, calls: 7, unverifiedCalls: 0 }, { agent: 'subagent', costUsd: 1, calls: 2, unverifiedCalls: 0 }],
  byModel: [{ model: 'model-a', costUsd: 4, calls: 9, unverifiedCalls: 0 }], checkedAt: null,
  budget: { limitUsd: 10, spentUsd: 4, state: 'active', revision: 1, reason: null, updatedAt: null },
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
    expect(text()).toContain('Checking session usage');
    const event = new window.Event('keydown', { cancelable: true }); Object.assign(event, { key: 'Escape' });
    document.dispatchEvent(event); expect(close).toHaveBeenCalledTimes(1); expect(event.defaultPrevented).toBe(true);
  });
  it('keeps incomplete lifetime and breakdown dollars Unverified, with explicitly labeled known portion', async () => {
    state.data = { ...initial(), unverifiedCalls: 1, byModel: [{ model: 'model-a', costUsd: 4, calls: 10, unverifiedCalls: 1 }] };
    await render(); expect(document.querySelector('.session-usage-total strong')!.textContent).toBe('Unverified');
    expect(text()).toContain('Known verified portion: $4.00. Not the lifetime total.');
    expect(text()).not.toContain('Remaining:');
    expect(document.querySelector('[aria-label="Usage by model"] .session-usage-row-cost')!.textContent).toBe('Unverified');
    expect(text()).toContain('Never resets.'); expect(text()).toContain('In-flight requests may exceed the allowance.');
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
  it('does not put ordinary unknown costs near the composer, but names configured pauses', async () => {
    await act(async () => { root.render(createElement(SessionBudgetStatus, { data: { ...initial(), budget: { ...initial().budget, limitUsd: null, state: 'unverified' } }, onOpen: close })); });
    expect(host.textContent).toBe('');
    await act(async () => { root.render(createElement(SessionBudgetStatus, { data: { ...initial(), budget: { ...initial().budget, state: 'paused' } }, onOpen: close })); });
    expect(host.textContent).toContain('Paused at budget');
  });
});
