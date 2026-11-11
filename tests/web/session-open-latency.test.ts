import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
vi.mock('../../web/src/utils/log', () => ({ log: { info: vi.fn() } }));
import { log } from '../../web/src/utils/log';
import { beginSessionOpen, noteSessionOpenSource, observeSessionOpen, hasVisibleSessionContent, hasReadableOpenRows } from '../../web/src/utils/session-open-latency';

const stops: Array<() => void> = [];
afterEach(() => { stops.splice(0).forEach(stop => stop()); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); });

function harness() {
  vi.useFakeTimers();
  const window = new EventTarget() as EventTarget & { setTimeout: typeof setTimeout };
  window.setTimeout = setTimeout;
  const document = new EventTarget() as EventTarget & { visibilityState: string };
  document.visibilityState = 'visible';
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', document);
  vi.stubGlobal('innerHeight', 900);
  vi.stubGlobal('innerWidth', 1280);
  vi.stubGlobal('navigator', { userAgent: 'Test WebKit' });
  vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible', display: 'block', opacity: '1' }));
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  let mutate = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal('MutationObserver', class {
    constructor(cb: () => void) { mutate = cb; }
    observe() {} disconnect = disconnect;
  });
  let visible = false;
  const box = { width: 300, height: 80, top: 100, bottom: 180, left: 0, right: 300 };
  const panel = {
    getBoundingClientRect: () => ({ ...box, height: 800, bottom: 900 }),
    querySelectorAll: (selector: string) => visible && selector.includes('> .markdown-body') ? [{ textContent: 'Latest answer', getBoundingClientRect: () => box }] : [],
  } as unknown as HTMLElement;
  return { panel, document, window, disconnect,
    show() { visible = true; mutate(); },
    paint(ms: number) { now = ms; frames.splice(0).forEach(cb => cb(ms)); },
  };
}

