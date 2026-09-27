/**
 * The ONE key dispatcher for session panels (web/src/hooks/usePanelKeyRouter.ts).
 *
 * Three columns side by side must see exactly one Esc / Cmd+Shift+E each: the
 * panel holding focus wins, and only a focus on <body> (or outside every panel)
 * falls back to the panel under the pointer (C19, C62). The dispatcher cases run
 * against a fake window/document, since this tier has no DOM.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  escapeIsFree, isDrawerChord, keyTargetClaimsEscape, keyTargetThreadDepth, pickKeyTarget, registerPanel,
  registeredPanelCount, type PanelKeyHandlers,
} from '@/hooks/usePanelKeyRouter';

/** Minimal element: a parent chain, attributes, and the few queries the router uses. */
class FakeEl {
  attrs = new Map<string, string>();
  children: FakeEl[] = [];
  constructor(public name: string, public parent: FakeEl | null = null) { parent?.children.push(this); }
  contains(other: unknown): boolean {
    for (let n = other as FakeEl | null; n; n = n.parent) if (n === this) return true;
    return false;
  }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  matches(sel: string) { return sel === '[data-thread-depth]' && this.attrs.has('data-thread-depth'); }
  querySelector(sel: string): FakeEl | null {
    for (const c of this.children) { if (c.matches(sel)) return c; const d = c.querySelector(sel); if (d) return d; }
    return null;
  }
  closest(sel: string): FakeEl | null {
    for (let n: FakeEl | null = this; n; n = n.parent) if (n.matches(sel)) return n;
    return null;
  }
}

const body = new FakeEl('body');
const col = (i: number) => {
  const panel = new FakeEl(`panel${i}`, body);
  const stack = new FakeEl(`stack${i}`, panel);
  stack.attrs.set('data-thread-depth', '0');
  const composer = new FakeEl(`composer${i}`, stack);
  const text = new FakeEl(`text${i}`, stack);
  return { panel, stack, composer, text };
};

describe('pickKeyTarget (pure)', () => {
  const [a, b, c] = [col(1), col(2), col(3)];
  const regs = [a, b, c].map((x) => ({ el: x.panel }));
  const hitAt = (x: number) => (x < 100 ? a.text : x < 200 ? b.text : c.text);

  it('focus in column 1 wins over a pointer resting on column 3 (C62)', () => {
    expect(pickKeyTarget(regs, a.composer as never, body as never, { x: 250, y: 10 }, hitAt as never)?.el).toBe(a.panel);
  });
  it('focus on body falls back to the panel under the pointer', () => {
    expect(pickKeyTarget(regs, body as never, body as never, { x: 150, y: 10 }, hitAt as never)?.el).toBe(b.panel);
  });
  it('focus outside every panel also falls back to the pointer', () => {
    const sidebar = new FakeEl('sidebar-input', body);
    expect(pickKeyTarget(regs, sidebar as never, body as never, { x: 250, y: 10 }, hitAt as never)?.el).toBe(c.panel);
  });
  it('no focus in a panel and no pointer: nobody', () => {
    expect(pickKeyTarget(regs, body as never, body as never, null, hitAt as never)).toBeNull();
    // N32: with focus on <body>, the panel he last pressed in beats the pointer's.
    expect(pickKeyTarget(regs, body as never, body as never, { x: 150, y: 10 }, hitAt as never, a.text as never)?.el).toBe(a.panel);
    // Focus still wins over a press elsewhere.
    expect(pickKeyTarget(regs, a.composer as never, body as never, { x: 150, y: 10 }, hitAt as never, new FakeEl('elsewhere', body) as never)?.el).toBe(a.panel);
  });
  it('nested panels resolve to the innermost', () => {
    const outer = new FakeEl('outer', body);
    const inner = new FakeEl('inner', outer);
    const leaf = new FakeEl('leaf', inner);
    const nested = [{ el: outer }, { el: inner }];
    expect(pickKeyTarget(nested, leaf as never, body as never, null, hitAt as never)?.el).toBe(inner);
  });
});

describe('chord and Esc gates', () => {
  const k = (o: Partial<KeyboardEvent>) => ({ key: 'E', code: 'KeyE', metaKey: false, ctrlKey: false, shiftKey: true, altKey: false, ...o });
  it('Cmd+Shift+E on Mac, Ctrl+Shift+E elsewhere, nothing with Alt', () => {
    expect(isDrawerChord(k({ metaKey: true }), true)).toBe(true);
    expect(isDrawerChord(k({ ctrlKey: true }), true)).toBe(false);
    expect(isDrawerChord(k({ ctrlKey: true }), false)).toBe(true);
    expect(isDrawerChord(k({ metaKey: true, altKey: true }), true)).toBe(false);
    expect(isDrawerChord(k({ metaKey: true, shiftKey: false }), true)).toBe(false);
  });
  it('Esc is free only when nobody took it, outside IME, with no modal', () => {
    expect(escapeIsFree({ defaultPrevented: false, isComposing: false }, false)).toBe(true);
    expect(escapeIsFree({ defaultPrevented: true, isComposing: false }, false)).toBe(false);
    expect(escapeIsFree({ defaultPrevented: false, isComposing: true }, false)).toBe(false);
    expect(escapeIsFree({ defaultPrevented: false, isComposing: false }, true)).toBe(false);
    // WebKit's composition-ending key: isComposing false, keyCode 229.
    expect(escapeIsFree({ defaultPrevented: false, isComposing: false, keyCode: 229 }, false)).toBe(false);
    expect(escapeIsFree({ defaultPrevented: false, isComposing: false, keyCode: 27 }, false)).toBe(true);
  });
});

