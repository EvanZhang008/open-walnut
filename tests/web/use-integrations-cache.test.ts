/**
 * `useIntegrations` (web/src/hooks/useIntegrations.ts) — ONE `/api/integrations`
 * request per page, ever.
 *
 * The incident these cases pin (2026-09-17): the memo held only the RESULT, set
 * inside `.then()`. Every task row calls this hook, and hundreds of rows mount in
 * the SAME tick, so all of them saw an empty cache and all of them fetched.
 * Measured on a board of 6,431 tasks: 66,318 requests in 10.5 hours — a sustained
 * 104.6 per minute for one small never-changing list. The fix caches the PROMISE
 * and goes through `apiGet` (bare `fetch` bypassed the six-slot admission gate in
 * api/client.ts, so that traffic competed for the browser's connections while the
 * gate believed it was holding the line).
 *
 * Why real React mounts instead of calling a loader directly: "N components in one
 * tick" IS the bug's shape, and the effect body is the thing that used to fire N
 * times. The repo has no jsdom/@testing-library; react + react-dom live in
 * web/node_modules and are imported by path (same trick as
 * tests/web/setup-banner.test.ts), with a linkedom-backed document underneath.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { createElement, act } from '../../web/node_modules/react/index.js';
import { createRoot } from '../../web/node_modules/react-dom/client.js';
import {
  useIntegrations,
  getIntegrationMeta,
  resetIntegrationsCacheForTesting,
  type IntegrationMeta,
} from '../../web/src/hooks/useIntegrations';
import { apiGet, getFetchQueueStats } from '../../web/src/api/client';

const INTEGRATIONS_PATH = '/api/integrations';

/** Deliberately different from the hook's `ms-todo`-only FALLBACK, so a test can
 *  tell "the server answered" apart from "the failure path answered". */
const SERVER_INTEGRATIONS: IntegrationMeta[] = [
  { id: 'ms-todo', name: 'Microsoft To-Do', badge: 'M', badgeColor: '#0078D4', externalLinkLabel: 'Microsoft To-Do' },
  { id: 'acme-tracker', name: 'Acme Tracker', badge: 'A', badgeColor: '#8855FF', externalLinkLabel: 'Acme Tracker' },
];
const SERVER_TEXT = '[ms-todo+acme-tracker]';
const FALLBACK_TEXT = '[ms-todo]';
const EMPTY_TEXT = '[]';

type Resolver = { url: string; resolve: (r: Response) => void; reject: (e: unknown) => void };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** One task-row-sized consumer: renders exactly what the hook handed it. */
function Probe() {
  const integrations = useIntegrations();
  return createElement('span', null, `[${integrations.map((i) => i.id).join('+')}]`);
}

