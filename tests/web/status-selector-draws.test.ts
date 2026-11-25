/**
 * The one-field status readers (useHostStatusOf in web/src/hooks/useHostStatus.ts, useSessionStatusOf
 * in web/src/hooks/useSessionStatus.ts), through the stores' real subscriptions: a view draws again
 * when the field it reads changes, and never for a frame that changes only the rest.
 *
 * Why (2026-11-25, task 9bceb9f2): every host frame carries the server's clock and every session
 * status write a new revision, so a session panel that kept the whole status drew its body (over a
 * thousand hooks), and the chat beside it its history, for every one.
 */
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import type { HostStatus } from '@/api/hosts';
import type { SessionStatusSnapshot } from '../../web/src/stores/session-status-store';

vi.mock('@/api/hosts', () => ({
  fetchHostStatus: vi.fn(() => new Promise(() => {})),
  connectHost: vi.fn(),
  checkHostReadiness: vi.fn(),
}));
vi.mock('@/api/ws', () => ({
  wsClient: { state: 'connected', onEvent() {}, offEvent() {}, onConnectionChange() {}, offConnectionChange() {}, subscribeAll: () => () => {} },
}));

type ReactModule = typeof import('../../web/node_modules/react/index.js');
let React: ReactModule;
let root: { render(node: unknown): void; unmount(): void };
let host: HTMLElement;
let hosts: typeof import('../../web/src/hooks/useHostStatus');
let sessions: typeof import('../../web/src/hooks/useSessionStatus');
let store: typeof import('../../web/src/stores/session-status-store')['sessionStatusStore'];
let seen: Array<{ connected: boolean | null; process: string | undefined }>;

const SID = 'provider-session-sel';
const connectedOf = (s: HostStatus | undefined) => (s ? s.connected === true : null);
const processOf = (s: { process_status?: string } | null) => s?.process_status;

function View() {
  const connected = hosts.useHostStatusOf('box', connectedOf);
  const process = sessions.useSessionStatusOf(SID, processOf);
  seen.push({ connected, process });
  return null;
}

function frame(at: number, connected: boolean): HostStatus {
  return { host: 'box', label: 'Box', phase: connected ? 'connected' : 'failed', connected, at, serverNow: at } as unknown as HostStatus;
}

function status(revision: number, process_status: 'idle' | 'running'): SessionStatusSnapshot {
  return {
    sessionId: SID, taskId: 'task-sel', process_status, activity: null, mode: 'bypass', planCompleted: false,
    archived: false, errorMessage: null, provider: 'cli', engine: 'claude', pendingPermissionTool: null,
    statusRevision: revision, statusUpdatedAt: new Date(1_800_000_000_000 + revision * 1000).toISOString(),
  };
}

beforeAll(() => {
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(async () => {
  vi.resetModules();
  React = await import('../../web/node_modules/react/index.js');
  const { createRoot } = await import('../../web/node_modules/react-dom/client.js');
  hosts = await import('../../web/src/hooks/useHostStatus');
  sessions = await import('../../web/src/hooks/useSessionStatus');
  store = (await import('../../web/src/stores/session-status-store')).sessionStatusStore;
  seen = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host) as typeof root;
  await React.act(async () => {
    hosts.seedHostStatus(frame(1, true));
    store.applyVersioned(status(1, 'idle'), 'ws');
    root.render(React.createElement(View));
  });
});

afterEach(async () => {
  await React.act(async () => { root.unmount(); });
  host.remove();
});

const act = (fn: () => void) => React.act(async () => { fn(); });

describe('one-field status readers', () => {
  it('a host frame that moves only its clock draws nothing; one that changes the field draws', async () => {
    expect(seen.at(-1)).toEqual({ connected: true, process: 'idle' });
    const drawn = seen.length;
    await act(() => hosts.seedHostStatus(frame(2, true)));
    await act(() => hosts.seedHostStatus(frame(3, true)));
    expect(seen.length).toBe(drawn);
    await act(() => hosts.seedHostStatus(frame(4, false)));
    expect(seen.length).toBe(drawn + 1);
    expect(seen.at(-1)!.connected).toBe(false);
  });

  it('a status write that moves only its revision draws nothing; a new process status draws', async () => {
    const drawn = seen.length;
    await act(() => { store.applyVersioned(status(2, 'idle'), 'ws'); });
    await act(() => { store.applyVersioned(status(3, 'idle'), 'ws'); });
    expect(seen.length).toBe(drawn);
    await act(() => { store.applyVersioned(status(4, 'running'), 'ws'); });
    expect(seen.length).toBe(drawn + 1);
    expect(seen.at(-1)!.process).toBe('running');
  });
});
