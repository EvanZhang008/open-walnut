/**
 * A session's servers list and its recovery status ask the server only while their page is on
 * show. App.tsx keeps the Home page mounted behind every other route (RouteShownContext false
 * there), so an open session panel on Home kept polling both while the person sat on Org:
 * measured on the dense fixture, 4 supervision reads and 3 servers reads a minute per panel.
 *
 * The same session can be on screen elsewhere (Org) while Home holds it hidden: the hidden copy
 * must not stop the visible one, and coming back asks at once and keeps what it already showed.
 * RouteShownContext null (any page that is not Home) stays shown.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { createElement, Fragment, act } from '../../web/node_modules/react/index.js';
import { createRoot } from '../../web/node_modules/react-dom/client.js';
import type { SessionSupervision } from '../../web/src/api/sessions';
import type { SessionServer, SessionServersResult } from '../../web/src/api/session-servers';
import type { SessionServersState } from '../../web/src/hooks/useSessionServers';
import type { SupervisionSnapshot } from '../../web/src/stores/session-supervision-store';

const serversApi = vi.hoisted(() => ({
  fetchSessionServers: vi.fn<(sid: string, signal?: AbortSignal) => Promise<SessionServersResult>>(),
  lastSessionServers: vi.fn<(sid: string) => SessionServersResult | undefined>(() => undefined),
  stopSessionServer: vi.fn(),
}));
vi.mock('@/api/session-servers', () => serversApi);
const sessionsApi = vi.hoisted(() => ({
  fetchSessionSupervision: vi.fn<(sid: string) => Promise<SessionSupervision>>(),
  setSessionSupervision: vi.fn(),
  terminateSession: vi.fn<(sid: string, opts?: { force?: boolean }) => Promise<{ status: 'terminated' | 'pending'; sessionId: string }>>(),
}));
vi.mock('@/api/sessions', () => sessionsApi);
vi.mock('@/api/client', () => ({ ApiError: class ApiError extends Error { status = 0; body: unknown; } }));
vi.mock('@/utils/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/hooks/useSessionStatus', () => ({ useActiveSessionCron: () => null }));
vi.mock('@/hooks/usePhoneLayout', () => ({ isPhoneLayout: () => false }));
// The real useEvent: one listener per mounted hook, added in an effect, so a burst reaches every copy.
const bus = vi.hoisted(() => new Map<string, Set<(data: unknown) => void>>());
vi.mock('@/hooks/useWebSocket', async () => {
  const React = await import('../../web/node_modules/react/index.js');
  return {
    useEvent: (name: string, callback: (data: unknown) => void) => {
      const ref = React.useRef(callback);
      ref.current = callback;
      React.useEffect(() => {
        const fn = (data: unknown) => ref.current(data);
        if (!bus.has(name)) bus.set(name, new Set());
        bus.get(name)!.add(fn);
        return () => { bus.get(name)!.delete(fn); };
      }, [name]);
    },
  };
});

const { RouteShownContext } = await import('../../web/src/contexts/RouteShownContext');
const { useSessionServers, SERVERS_POLL_SLOW_MS } = await import('../../web/src/hooks/useSessionServers');
const { useSessionSupervision } = await import('../../web/src/components/sessions/SessionSupervisionBar');
const { getSessionSupervision, stopSupervisedSession } = await import('../../web/src/stores/session-supervision-store');

const server = (port: number): SessionServer => ({
  port, addresses: ['127.0.0.1'], loopbackOnly: true, pid: 1000 + port, pgid: 1000 + port, name: 'node',
  command: 'node dev.js', ageSec: 1, via: 'env', kind: 'http', stopScope: 'group', url: `http://localhost:${port}/`,
});
const listed = (...ports: number[]): SessionServersResult => ({ state: 'ok', host: '__local__', servers: ports.map(server) });
const supervision = (generation: number, stop: 'pending' | null = null): SessionSupervision => ({
  available: true, startup: 'login',
  stopRequest: stop ? { id: 'stop-1', requestedAt: '2026-11-13T00:00:00.000Z', state: stop } : null,
  supervision: { enabled: true, state: 'watching', reason: null, generation, retryAt: null, updatedAt: 1 },
});

type Kind = 'servers' | 'supervision';
interface Copy { name: string; kind: Kind; shown: boolean | null }
const seenServers: Record<string, SessionServersState> = {};
const seenSupervision: Record<string, SupervisionSnapshot> = {};
function ServersProbe({ name }: { name: string }) { seenServers[name] = useSessionServers(sid, { enabled: true, fast: false }); return null; }
function SupervisionProbe({ name }: { name: string }) { seenSupervision[name] = useSessionSupervision(sid); return null; }
/** Every copy under its own page: `shown: false` is the hidden Home page, null a page that is not Home. */
function Tree({ copies }: { copies: Copy[] }) {
  return createElement(Fragment, null, ...copies.map((c) => createElement(
    RouteShownContext.Provider, { key: c.name, value: c.shown },
    createElement(c.kind === 'servers' ? ServersProbe : SupervisionProbe, { name: c.name }),
  )));
}

