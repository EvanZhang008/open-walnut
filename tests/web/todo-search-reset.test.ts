import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { act, createElement } from '../../web/node_modules/react/index.js';
import { createRoot } from '../../web/node_modules/react-dom/client.js';

vi.mock('@/hooks/usePhoneLayout', () => ({ usePhoneLayout: () => false }));
vi.mock('@/utils/log', () => ({ log: { info: vi.fn() } }));
vi.mock('../../web/src/components/tasks/PhoneSearchLayer', () => ({ PhoneSearchLayer: () => null }));
vi.mock('../../web/src/components/tasks/PhonePullToRefresh', () => ({ PhonePullToRefresh: () => null }));
vi.mock('../../web/src/components/tasks/PhoneQueuedUpdatesPill', () => ({ PhoneQueuedUpdatesPill: () => null }));

const { TodoSearchBar } = await import('../../web/src/components/tasks/TodoSearchBar');

beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><body></body></html>');
  Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
});

function harness() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onQueryChange = vi.fn();
  const onClear = vi.fn();
  return {
    onQueryChange,
    onClear,
    async render(query: string, resetVersion: number) {
      await act(async () => { root.render(createElement(TodoSearchBar, { query, resetVersion, onQueryChange, onClear, isSearching: false })); });
    },
    input() { return container.querySelector('input')!; },
    async type(value: string) {
      const input = this.input();
      const key = Object.keys(input).find((name) => name.startsWith('__reactProps$'))!;
      const props = (input as unknown as Record<string, { onChange: (event: unknown) => void }>)[key];
      await act(async () => { props.onChange({ target: { value } }); });
    },
    async clear() {
      await act(async () => { container.querySelector('button')!.dispatchEvent(new window.Event('click', { bubbles: true })); });
    },
    async unmount() { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

describe('task search input reset', () => {
  it('an external locate clears its input as well as the parent search, without emitting another query or moving focus', async () => {
    const h = harness();
    try {
      await h.render('Waiting task', 0);
      const input = h.input();
      const focus = vi.fn();
      input.focus = focus;
      await h.type('Waiting task details');
      await h.render('', 1);
      expect(input.value).toBe('');
      expect(h.input()).toBe(input);
      expect(h.onQueryChange.mock.calls).toEqual([['Waiting task details']]);
      expect(h.onClear).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      await h.type('Next task');
      await h.render('Next task', 1);
      expect(input.value).toBe('Next task');
      await h.render('', 2);
      expect(input.value).toBe('');
    } finally { await h.unmount(); }
  });

  it('delayed parent echoes never replace newer urgent typing, including typing after a reset', async () => {
    const h = harness();
    try {
      await h.render('', 0);
      await h.type('a');
      await h.type('ab');
      await h.render('a', 0);
      expect(h.input().value).toBe('ab');
      await h.render('ab', 0);
      await h.type('abc');
      await h.render('ab', 0);
      expect(h.input().value).toBe('abc');
      await h.render('', 1);
      await h.type('new');
      await h.render('', 1);
      expect(h.input().value).toBe('new');
      await h.render('new', 1);
      expect(h.input().value).toBe('new');
    } finally { await h.unmount(); }
  });

  it('the input clear button resets locally and invokes the existing parent clear', async () => {
    const h = harness();
    try {
      await h.render('Original', 0);
      await h.clear();
      expect(h.input().value).toBe('');
      expect(h.onClear).toHaveBeenCalledTimes(1);
      await h.type('After clearing');
      await h.render('', 0);
      expect(h.input().value).toBe('After clearing');
    } finally { await h.unmount(); }
  });
});