describe('the window dispatcher: exactly one panel per key (C19, C62)', () => {
  const g = globalThis as Record<string, unknown>;
  let win: EventTarget;
  let doc: { activeElement: unknown; body: unknown; elementFromPoint: (x: number, y: number) => unknown };
  let unregister: Array<() => void> = [];
  const cols = [col(11), col(12), col(13)];
  const calls = { esc: [0, 0, 0], chord: [0, 0, 0] };
  const navDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  const key = (init: Record<string, unknown>) => {
    const e = new Event('keydown', { cancelable: true, bubbles: true });
    for (const [k, v] of Object.entries({ key: '', code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false, ...init })) {
      Object.defineProperty(e, k, { value: v });
    }
    win.dispatchEvent(e);
    return e;
  };

  beforeEach(() => {
    win = new EventTarget();
    doc = { activeElement: body, body, elementFromPoint: () => null };
    g.window = win;
    g.document = doc;
    // Node 21+ ships a getter-only global navigator: redefine, restore after.
    Object.defineProperty(globalThis, 'navigator', { value: { platform: 'MacIntel', userAgent: 'test' }, configurable: true, writable: true });
    calls.esc = [0, 0, 0];
    calls.chord = [0, 0, 0];
    unregister = cols.map((c, i) => {
      const h: { current: PanelKeyHandlers } = {
        current: {
          sessionId: `s${i}`,
          onEscape: () => { calls.esc[i] += 1; return c.stack.getAttribute('data-thread-depth') !== '0'; },
          onToggleDrawer: () => { calls.chord[i] += 1; return true; },
        },
      };
      return registerPanel(c.panel as unknown as HTMLElement, h);
    });
  });

  afterEach(() => {
    unregister.forEach((u) => u());
    for (const k of ['window', 'document']) delete g[k];
    if (navDescriptor) Object.defineProperty(globalThis, 'navigator', navDescriptor);
    else delete g.navigator;
  });

  it('Esc with focus in column 1 reaches column 1 only, even with the pointer on column 3', () => {
    cols[0].stack.attrs.set('data-thread-depth', '2');
    doc.activeElement = cols[0].composer;
    win.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 900, clientY: 10 }));
    doc.elementFromPoint = () => cols[2].text;
    const e = key({ key: 'Escape' });
    expect(calls.esc).toEqual([1, 0, 0]);
    expect(e.defaultPrevented).toBe(true);
    cols[0].stack.attrs.set('data-thread-depth', '0');
  });

  it('Cmd+Shift+E with focus on body goes to the column under the pointer only', () => {
    doc.activeElement = body;
    win.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 500, clientY: 10 }));
    doc.elementFromPoint = () => cols[1].text;
    key({ key: 'E', code: 'KeyE', metaKey: true, shiftKey: true });
    expect(calls.chord).toEqual([0, 1, 0]);
  });

  it('an Esc someone already prevented is left alone; a handler that declines does not prevent', () => {
    doc.activeElement = cols[2].composer;
    const taken = new Event('keydown', { cancelable: true });
    Object.defineProperty(taken, 'key', { value: 'Escape' });
    Object.defineProperty(taken, 'isComposing', { value: false });
    taken.preventDefault();
    win.dispatchEvent(taken);
    expect(calls.esc).toEqual([0, 0, 0]);
    const e = key({ key: 'Escape' });
    expect(calls.esc).toEqual([0, 0, 1]);
    expect(e.defaultPrevented).toBe(false);
  });

  it('IME composition never pops', () => {
    doc.activeElement = cols[0].composer;
    key({ key: 'Escape', isComposing: true });
    expect(calls.esc).toEqual([0, 0, 0]);
  });

  it('WebKit: the Esc that ends a composition (isComposing false, keyCode 229) never pops, nor does the chord', () => {
    cols[0].stack.attrs.set('data-thread-depth', '2');
    doc.activeElement = cols[0].composer;
    const e = key({ key: 'Escape', isComposing: false, keyCode: 229 });
    expect(calls.esc).toEqual([0, 0, 0]);
    expect(e.defaultPrevented).toBe(false);
    key({ key: 'E', code: 'KeyE', metaKey: true, shiftKey: true, isComposing: false, keyCode: 229 });
    expect(calls.chord).toEqual([0, 0, 0]);
    // The next, ordinary Esc still pops.
    key({ key: 'Escape', keyCode: 27 });
    expect(calls.esc).toEqual([1, 0, 0]);
    cols[0].stack.attrs.set('data-thread-depth', '0');
  });

  it('fullscreen reads the target depth: a question page claims Esc, the root does not (C50)', () => {
    doc.activeElement = cols[1].composer;
    expect(keyTargetThreadDepth()).toBe(0);
    expect(keyTargetClaimsEscape()).toBe(false);
    cols[1].stack.attrs.set('data-thread-depth', '2');
    expect(keyTargetThreadDepth()).toBe(2);
    expect(keyTargetClaimsEscape()).toBe(true);
    cols[1].stack.attrs.set('data-thread-depth', '0');
  });

  it('registers exactly one entry per panel', () => {
    expect(registeredPanelCount()).toBe(3);
  });
});
