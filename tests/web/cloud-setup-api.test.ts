/**
 * Cloud-setup API client mapping (web/src/api/cloud-setup.ts).
 *
 * The client is thin, so the parts worth pinning are the ones with real decisions
 * in them:
 *   - getJob() turns the route's 404 ("no job exists") into null, because a
 *     missing job is the NORMAL state and must not surface as an error banner.
 *   - streamJob() passes lastEventId as a QUERY param. A fresh EventSource never
 *     sends the Last-Event-ID header (the browser only does that on its own
 *     auto-reconnect), so without the query param a remount would silently
 *     re-read the whole ring instead of resuming.
 *   - the step-id list matches the server's execution order, since the checklist
 *     renders straight from it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CLOUD_SETUP_STEP_IDS as SERVER_STEP_IDS } from '../../src/core/cloud-setup/job-types';

/** Minimal EventSource stand-in — records the URL and lets tests fire events. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  listeners = new Map<string, ((ev: unknown) => void)[]>();
  closed = false;
  constructor(public url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  close(): void { this.closed = true; }
  fire(type: string, ev: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  FakeEventSource.last = null;
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  // The client reads a device token from localStorage; give it a no-op store.
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Stub fetch with a fixed status + JSON body, capturing the requested URL. */
function stubFetch(status: number, body: unknown): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(typeof input === 'string' ? input : String(input));
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? 'Not Found' : 'OK',
      headers: { get: () => null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as typeof fetch;
  return { urls };
}

describe('getJob', () => {
  it('returns null when no job exists (404), not a thrown error', async () => {
    stubFetch(404, { error: 'No cloud setup job exists' });
    const { getJob } = await import('../../web/src/api/cloud-setup');
    await expect(getJob()).resolves.toBeNull();
  });

  it('unwraps the { job } envelope on success', async () => {
    stubFetch(200, { job: { id: 'cs-abc', status: 'running', currentStep: 'provision' } });
    const { getJob } = await import('../../web/src/api/cloud-setup');
    const job = await getJob();
    expect(job?.id).toBe('cs-abc');
    expect(job?.currentStep).toBe('provision');
  });

  it('propagates a real server failure instead of masking it as "no job"', async () => {
    stubFetch(500, { error: 'boom' });
    const { getJob } = await import('../../web/src/api/cloud-setup');
    await expect(getJob()).rejects.toThrow(/boom/);
  });
});

describe('getUserData', () => {
  it('omits an absent domain from the query (sslip has no operator hostname)', async () => {
    const { urls } = stubFetch(200, { userData: '#!/bin/bash', steps: [] });
    const { getUserData } = await import('../../web/src/api/cloud-setup');
    await getUserData({ provider: 'manual', domainMode: 'sslip' });
    expect(urls[0]).toContain('provider=manual');
    expect(urls[0]).toContain('domainMode=sslip');
    expect(urls[0]).not.toContain('domain=');
  });

  it('sends the domain in own-domain mode', async () => {
    const { urls } = stubFetch(200, { userData: '#!/bin/bash', steps: [] });
    const { getUserData } = await import('../../web/src/api/cloud-setup');
    await getUserData({ provider: 'aws', domainMode: 'own-domain', domain: 'walnut.example.com' });
    expect(urls[0]).toContain('domain=walnut.example.com');
  });
});

describe('streamJob', () => {
  it('resumes from a held event id via the query param, not only the header', async () => {
    const { streamJob } = await import('../../web/src/api/cloud-setup');
    const close = streamJob({}, '412');
    expect(FakeEventSource.last?.url).toBe('/api/cloud-setup/job/stream?lastEventId=412');
    close();
    expect(FakeEventSource.last?.closed).toBe(true);
  });

  it('parses snapshot + progress frames and reports the event id', async () => {
    const { streamJob } = await import('../../web/src/api/cloud-setup');
    const snapshots: unknown[] = [];
    const progress: unknown[] = [];
    const ids: string[] = [];
    streamJob({
      onSnapshot: (j) => snapshots.push(j),
      onProgress: (p) => progress.push(p),
      onEventId: (id) => ids.push(id),
    });

    FakeEventSource.last!.fire('snapshot', { data: JSON.stringify({ job: { id: 'cs-1' } }), lastEventId: '' });
    FakeEventSource.last!.fire('progress', {
      data: JSON.stringify({ jobId: 'cs-1', status: 'running', currentStep: 'dns', logLines: ['waiting'] }),
      lastEventId: '77',
    });

    expect(snapshots).toEqual([{ id: 'cs-1' }]);
    expect(progress).toHaveLength(1);
    expect((progress[0] as { logLines: string[] }).logLines).toEqual(['waiting']);
    // A snapshot carries no id (by design in sse-channels.ts) so it must not
    // advance the resume cursor — only the real progress frame does.
    expect(ids).toEqual(['77']);
  });

  it('survives a malformed frame without throwing into the render tree', async () => {
    const { streamJob } = await import('../../web/src/api/cloud-setup');
    const progress: unknown[] = [];
    streamJob({ onProgress: (p) => progress.push(p) });
    expect(() => FakeEventSource.last!.fire('progress', { data: 'not json{', lastEventId: '1' })).not.toThrow();
    expect(progress).toHaveLength(0);
  });
});

describe('step ids', () => {
  it('match the server’s execution order exactly (the checklist renders from them)', async () => {
    const { CLOUD_SETUP_STEP_IDS } = await import('../../web/src/api/cloud-setup');
    expect([...CLOUD_SETUP_STEP_IDS]).toEqual([...SERVER_STEP_IDS]);
  });
});
