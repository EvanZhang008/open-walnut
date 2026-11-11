import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { act, createElement, useState } from '../../web/node_modules/react/index.js';
import { createRoot } from '../../web/node_modules/react-dom/client.js';

vi.mock('@/hooks/useSessionStatus', () => ({ useSessionStatus: () => ({ process_status: 'stopped' }) }));
vi.mock('@/hooks/useSessionSend', () => ({ useSessionSend: () => ({ send: vi.fn() }) }));
vi.mock('@/hooks/useMenuPlacement', () => ({ useMenuPlacement: () => ({}), menuPlacementStyle: () => ({}) }));
vi.mock('@/components/common/AgentText', () => ({ AgentText: () => createElement('a', { href: '#file' }, '/srv/notes.txt') }));
type Picture = { name: string };
const h = vi.hoisted(() => ({ answer: null as { value: string; onChange: (text: string) => void; pictures: { images: Picture[]; set: (images: Picture[]) => void } } | null }));
vi.mock('@/components/common/AnswerBox', () => ({ AnswerBox: (props: NonNullable<typeof h.answer>) => { h.answer = props; return null; } }));
vi.mock('@/components/common/image-attachments', () => ({ useImageAttachments: () => {
  const [images, set] = useState<Picture[]>([]);
  return { images, set, clear: () => set([]) };
} }));
vi.mock('@/api/sessions', () => ({ fetchSessionHistory: async () => ({ messages: [{ role: 'assistant', text: '/srv/notes.txt' }] }) }));
const { SessionTaskbar } = await import('../../web/src/components/sessions/SessionTaskbar');
const { OPEN_CENTER_EVENT, OPEN_FILE_EVENT } = await import('../../web/src/utils/open-anywhere');
const { DEFAULT_TASKBAR_SETTINGS } = await import('../../web/src/pages/sessionTaskbar');

beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><body></body></html>');
  Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
});

describe('a viewer opened from the minimized session card', () => {
  it.each([OPEN_FILE_EVENT, OPEN_CENTER_EVENT])('dismisses the card on %s, leaving its chip available to reopen', async (event) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(createElement(SessionTaskbar, { chips: ['session-1'], recent: [], tasks: [], onRestore: vi.fn(), onClose: vi.fn(), onCloseRecent: vi.fn(), onMove: vi.fn(), settings: DEFAULT_TASKBAR_SETTINGS })); });
      const peek = container.querySelector('.session-taskbar-peek')!;
      await act(async () => { peek.dispatchEvent(new window.Event('click', { bubbles: true })); });
      const card = document.querySelector('[data-testid="session-taskbar-card"]')!;
      expect(card).not.toBeNull();
      await act(async () => { h.answer!.onChange('Keep this unsent reply'); h.answer!.pictures.set([{ name: 'design.png' }]); });
      await act(async () => { card.querySelector('a')!.dispatchEvent(new window.Event('click', { bubbles: true })); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
      expect(document.querySelector('[data-testid="session-taskbar-card"]')).not.toBeNull();
      await act(async () => { window.dispatchEvent(new window.Event(event)); });
      expect(document.querySelector('[data-testid="session-taskbar-card"]')).toBeNull();
      expect(container.querySelector('.session-taskbar-chip')).not.toBeNull();
      await act(async () => { peek.dispatchEvent(new window.Event('click', { bubbles: true })); });
      expect(document.querySelector('[data-testid="session-taskbar-card"]')).not.toBeNull();
      expect(h.answer!.value).toBe('Keep this unsent reply');
      expect(h.answer!.pictures.images).toEqual([{ name: 'design.png' }]);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });
});