describe('chat open measurement', () => {
  it('every history-source notification uses the full session id, never its diagnostic prefix', () => {
    const hook = fs.readFileSync('web/src/hooks/useSessionHistory.ts', 'utf8');
    const calls = [...hook.matchAll(/noteSessionOpenSource\(([^,]+),/g)];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(call => call[1].trim() === 'sessionId')).toBe(true);
  });

  it('notices and an acknowledgement alone are not readable content', () => {
    expect(hasReadableOpenRows([{ role: 'assistant', text: '<walnut-turn status="agent-ack"/>', timestamp: '' }])).toBe(false);
    expect(hasReadableOpenRows([{ role: 'assistant', text: 'Latest answer', timestamp: '' }])).toBe(true);
  });

  it('tool and thinking rows alone do not satisfy the conversational body selector', () => {
    const h = harness();
    const tool = { textContent: 'Ran a command', getBoundingClientRect: () => ({ width: 300, height: 40, top: 100, bottom: 140, left: 0, right: 300 }) };
    h.panel.querySelectorAll = ((selector: string) => selector.includes('> .markdown-body') ? [] : [tool]) as typeof h.panel.querySelectorAll;
    expect(hasVisibleSessionContent(h.panel)).toBe(false);
  });

  it('the timeout starts at the click even if no panel ever mounts', async () => {
    const h = harness();
    beginSessionOpen('metric-no-panel', 'org-node');
    h.paint(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(log.info).toHaveBeenCalledWith('session-open', expect.stringContaining('first content '), expect.objectContaining({ ms: 30_000, outcome: 'timeout', entry: 'org-node' }));
  });

  it('mount-only opens do not inherit the previous source classification', () => {
    const h = harness();
    noteSessionOpenSource('metric-mount', 'network');
    stops.push(observeSessionOpen(h.panel, 'metric-mount', () => 'claude'));
    h.show(); h.paint(100); h.paint(116);
    expect(log.info).toHaveBeenCalledWith('session-open', expect.stringContaining('first content '), expect.objectContaining({ source: 'unknown', entry: 'mount' }));
  });

  it('a first host-ready view is cold, not a cached visit', () => {
    const h = harness();
    beginSessionOpen('metric-ready', 'home-column');
    noteSessionOpenSource('metric-ready', 'ready');
    stops.push(observeSessionOpen(h.panel, 'metric-ready', () => 'claude'));
    h.show(); h.paint(100); h.paint(116);
    expect(log.info).toHaveBeenCalledWith('session-open', expect.stringContaining('first content '), expect.objectContaining({ cache: 'cold', source: 'ready' }));
  });

  it('measures click to painted content once and keeps the first cache source', () => {
    const h = harness();
    beginSessionOpen('metric-cached', 'home-column');
    noteSessionOpenSource('metric-cached', 'idb');
    stops.push(observeSessionOpen(h.panel, 'metric-cached', () => 'claude'));
    h.paint(10);
    expect(log.info).not.toHaveBeenCalled();
    h.show(); h.paint(100);
    expect(log.info).not.toHaveBeenCalled();
    noteSessionOpenSource('metric-cached', 'network');
    h.paint(116);
    expect(log.info).toHaveBeenCalledExactlyOnceWith('session-open', expect.stringContaining('first content '), expect.objectContaining({
      sessionId: 'metric-cached', ms: 116, source: 'idb', cache: 'cached', outcome: 'content', client: 'browser', userAgent: 'Test WebKit',
    }));
    expect(h.disconnect).toHaveBeenCalled();
  });

  it('a hidden page or empty timeline never counts as content and times out explicitly', async () => {
    const h = harness();
    beginSessionOpen('metric-hidden', 'ask-slot');
    noteSessionOpenSource('metric-hidden', 'preview');
    stops.push(observeSessionOpen(h.panel, 'metric-hidden', () => 'codex'));
    h.document.visibilityState = 'hidden';
    h.show(); h.paint(100); h.paint(116);
    expect(hasVisibleSessionContent(h.panel)).toBe(false);
    expect(log.info).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(log.info).toHaveBeenCalledWith('session-open', expect.stringContaining('first content '), expect.objectContaining({ source: 'preview', cache: 'cold', outcome: 'timeout', hiddenDuringOpen: true }));
  });

  it('closing or switching before paint does not report a successful open', () => {
    const h = harness();
    beginSessionOpen('metric-switch', 'org-node');
    const stop = observeSessionOpen(h.panel, 'metric-switch', () => 'claude');
    h.show(); h.paint(100); stop(); h.paint(116);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('StrictMode setup cleanup setup keeps the click clock and classification', async () => {
    const h = harness();
    beginSessionOpen('metric-strict', 'home-column');
    noteSessionOpenSource('metric-strict', 'ready');
    const stop = observeSessionOpen(h.panel, 'metric-strict', () => 'claude');
    stop();
    stops.push(observeSessionOpen(h.panel, 'metric-strict', () => 'claude', false));
    await Promise.resolve();
    h.show(); h.paint(100); h.paint(116);
    expect(log.info).toHaveBeenCalledWith('session-open', expect.stringContaining('first content '), expect.objectContaining({ ms: 116, entry: 'home-column', cache: 'cold' }));
  });

  it('moving a session between panels keeps its click clock across cleanup', async () => {
    const h = harness();
    beginSessionOpen('metric-move', 'org-node');
    const stop = observeSessionOpen(h.panel, 'metric-move', () => 'claude');
    stop();
    stops.push(observeSessionOpen(h.panel, 'metric-move', () => 'claude'));
    await Promise.resolve();
    h.show(); h.paint(200); h.paint(216);
    expect(log.info).toHaveBeenCalledWith('session-open', expect.stringContaining('first content '), expect.objectContaining({ ms: 216, entry: 'org-node' }));
  });

  it('a real unmount cancels the timeout rather than reporting a slow open', async () => {
    const h = harness();
    beginSessionOpen('metric-closed', 'org-node');
    observeSessionOpen(h.panel, 'metric-closed', () => 'claude')();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('reopening an already mounted panel records a new attempt without repeated live-mutation logs', () => {
    const h = harness();
    beginSessionOpen('metric-reopen', 'home-column');
    stops.push(observeSessionOpen(h.panel, 'metric-reopen', () => 'claude'));
    h.show(); h.paint(100); h.paint(116);
    beginSessionOpen('metric-reopen', 'home-column');
    noteSessionOpenSource('metric-reopen', 'memory');
    h.paint(200); h.paint(216);
    expect(log.info).toHaveBeenCalledTimes(2);
    expect(vi.mocked(log.info).mock.calls[1][2]).toMatchObject({ ms: 100, source: 'memory', cache: 'cached' });
  });
});
