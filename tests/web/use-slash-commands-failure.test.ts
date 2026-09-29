/**
 * `useSlashCommands` (web/src/hooks/useSlashCommands.ts): a failed palette fetch is handled,
 * never an unhandled rejection in the page.
 *
 * Found 2026-09-28 in an end-to-end run: opening a task whose session record is gone (a
 * test server with the task board but no sessions) answered 404 "session not found" for
 * `/api/sessions/:id/slash-commands`, and the page logged it twice as an uncaught error,
 * once per attempt (the hook retries after 3s). The awaiting caller already caught the
 * failure; the in-flight bookkeeping's `promise.finally(...)` was a second chain that
 * re-raised it with nobody listening.
 *
 * Real React mounts over linkedom, the same setup as tests/web/use-integrations-cache.test.ts.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { createElement, act } from '../../web/node_modules/react/index.js';
import { createRoot } from '../../web/node_modules/react-dom/client.js';
import { useSlashCommands } from '../../web/src/hooks/useSlashCommands';

const tick = () => new Promise((r) => setTimeout(r, 0));

function Probe({ sessionId }: { sessionId: string }) {
  const { items, loading } = useSlashCommands(undefined, undefined, sessionId);
  return createElement('span', null, loading ? 'loading' : `${items.length} commands`);
}

describe('useSlashCommands when the palette request fails', () => {
  let doc: Document;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  let unmount: (() => void) | undefined;

  beforeAll(() => {
    const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>');
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = dom.window;
    g.document = dom.document;
    g.IS_REACT_ACT_ENVIRONMENT = true;
    doc = dom.document as unknown as Document;
  });

  afterEach(async () => {
    await act(async () => { unmount?.(); });
    unmount = undefined;
    process.off('unhandledRejection', onUnhandled);
    unhandled.length = 0;
    vi.unstubAllGlobals();
  });

  it('answers a 404 for a session that is gone with an empty palette, and nothing unhandled', async () => {
    process.on('unhandledRejection', onUnhandled);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'session not found' }), {
      status: 404, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const host = doc.createElement('div');
    doc.body.appendChild(host);
    const root = createRoot(host as unknown as Element);
    unmount = () => root.unmount();
    await act(async () => { root.render(createElement(Probe, { sessionId: 'session-that-is-gone' })); });
    for (let i = 0; i < 20 && host.textContent === 'loading'; i++) await act(async () => { await tick(); });
    // Unhandled rejections are reported after the microtask queue drains.
    await tick();
    await tick();

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining('/api/sessions/session-that-is-gone/slash-commands'),
    ]);
    expect(host.textContent).toBe('0 commands');
    expect(unhandled).toEqual([]);
  });
});
