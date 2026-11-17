import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { createElement, act } from '../../web/node_modules/react/index.js';
import { createRoot } from '../../web/node_modules/react-dom/client.js';
import type { ChangeSnapshot, ChangeStage } from '../../src/core/changes/model';

// A change link's pill and card (web ChangePill.tsx, ChangeCard.tsx, change-status.ts): the words
// after the link's name, the fold of a long run of stages not reached, and a stage's live detail.
// Placement and pixels are the browser's (tests/e2e/browser/change-status.spec.ts).
vi.mock('@/hooks/useMenuPlacement', () => ({
  useMenuPlacement: () => ({ top: 10, left: 10, maxHeight: 400, side: 'down' }),
  menuPlacementStyle: () => ({}),
}));
const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('@/api/client', () => ({ apiGet: (...a: unknown[]) => apiGet(...a), apiPost: (...a: unknown[]) => apiPost(...a) }));
const { stageRows, changeOfTag, reviewFacts, FOLD_RUN } = await import('../../web/src/components/tasks/change-status');
const { ChangePill } = await import('../../web/src/components/tasks/ChangePill');

const URL_CR = 'https://review.acme.dev/CR-1001';
const TAG = `cr:${URL_CR}`;
const st = (name: string, status: ChangeStage['status'], extra: Partial<ChangeStage> = {}): ChangeStage => ({ name, status, ...extra });

function pipeline(): ChangeStage[] {
  return [
    st('beta-w1', 'done', { target: 'beta-c01', at: '2026-11-16T10:00:00Z' }),
    st('prod-w1', 'waiting', { prod: true, note: 'approval running', blocker: { kind: 'bake', text: 'Bake Time: 6 hours 59 minutes left' } }),
    st('prod-w2', 'pending', { prod: true, note: 'waits for prod-w1' }),
    ...Array.from({ length: 8 }, (_, i) => st(`prod-w${i + 3}`, 'pending', { prod: true })),
  ];
}

function snapshot(over: Partial<ChangeSnapshot> = {}): ChangeSnapshot {
  return {
    provider: 'acme:reviews', url: URL_CR, label: 'CR-1001', title: 'Move the controller onto the new instance type',
    review: { state: 'merged', revision: 2, approvals: { got: 1, need: 1 }, checks: { passed: 4, failed: 0, pending: 0 } },
    deploy: { pipeline: 'acme-deployer', url: 'https://pipelines.acme.dev/acme-deployer', commit: 'e138767', stages: pipeline(), done: false, last: 'prod-w1' },
    checkedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    ...over,
  };
}

describe('change-status rules', () => {
  it('finds the snapshot by the tag URL', () => {
    const snap = snapshot();
    expect(changeOfTag({ id: 't', change_status: { [URL_CR]: snap } }, TAG)).toBe(snap);
    expect(changeOfTag({ id: 't', change_status: {} }, TAG)).toBeUndefined();
    expect(changeOfTag({ id: 't', change_status: { [URL_CR]: snap } }, 'cr:CR-1001')).toBeUndefined();
  });

  it('folds a run of more than FOLD_RUN stages not reached, keeping the next stage', () => {
    const rows = stageRows(pipeline());
    expect(rows.map((r) => r.kind === 'stage' ? r.stage.name : `fold:${r.stages.length}`)).toEqual(['beta-w1', 'prod-w1', 'prod-w2', 'fold:8']);
    // Opened, the fold draws its stages again.
    const fold = rows.at(-1)!;
    expect(fold.kind).toBe('fold');
    const opened = stageRows(pipeline(), new Set([fold.kind === 'fold' ? fold.from : -1]));
    expect(opened).toHaveLength(11);
    expect(opened.every((r) => r.kind === 'stage')).toBe(true);
  });

  it('keeps a run of FOLD_RUN or fewer whole', () => {
    const stages = [st('a', 'done'), ...Array.from({ length: FOLD_RUN }, (_, i) => st(`p${i}`, 'pending')), st('z', 'done')];
    expect(stageRows(stages).every((r) => r.kind === 'stage')).toBe(true);
  });

  it('says the review facts it has, leaving out the rest', () => {
    expect(reviewFacts({ state: 'open', revision: 1, approvals: { got: 0, need: 1 }, checks: { passed: 3, failed: 1, pending: 0 } }))
      .toEqual(['Revision 1', '0/1 approvals', 'Checks: 3 passed, 1 failed']);
    expect(reviewFacts({ state: 'open' })).toEqual([]);
  });
});

