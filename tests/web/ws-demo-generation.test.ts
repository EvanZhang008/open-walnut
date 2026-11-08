import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const check = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('../../web/src/utils/demo-generation', () => ({ isDemoOrigin: () => true, initDemoGeneration: check.init, demoPageGeneration: () => 'first' }));
let socket: { readyState: number; onopen: (() => void) | null; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
let reload: ReturnType<typeof vi.fn>;
let client: typeof import('../../web/src/api/ws')['wsClient'];
beforeEach(async () => {
  vi.resetModules(); check.init.mockReset(); reload = vi.fn();
  const Fake = function () {
    socket = { readyState: 0, onopen: null, send: vi.fn(), close: vi.fn() };
    return socket;
  } as unknown as typeof WebSocket;
  (Fake as unknown as { OPEN: number }).OPEN = 1;
  vi.stubGlobal('WebSocket', Fake);
  vi.stubGlobal('window', { location: { protocol: 'http:', host: '127.0.0.1:3458', reload } });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  client = (await import('../../web/src/api/ws')).wsClient;
});
afterEach(() => { client.disconnect(); vi.unstubAllGlobals(); });

describe('Demo generation check before socket admission', () => {
  it('queues RPCs on an OPEN socket until the generation is confirmed', async () => {
    let answer!: (changed: boolean) => void;
    check.init.mockReturnValue(new Promise<boolean>(resolve => { answer = resolve; }));
    client.connect(); socket.readyState = 1; socket.onopen!();
    const call = client.sendRpc('session:send', { message: 'old draft' }).catch(error => error);
    expect(socket.send).not.toHaveBeenCalled();
    answer(true); await Promise.resolve(); await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(socket.send).not.toHaveBeenCalled();
    expect(await call).toMatchObject({ message: 'WebSocket disposed' });
  });

  it('keeps the connection when a restart kept the same generation', async () => {
    check.init.mockResolvedValue(false);
    client.connect(); socket.readyState = 1; socket.onopen!();
    const call = client.sendRpc('session:send', { message: 'kept draft' }).catch(error => error);
    expect(socket.send).not.toHaveBeenCalled();
    await Promise.resolve(); await Promise.resolve();
    expect(client.state).toBe('connected');
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    client.disconnect(); await call;
  });
});
