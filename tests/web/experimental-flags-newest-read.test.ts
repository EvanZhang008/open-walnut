/**
 * The page's one copy of `config.experimental` (web/src/hooks/useExperimental.ts): the newest
 * read always wins.
 *
 * Two ways an older value used to stay on the page (2026-11-17, found while checking whether
 * tests/e2e/browser/apps-page.spec.ts read apps_stay_open as off; that flake had another cause):
 *   - a `config:changed` that arrived while a read was out joined that read, whose answer may
 *     predate the change, so the newer value was never read;
 *   - a reconnect read again from the connection-state callback, which runs BEFORE
 *     `_ws:reconnected` drops the shared answer (web/src/api/shared-get.ts), so it got the
 *     answer of a moment ago, from before the socket went down.
 * These run the real shared GET and config client over a fake socket and a fake server whose
 * reads answer when the test says, in the order the test says.
 */
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';

type Flags = Record<string, boolean>;

const server = vi.hoisted(() => {
  const reads: Array<{ answer: (experimental: Flags) => void; fail: () => void }> = [];
  return {
    reads,
    get: (path: string) => new Promise((resolve, reject) => {
      if (path !== '/api/config') { reject(new Error(`unexpected GET ${path}`)); return; }
      reads.push({ answer: (experimental) => resolve({ config: { experimental } }), fail: () => reject(new TypeError('Failed to fetch')) });
    }),
  };
});

const ws = vi.hoisted(() => {
  const named = new Map<string, Set<(data: unknown) => void>>();
  const any = new Set<(name: string, data: unknown) => void>();
  const states = new Set<(state: string) => void>();
  const client = {
    state: 'connected',
    onEvent(name: string, cb: (data: unknown) => void) {
      let set = named.get(name);
      if (!set) named.set(name, set = new Set());
      set.add(cb);
    },
    offEvent(name: string, cb: (data: unknown) => void) { named.get(name)?.delete(cb); },
    subscribeAll(cb: (name: string, data: unknown) => void) { any.add(cb); return () => { any.delete(cb); }; },
    onConnectionChange(cb: (state: string) => void) { states.add(cb); },
    offConnectionChange(cb: (state: string) => void) { states.delete(cb); },
  };
  /** An event as web/src/api/ws.ts dispatches it: wildcard listeners first, then named ones. */
  function emit(name: string, data: unknown) {
    for (const cb of [...any]) cb(name, data);
    for (const cb of [...(named.get(name) ?? [])]) cb(data);
  }
  function setState(state: string) {
    client.state = state;
    for (const cb of [...states]) cb(state);
  }
  return {
    client,
    emit,
    /** A reconnect in ws.ts's order: the state change, then `_ws:reconnected`. */
    reconnect() { setState('disconnected'); setState('connected'); emit('_ws:reconnected', {}); },
    reset() { named.clear(); any.clear(); states.clear(); client.state = 'connected'; },
  };
});

vi.mock('@/api/client', () => ({ apiGet: vi.fn(server.get), apiPut: vi.fn(), apiPost: vi.fn() }));
vi.mock('@/api/ws', () => ({ wsClient: ws.client }));
vi.mock('@/api/leader-presence', () => ({ noteReplicaConfig: () => {} }));
// A test run's tab: nothing is read from or kept in localStorage.
vi.mock('@/api/test-run', () => ({ testRunLabel: () => 'unit-test' }));

type ReactModule = typeof import('../../web/node_modules/react/index.js');
let React: ReactModule;
let root: { render(node: unknown): void; unmount(): void };
let host: HTMLElement;
let seen: boolean[][];
let useExperimental: typeof import('../../web/src/hooks/useExperimental')['useExperimental'];

/** A view reading the experiment; `slot` keeps what each view showed apart. */
function Probe({ slot }: { slot: number }) {
  (seen[slot] ??= []).push(useExperimental('apps_stay_open'));
  return null;
}

beforeAll(() => {
  const dom = parseHTML('<!doctype html><html><body></body></html>');
  Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
});

beforeEach(async () => {
  // The hook keeps one copy per page: each test is a new page.
  vi.resetModules();
  server.reads.length = 0;
  ws.reset();
  React = await import('../../web/node_modules/react/index.js');
  const { createRoot } = await import('../../web/node_modules/react-dom/client.js');
  ({ useExperimental } = await import('../../web/src/hooks/useExperimental'));
  seen = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host) as typeof root;
});

afterEach(async () => {
  await React.act(async () => { root.unmount(); });
  host.remove();
});

async function mount(views = 1): Promise<void> {
  const nodes = Array.from({ length: views }, (_, slot) => React.createElement(Probe, { key: slot, slot }));
  await React.act(async () => { root.render(React.createElement(React.Fragment, null, nodes)); });
}

/** Lets every answer given so far reach the views. */
async function settle(): Promise<void> {
  await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const shown = (view = 0) => seen[view]?.at(-1);

describe('useExperimental: the newest read wins', () => {
  it('a change announced while the first read is out is read again, and its answer shows', async () => {
    await mount();
    expect(server.reads).toHaveLength(1);
    // The flag is turned on while the first read is out; that read answered from before.
    ws.emit('config:changed', { config: {} });
    server.reads[0]!.answer({ apps_stay_open: false });
    await settle();
    server.reads.at(-1)!.answer({ apps_stay_open: true });
    await settle();
    expect(server.reads).toHaveLength(2);
    expect(shown()).toBe(true);
  });

  it('an older answer that lands after a newer one never replaces it', async () => {
    await mount();
    ws.emit('config:changed', { config: {} });
    expect(server.reads).toHaveLength(2);
    const [older, newer] = server.reads;
    newer!.answer({ apps_stay_open: true });
    await settle();
    older!.answer({ apps_stay_open: false });
    await settle();
    expect(shown()).toBe(true);
  });

  it('a reconnect reads the server again, never the shared answer of a moment ago', async () => {
    await mount();
    server.reads[0]!.answer({ apps_stay_open: false });
    await settle();
    expect(shown()).toBe(false);
    // Turned on while the socket was down: its config:changed never arrived.
    ws.reconnect();
    await settle();
    expect(server.reads).toHaveLength(2);
    server.reads[1]!.answer({ apps_stay_open: true });
    await settle();
    expect(shown()).toBe(true);
  });

  it('a change for another key reads nothing', async () => {
    await mount();
    server.reads[0]!.answer({ apps_stay_open: true });
    await settle();
    ws.emit('config:changed', { key: 'hosts', config: {} });
    await settle();
    expect(server.reads).toHaveLength(1);
    expect(shown()).toBe(true);
  });

  it('views that mount while a read is out join it: one request for the page', async () => {
    await mount(3);
    expect(server.reads).toHaveLength(1);
    server.reads[0]!.answer({ apps_stay_open: true });
    await settle();
    expect([shown(0), shown(1), shown(2)]).toEqual([true, true, true]);
  });
});
