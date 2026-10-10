/**
 * Time tracking detail in the browser: which part of a session panel had the
 * input (data-time-view), the file open in it (data-time-file), a plugin's own
 * item (data-time-item, kind 'app'), and the lease closing when the window loses
 * focus to another app (not when focus moves into one of Walnut's own iframes).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { resolveAttribution, sameContext } from '@/utils/time-attribution';
import { applySignal, forServer, IDLE_LEASE, installTimeTracker, LEASE_MS, stillInWalnut, type TimeSample } from '@/utils/time-tracking';

const T0 = 1_800_000_000_000;
const SID = 'sess-aaaa-1111-bbbb-2222';

const PANEL = `<div class="session-panel" data-session-id="${SID}">
  <div class="session-panel-header"><button id="hdr">x</button></div>
  <div class="session-panel-diff-col" data-time-view="files">
    <div class="session-file-explorer-preview" data-time-file="/repo/src/app.ts"><pre id="code">code</pre></div>
    <div id="tree">tree</div>
  </div>
  <div class="session-panel-chat-col" data-time-view="chat"><textarea id="composer"></textarea></div>
</div>
<div class="plugin-view" data-time-kind="chatapp">
  <div data-time-item="C0123/1700000000.0001" data-time-label="#general">
    <span id="msg">a message</span>
    <div data-time-mode="reply"><textarea id="reply"></textarea></div>
  </div>
  <div data-time-item="C0456" data-time-label="#random"><span id="other">other</span></div>
  <span id="chrome">plugin chrome, no item</span>
</div>`;

function el(id: string): Element {
  const { document } = parseHTML(`<body>${PANEL}</body>`);
  const found = document.getElementById(id);
  if (!found) throw new Error(`fixture missing #${id}`);
  return found as unknown as Element;
}

describe('resolveAttribution: detail markers', () => {
  it('names the panel view and the open file for input inside the file viewer', () => {
    expect(resolveAttribution(el('code'), '/')).toEqual({ kind: 'session', sessionId: SID, view: 'files', file: '/repo/src/app.ts' });
  });

  it('names the view alone outside the viewer, and the chat column as chat', () => {
    expect(resolveAttribution(el('tree'), '/')).toEqual({ kind: 'session', sessionId: SID, view: 'files' });
    expect(resolveAttribution(el('composer'), '/')).toEqual({ kind: 'session', sessionId: SID, view: 'chat' });
  });

  it('gives the panel header no view (no marker above it inside the panel)', () => {
    expect(resolveAttribution(el('hdr'), '/')).toEqual({ kind: 'session', sessionId: SID });
  });

  it('never borrows a view from OUTSIDE the panel', () => {
    const { document } = parseHTML(`<body><div data-time-view="board"><div class="session-panel" data-session-id="${SID}"><b id="in">x</b></div></div></body>`);
    expect(resolveAttribution(document.getElementById('in') as unknown as Element, '/')).toEqual({ kind: 'session', sessionId: SID });
  });

  it('attributes a plugin item as kind app with the plugin, item and label', () => {
    expect(resolveAttribution(el('msg'), '/')).toEqual({ kind: 'app', app: 'chatapp', item: 'C0123/1700000000.0001', label: '#general' });
  });

  it('marks the reply box as mode reply', () => {
    expect(resolveAttribution(el('reply'), '/')).toEqual({ kind: 'app', app: 'chatapp', item: 'C0123/1700000000.0001', label: '#general', mode: 'reply' });
  });

  it('plugin chrome with no item is not attributable', () => {
    expect(resolveAttribution(el('chrome'), '/')).toBeNull();
  });

  it('a change of view, file, item or mode is a context switch', () => {
    const base = { kind: 'session' as const, sessionId: SID, view: 'chat' };
    expect(sameContext(base, { ...base })).toBe(true);
    expect(sameContext(base, { ...base, view: 'files' })).toBe(false);
    expect(sameContext({ ...base, file: 'a' }, { ...base, file: 'b' })).toBe(false);
    const item = { kind: 'app' as const, app: 'chatapp', item: 'C1' };
    expect(sameContext(item, { ...item, item: 'C2' })).toBe(false);
    expect(sameContext(item, { ...item, mode: 'reply' })).toBe(false);
  });

  it('banks the old view at the switch and carries the detail into the sample', () => {
    const chat = { kind: 'session' as const, sessionId: SID, view: 'chat' };
    const files = { kind: 'session' as const, sessionId: SID, view: 'files', file: '/repo/a.ts' };
    let state = applySignal(IDLE_LEASE, chat, T0).state;
    const out = applySignal(state, files, T0 + 20_000);
    expect(out.sample).toEqual({ ts: new Date(T0).toISOString(), durationMs: 20_000, kind: 'session', sessionId: SID, view: 'chat' });
    state = out.state;
    const next = applySignal(state, chat, T0 + 30_000);
    expect(next.sample).toMatchObject({ durationMs: 10_000, view: 'files', file: '/repo/a.ts' });
  });
});

describe('forServer', () => {
  it('drops the names (file, item, label) unless the page is served from this machine', () => {
    const s = { ts: 'x', durationMs: 1, kind: 'app' as const, app: 'chatapp', item: 'C1', label: '#general', mode: 'reply' }
    expect(forServer([s], true)).toEqual([s])
    expect(forServer([s], false)).toEqual([{ ts: 'x', durationMs: 1, kind: 'app', app: 'chatapp', mode: 'reply' }])
    expect(forServer([{ ts: 'x', durationMs: 1, kind: 'session', view: 'files', file: '/a' }], false)).toEqual([{ ts: 'x', durationMs: 1, kind: 'session', view: 'files' }])
  })
})

describe('stillInWalnut', () => {
  it('is true while focus sits in one of our iframes, or the document still has focus', () => {
    expect(stillInWalnut({ activeElement: { tagName: 'IFRAME' }, hasFocus: () => false } as unknown as Document)).toBe(true);
    expect(stillInWalnut({ activeElement: null, hasFocus: () => true } as unknown as Document)).toBe(true);
    expect(stillInWalnut({ activeElement: { tagName: 'BODY' }, hasFocus: () => false } as unknown as Document)).toBe(false);
  });
  it('fails closed when the DOM cannot answer', () => {
    expect(stillInWalnut({ get activeElement(): never { throw new Error('x'); } } as unknown as Document)).toBe(false);
  });
});

// ── Installer: window blur ──

let dom: ReturnType<typeof parseHTML>;
let clock = T0;
let sent: TimeSample[] = [];
let uninstall: () => void = () => {};
let focused = false;
let activeTag = 'BODY';

beforeEach(() => {
  dom = parseHTML(`<body>${PANEL}<iframe id="board"></iframe></body>`);
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = dom.document;
  g.window = dom.window;
  g.Element = dom.window.Element;
  Object.defineProperty(dom.document, 'hasFocus', { value: () => focused, configurable: true });
  Object.defineProperty(dom.document, 'activeElement', { get: () => ({ tagName: activeTag }), configurable: true });
  vi.useFakeTimers();
  clock = T0;
  sent = [];
  focused = false;
  activeTag = 'BODY';
  uninstall = installTimeTracker({ getPathname: () => '/', now: () => clock, send: (batch) => { sent.push(...batch); } });
});

afterEach(() => {
  uninstall();
  vi.useRealTimers();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.document;
  delete g.window;
  delete g.Element;
});

function keydown(id: string): void {
  dom.document.getElementById(id)!.dispatchEvent(new dom.window.Event('keydown', { bubbles: true }));
}

function blurWindow(): void {
  dom.window.dispatchEvent(new dom.window.Event('blur'));
  vi.advanceTimersByTime(0);
}

describe('window blur', () => {
  it('closes the lease when another app takes the focus: the 60 s tail is not counted', () => {
    keydown('composer');
    clock += 10_000;
    blurWindow();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ durationMs: 10_000, kind: 'session', view: 'chat' });
    // Nothing more accrues while the user is elsewhere.
    clock += LEASE_MS * 3;
    vi.advanceTimersByTime(30_000);
    expect(sent.reduce((s, x) => s + x.durationMs, 0)).toBe(10_000);
  });

  it('keeps the lease when the focus only moved into a Walnut iframe (the Board)', () => {
    keydown('composer');
    clock += 10_000;
    activeTag = 'IFRAME';
    blurWindow();
    expect(sent).toHaveLength(0);
    clock += 20_000;
    vi.advanceTimersByTime(30_000);
    expect(sent.reduce((s, x) => s + x.durationMs, 0)).toBeGreaterThanOrEqual(30_000);
  });

  it('an element losing focus is not the window losing it', () => {
    keydown('composer');
    clock += 10_000;
    dom.document.getElementById('composer')!.dispatchEvent(new dom.window.Event('blur'));
    vi.advanceTimersByTime(0);
    expect(sent).toHaveLength(0);
  });

  it('a blur with no lease banks nothing, and the next input starts a fresh lease', () => {
    blurWindow();
    expect(sent).toHaveLength(0);
    keydown('msg');
    clock += 5_000;
    blurWindow();
    expect(sent).toEqual([expect.objectContaining({ kind: 'app', app: 'chatapp', label: '#general', durationMs: 5_000 })]);
  });
});
