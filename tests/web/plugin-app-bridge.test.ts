/**
 * Plugin-app postMessage bridge (web/src/pages/pluginAppBridge.ts).
 *
 * The bridge is the ONLY channel a plugin app has: it runs in an iframe
 * sandboxed without allow-same-origin, so it cannot fetch /api itself, read the
 * device token, or touch localStorage. That makes three things load-bearing and
 * worth pinning:
 *
 *   1. Only OUR iframe is heard. `event.source` is the browser's unforgeable
 *      handle on the sender; a message from any other window must be dropped
 *      even though a sandboxed frame legitimately reports origin "null".
 *   2. Replies target '*'. An opaque origin cannot be addressed by a concrete
 *      origin string (passing 'null' throws), so the pattern is: identity check
 *      on the way in, wildcard on the way out.
 *   3. Config WRITES are refused. Full API access is the product intent, but
 *      provider credentials change in Settings by a human, never from an
 *      embedded page. Reads of /api/config stay allowed.
 *
 * Runs under the node-env base config: no DOM is needed because the bridge takes
 * every capability as a callback, and MessageEvent is faked as a plain object.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createPluginAppBridge,
  validateApiRequest,
  MAX_EVENT_PREFIXES,
  type BridgeContext,
} from '../../web/src/pages/pluginAppBridge';

interface FakeFrame {
  postMessage: (msg: unknown, targetOrigin: string) => void;
  sent: Array<{ msg: Record<string, unknown>; targetOrigin: string }>;
}

function fakeFrame(): FakeFrame {
  const sent: FakeFrame['sent'] = [];
  return {
    sent,
    postMessage: (msg, targetOrigin) => {
      sent.push({ msg: msg as Record<string, unknown>, targetOrigin });
    },
  };
}

interface Harness {
  setTheme: (t: 'light' | 'dark') => void;
  frame: FakeFrame;
  bridge: ReturnType<typeof createPluginAppBridge>;
  apiCall: ReturnType<typeof vi.fn>;
  warnings: Array<{ message: string; data?: Record<string, unknown> }>;
  navigated: string[];
  emit: (name: string, data: unknown) => void;
  subscribeCount: () => number;
  unsubscribeCount: () => number;
  /** Deliver a message as if it came from our iframe (origin "null"). */
  fromFrame: (data: unknown) => void;
  fromSource: (source: unknown, data: unknown, origin?: string) => void;
}

function harness(opts?: { apiCall?: (m: string, p: string, b?: unknown) => Promise<unknown> }): Harness {
  const frame = fakeFrame();
  const warnings: Harness['warnings'] = [];
  const navigated: string[] = [];
  let sink: ((name: string, data: unknown) => void) | null = null;
  let subscribes = 0;
  let unsubscribes = 0;
  const apiCall = vi.fn(opts?.apiCall ?? (() => Promise.resolve({ ok: true })));

  let theme: 'light' | 'dark' = 'dark';
  const ctx: BridgeContext = {
    appId: 'demo-app',
    pluginId: 'demo-plugin',
    getTheme: () => theme,
    getFrameWindow: () => frame as unknown as Window,
    apiCall: apiCall as unknown as BridgeContext['apiCall'],
    subscribeAll: (cb) => {
      subscribes++;
      sink = cb;
      return () => { unsubscribes++; sink = null; };
    },
    navigate: (p) => navigated.push(p),
    logWarn: (message, data) => warnings.push({ message, data }),
  };

  const bridge = createPluginAppBridge(ctx);
  return {
    frame, bridge, apiCall, warnings, navigated,
    setTheme: (t: 'light' | 'dark') => { theme = t; },
    emit: (name, data) => sink?.(name, data),
    subscribeCount: () => subscribes,
    unsubscribeCount: () => unsubscribes,
    fromFrame: (data) => bridge.handleMessage({ source: frame, origin: 'null', data } as unknown as MessageEvent),
    fromSource: (source, data, origin = 'null') =>
      bridge.handleMessage({ source, origin, data } as unknown as MessageEvent),
  };
}

