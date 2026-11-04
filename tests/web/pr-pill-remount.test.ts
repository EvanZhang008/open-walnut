import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { createElement, Fragment, act } from '../../web/node_modules/react/index.js';
import { createRoot } from '../../web/node_modules/react-dom/client.js';
import type { Task } from '@open-walnut/core';

// A row drawn anew (a task moving to another section) mounts its pill anew. These tests cover
// the card's open state across that remount; placement and pixels are the browser's
// (tests/e2e/browser/pr-status-pill.spec.ts).
const anchorLost: Array<() => void> = [];
vi.mock('@/hooks/useMenuPlacement', () => ({
  useMenuPlacement: (_open: boolean, _t: unknown, _m: unknown, o: { onAnchorLost?: () => void }) => {
    if (o.onAnchorLost) anchorLost.push(o.onAnchorLost);
    return { top: 10, left: 10, maxHeight: 400, side: 'down' };
  },
  menuPlacementStyle: () => ({}),
}));
vi.mock('@/hooks/useKeyboardOpenFocus', () => ({ useKeyboardOpenFocus: () => () => {} }));
vi.mock('@/hooks/usePhoneLayout', () => ({ usePhoneLayout: () => false }));
vi.mock('@/contexts/TasksContext', () => ({ useStoreTask: () => null }));
vi.mock('@/api/tasks', () => ({ completeTask: vi.fn().mockResolvedValue({}) }));
vi.mock('@/api/client', () => ({
  apiGet: vi.fn().mockResolvedValue({ watching: true, autoComplete: true, wake: true, prs: [] }),
  apiPatch: vi.fn().mockResolvedValue({}),
  apiPost: vi.fn().mockResolvedValue({}),
}));
const { PrPill } = await import('../../web/src/components/tasks/PrPill');

const task = (id: string): Task => ({ id, title: 'Remount check', tags: [`pr:https://github.com/acme/remount/pull/${id.length}`] } as unknown as Task);

let root: ReturnType<typeof createRoot>;
let host: HTMLElement;
/** Draws the pill under a row key: a new key is a new row, so a new pill. */
async function draw(id: string, rowKey: string) {
  await act(async () => { root.render(createElement(Fragment, { key: rowKey }, createElement(PrPill, { task: task(id) }))); });
}
function props(node: Element): Record<string, (...args: any[]) => void> {
  const key = Object.keys(node).find((name) => name.startsWith('__reactProps$'))!;
  return (node as unknown as Record<string, Record<string, (...args: any[]) => void>>)[key];
}
async function clickPill() {
  const pill = document.querySelector('[data-testid="pr-pill"]')!;
  await act(async () => { props(pill).onClick({ preventDefault() {}, stopPropagation() {}, detail: 1, currentTarget: pill }); });
}
const cardOpen = () => !!document.querySelector('[data-testid="pr-card"]');

beforeAll(() => {
  const dom = parseHTML('<html><body></body></html>');
  Object.assign(dom.window, { innerHeight: 800, innerWidth: 1280 });
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
});
beforeEach(() => { anchorLost.length = 0; host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

describe('the pull request card across a row drawn anew', () => {
  it('stays open when its row is replaced in one render', async () => {
    await draw('t-replace', 'a');
    await clickPill();
    expect(cardOpen()).toBe(true);
    await draw('t-replace', 'b');
    expect(cardOpen()).toBe(true);
  });

  it('stays open when the old trigger left the page first', async () => {
    await draw('t-lost', 'a');
    await clickPill();
    await act(async () => { anchorLost.at(-1)!(); });
    expect(cardOpen()).toBe(false);
    await draw('t-lost', 'b');
    expect(cardOpen()).toBe(true);
  });

  it('stays closed when it was closed, or when the row comes back long after', async () => {
    await draw('t-closed', 'a');
    await draw('t-closed', 'b');
    expect(cardOpen()).toBe(false);

    vi.useFakeTimers({ toFake: ['Date'] });
    await draw('t-late', 'a');
    await clickPill();
    await act(async () => root.render(createElement(Fragment, null)));
    vi.setSystemTime(Date.now() + 20_000);
    await draw('t-late', 'b');
    expect(cardOpen()).toBe(false);
  });

  it('opens on one new pill only, and not on another task', async () => {
    await draw('t-one', 'a');
    await clickPill();
    await act(async () => {
      root.render(createElement(Fragment, { key: 'b' },
        createElement(PrPill, { task: task('t-other') }), createElement(PrPill, { task: task('t-one') }), createElement(PrPill, { task: task('t-one') })));
    });
    const expanded = [...document.querySelectorAll('[data-testid="pr-pill"]')].map((el) => el.getAttribute('aria-expanded'));
    expect(expanded).toEqual(['false', 'true', 'false']);
    expect(document.querySelectorAll('[data-testid="pr-card"]').length).toBe(1);
  });
});