describe('useIntegrations issues one request per page', () => {
  let pending: Resolver[];
  let fetchMock: ReturnType<typeof vi.fn>;
  let doc: Document;
  let roots: Array<{ unmount: () => void }>;

  beforeAll(() => {
    // react-dom needs a document; the node-env tiers have none and the repo has
    // no jsdom (linkedom is already a root dep — see tests/web/markdown/dom-setup.ts).
    const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>');
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = dom.window;
    g.document = dom.document;
    g.IS_REACT_ACT_ENVIRONMENT = true;
    doc = dom.document as unknown as Document;
  });

  beforeEach(() => {
    // Every case states its own starting state: cold module cache, idle gate,
    // zero requests recorded.
    resetIntegrationsCacheForTesting();
    roots = [];
    pending = [];
    fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      return new Promise<Response>((resolve, reject) => {
        pending.push({ url, resolve, reject });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(getFetchQueueStats()).toEqual({ inFlight: 0, queued: 0 });
  });

  afterEach(async () => {
    // Unmount first (the hook's cleanup flips `alive=false`), then drain so no
    // in-flight request can land a setState — or a cached value — in the next case.
    await act(async () => {
      for (const root of roots) root.unmount();
    });
    while (pending.length > 0 || getFetchQueueStats().queued > 0) {
      for (const p of pending.splice(0)) p.resolve(jsonResponse([]));
      await tick();
    }
    vi.unstubAllGlobals();
    resetIntegrationsCacheForTesting();
  });

  function integrationRequests(): number {
    return fetchMock.mock.calls.filter((c) => String(c[0]) === INTEGRATIONS_PATH).length;
  }

  /** Mount `count` Probes in ONE commit — i.e. all their effects run in one tick. */
  async function mount(count: number): Promise<() => string> {
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(createElement(
        'div',
        null,
        ...Array.from({ length: count }, (_, i) => createElement(Probe, { key: i })),
      ));
    });
    return () => String(host.textContent);
  }

  async function answer(body: unknown): Promise<void> {
    const entry = pending.find((p) => p.url === INTEGRATIONS_PATH);
    if (!entry) throw new Error(`no in-flight request to ${INTEGRATIONS_PATH}`);
    pending = pending.filter((p) => p !== entry);
    // Inside act(): the resolution lands a setState in every mounted consumer.
    await act(async () => {
      entry.resolve(jsonResponse(body));
      await tick();
    });
  }

  it('20 consumers mounting in the same tick produce exactly ONE request', async () => {
    // Starting state: cold cache, nothing requested yet.
    const text = await mount(20);

    // The old result-only cache fired 20 times here — one per row, all in one tick.
    expect(integrationRequests()).toBe(1);
    // Until it lands, every consumer holds the empty list (rows paint badge-less).
    expect(text()).toBe(EMPTY_TEXT.repeat(20));

    await answer(SERVER_INTEGRATIONS);
    expect(text()).toBe(SERVER_TEXT.repeat(20));
    expect(integrationRequests()).toBe(1);
  });

  it('a consumer mounting in a LATER tick while the request is still in flight adds no request', async () => {
    // Starting state: cold cache. This is the case a result-only cache cannot
    // cover even with one mount per tick — the value has not landed yet, so the
    // memo is still empty and only a cached PROMISE can dedupe.
    const first = await mount(20);
    expect(integrationRequests()).toBe(1);

    const late = await mount(1);
    await tick();
    expect(integrationRequests()).toBe(1);

    await answer(SERVER_INTEGRATIONS);
    expect(first()).toBe(SERVER_TEXT.repeat(20));
    expect(late()).toBe(SERVER_TEXT);
  });

  it('a mount after the value landed makes no request and still gets the value', async () => {
    // Starting state: cold cache → warm it explicitly, then forget the history.
    const warm = await mount(1);
    await answer(SERVER_INTEGRATIONS);
    expect(warm()).toBe(SERVER_TEXT);
    fetchMock.mockClear();

    const later = await mount(5);
    await tick();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(later()).toBe(SERVER_TEXT.repeat(5));
  });

  it('a failed request answers with the ms-todo fallback and never retries', async () => {
    // Starting state: cold cache. A retry-per-row is the reported bug's twin, so
    // the failure is deliberately NOT cleared from the cache: the fallback is a
    // complete answer for a list this widely mounted.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const text = await mount(4);
      expect(integrationRequests()).toBe(1);

      const entry = pending.find((p) => p.url === INTEGRATIONS_PATH)!;
      pending = pending.filter((p) => p !== entry);
      await act(async () => {
        entry.reject(new Error('network down'));
        await tick();
      });
      expect(text()).toBe(FALLBACK_TEXT.repeat(4));

      // Several more waves of rows mount; not one of them re-asks.
      for (let wave = 0; wave < 3; wave++) {
        const more = await mount(5);
        await tick();
        expect(more()).toBe(FALLBACK_TEXT.repeat(5));
      }
      expect(integrationRequests()).toBe(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('the request goes through the admission gate, not around it via bare fetch', async () => {
    // Starting state: cold cache, then the six-slot pool is saturated by other
    // traffic. A bare `window.fetch` (the old implementation) would dispatch
    // immediately and be invisible to the gate; an apiGet must WAIT in the queue.
    const blockers = Array.from({ length: 6 }, (_, i) => apiGet(`/api/blocker${i}`).catch(() => {}));
    await tick();
    expect(getFetchQueueStats()).toEqual({ inFlight: 6, queued: 0 });

    const text = await mount(20);
    await tick();
    expect(integrationRequests()).toBe(0);
    expect(getFetchQueueStats()).toEqual({ inFlight: 6, queued: 1 });

    // Freeing one connection dispatches it — proof the gate owns this request.
    pending.shift()!.resolve(jsonResponse({}));
    await tick();
    expect(integrationRequests()).toBe(1);

    await answer(SERVER_INTEGRATIONS);
    expect(text()).toBe(SERVER_TEXT.repeat(20));

    for (const p of pending.splice(0)) p.resolve(jsonResponse({}));
    await Promise.all(blockers);
  });

  it('getIntegrationMeta resolves a known id and returns undefined for an unknown one', () => {
    // Pure lookup, preserved verbatim through the rewrite — pin it so a future
    // refactor of the caching cannot quietly change the shape callers read.
    expect(getIntegrationMeta(SERVER_INTEGRATIONS, 'acme-tracker')).toEqual(SERVER_INTEGRATIONS[1]);
    expect(getIntegrationMeta(SERVER_INTEGRATIONS, 'ms-todo')?.badge).toBe('M');
    expect(getIntegrationMeta(SERVER_INTEGRATIONS, 'no-such-plugin')).toBeUndefined();
    expect(getIntegrationMeta([], 'ms-todo')).toBeUndefined();
  });
});
