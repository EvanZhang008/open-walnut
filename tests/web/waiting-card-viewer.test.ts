import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { act, createElement } from '../../web/node_modules/react/index.js';
import { createRoot } from '../../web/node_modules/react-dom/client.js';

vi.mock('@/hooks/useTaskTriggers', () => ({ useTaskTriggers: () => [] }));
vi.mock('@/hooks/useMenuPlacement', () => ({ useMenuPlacement: () => ({}), menuPlacementStyle: () => ({}) }));
vi.mock('@/components/common/AgentText', () => ({ AgentText: () => createElement('a', { href: '#file' }, '/srv/notes.txt') }));
vi.mock('@/components/tasks/TaskStatusControl', () => ({ formatWaitUntil: () => '', WAIT_UNTIL_ICON: 'W' }));
vi.mock('@/components/routines/TriggerPill', () => ({ triggerPillTitle: () => '' }));
const { WaitingChip } = await import('../../web/src/components/tasks/WaitingChip');
const { OPEN_CENTER_EVENT, OPEN_FILE_EVENT } = await import('../../web/src/utils/open-anywhere');

beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><body></body></html>');
  Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
});

describe('a viewer opened from the wait card', () => {
  it.each([OPEN_FILE_EVENT, OPEN_CENTER_EVENT, 'main:locate-task'])('closes the card only once %s takes over, clearing its pending hover timer', async (event) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const task = { id: 'task-1', phase: 'WAITING', user_status: { state: 'waiting', waitingOn: '/srv/notes.txt' } };
    try {
      await act(async () => { root.render(createElement(WaitingChip, { task } as never)); });
      const chip = container.querySelector('button')!;
      await act(async () => { chip.dispatchEvent(new window.Event('click', { bubbles: true })); });
      expect(document.querySelector('[data-testid="session-waiting-card"]')).not.toBeNull();
      const card = document.querySelector('[data-testid="session-waiting-card"]')!;
      await act(async () => { card.querySelector('a')!.dispatchEvent(new window.Event('click', { bubbles: true })); });
      await act(async () => { card.dispatchEvent(new window.Event('mouseout', { bubbles: true })); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
      expect(document.querySelector('[data-testid="session-waiting-card"]')).not.toBeNull();
      await act(async () => { chip.dispatchEvent(new window.Event('mouseover', { bubbles: true })); });
      await act(async () => { window.dispatchEvent(new window.Event(event)); });
      expect(document.querySelector('[data-testid="session-waiting-card"]')).toBeNull();
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
      expect(document.querySelector('[data-testid="session-waiting-card"]')).toBeNull();
      await act(async () => { chip.dispatchEvent(new window.Event('click', { bubbles: true })); });
      expect(document.querySelector('[data-testid="session-waiting-card"]')).not.toBeNull();
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  });
});
