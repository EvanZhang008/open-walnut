/**
 * A width change keeps the reader's place in a file view (web/src/utils/reading-place.ts;
 * 2026-11-10 WebKit review: widening 1280 -> 1600 with an Ask card open moved the document
 * from Section 62 to Section 74, and the card docked over the file header).
 *
 * The node tier has no DOM, so a small model of a wrapped document stands in: a block's
 * document offset shrinks as the column widens (fewer wrapped lines above it), and its
 * viewport top is the scroller's top + offset - scrollTop, as in a browser.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keepReadingPlace, placeShift, setReadingAnchor } from '../../web/src/utils/reading-place';

type Listener = (e: { target: unknown }) => void;

/** A document of `blocks` paragraphs, each `chars` characters, wrapped at `width` px (8px a char, 20px a line): 4 lines at 800px, 3 at 1000px. */
function model(blocks = 120, chars = 330) {
  const state = { width: 800, scrollTop: 0 };
  const lineH = 20;
  const blockTop = (i: number) => {
    const lines = Math.ceil((chars * 8) / state.width);
    return i * (lines * lineH + 16);
  };
  const SCROLLER_TOP = 100;
  // Accessors copied as accessors (a spread would freeze them into values).
  const el = (name: string, extra: object = {}) => Object.defineProperties({
    name,
    get clientWidth() { return state.width; },
    getBoundingClientRect: () => ({ top: SCROLLER_TOP, bottom: SCROLLER_TOP + 600, left: 0, right: state.width, width: state.width, height: 600 }),
    contains: (o: unknown) => o === scroller || o === body || (o as { block?: number })?.block !== undefined,
    classList: { contains: () => false },
  } as Record<string, unknown>, Object.getOwnPropertyDescriptors(extra));
  const scroller = el('scroller', {
    get scrollTop() { return state.scrollTop; },
    set scrollTop(v: number) { state.scrollTop = v; },
  });
  const blockEl = (i: number) => ({
    block: i, isConnected: true,
    getBoundingClientRect: () => ({ top: SCROLLER_TOP + blockTop(i) - state.scrollTop, width: 10, height: 10 }),
  });
  const body = el('body', {
    ownerDocument: {
      // The block under a point: the one whose box spans that y.
      elementFromPoint: (_x: number, y: number) => {
        for (let i = 0; i < blocks; i++) {
          const top = SCROLLER_TOP + blockTop(i) - state.scrollTop;
          if (y >= top && y < SCROLLER_TOP + blockTop(i + 1) - state.scrollTop) return blockEl(i);
        }
        return null;
      },
    },
  });
  const view = el('view');
  return { state, view, scroller, body, blockEl, blockTop, SCROLLER_TOP };
}

let ro: { cb: () => void } | null = null;
/** Every observe/unobserve call, and whether it ran inside the observer's own callback. */
const observeLog: Array<{ el: unknown; inCallback: boolean }> = [];
const unobserveLog: Array<{ el: unknown; inCallback: boolean }> = [];
let inCallback = false;
/** Deliver the observer the way a browser does: its callback, with the flag set meanwhile. */
const deliver = () => { inCallback = true; try { ro!.cb(); } finally { inCallback = false; } };
const scrollListeners: Listener[] = [];
beforeEach(() => {
  ro = null;
  scrollListeners.length = 0;
  observeLog.length = 0;
  unobserveLog.length = 0;
  const g = globalThis as Record<string, unknown>;
  g.ResizeObserver = class { constructor(cb: () => void) { ro = { cb }; } observe(el: unknown) { observeLog.push({ el, inCallback }); } unobserve(el: unknown) { unobserveLog.push({ el, inCallback }); } disconnect() {} };
  g.getComputedStyle = () => ({ paddingLeft: '0', paddingRight: '0' });
  g.requestAnimationFrame = (f: () => void) => { f(); return 1; };
  g.cancelAnimationFrame = () => {};
  g.document = { addEventListener: (_t: string, l: Listener) => scrollListeners.push(l), removeEventListener: () => {} };
});
afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  for (const k of ['ResizeObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'document']) delete g[k];
});

function keep(m: ReturnType<typeof model>) {
  return keepReadingPlace(m.view as unknown as HTMLElement, () => ({ scroller: m.scroller as unknown as HTMLElement, body: m.body as unknown as Element }));
}
const scrolled = (m: ReturnType<typeof model>) => { for (const l of scrollListeners) l({ target: m.scroller }); };