/** Wait for the bridge's promise chain (apiCall → post) to settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('validateApiRequest', () => {
  it('accepts every method under /api/', () => {
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(validateApiRequest(m, '/api/tasks')).toMatchObject({ ok: true, method: m, path: '/api/tasks' });
    }
  });

  it('rejects a non-/api path, a non-string path and an unknown method', () => {
    expect(validateApiRequest('GET', '/etc/passwd')).toMatchObject({ ok: false });
    expect(validateApiRequest('GET', 'api/tasks')).toMatchObject({ ok: false });
    expect(validateApiRequest('GET', undefined)).toMatchObject({ ok: false });
    expect(validateApiRequest('TRACE', '/api/tasks')).toMatchObject({ ok: false });
  });

  it('rejects traversal SEGMENTS but not a filename that merely contains dots', () => {
    expect(validateApiRequest('GET', '/api/files/../../secret')).toMatchObject({ ok: false });
    expect(validateApiRequest('GET', '/api/file-content?path=mod..old/thing.ts')).toMatchObject({ ok: true });
  });

  it('allows reading config but refuses every config write', () => {
    expect(validateApiRequest('GET', '/api/config')).toMatchObject({ ok: true });
    expect(validateApiRequest('GET', '/api/config/test-connection')).toMatchObject({ ok: true });
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(validateApiRequest(m, '/api/config')).toMatchObject({ ok: false });
      expect(validateApiRequest(m, '/api/config/providers')).toMatchObject({ ok: false });
    }
    // Query strings must not launder the check.
    expect(validateApiRequest('POST', '/api/config?x=1')).toMatchObject({ ok: false });
  });

  // Regression: a literal string check and fetch()'s URL normalizer disagreed, so
  // each of these passed validation and then landed on the real config-write route.
  it('refuses config writes that only reach /api/config after URL normalization', () => {
    for (const path of [
      '/api/x/%2e%2e/config',
      '/api/./config',
      '/api/x/..\\config',
      '/api/x/.%2e/config',
      '/api/x/../config',
      '/api/x/%2E%2E/config/providers',
    ]) {
      expect(validateApiRequest('PUT', path), `must refuse ${path}`).toMatchObject({ ok: false });
    }
  });

  it('returns the NORMALIZED path so the guard and the HTTP client cannot diverge', () => {
    expect(validateApiRequest('GET', '/api/x/../tasks')).toMatchObject({ ok: true, path: '/api/tasks' });
    expect(validateApiRequest('GET', '/api/./tasks?limit=5')).toMatchObject({ ok: true, path: '/api/tasks?limit=5' });
    // Normalizing out of /api/ entirely is still a refusal.
    expect(validateApiRequest('GET', '/api/../secret')).toMatchObject({ ok: false });
  });
});

describe('handshake', () => {
  it('answers walnut:ready with init carrying appId/pluginId/theme, targeted at *', () => {
    const h = harness();
    h.fromFrame({ type: 'walnut:ready' });
    expect(h.frame.sent).toHaveLength(1);
    expect(h.frame.sent[0].targetOrigin).toBe('*');
    expect(h.frame.sent[0].msg).toEqual({
      type: 'walnut:init',
      payload: { appId: 'demo-app', pluginId: 'demo-plugin', theme: 'dark' },
    });
  });

  it('ignores a message from any window that is not our iframe', () => {
    const h = harness();
    h.fromSource({ postMessage: () => {} }, { type: 'walnut:ready' });
    expect(h.frame.sent).toHaveLength(0);
  });

  it('ignores a foreign concrete origin even when the source matches', () => {
    const h = harness();
    h.fromSource(h.frame, { type: 'walnut:ready' }, 'https://evil.example');
    expect(h.frame.sent).toHaveLength(0);
    expect(h.warnings.map((w) => w.message)).toContain('rejected message from unexpected origin');
  });

  it('ignores non-walnut and malformed messages without replying', () => {
    const h = harness();
    h.fromFrame({ type: 'webpackHotUpdate' });
    h.fromFrame('a string');
    h.fromFrame(null);
    h.fromFrame({ noType: 1 });
    expect(h.frame.sent).toHaveLength(0);
    expect(h.warnings).toHaveLength(0);
  });

  it('warns on an unknown walnut:* message', () => {
    const h = harness();
    h.fromFrame({ type: 'walnut:teleport' });
    expect(h.warnings.map((w) => w.message)).toContain('unknown bridge message');
  });
});

describe('walnut:api', () => {
  it('dispatches an allowed call and replies with the data under the same id', async () => {
    const h = harness({ apiCall: () => Promise.resolve([{ id: 't1' }]) });
    h.fromFrame({ type: 'walnut:api', id: 'a1', method: 'GET', path: '/api/tasks' });
    await flush();
    expect(h.apiCall).toHaveBeenCalledWith('GET', '/api/tasks', undefined);
    // No `status` on success: the client helpers hand back only the parsed body,
    // so the host does not know the code and must not invent one. The failure
    // path below is where a real status exists and is reported.
    expect(h.frame.sent[0].msg).toEqual({
      type: 'walnut:api-result', id: 'a1', ok: true, data: [{ id: 't1' }],
    });
  });

  it('forwards the body on a write', async () => {
    const h = harness();
    h.fromFrame({ type: 'walnut:api', id: 'a2', method: 'POST', path: '/api/tasks', body: { title: 'x' } });
    await flush();
    expect(h.apiCall).toHaveBeenCalledWith('POST', '/api/tasks', { title: 'x' });
  });

  it('refuses a blocked path WITHOUT calling the API, and still answers the id', async () => {
    const h = harness();
    h.fromFrame({ type: 'walnut:api', id: 'a3', method: 'POST', path: '/api/config' });
    await flush();
    expect(h.apiCall).not.toHaveBeenCalled();
    expect(h.frame.sent[0].msg).toMatchObject({ type: 'walnut:api-result', id: 'a3', ok: false });
    expect(String(h.frame.sent[0].msg.error)).toContain('Settings');
  });

  it('propagates an ApiError-shaped status/message', async () => {
    const err = Object.assign(new Error('Not found'), { status: 404 });
    const h = harness({ apiCall: () => Promise.reject(err) });
    h.fromFrame({ type: 'walnut:api', id: 'a4', method: 'GET', path: '/api/tasks/zzz' });
    await flush();
    expect(h.frame.sent[0].msg).toEqual({
      type: 'walnut:api-result', id: 'a4', ok: false, status: 404, error: 'Not found',
    });
  });

  it('drops an api message with no id (there is nobody to answer)', async () => {
    const h = harness();
    h.fromFrame({ type: 'walnut:api', method: 'GET', path: '/api/tasks' });
    await flush();
    expect(h.apiCall).not.toHaveBeenCalled();
    expect(h.frame.sent).toHaveLength(0);
    expect(h.warnings.map((w) => w.message)).toContain('walnut:api without an id');
  });
});

describe('walnut:subscribe', () => {
  it('forwards only events matching a registered prefix', () => {
    const h = harness();
    h.fromFrame({ type: 'walnut:subscribe', prefixes: ['task:', 'session:status'] });
    h.emit('task:created', { id: 't1' });
    h.emit('session:status-changed', { id: 's1' });
    h.emit('note:updated', { id: 'n1' });
    expect(h.frame.sent.map((s) => s.msg)).toEqual([
      { type: 'walnut:event', name: 'task:created', data: { id: 't1' } },
      { type: 'walnut:event', name: 'session:status-changed', data: { id: 's1' } },
    ]);
  });

  it('subscribes to the bus only once across repeated subscribe messages', () => {
    const h = harness();
    h.fromFrame({ type: 'walnut:subscribe', prefixes: ['task:'] });
    h.fromFrame({ type: 'walnut:subscribe', prefixes: ['task:', 'note:'] });
    expect(h.subscribeCount()).toBe(1);
    expect(h.bridge.getPrefixes()).toEqual(['task:', 'note:']);
  });

  it('never touches the bus for an empty prefix list', () => {
    const h = harness();
    h.fromFrame({ type: 'walnut:subscribe', prefixes: [] });
    expect(h.subscribeCount()).toBe(0);
  });

  it(`caps the prefix list at ${MAX_EVENT_PREFIXES} and warns`, () => {
    const h = harness();
    const many = Array.from({ length: MAX_EVENT_PREFIXES + 9 }, (_, i) => `p${i}:`);
    h.fromFrame({ type: 'walnut:subscribe', prefixes: many });
    expect(h.bridge.getPrefixes()).toHaveLength(MAX_EVENT_PREFIXES);
    expect(h.warnings.map((w) => w.message)).toContain('event prefixes capped');
  });

  it('drops duplicates and non-strings', () => {
    const h = harness();
    h.fromFrame({ type: 'walnut:subscribe', prefixes: ['task:', 'task:', 7, '', null, 'note:'] });
    expect(h.bridge.getPrefixes()).toEqual(['task:', 'note:']);
  });
});

describe('walnut:open', () => {
  it('navigates an absolute in-app path', () => {
    const h = harness();
    h.fromFrame({ type: 'walnut:open', path: '/tasks' });
    expect(h.navigated).toEqual(['/tasks']);
  });

  it('refuses a relative path or an absolute URL', () => {
    const h = harness();
    h.fromFrame({ type: 'walnut:open', path: 'tasks' });
    h.fromFrame({ type: 'walnut:open', path: 'https://evil.example' });
    h.fromFrame({ type: 'walnut:open' });
    expect(h.navigated).toEqual([]);
    expect(h.warnings).toHaveLength(3);
  });

  // Regression: `startsWith('/')` alone accepted protocol-relative URLs, which are
  // off-site navigations wearing an in-app path's clothes (open-redirect shape).
  it('refuses protocol-relative and backslash-escaped paths', () => {
    const h = harness();
    for (const path of ['//evil.example', '/\\evil.example', '//evil.example/x', '/\\\\evil.example']) {
      h.fromFrame({ type: 'walnut:open', path });
    }
    expect(h.navigated).toEqual([]);
    expect(h.warnings).toHaveLength(4);
  });
});

describe('theme', () => {
  it('reads the theme live at handshake time', () => {
    const h = harness();
    h.setTheme('light');
    h.fromFrame({ type: 'walnut:ready' });
    expect(h.frame.sent[0].msg).toMatchObject({
      type: 'walnut:init',
      payload: { theme: 'light' },
    });
  });

  it('pushes a later theme change as its own frame, keeping subscriptions alive', () => {
    const h = harness();
    h.fromFrame({ type: 'walnut:subscribe', prefixes: ['task:'] });
    h.bridge.sendTheme('light');
    expect(h.frame.sent[h.frame.sent.length - 1].msg).toEqual({
      type: 'walnut:theme',
      payload: { theme: 'light' },
    });
    // The whole point: the event feed survives a theme flip.
    expect(h.bridge.getPrefixes()).toEqual(['task:']);
    h.emit('task:created', { id: 't1' });
    expect(h.frame.sent[h.frame.sent.length - 1].msg).toMatchObject({ type: 'walnut:event', name: 'task:created' });
  });

  it('stays quiet after dispose', () => {
    const h = harness();
    h.bridge.dispose();
    const before = h.frame.sent.length;
    h.bridge.sendTheme('light');
    expect(h.frame.sent).toHaveLength(before);
  });
});

describe('dispose', () => {
  it('unsubscribes from the bus and stops answering', () => {
    const h = harness();
    h.fromFrame({ type: 'walnut:subscribe', prefixes: ['task:'] });
    h.bridge.dispose();
    expect(h.unsubscribeCount()).toBe(1);
    const before = h.frame.sent.length;
    h.fromFrame({ type: 'walnut:ready' });
    h.emit('task:created', {});
    expect(h.frame.sent).toHaveLength(before);
  });
});
