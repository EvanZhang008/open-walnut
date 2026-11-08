import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
let initDemoGeneration: typeof import('../../web/src/utils/demo-generation')['initDemoGeneration'];
let installDemoGenerationFetch: typeof import('../../web/src/utils/demo-generation')['installDemoGenerationFetch'];
let demoDatabaseName: typeof import('../../web/src/utils/demo-generation')['demoDatabaseName'];
let demoSignInCopy: typeof import('../../web/src/utils/demo-generation')['demoSignInCopy'];

function store() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    clear: vi.fn(() => values.clear()),
  };
}
let local: ReturnType<typeof store>;
let session: ReturnType<typeof store>;
let request: ReturnType<typeof vi.fn>;
let beacon: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.resetModules();
  ({ initDemoGeneration, installDemoGenerationFetch, demoDatabaseName, demoSignInCopy } = await import('../../web/src/utils/demo-generation'));
  local = store(); session = store(); request = vi.fn(); beacon = vi.fn(() => true);
  vi.stubGlobal('navigator', { sendBeacon: beacon });
  vi.stubGlobal('localStorage', local); vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('window', { location: { hostname: '127.0.0.1', port: '3458' } });
  vi.stubGlobal('fetch', request);
});
afterEach(() => vi.unstubAllGlobals());

