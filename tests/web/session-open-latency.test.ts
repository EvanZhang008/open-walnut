import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
vi.mock('../../web/src/utils/log', () => ({ log: { info: vi.fn() } }));
import { log } from '../../web/src/utils/log';
import { beginSessionOpen, noteSessionOpenSource, observeSessionOpen, hasVisibleSessionContent, hasReadableOpenRows, sessionOpenStageRecorder } from '../../web/src/utils/session-open-latency';

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
  let intersect = () => {};
  const intersectionDisconnect = vi.fn();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(cb: () => void) { intersect = cb; }
    observe() {} disconnect = intersectionDisconnect;
  });
  let visible = false;
  let offscreen = false;
  const box = { width: 300, height: 80, top: 100, bottom: 180, left: 0, right: 300 };
  const panel = {
    getBoundingClientRect: () => offscreen ? { ...box, left: 2000, right: 2300 } : { ...box, height: 800, bottom: 900 },
    querySelectorAll: (selector: string) => visible && selector.includes('> .markdown-body') ? [{ textContent: 'Latest answer', getBoundingClientRect: () => box }] : [],
  } as unknown as HTMLElement;
  return { panel, document, window, disconnect, intersectionDisconnect,
    offscreen(value: boolean) { offscreen = value; },
    intersect() { intersect(); },
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

  it('records first stage offsets without changing the click-to-paint total', () => {
    const h = harness();
    beginSessionOpen('metric-stages', 'home-column');
    const stage = sessionOpenStageRecorder('metric-stages');
    h.paint(20); stage('historyEffect'); stage('idbStart');
    h.paint(420); stage('idbReady'); stage('historyReady');
    stage('historyAdopted');
    h.paint(440); stage('historyReady');
    noteSessionOpenSource('metric-stages', 'idb');
    stops.push(observeSessionOpen(h.panel, 'metric-stages', () => 'claude'));
    h.show(); h.paint(1000); h.paint(1016);
    expect(log.info).toHaveBeenCalledWith('session-open', expect.any(String), expect.objectContaining({
      ms: 1016, source: 'idb', stages: { historyEffect: 20, idbStart: 20, idbReady: 420,
        historyReady: 420, historyAdopted: 420, contentDetected: 1000 },
    }));
  });

  it('late stage callbacks cannot annotate a reopened attempt of the same session', () => {
    const h = harness();
    beginSessionOpen('metric-late-stage', 'home-column');
    const old = sessionOpenStageRecorder('metric-late-stage');
    stops.push(observeSessionOpen(h.panel, 'metric-late-stage', () => 'claude'));
    h.paint(20);
    beginSessionOpen('metric-late-stage', 'home-column');
    old('idbReady');
    h.paint(30); sessionOpenStageRecorder('metric-late-stage')('historyReady');
    h.show(); h.paint(100); h.paint(116);
    expect(log.info).toHaveBeenCalledWith('session-open', expect.any(String), expect.objectContaining({
      ms: 96, stages: { historyReady: 10, contentDetected: 80 },
    }));
  });

  it('a recorder created without an open cannot claim a later mount', () => {
    const h = harness();
    const early = sessionOpenStageRecorder('metric-before-mount');
    stops.push(observeSessionOpen(h.panel, 'metric-before-mount', () => 'claude'));
    early('idbReady');
    h.show(); h.paint(100); h.paint(116);
    expect(log.info).toHaveBeenCalledWith('session-open', expect.any(String), expect.objectContaining({
      stages: { contentDetected: 100 },
    }));
  });

  it('mount measurement starts in layout before the passive history read can finish', () => {
    const panel = fs.readFileSync('web/src/components/sessions/SessionPanel.tsx', 'utf8');
    expect(panel).toMatch(/useLayoutEffect\(\(\) => \{\s*const panel = panelRef\.current;[\s\S]*?return observeSessionOpen/);
    const hook = fs.readFileSync('web/src/hooks/useSessionHistory.ts', 'utf8');
    expect(hook).toContain('const stage = sessionOpenStageRecorder(sessionId)');
    expect(hook).toMatch(/stage\('idbStart'\);\s*idbGetHistory\(sessionId\)/);
    expect(hook).toMatch(/if \(cancelled\) return;\s*stage\('idbReady'\)/);
    expect(hook.indexOf('const stage = sessionOpenStageRecorder')).toBeGreaterThan(hook.indexOf('if (version > 0)'));
    expect(hook).toMatch(/const readable = noteReady\(partial\.messages, 'network'\);\s*setMessages\(partial\.messages\);\s*if \(readable\) stage\('historyAdopted'\)/);
    expect(hook).toMatch(/if \(result\.stale\) \{\s*if \(result\.messages\.length > shown\(\)\) \{\s*const readable = noteReady/);
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

  it('an offscreen restored column is not a thirty-second visible loading timeout', async () => {
    const h = harness(); h.offscreen(true);
    stops.push(observeSessionOpen(h.panel, 'metric-offscreen', () => 'claude'));
    h.show(); h.paint(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(log.info).toHaveBeenCalledWith('session-open', expect.any(String), expect.objectContaining({
      outcome: 'not-visible', outsideViewportAtAttach: true, viewportSeen: false, measurementVersion: 2,
    }));
    expect(h.intersectionDisconnect).toHaveBeenCalled();
  });

  it.each([
    ['checkVisibility', (panel: HTMLElement) => { (panel as unknown as { checkVisibility: (o?: { visibilityProperty?: boolean }) => boolean }).checkVisibility = (o) => !o?.visibilityProperty; }],
    ['computed style', () => { vi.stubGlobal('getComputedStyle', () => ({ visibility: 'hidden', display: 'block', opacity: '1' })); }],
  ])('a chat laid out but hidden by the page (%s) is not a visible timeout (2026-11-14)', async (_how, hide) => {
    // Home stays mounted under visibility:hidden behind /org: its columns keep their boxes.
    const h = harness();
    hide(h.panel);
    stops.push(observeSessionOpen(h.panel, `metric-hidden-page-${_how}`, () => 'claude'));
    h.show(); h.paint(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(log.info).toHaveBeenCalledWith('session-open', expect.any(String), expect.objectContaining({
      outcome: 'not-visible', outsideViewportAtAttach: true, viewportSeen: false,
    }));
  });

  it('a chat hidden under a peek after it opened times out as not visible, not as a slow open', async () => {
    // task-board.css hides the chat column's children, not the panel: the history scroller tells.
    const h = harness();
    let peek = false;
    const scroller = { checkVisibility: (o?: { visibilityProperty?: boolean }) => !(peek && o?.visibilityProperty) } as unknown as HTMLElement;
    (h.panel as unknown as { querySelector: (s: string) => unknown }).querySelector = (sel: string) => sel === '.session-history' ? scroller : null;
    stops.push(observeSessionOpen(h.panel, 'metric-hidden-peek', () => 'claude'));
    h.paint(16);
    peek = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(log.info).toHaveBeenCalledWith('session-open', expect.any(String), expect.objectContaining({
      outcome: 'not-visible', hiddenByPage: true,
    }));
  });

  it('the page hides a mounted chat with visibility, which the measurement reads', () => {
    // Each member of the class (a chat kept mounted but not drawn) must hide it in a way
    // chatHiddenByPage() sees: visibility, never opacity alone.
    const rule = (file: string, selector: string) => {
      const css = fs.readFileSync(file, 'utf8');
      const at = css.indexOf(selector);
      expect(at, `${selector} in ${file}`).toBeGreaterThan(-1);
      return css.slice(at, css.indexOf('}', at));
    };
    expect(rule('web/src/styles/globals.css', '.main-page-wrapper-hidden {')).toMatch(/visibility:\s*hidden/);
    expect(rule('web/src/styles/task-board.css', '.session-panel-chat-col.is-board-peek >')).toMatch(/visibility:\s*hidden/);
  });

  it('intersection changes reveal an existing body without a DOM mutation and retain the original total', () => {
    const h = harness(); h.offscreen(true);
    stops.push(observeSessionOpen(h.panel, 'metric-intersection', () => 'claude'));
    h.show(); h.paint(100);
    expect(log.info).not.toHaveBeenCalled();
    h.offscreen(false); h.intersect(); h.paint(5000); h.paint(5016);
    expect(log.info).toHaveBeenCalledWith('session-open', expect.any(String), expect.objectContaining({
      ms: 5016, outsideViewportAtAttach: true, viewportSeen: true, viewportEnteredMs: 5000,
    }));
  });

  it.each(['scroll', 'resize'])('%s checks existing content without a DOM mutation', event => {
    const h = harness();
    stops.push(observeSessionOpen(h.panel, `metric-geometry-${event}`, () => 'claude'));
    h.show(); h.offscreen(true); h.paint(100);
    h.offscreen(false); h.window.dispatchEvent(new Event(event)); h.paint(200); h.paint(216);
    expect(log.info).toHaveBeenCalledWith('session-open', expect.any(String), expect.objectContaining({ ms: 216, outcome: 'content' }));
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