let root: ReturnType<typeof createRoot> | undefined;
let sid: string;
let hidden: boolean;
let sequence = 0;
async function draw(...copies: Copy[]) { await act(async () => { root!.render(createElement(Tree, { copies })); }); }
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function emit(name: string, data: unknown) { await act(async () => { for (const fn of [...(bus.get(name) ?? [])]) fn(data); }); }
const home = (kind: Kind, shown: boolean): Copy => ({ name: `home-${kind}`, kind, shown });
const org = (kind: Kind): Copy => ({ name: `org-${kind}`, kind, shown: null });

beforeAll(() => {
  const dom = parseHTML('<html><body></body></html>');
  Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
});
beforeEach(() => {
  vi.useFakeTimers();
  sid = `route-shown-${++sequence}`; hidden = false; bus.clear();
  for (const seen of [seenServers, seenSupervision]) for (const k of Object.keys(seen)) delete seen[k];
  serversApi.fetchSessionServers.mockReset().mockImplementation(async () => listed(3000));
  serversApi.lastSessionServers.mockReset().mockReturnValue(undefined);
  sessionsApi.fetchSessionSupervision.mockReset().mockImplementation(async () => supervision(1));
  sessionsApi.terminateSession.mockReset();
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('session servers off the page on show', () => {
  it('a panel on the hidden Home page asks nothing for a minute, through tab visibility changes', async () => {
    await draw(home('servers', false));
    await tick(60_000);
    hidden = true; await act(async () => { document.dispatchEvent(new window.Event('visibilitychange')); });
    hidden = false; await act(async () => { document.dispatchEvent(new window.Event('visibilitychange')); });
    await tick(60_000);
    expect(serversApi.fetchSessionServers).not.toHaveBeenCalled();
  });

  it('coming back keeps the list it showed and asks at once, then polls again', async () => {
    await draw(home('servers', true));
    expect(seenServers['home-servers'].servers.map((s) => s.port)).toEqual([3000]);
    await draw(home('servers', false));
    const atLeave = serversApi.fetchSessionServers.mock.calls.length;
    await tick(60_000);
    expect(serversApi.fetchSessionServers).toHaveBeenCalledTimes(atLeave);
    expect(seenServers['home-servers'].servers.map((s) => s.port)).toEqual([3000]);

    serversApi.fetchSessionServers.mockImplementation(async () => listed(3000, 4000));
    await draw(home('servers', true));
    expect(serversApi.fetchSessionServers).toHaveBeenCalledTimes(atLeave + 1);
    expect(seenServers['home-servers'].servers.map((s) => s.port)).toEqual([3000, 4000]);
    await tick(SERVERS_POLL_SLOW_MS);
    expect(serversApi.fetchSessionServers).toHaveBeenCalledTimes(atLeave + 2);
  });

  it('a reply that lands after the page went away starts no new poll', async () => {
    let answer!: (r: SessionServersResult) => void;
    serversApi.fetchSessionServers.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    await draw(home('servers', true));
    const signal = serversApi.fetchSessionServers.mock.calls[0][1]!;
    await draw(home('servers', false));
    expect(signal.aborted).toBe(true);
    await act(async () => { answer(listed(5000)); });
    await tick(60_000);
    expect(serversApi.fetchSessionServers).toHaveBeenCalledTimes(1);
    expect(seenServers['home-servers'].state).toBe('loading');
  });

  it('the same session shown on Org keeps its poll while Home holds it hidden, and Home leaving changes nothing', async () => {
    await draw(org('servers'), home('servers', true));
    await draw(org('servers'), home('servers', false));
    const start = serversApi.fetchSessionServers.mock.calls.length;
    await tick(3 * SERVERS_POLL_SLOW_MS);
    // Only Org's chain: one read per slow interval.
    expect(serversApi.fetchSessionServers.mock.calls.length - start).toBe(3);
    expect(seenServers['org-servers'].servers.map((s) => s.port)).toEqual([3000]);
  });
});

describe('session recovery status off the page on show', () => {
  it('a panel on the hidden Home page asks nothing for a minute, through status events and a reconnect burst', async () => {
    await draw(home('supervision', false), { name: 'home-supervision-2', kind: 'supervision', shown: false });
    await tick(60_000);
    await emit('session:status-changed', { sessionId: sid });
    for (let i = 0; i < 5; i++) await emit('_ws:reconnected', {});
    await tick(60_000);
    expect(sessionsApi.fetchSessionSupervision).not.toHaveBeenCalled();
  });

  it('coming back keeps the status it showed and asks at once', async () => {
    await draw(home('supervision', true));
    expect(seenSupervision['home-supervision'].value?.supervision?.generation).toBe(1);
    await draw(home('supervision', false));
    await tick(60_000);
    expect(sessionsApi.fetchSessionSupervision).toHaveBeenCalledTimes(1);
    expect(getSessionSupervision(sid).value?.supervision?.generation).toBe(1);

    sessionsApi.fetchSessionSupervision.mockImplementation(async () => supervision(2));
    await draw(home('supervision', true));
    expect(sessionsApi.fetchSessionSupervision).toHaveBeenCalledTimes(2);
    expect(seenSupervision['home-supervision'].value?.supervision?.generation).toBe(2);
    await emit('session:status-changed', { sessionId: sid });
    expect(sessionsApi.fetchSessionSupervision).toHaveBeenCalledTimes(3);
  });

  it('the same session shown on Org keeps its poll and its events while Home holds it hidden', async () => {
    await draw(org('supervision'), home('supervision', true));
    await draw(org('supervision'), home('supervision', false));
    const start = sessionsApi.fetchSessionSupervision.mock.calls.length;
    await tick(60_000);
    expect(sessionsApi.fetchSessionSupervision.mock.calls.length - start).toBe(4);
    // A reconnect reaches Org's copy only: one read, not one per copy.
    await emit('_ws:reconnected', {});
    expect(sessionsApi.fetchSessionSupervision.mock.calls.length - start).toBe(5);
    // Home coming back while Org already polls adds no read of its own.
    await draw(org('supervision'), home('supervision', true));
    expect(sessionsApi.fetchSessionSupervision.mock.calls.length - start).toBe(5);
  });

  it('a stop asked on Home that ends after Home went hidden is still shown on return', async () => {
    let done!: (r: { status: 'pending'; sessionId: string }) => void;
    sessionsApi.terminateSession.mockImplementation(() => new Promise((resolve) => { done = resolve; }));
    await draw(home('supervision', true));
    let stopped!: Promise<void>;
    await act(async () => { stopped = stopSupervisedSession(sid); });
    expect(seenSupervision['home-supervision'].stopping).toBe(true);
    await draw(home('supervision', false));
    sessionsApi.fetchSessionSupervision.mockImplementation(async () => supervision(1, 'pending'));
    await act(async () => { done({ status: 'pending', sessionId: sid }); await stopped; });
    expect(getSessionSupervision(sid).stopPending).toBe(true);
    // The read on return has not answered yet: what shows is what was kept, not a blank "loading".
    sessionsApi.fetchSessionSupervision.mockImplementation(() => new Promise(() => {}));
    await draw(home('supervision', true));
    expect(seenSupervision['home-supervision'].stopPending).toBe(true);
    expect(seenSupervision['home-supervision'].stopping).toBe(false);
    expect(seenSupervision['home-supervision'].loading).toBe(false);
  });
});
