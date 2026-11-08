import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { createElement, memo, act, useState } from '../../web/node_modules/react/index.js';
import { createRoot } from '../../web/node_modules/react-dom/client.js';

// A plugin re-renders its page often: the Interview Practice editor on every keystroke, its clock
// every second. `walnut.ui.views.SessionView` handed the memo'd session panel a new closure on each
// of those renders, so the whole embedded panel (composer, header, hooks) rendered again every
// time: on 2026-11-08 that was about 0.3 MB of garbage a keystroke and the bulk of the page's
// allocation while idle, on a page whose memory grew about 1 GB an hour. The panel must see the
// same props until something it shows changes, and its callbacks must still reach the plugin's
// latest ones.

const panelRenders: Array<Record<string, unknown>> = [];
vi.mock('@/components/sessions/SessionPanel', () => ({
  SessionPanel: memo((props: Record<string, unknown>) => { panelRenders.push(props); return null; }),
}));
for (const mod of [
  '@/pages/CalendarPage', '@/pages/NotesPage', '@/components/sessions/SessionFileExplorer', '@/components/sessions/SessionTerminal',
  '@/components/tasks/TaskViewSurface', '@/components/chat/PluginChatView', '@/components/chat/AskObjectDrawer',
  '@/components/settings/PluginSettingsForm', '@/components/common/BoxMic', '@/components/content/ContentActionButtons',
]) vi.doMock(mod, () => new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : () => null) }));
const { createPluginViews } = await import('../../web/src/plugins/views');

let root: ReturnType<typeof createRoot>;
let host: HTMLElement;
beforeAll(() => {
  const dom = parseHTML('<html><body></body></html>');
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
});
beforeEach(() => { panelRenders.length = 0; host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); });

describe('plugin SessionView', () => {
  it('renders the session panel once across many plugin re-renders with fresh callbacks', async () => {
    const { SessionView } = createPluginViews('acme');
    const closes: number[] = [];
    let bump: () => void = () => {};
    // A plugin page that passes a new arrow every render, as real ones do.
    function Page() {
      const [n, setN] = useState(0);
      bump = () => setN((v) => v + 1);
      return createElement(SessionView, { sessionId: 's-1', onClose: () => closes.push(n), onToggleLock: () => closes.push(-n) });
    }
    await act(async () => { root.render(createElement(Page)); });
    for (let i = 0; i < 50; i++) await act(async () => { bump(); });
    expect(panelRenders).toHaveLength(1);
    // The stable callbacks still call the plugin's latest ones.
    const props = panelRenders[0] as { onClose: () => void; onToggleLock?: () => void; viewPlace: string };
    expect(props.viewPlace).toBe('plugin:acme');
    props.onClose();
    props.onToggleLock?.();
    expect(closes).toEqual([50, -50]);
  });

  it('renders again when what the panel shows changes, and offers no lock toggle when the plugin gives none', async () => {
    const { SessionView } = createPluginViews('acme');
    await act(async () => { root.render(createElement(SessionView, { sessionId: 's-1', onClose: () => {} })); });
    await act(async () => { root.render(createElement(SessionView, { sessionId: 's-2', onClose: () => {} })); });
    await act(async () => { root.render(createElement(SessionView, { sessionId: 's-2', onClose: () => {}, locked: true })); });
    expect(panelRenders.map((p) => [p.sessionId, p.locked ?? false])).toEqual([['s-1', false], ['s-2', false], ['s-2', true]]);
    expect(panelRenders.every((p) => p.onToggleLock === undefined)).toBe(true);
  });
});
