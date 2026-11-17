import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { createElement, act } from '../../web/node_modules/react/index.js';
import { createRoot } from '../../web/node_modules/react-dom/client.js';
import type { Task } from '@open-walnut/core';

// A merged pull request reads once: its own pill's card (PrPill.tsx) shows its deploy with the
// change card's view (ChangeDeployView.tsx), and its link tag stays the plain link
// (change-status.ts changeOfTag, tests/web/change-status.test.ts). Off with the experiment.
const flags = { change_status: true };
vi.mock('@/hooks/useExperimental', () => ({ useExperimental: (id: keyof typeof flags) => flags[id] }));
vi.mock('@/hooks/useMenuPlacement', () => ({
  useMenuPlacement: () => ({ top: 10, left: 10, maxHeight: 400, side: 'down' }),
  menuPlacementStyle: () => ({}),
}));
vi.mock('@/hooks/useKeyboardOpenFocus', () => ({ useKeyboardOpenFocus: () => () => {} }));
vi.mock('@/hooks/usePhoneLayout', () => ({ usePhoneLayout: () => false }));
vi.mock('@/contexts/TasksContext', () => ({ useStoreTask: () => null }));
vi.mock('@/api/tasks', () => ({ completeTask: vi.fn().mockResolvedValue({}) }));

const PR = 'https://github.com/acme/app/pull/77';
const READ = new Date(Date.now() - 60_000).toISOString();
const prSnap = {
  provider: 'github', url: PR, repo: 'acme/app', number: 77, title: 'Ship the export', state: 'merged', mine: true,
  checks: { total: 2, passed: 2, failed: 0, pending: 0, skipped: 0, items: [] }, mergedAt: READ, checkedAt: READ,
  watch: { mergeSeen: true },
};
vi.mock('@/api/client', () => ({
  apiGet: vi.fn().mockResolvedValue({ watching: true, autoComplete: false, wake: true, prs: [prSnap] }),
  apiPatch: vi.fn().mockResolvedValue({}),
  apiPost: vi.fn().mockResolvedValue({}),
}));
const { PrPill } = await import('../../web/src/components/tasks/PrPill');

const task = {
  id: 'task-pr-deploy', title: 'Export', tags: [`pr:${PR}`], pr_status: { [PR]: prSnap },
  change_status: {
    [PR]: {
      provider: 'github', url: PR, label: 'app#77', review: { state: 'merged' }, checkedAt: READ,
      deploy: {
        pipeline: 'GitHub deployments', commit: 'abcdef1234567', done: false, last: 'staging',
        stages: [{ name: 'staging', status: 'done' }, { name: 'production', status: 'running', prod: true, note: 'Rolling out' }],
      },
    },
  },
} as unknown as Task;

let root: ReturnType<typeof createRoot>;
let host: HTMLElement;
function props(node: Element): Record<string, (...args: any[]) => void> {
  const key = Object.keys(node).find((name) => name.startsWith('__reactProps$'))!;
  return (node as unknown as Record<string, Record<string, (...args: any[]) => void>>)[key];
}
async function openCard() {
  await act(async () => { root.render(createElement(PrPill, { task })); });
  // A card open when the last test's pill unmounted opens again by itself (PrPill.tsx reopenFor).
  const pill = document.querySelector('[data-testid="pr-pill"]')!;
  if (!document.querySelector('[data-testid="pr-card"]')) await act(async () => { props(pill).onClick({ preventDefault() {}, stopPropagation() {}, detail: 1, currentTarget: pill }); });
  await act(async () => { await Promise.resolve(); });
}

beforeAll(() => {
  const dom = parseHTML('<html><body></body></html>');
  Object.assign(dom.window, { innerHeight: 800, innerWidth: 1280 });
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
});
beforeEach(() => { flags.change_status = true; host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("a merged pull request's deploy in its own card", () => {
  it('shows the stages with the change view, under the pull request', async () => {
    await openCard();
    const deploy = document.querySelector('[data-testid="pr-card-deploy"]')!;
    expect(deploy).not.toBeNull();
    expect(deploy.querySelector('[data-testid="change-deploy-count"]')!.textContent).toBe('1 of 2 deployed');
    expect([...deploy.querySelectorAll('[data-testid="change-stage"]')].map((s) => s.getAttribute('data-stage'))).toEqual(['staging', 'production']);
  });

  it('shows none with the experiment off', async () => {
    flags.change_status = false;
    await openCard();
    expect(document.querySelector('[data-testid="pr-card"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="pr-card-deploy"]')).toBeNull();
  });
});
