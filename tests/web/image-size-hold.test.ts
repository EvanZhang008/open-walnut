/**
 * A chat image drawn again keeps its box while it decodes
 * (web/src/utils/image-size-hold.ts): the rule, on stand-in image elements.
 * The browser half is tests/e2e/browser/stream-final-render-parity.spec.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { _resetImageSizeHold, holdImageBox, rememberImageBox } from '../../web/src/utils/image-size-hold';

function fakeImg(opts: { src: string; complete: boolean; natural?: number; rect?: { w: number; h: number }; cw: number }) {
  const listeners: Record<string, Array<() => void>> = {};
  const img = {
    complete: opts.complete,
    naturalWidth: opts.natural ?? (opts.complete ? 40 : 0),
    style: { width: '', height: '' },
    dataset: {} as Record<string, string>,
    parentElement: { clientWidth: opts.cw },
    getAttribute: (k: string) => (k === 'src' ? opts.src : k === 'style' ? (img.styleAttr ?? null) : k === 'loading' ? img.loadingAttr : null),
    removeAttribute: (k: string) => {
      if (k === 'style') { img.styleAttr = null; img.style.width = ''; img.style.height = ''; }
      if (k === 'loading') img.loadingAttr = null;
    },
    styleAttr: null as string | null,
    loadingAttr: 'lazy' as string | null,
    getBoundingClientRect: () => ({ width: opts.rect?.w ?? 0, height: opts.rect?.h ?? 0 }),
    addEventListener: (k: string, f: () => void) => { (listeners[k] ??= []).push(f); },
    removeEventListener: (k: string, f: () => void) => { listeners[k] = (listeners[k] ?? []).filter((x) => x !== f); },
    fire: (k: string) => { for (const f of [...(listeners[k] ?? [])]) f(); },
  };
  return img as unknown as HTMLImageElement & { fire: (k: string) => void; loadingAttr: string | null };
}

// The node tier has no layout: the content box is the stand-in's rect.
(globalThis as { getComputedStyle?: unknown }).getComputedStyle = (el: { getBoundingClientRect: () => { width: number; height: number } }) => {
  const r = el.getBoundingClientRect();
  return { width: `${r.width}px`, height: `${r.height}px` };
};

afterEach(() => _resetImageSizeHold());

describe('image size hold', () => {
  it('holds a new, loading image at the box its src was drawn at, until it loads', () => {
    rememberImageBox(fakeImg({ src: '/a.png', complete: true, rect: { w: 400, h: 240 }, cw: 800 }));
    const next = fakeImg({ src: '/a.png', complete: false, cw: 800 });
    expect(holdImageBox(next)).toBe(true);
    expect(next.style.width).toBe('400px');
    expect(next.style.height).toBe('240px');
    next.fire('load');
    expect(next.style.width).toBe('');
    expect(next.style.height).toBe('');
    expect(next.dataset.wnHeld).toBeUndefined();
  });

  it('a src this page loaded is no longer lazy, a src it never loaded stays lazy', () => {
    const first = fakeImg({ src: '/a.png', complete: true, rect: { w: 40, h: 24 }, cw: 800 });
    rememberImageBox(first);
    expect(first.loadingAttr).toBeNull();
    const again = fakeImg({ src: '/a.png', complete: false, cw: 800 });
    holdImageBox(again);
    expect(again.loadingAttr).toBeNull();
    const other = fakeImg({ src: '/never.png', complete: false, cw: 800 });
    holdImageBox(other);
    expect(other.loadingAttr).toBe('lazy');
  });

  it('releases on error too', () => {
    rememberImageBox(fakeImg({ src: '/a.png', complete: true, rect: { w: 40, h: 24 }, cw: 800 }));
    const next = fakeImg({ src: '/a.png', complete: false, cw: 800 });
    holdImageBox(next);
    next.fire('error');
    expect(next.style.height).toBe('');
  });

  it('leaves alone an image already drawn, one never seen, and one in a container of another width', () => {
    rememberImageBox(fakeImg({ src: '/a.png', complete: true, rect: { w: 40, h: 24 }, cw: 800 }));
    expect(holdImageBox(fakeImg({ src: '/a.png', complete: true, cw: 800 }))).toBe(false);
    expect(holdImageBox(fakeImg({ src: '/b.png', complete: false, cw: 800 }))).toBe(false);
    expect(holdImageBox(fakeImg({ src: '/a.png', complete: false, cw: 600 }))).toBe(false);
  });

  it('records nothing for a hidden image, a broken one, or one it is holding', () => {
    rememberImageBox(fakeImg({ src: '/h.png', complete: true, rect: { w: 0, h: 0 }, cw: 800 }));
    expect(holdImageBox(fakeImg({ src: '/h.png', complete: false, cw: 800 }))).toBe(false);
    rememberImageBox(fakeImg({ src: '/x.png', complete: true, natural: 0, rect: { w: 16, h: 16 }, cw: 800 }));
    expect(holdImageBox(fakeImg({ src: '/x.png', complete: false, cw: 800 }))).toBe(false);
    rememberImageBox(fakeImg({ src: '/a.png', complete: true, rect: { w: 40, h: 24 }, cw: 800 }));
    const held = fakeImg({ src: '/a.png', complete: false, cw: 800 });
    holdImageBox(held);
    Object.assign(held, { complete: true, naturalWidth: 40, getBoundingClientRect: () => ({ width: 99, height: 99 }) });
    rememberImageBox(held); // still held: its box is the remembered one, not its own
    const again = fakeImg({ src: '/a.png', complete: false, cw: 800 });
    holdImageBox(again);
    expect(again.style.width).toBe('40px');
  });
});
