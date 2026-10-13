import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { createElement, act } from '../../web/node_modules/react/index.js';
import { createRoot } from '../../web/node_modules/react-dom/client.js';

const fetchDirListMany = vi.hoisted(() => vi.fn());
vi.mock('@/api/files', () => ({ fetchDirListMany }));
const events = vi.hoisted(() => new Map<string, () => void>());
vi.mock('@/hooks/useWebSocket', () => ({ useEvent: (name: string, callback: () => void) => events.set(name, callback) }));
const { useDirectoryRefresh } = await import('../../web/src/hooks/useDirectoryRefresh');

let root: ReturnType<typeof createRoot> | undefined;
let paths: string[];
let host: string | undefined;
let hiddenFiles: boolean;
let hidden: boolean;
let revision: number;
const applied = vi.fn();
function Probe() { useDirectoryRefresh(paths, host, hiddenFiles, applied, () => String(revision)); return null; }
async function render() { await act(async () => { root!.render(createElement(Probe)); }); }
async function tick(ms = 5_000) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

beforeAll(() => {
  const dom = parseHTML('<html><body></body></html>');
  Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
});
beforeEach(() => {
  vi.useFakeTimers();
  paths = ['/repo']; host = 'remote'; hiddenFiles = false; hidden = false; revision = 0;
  applied.mockReset(); fetchDirListMany.mockReset(); events.clear();
  fetchDirListMany.mockResolvedValue({ listings: [{ path: '/repo', entries: [] }], timedOut: false, truncated: false });
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  vi.useRealTimers();
});

describe('directory refresh lifecycle', () => {
  it('sends one batch per tick, with the host, hidden-file mode and abort signal', async () => {
    paths = ['/repo', '/repo/docs']; hiddenFiles = true;
    await render();
    expect(fetchDirListMany).not.toHaveBeenCalled();
    await tick();
    expect(fetchDirListMany).toHaveBeenCalledWith(paths, 'remote', true, { signal: expect.any(AbortSignal), background: true });
    expect(applied).toHaveBeenCalledWith([{ path: '/repo', entries: [] }]);
    await tick();
    expect(fetchDirListMany).toHaveBeenCalledTimes(2);
  });

  it('splits every visible directory into sequential batches instead of truncating at 64', async () => {
    paths = Array.from({ length: 131 }, (_, i) => `/repo/${i}`);
    await render(); await tick();
    expect(fetchDirListMany.mock.calls.map(call => call[0].length)).toEqual([64, 64, 3]);
    expect(fetchDirListMany.mock.calls.flatMap(call => call[0])).toEqual(paths);
  });

  it('does not overlap slow ticks or time out a request before admission', async () => {
    let fail!: (error: Error) => void;
    let signal!: AbortSignal;
    fetchDirListMany.mockImplementationOnce((_p, _h, _s, opts) => new Promise((_resolve, reject) => {
      signal = opts.signal; fail = reject;
    }));
    await render(); await tick(); await tick(15_000);
    expect(fetchDirListMany).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);
    await act(async () => { fail(new Error('network deadline')); });
    expect(applied).not.toHaveBeenCalled();
    await tick();
    expect(fetchDirListMany).toHaveBeenCalledTimes(2);
  });

  it('ignores late answers after switching the host, path or hidden mode', async () => {
    let finish!: (value: unknown) => void;
    let signal!: AbortSignal;
    fetchDirListMany.mockImplementationOnce((_p, _h, _s, opts) => {
      signal = opts.signal;
      return new Promise(resolve => { finish = resolve; });
    });
    await render(); await tick();
    paths = ['/other']; host = 'other-host'; hiddenFiles = true;
    await render();
    expect(signal.aborted).toBe(true);
    await act(async () => { finish({ listings: [{ path: '/repo', entries: [] }] }); });
    expect(applied).not.toHaveBeenCalled();
    await tick();
    expect(fetchDirListMany).toHaveBeenLastCalledWith(['/other'], 'other-host', true, { signal: expect.any(AbortSignal), background: true });
  });

  it('does not replace a newer foreground listing with an older background answer', async () => {
    let finish!: (value: unknown) => void;
    fetchDirListMany.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await render(); await tick();
    revision += 1;
    await act(async () => { finish({ listings: [{ path: '/repo', entries: [] }] }); });
    expect(applied).not.toHaveBeenCalled();
    await tick();
    expect(applied).toHaveBeenCalledTimes(1);
  });

  it('sleeps while hidden and catches up on visibility and socket recovery', async () => {
    await render(); hidden = true; await tick(15_000);
    expect(fetchDirListMany).not.toHaveBeenCalled();
    hidden = false;
    await act(async () => { document.dispatchEvent(new window.Event('visibilitychange')); });
    expect(fetchDirListMany).toHaveBeenCalledTimes(1);
    await act(async () => { events.get('_ws:reconnected')!(); });
    expect(fetchDirListMany).toHaveBeenCalledTimes(2);
  });

  it('keeps existing rows on failures, applies partial successes and retries', async () => {
    paths = ['/repo', '/denied'];
    fetchDirListMany.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({
      listings: [{ path: '/repo', entries: [] }, { path: '/denied', error: 'permission denied' }], timedOut: true, truncated: false,
    });
    await render(); await tick();
    expect(applied).not.toHaveBeenCalled();
    await tick();
    expect(applied).toHaveBeenLastCalledWith([
      { path: '/repo', entries: [] }, { path: '/denied', error: 'permission denied' },
    ]);
  });

  it('puts paths omitted by a partial timeout before the slow prefix next round', async () => {
    paths = ['/repo', '/repo/tail'];
    fetchDirListMany.mockResolvedValueOnce({ listings: [{ path: '/repo', entries: [] }], timedOut: true, truncated: false });
    await render(); await tick(); await tick();
    expect(fetchDirListMany.mock.calls[1]![0]).toEqual(['/repo/tail', '/repo']);
  });

  it('changing expanded paths does not reset the clock or abort another directory', async () => {
    await render(); await tick(3_000);
    paths = ['/repo', '/repo/docs']; await render(); await tick(2_000);
    expect(fetchDirListMany).toHaveBeenCalledTimes(1);
    expect(fetchDirListMany.mock.calls[0]![0]).toEqual(paths);
  });

  it('does no work with a collapsed tree and stops on unmount', async () => {
    paths = []; await render(); await tick();
    expect(fetchDirListMany).not.toHaveBeenCalled();
    paths = ['/repo']; await render(); await tick();
    await act(async () => { root!.unmount(); }); root = undefined;
    await tick(15_000);
    expect(fetchDirListMany).toHaveBeenCalledTimes(1);
  });
});