describe('Demo browser generation before application imports', () => {
  it.each([
    ['127.0.0.1', '3456'], ['127.0.0.1', '3457'], ['localhost', '3458'], ['example.test', '3458'],
  ])('does not read or clear another console at %s:%s', async (hostname, port) => {
    vi.stubGlobal('window', { location: { hostname, port } });
    await initDemoGeneration();
    expect(request).not.toHaveBeenCalled();
    expect(local.clear).not.toHaveBeenCalled(); expect(session.clear).not.toHaveBeenCalled();
  });

  it('keeps storage when the port holds a non-Demo server', async () => {
    request.mockResolvedValue(new Response('', { status: 404 }));
    await initDemoGeneration();
    expect(local.clear).not.toHaveBeenCalled(); expect(session.clear).not.toHaveBeenCalled();
  });

  it('clears only this origin on first use and every reset, keeping reopen drafts', async () => {
    local.setItem('draft', 'previous'); session.setItem('panel', 'previous');
    request.mockImplementation(async () => Response.json({ generation: 'first' }));
    expect(await initDemoGeneration()).toBe(true);
    expect(local.getItem('draft')).toBeNull(); expect(session.getItem('panel')).toBeNull();
    expect(local.getItem('walnut.demo.generation')).toBe('first');
    local.setItem('draft', 'keep'); session.setItem('panel', 'keep');
    expect(await initDemoGeneration()).toBe(false);
    expect(local.getItem('draft')).toBe('keep'); expect(session.getItem('panel')).toBe('keep');
    expect(local.clear).toHaveBeenCalledTimes(1);
    request.mockImplementation(async () => Response.json({ generation: 'second' }));
    expect(await initDemoGeneration()).toBe(true);
    expect(local.getItem('draft')).toBe('keep');
    vi.resetModules();
    ({ initDemoGeneration } = await import('../../web/src/utils/demo-generation'));
    expect(await initDemoGeneration()).toBe(true);
    expect(local.getItem('draft')).toBeNull(); expect(session.getItem('panel')).toBeNull();
    expect(local.getItem('walnut.demo.generation')).toBe('second');
  });

  it.each([{}, { generation: null }, { generation: '../old' }, { generation: '' }])('keeps storage on an invalid generation %j', async value => {
    request.mockResolvedValue(Response.json(value));
    await expect(initDemoGeneration()).rejects.toThrow(/valid data generation/);
    expect(local.clear).not.toHaveBeenCalled(); expect(session.clear).not.toHaveBeenCalled();
  });

  it('detects an old tab even when a fresh tab already changed shared localStorage', async () => {
    request.mockImplementation(async () => Response.json({ generation: 'first' }));
    await initDemoGeneration();
    local.setItem('walnut.demo.generation', 'second');
    local.setItem('draft', 'new-tab-draft');
    request.mockImplementation(async () => Response.json({ generation: 'second' }));
    expect(await initDemoGeneration()).toBe(true);
    expect(local.getItem('draft')).toBe('new-tab-draft');
    expect(local.getItem('walnut.demo.generation')).toBe('second');
  });

  it('keeps every browser database tied to the page generation, not another tab', async () => {
    request.mockImplementation(async () => Response.json({ generation: 'first' }));
    await initDemoGeneration();
    for (const name of ['walnut-history-cache', 'walnut-filecontent-cache', 'walnut-dirlist-cache', 'new-cache']) {
      expect(demoDatabaseName(name)).toBe(`${name}-demo-first`);
    }
    local.setItem('walnut.demo.generation', 'second');
    expect(demoDatabaseName('new-cache')).toBe('new-cache-demo-first');
    vi.stubGlobal('window', { location: { hostname: '127.0.0.1', port: '3456' } });
    expect(demoDatabaseName('new-cache')).toBe('new-cache');
  });

  it('clears this tab session storage after another tab already reset shared storage', async () => {
    local.setItem('walnut.demo.generation', 'second');
    session.setItem('walnut.demo.generation', 'first');
    session.setItem('old-panel', 'old');
    request.mockImplementation(async () => Response.json({ generation: 'second' }));
    expect(await initDemoGeneration()).toBe(false);
    expect(session.getItem('old-panel')).toBeNull();
    expect(session.getItem('walnut.demo.generation')).toBe('second');
    expect(local.clear).not.toHaveBeenCalled();
  });

  it('stamps same-origin API requests with the generation this page booted on', async () => {
    local.setItem('walnut.demo.generation', 'first');
    vi.stubGlobal('window', { fetch: request, location: {
      hostname: '127.0.0.1', port: '3458', origin: 'http://127.0.0.1:3458', href: 'http://127.0.0.1:3458/',
    } });
    request.mockResolvedValue(new Response(''));
    installDemoGenerationFetch();
    local.setItem('walnut.demo.generation', 'second');
    await window.fetch('/api/drafts', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(new Headers(request.mock.calls[0][1].headers).get('x-walnut-demo-generation')).toBe('first');
    expect(new Headers(request.mock.calls[0][1].headers).get('content-type')).toBe('application/json');
    const req = new Request('http://127.0.0.1:3458/api/ui-prefs', { headers: { 'x-original': 'keep' } });
    await window.fetch(req);
    expect(new Headers(request.mock.calls[1][1].headers).get('x-original')).toBe('keep');
    expect(new Headers(request.mock.calls[1][1].headers).get('x-walnut-demo-generation')).toBe('first');
    await window.fetch('https://example.test/api/read');
    expect(request.mock.calls[2]).toEqual(['https://example.test/api/read', undefined]);
    await window.fetch('/assets/image.png');
    expect(request.mock.calls[3]).toEqual(['/assets/image.png', undefined]);
  });

  it('stamps every API unload beacon with this page generation and leaves other destinations alone', async () => {
    local.setItem('walnut.demo.generation', 'first');
    vi.stubGlobal('window', { fetch: request, location: {
      hostname: '127.0.0.1', port: '3458', origin: 'http://127.0.0.1:3458', href: 'http://127.0.0.1:3458/',
    } });
    request.mockResolvedValue(new Response(''));
    installDemoGenerationFetch();
    local.setItem('walnut.demo.generation', 'second');
    const body = new Blob(['{}'], { type: 'application/json' });
    for (const path of ['/api/browser-logs', '/api/time/heartbeats', '/api/future-unload']) {
      expect(navigator.sendBeacon(path, body)).toBe(true);
      expect(request.mock.calls.at(-1)).toEqual([path, {
        method: 'POST', body, keepalive: true,
        headers: { 'x-walnut-demo-generation': 'first' },
      }]);
    }
    expect(beacon).not.toHaveBeenCalled();
    for (const url of ['https://example.test/api/read', '/assets/ping']) {
      expect(navigator.sendBeacon(url, body)).toBe(true);
      expect(beacon.mock.calls.at(-1)).toEqual([url, body]);
    }
    expect(request).toHaveBeenCalledTimes(3);
    request.mockRejectedValueOnce(new TypeError('Network unavailable'));
    expect(navigator.sendBeacon('/api/browser-logs', body)).toBe(true);
    await Promise.resolve();
    request.mockImplementationOnce(() => { throw new TypeError('Request unavailable'); });
    expect(navigator.sendBeacon('/api/browser-logs', body)).toBe(false);
  });

  it('never replaces ordinary unload beacons when the console is not Demo', () => {
    vi.stubGlobal('window', { location: { hostname: '127.0.0.1', port: '3456' } });
    installDemoGenerationFetch();
    expect(navigator.sendBeacon).toBe(beacon);
    expect(request).not.toHaveBeenCalled();
  });

  describe('the address of a page from an earlier generation', () => {
    function page(href: string) {
      const url = new URL(href);
      const replaceState = vi.fn((_s: unknown, _t: string, next: string) => {
        const to = new URL(next, url);
        location.pathname = to.pathname; location.search = to.search; location.hash = to.hash;
      });
      const location = { hostname: '127.0.0.1', port: '3458', pathname: url.pathname, search: url.search, hash: url.hash };
      vi.stubGlobal('window', { location, history: { replaceState } });
      return { location, replaceState };
    }

    // D05: a reset with two session columns open reloaded into the new first run with
    // `?s1=&s2=` still in the address, so the columns came back as "Session not found".
    it('goes to Home after a reset, so old session columns and a focused task never come back', async () => {
      local.setItem('walnut.demo.generation', 'first'); session.setItem('walnut.demo.generation', 'first');
      const { location, replaceState } = page('http://127.0.0.1:3458/?s1=aaaa&s2=bbbb&task=t1');
      request.mockImplementation(async () => Response.json({ generation: 'second' }));
      expect(await initDemoGeneration()).toBe(true);
      expect(replaceState).toHaveBeenCalledWith(null, '', '/');
      expect(location.search).toBe('');
    });

    it('also when another tab already moved shared storage to the new generation', async () => {
      local.setItem('walnut.demo.generation', 'second'); session.setItem('walnut.demo.generation', 'first');
      const { replaceState } = page('http://127.0.0.1:3458/sessions?id=aaaa');
      request.mockImplementation(async () => Response.json({ generation: 'second' }));
      await initDemoGeneration();
      expect(replaceState).toHaveBeenCalledWith(null, '', '/');
    });

    it.each([
      ['a new tab of the same generation', 'second', null],
      ['a reload of the same generation', 'second', 'second'],
      ['the first open of a new Demo', null, null],
    ])('keeps the address of %s', async (_name, kept, keptTab) => {
      if (kept) local.setItem('walnut.demo.generation', kept);
      if (keptTab) session.setItem('walnut.demo.generation', keptTab);
      const { replaceState } = page('http://127.0.0.1:3458/?s1=cccc');
      request.mockImplementation(async () => Response.json({ generation: 'second' }));
      await initDemoGeneration();
      expect(replaceState).not.toHaveBeenCalled();
    });
  });

  it('keeps storage and refuses boot when Demo cannot confirm its generation', async () => {
    request.mockResolvedValue(new Response('', { status: 503 }));
    await expect(initDemoGeneration()).rejects.toThrow(/confirm its data generation/);
    expect(local.clear).not.toHaveBeenCalled();
    request.mockRejectedValue(new TypeError('Network unavailable'));
    await expect(initDemoGeneration()).rejects.toThrow(/Network unavailable/);
    expect(local.clear).not.toHaveBeenCalled();
  });
});

describe('Demo sign-in command for copy fallbacks', () => {
  const SAFE = "/usr/bin/env -i HOME='/d/it'\\''s home' CLAUDE_CONFIG_DIR='/d/.claude' PATH='/usr/bin' /bin/sh -c 'exec x'";

  it('a confirmed Demo page keeps the command its own generation reported', async () => {
    request.mockImplementation(async () => Response.json({ generation: 'first', signInCommand: SAFE }));
    expect(demoSignInCopy()).toBeNull();
    await initDemoGeneration();
    expect(demoSignInCopy()).toEqual({ command: SAFE });
    request.mockImplementation(async () => Response.json({ generation: 'second', signInCommand: `${SAFE} other` }));
    expect(await initDemoGeneration()).toBe(true);
    expect(demoSignInCopy()).toEqual({ command: SAFE });
  });

  it.each([
    [{}], [{ signInCommand: null }], [{ signInCommand: 7 }], [{ signInCommand: 'claude auth login' }],
    [{ signInCommand: `${SAFE}\nclaude` }], [{ signInCommand: `${SAFE}\u001b[2K` }],
  ])('a Demo with no usable command gets none, never the normal one: %j', async extra => {
    request.mockImplementation(async () => Response.json({ generation: 'first', ...extra }));
    await initDemoGeneration();
    expect(demoSignInCopy()).toEqual({ command: null });
  });

  it.each([
    "/bin/sh '/u/.local/share/open-walnut-demo/data/first/local/demo-sign-in.sh'",
    "/bin/sh '/u/it'\\''s/open-walnut-demo/data/first/local/demo-sign-in.sh'",
  ])("keeps the short form that runs the generation's sign-in script: %s", async short => {
    request.mockImplementation(async () => Response.json({ generation: 'first', signInCommand: short }));
    await initDemoGeneration();
    expect(demoSignInCopy()).toEqual({ command: short });
  });

  it.each([
    "/bin/sh '/u/evil.sh'", '/bin/sh /u/demo-sign-in.sh', "/bin/sh '/u/demo-sign-in.sh'; claude", "/bin/sh 'relative/demo-sign-in.sh'",
  ])('nothing else shaped like it: %s', async bad => {
    request.mockImplementation(async () => Response.json({ generation: 'first', signInCommand: bad }));
    await initDemoGeneration();
    expect(demoSignInCopy()).toEqual({ command: null });
  });

  it('a non-Demo server on the Demo port and every other console keep the normal command', async () => {
    request.mockResolvedValue(new Response('', { status: 404 }));
    await initDemoGeneration();
    expect(demoSignInCopy()).toBeNull();
    for (const port of ['3456', '3457']) {
      vi.stubGlobal('window', { location: { hostname: '127.0.0.1', port } });
      await initDemoGeneration();
      expect(demoSignInCopy()).toBeNull();
    }
    expect(request).toHaveBeenCalledTimes(1);
  });
});