describe('the reading place across a width change', () => {
  it('the reported case: a passage with its card open stays where it was when the view widens', () => {
    const m = model();
    const off = keep(m);
    // The reader is at block 62 (Section 62), 150px under the scroller's top.
    m.state.scrollTop = m.blockTop(62) - 150;
    const passage = m.blockEl(62);
    setReadingAnchor(m.view as unknown as Element, () => passage.getBoundingClientRect().top);
    scrolled(m);
    const before = passage.getBoundingClientRect().top;
    // 1280 -> 1600: the column widens, every block above rewraps into fewer lines.
    m.state.width = 1000;
    expect(Math.abs(passage.getBoundingClientRect().top - before)).toBeGreaterThan(200); // what WebKit showed
    ro!.cb();
    expect(Math.abs(passage.getBoundingClientRect().top - before)).toBeLessThanOrEqual(1);
    // And back at the old width it comes back to the same place.
    m.state.width = 800;
    ro!.cb();
    expect(Math.abs(passage.getBoundingClientRect().top - before)).toBeLessThanOrEqual(1);
    setReadingAnchor(m.view as unknown as Element, null);
    off();
  });

  it('with no card the top line stays at the top, through many steps of a window drag', () => {
    const m = model();
    const off = keep(m);
    m.state.scrollTop = m.blockTop(40) + 5;
    scrolled(m);
    const top = m.blockEl(40);
    const before = top.getBoundingClientRect().top;
    for (const w of [820, 860, 910, 990, 1100, 700, 640]) {
      m.state.width = w;
      ro!.cb();
      expect(Math.abs(top.getBoundingClientRect().top - before)).toBeLessThanOrEqual(1);
    }
    off();
  });

  it('a passage scrolled off screen does not hold the place: the top line does', () => {
    const m = model();
    const off = keep(m);
    m.state.scrollTop = m.blockTop(80);
    const far = m.blockEl(10);
    setReadingAnchor(m.view as unknown as Element, () => far.getBoundingClientRect().top);
    scrolled(m);
    const line = m.blockEl(80);
    const before = line.getBoundingClientRect().top;
    m.state.width = 1000;
    ro!.cb();
    expect(Math.abs(line.getBoundingClientRect().top - before)).toBeLessThanOrEqual(1);
    setReadingAnchor(m.view as unknown as Element, null);
    off();
  });

  it('a change of height alone (text typed, an image) never moves the reader', () => {
    const m = model();
    const off = keep(m);
    m.state.scrollTop = 4000;
    scrolled(m);
    ro!.cb();
    expect(m.state.scrollTop).toBe(4000);
    off();
  });

  it('placeShift ignores sub-pixel noise', () => {
    expect(placeShift(100, 100.6)).toBe(0);
    expect(placeShift(100, 340)).toBe(240);
    expect(placeShift(100, -20)).toBe(-120);
  });
});

/**
 * A real frame: the animation-frame callbacks run first, then layout, then the ResizeObserver,
 * as in a browser. A synchronous requestAnimationFrame stand-in hides the order this is about
 * (2026-11-10 review: the scroll handler's frame noted the rewrapped place before the observer
 * could put the old one back, so a continuous width drag lost the reader's place).
 */
describe('the reading place in real frame order', () => {
  let frames: Array<() => void> = [];
  beforeEach(() => {
    frames = [];
    const g = globalThis as Record<string, unknown>;
    g.requestAnimationFrame = (f: () => void) => { frames.push(f); return frames.length; };
  });
  const frame = () => {
    const due = frames.splice(0);
    for (const f of due) f();
    deliver();
  };

  it('a scroll event and a width change in the same frame keep the place, through a whole drag', () => {
    const m = model();
    const off = keep(m);
    m.state.scrollTop = m.blockTop(40) + 5;
    scrolled(m);
    frame();
    const top = m.blockEl(40);
    const before = top.getBoundingClientRect().top;
    for (const w of [820, 860, 910, 990, 1100, 700, 640]) {
      m.state.width = w;
      // The previous frame's restore scrolled, so its scroll event lands in this frame too.
      scrolled(m);
      frame();
      expect(Math.abs(top.getBoundingClientRect().top - before)).toBeLessThanOrEqual(1);
    }
    off();
  });

  it('a scroll of the reader alone, at one width, is noted and never undone', () => {
    const m = model();
    const off = keep(m);
    m.state.scrollTop = 2000;
    scrolled(m);
    frame();
    m.state.scrollTop = 3000;
    scrolled(m);
    frame();
    expect(m.state.scrollTop).toBe(3000);
    m.state.width = 1000;
    frame();
    // The width change keeps the place noted at 3000, not the one at 2000.
    const line = m.blockEl(Math.floor(3000 / (4 * 20 + 16)));
    expect(line.getBoundingClientRect().top).toBeGreaterThan(m.SCROLLER_TOP - 200);
    off();
  });

  it('the observer never observes or lets go of an element inside its own callback', () => {
    const m = model();
    const scroller2 = { ...m.scroller } as unknown as HTMLElement;
    let surface = { scroller: m.scroller as unknown as HTMLElement, body: m.body as unknown as Element };
    const off = keepReadingPlace(m.view as unknown as HTMLElement, () => surface);
    // The view swaps its surface (Preview to Source): the next delivery finds a new scroller.
    surface = { scroller: scroller2, body: m.body as unknown as Element };
    deliver();
    expect(observeLog.filter((o) => o.inCallback)).toEqual([]);
    expect(unobserveLog.filter((o) => o.inCallback)).toEqual([]);
    frame();
    // A frame later the new scroller is watched and the old one let go.
    expect(observeLog.some((o) => o.el === scroller2)).toBe(true);
    expect(unobserveLog.some((o) => o.el === m.scroller)).toBe(true);
    off();
  });
});
