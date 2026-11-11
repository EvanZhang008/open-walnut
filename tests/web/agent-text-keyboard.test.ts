import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { act, createElement } from '../../web/node_modules/react/index.js';
import { createRoot } from '../../web/node_modules/react-dom/client.js';

vi.mock('@/hooks/useEntityLabels', () => ({ useEntityLabelsVersion: () => 0 }));
vi.mock('@/hooks/useStableHtml', () => ({ useStableHtml: (html: string) => ({ __html: html }) }));
vi.mock('@/hooks/useAgentFileOpener', () => ({ useAgentFileOpener: () => ({ render: { images: false } }) }));
const clicks = vi.hoisted(() => ({ open: vi.fn(), claim: vi.fn() }));
vi.mock('@/utils/open-anywhere', () => ({ claimAgentLinkClick: clicks.claim }));
vi.mock('@/hooks/useEntityClickHandler', () => ({ useEntityClickHandler: () => clicks.open }));
vi.mock('@/utils/markdown', () => ({ renderMarkdownWithRefs: () => '<a href="#file" class="file-link">/tmp/design.png</a>' }));

const { AgentText } = await import('../../web/src/components/common/AgentText');

beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><body></body></html>');
  Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
});

describe('keyboard input on a linked agent path', () => {
  it('does not activate selected agent words or their parent row, but keeps keyboard and unrelated selections working', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const row = vi.fn();
    const original = Object.getOwnPropertyDescriptor(window, 'getSelection');
    let selection: { isCollapsed: boolean; anchorNode: Node | null; focusNode: Node | null } | null = null;
    Object.defineProperty(window, 'getSelection', { configurable: true, value: () => selection });
    clicks.open.mockClear();
    clicks.claim.mockClear();
    try {
      await act(async () => { root.render(createElement('div', { onClick: row }, createElement(AgentText, { text: '/tmp/design.png', compact: true }))); });
      const link = container.querySelector('a')!;
      const pointer = async (type: string, clientX: number) => {
        const event = new window.Event(type, { bubbles: true, cancelable: true });
        Object.assign(event, { button: 0, clientX, clientY: 20 });
        await act(async () => { link.dispatchEvent(event); });
      };
      const press = async (detail: number, clientX = 10, shiftKey = false) => {
        const event = new window.Event('click', { bubbles: true, cancelable: true });
        Object.assign(event, { detail, clientX, clientY: 20, shiftKey });
        await act(async () => { link.dispatchEvent(event); });
        return event.defaultPrevented;
      };
      selection = { isCollapsed: false, anchorNode: link.firstChild, focusNode: link.firstChild };
      await pointer('pointerdown', 10);
      await pointer('pointermove', 30);
      expect(await press(1, 30)).toBe(true);
      expect(clicks.open).not.toHaveBeenCalled();
      expect(clicks.claim).toHaveBeenCalledTimes(1);
      expect(row).not.toHaveBeenCalled();
      await pointer('pointerdown', 10);
      expect(await press(1)).toBe(false);
      expect(clicks.open).toHaveBeenCalledTimes(1);
      expect(clicks.claim).toHaveBeenCalledTimes(1);
      await pointer('pointerdown', 10);
      await pointer('pointermove', 30);
      await pointer('pointermove', 10);
      expect(await press(1)).toBe(true);
      expect(clicks.open).toHaveBeenCalledTimes(1);
      expect(clicks.claim).toHaveBeenCalledTimes(2);
      await pointer('pointerdown', 10);
      expect(await press(1, 10, true)).toBe(true);
      expect(clicks.open).toHaveBeenCalledTimes(1);
      expect(row).not.toHaveBeenCalled();
      await press(0);
      expect(clicks.open).toHaveBeenCalledTimes(2);
      selection = { isCollapsed: false, anchorNode: document.body, focusNode: document.body };
      await pointer('pointerdown', 10);
      await press(1, 30);
      expect(clicks.open).toHaveBeenCalledTimes(3);
      selection = { isCollapsed: true, anchorNode: link.firstChild, focusNode: link.firstChild };
      await pointer('pointerdown', 10);
      await press(1, 30);
      expect(clicks.open).toHaveBeenCalledTimes(4);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
      if (original) Object.defineProperty(window, 'getSelection', original);
      else Reflect.deleteProperty(window, 'getSelection');
    }
  });
  it('blocks only activation keys, so Escape reaches the file viewer after keyboard opening', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const seen = vi.fn();
    await act(async () => {
      root.render(createElement('div', { onKeyDown: (e: { key: string }) => seen(e.key) }, createElement(AgentText, { text: '/tmp/design.png', compact: true })));
    });
    try {
      const link = container.querySelector('a')!;
      for (const key of ['Enter', ' ', 'Escape', 'Tab', 'ArrowDown']) {
        const event = new window.Event('keydown', { bubbles: true });
        Object.assign(event, { key });
        await act(async () => { link.dispatchEvent(event); });
      }
      expect(seen.mock.calls.map(([key]) => key)).toEqual(['Escape', 'Tab', 'ArrowDown']);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });
});