let root: ReturnType<typeof createRoot>;
let host: HTMLElement;
function props(node: Element): Record<string, (...args: any[]) => void> {
  const key = Object.keys(node).find((name) => name.startsWith('__reactProps$'))!;
  return (node as unknown as Record<string, Record<string, (...args: any[]) => void>>)[key];
}
const click = async (el: Element) => { await act(async () => { props(el).onClick({ preventDefault() {}, stopPropagation() {}, detail: 1, currentTarget: el }); }); };
const card = () => document.querySelector('[data-testid="change-card"]');

beforeAll(() => {
  const dom = parseHTML('<html><body></body></html>');
  Object.assign(dom.window, { innerHeight: 800, innerWidth: 1280 });
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
});
beforeEach(() => { apiGet.mockReset(); apiPost.mockReset(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('the change pill and its card', () => {
  async function draw(snap = snapshot()) {
    await act(async () => { root.render(createElement(ChangePill, { tag: TAG, snap, taskId: 'task-1', inline: true })); });
    return document.querySelector(`[data-tag="${TAG}"]`)!;
  }

  it('reads its name, a dot in its tone and the words of where it is', async () => {
    const pill = await draw();
    expect(pill.textContent!.replace(/\s+/g, ' ').trim()).toBe('CR-1001 · prod-w1 baking');
    expect(pill.getAttribute('data-tone')).toBe('waiting');
    expect(pill.getAttribute('role')).toBe('button');
    expect(pill.querySelector('.tag-chip-change-dot')!.getAttribute('data-tone')).toBe('waiting');
    expect(pill.tagName).not.toBe('A');
  });

  it('opens the card instead of the link, with the review, the rows and the fold', async () => {
    const pill = await draw();
    await click(pill);
    const c = card()!;
    expect(c).not.toBeNull();
    expect(c.querySelector('[data-testid="change-card-state"]')!.textContent).toBe('Merged');
    expect(c.querySelector('[data-testid="change-card-facts"]')!.textContent).toContain('1/1 approvals');
    expect([...c.querySelectorAll('[data-testid="change-stage"]')].map((r) => r.getAttribute('data-stage'))).toEqual(['beta-w1', 'prod-w1', 'prod-w2']);
    const fold = c.querySelector('[data-testid="change-stage-fold"]')!;
    expect(fold.textContent).toContain('8 more stages');
    await click(fold);
    expect(c.querySelectorAll('[data-testid="change-stage"]')).toHaveLength(11);
    expect(c.querySelector('[data-testid="change-card-open"]')!.getAttribute('href')).toBe(URL_CR);
    expect(c.querySelector('[data-testid="change-card-open-pipeline"]')!.getAttribute('href')).toBe('https://pipelines.acme.dev/acme-deployer');
    expect(c.querySelector('[data-testid="change-card-read"]')!.textContent).toBe('read 2 min ago');
  });

  it('opens a stage with its steps, read live, and says a timeout in words', async () => {
    apiGet.mockResolvedValueOnce({ detail: { stage: 'prod-w1', steps: [{ name: 'Integration Test', status: 'done', note: '6 passed', url: 'https://tests.acme.dev/1' }, { name: 'Bake Time', status: 'waiting' }], blockers: [{ kind: 'bake', text: '6 hours 59 minutes left' }] } });
    await click(await draw());
    const row = card()!.querySelector('[data-stage="prod-w1"] button')!;
    await click(row);
    expect(apiGet).toHaveBeenCalledWith('/api/tasks/task-1/changes/stage', { url: URL_CR, stage: 'prod-w1' }, expect.anything());
    await act(async () => { await Promise.resolve(); });
    const steps = [...card()!.querySelectorAll('[data-testid="change-stage-step"]')].map((s) => s.textContent);
    expect(steps).toEqual(['✓Integration Test 6 passed', '…Bake Time']);
    expect(card()!.querySelector('.change-card-blocker')!.textContent).toContain('6 hours 59 minutes left');

    apiGet.mockResolvedValueOnce({ detail: null, error: 'timeout' });
    const other = card()!.querySelector('[data-stage="beta-w1"] button')!;
    await click(other);
    await act(async () => { await Promise.resolve(); });
    expect(card()!.querySelector('[data-testid="change-stage-error"]')!.textContent).toContain('did not answer in time');
  });

  it('shows the read error and what the read before found', async () => {
    await click(await draw(snapshot({ error: { code: 'signed-out', message: 'Sign in again.' } })));
    expect(card()!.querySelector('[data-testid="change-card-error"]')!.textContent).toContain('signed out');
    expect(card()!.querySelector('[data-testid="change-stages"]')).not.toBeNull();
  });
});
