/**
 * `--fullscreen-left` is written only while a full screen sheet reads it, and the rail's
 * slide starts only when the page really moved.
 *
 * 2026-11-22, the user, in the Mac app: "the sidebar is extremely laggy when I open and
 * close it." One write of that variable on <html> restyled the whole document (57 ms on
 * Home, 96 ms on Org, measured in the system WebKit), and the shell wrote it on every frame
 * of the slide with no sheet open to read it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFullscreenArea } from '../../web/src/components/layout/fullscreen-area';
import { SLIDE_MS, slideDistance, slideFrom } from '../../web/src/utils/layout-slide';

describe('fullscreen area', () => {
  it('writes nothing while no sheet is on screen, however often the page area moves', () => {
    const writes: string[] = [];
    const area = createFullscreenArea((value) => writes.push(value));
    let left = 56;
    area.bind(() => left);
    for (left = 57; left <= 240; left += 1) area.moved();
    expect(writes).toEqual([]);
    expect(area.inUse()).toBe(false);
  });

  it('writes the current edge the moment a sheet shows, then follows it', () => {
    const writes: string[] = [];
    const area = createFullscreenArea((value) => writes.push(value));
    let left = 56;
    area.bind(() => left);
    left = 240;
    const release = area.retain();
    expect(writes).toEqual(['240px']);
    expect(area.inUse()).toBe(true);
    left = 56;
    area.moved();
    expect(writes).toEqual(['240px', '56px']);
    release();
    left = 240;
    area.moved();
    expect(writes).toEqual(['240px', '56px']);
    expect(area.inUse()).toBe(false);
  });

  it('skips a write of the value already there', () => {
    const writes: string[] = [];
    const area = createFullscreenArea((value) => writes.push(value));
    area.bind(() => 240);
    const release = area.retain();
    area.moved();
    area.moved();
    release();
    area.retain();
    expect(writes).toEqual(['240px']);
  });

  it('stays in use until every sheet has left, and a release counts once', () => {
    const area = createFullscreenArea(() => {});
    area.bind(() => 0);
    const first = area.retain();
    const second = area.retain();
    first();
    first();
    expect(area.inUse()).toBe(true);
    second();
    expect(area.inUse()).toBe(false);
  });

  it('ends a slide of the page before it measures, so the edge is where the page rests', () => {
    const writes: string[] = [];
    const area = createFullscreenArea((value) => writes.push(value));
    let left = 80; // mid-slide: the transform still holds the page short of 56
    area.bind(() => left, () => { left = 56; });
    area.moved();
    expect(writes).toEqual([]);
    area.retain();
    expect(writes).toEqual(['56px']);
  });

  it('a sheet that showed before the shell bound gets the edge when it binds', () => {
    const writes: string[] = [];
    const area = createFullscreenArea((value) => writes.push(value));
    area.retain();
    expect(writes).toEqual([]);
    area.bind(() => 56);
    expect(writes).toEqual(['56px']);
  });
});

describe('layout slide', () => {
  afterEach(() => vi.unstubAllGlobals());

  const element = (left: number) => {
    const animate = vi.fn(() => ({ finished: Promise.resolve(), cancel: () => {} }));
    return { el: { animate, getBoundingClientRect: () => ({ left }) } as unknown as HTMLElement, animate };
  };

  it('is the distance back to where the element was', () => {
    expect(slideDistance(56, 240)).toBe(-184);
    expect(slideDistance(240, 56)).toBe(184);
    expect(slideDistance(240, 240.4)).toBe(0);
  });

  it('slides from the old place to rest with a transform, and nothing else', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    const { el, animate } = element(240);
    expect(slideFrom(el, 56)).not.toBeNull();
    expect(animate).toHaveBeenCalledWith(
      [{ transform: 'translateX(-184px)' }, { transform: 'translateX(0)' }],
      expect.objectContaining({ duration: SLIDE_MS }),
    );
  });

  it('does not start when the element did not move', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    const { el, animate } = element(240);
    expect(slideFrom(el, 240)).toBeNull();
    expect(animate).not.toHaveBeenCalled();
  });

  it('does not start for a reader who asked for reduced motion', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    const { el, animate } = element(240);
    expect(slideFrom(el, 56)).toBeNull();
    expect(animate).not.toHaveBeenCalled();
  });
});
