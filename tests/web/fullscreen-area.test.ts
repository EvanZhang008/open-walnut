/**
 * `--fullscreen-left` is written only while a full screen sheet reads it, and the page's
 * slide starts at the click, ahead of the layout that moves it.
 *
 * 2026-11-22, the user, in the Mac app: "the sidebar is extremely laggy when I open and
 * close it." One write of that variable on <html> restyled the whole document (57 ms on
 * Home, 96 ms on Org, measured in the system WebKit), and the shell wrote it on every frame
 * of the slide with no sheet open to read it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFullscreenArea } from '../../web/src/components/layout/fullscreen-area';
import { LEAD_HOLD_MS, SLIDE_MS, createLeadSlide, slideDistance } from '../../web/src/utils/layout-slide';

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

describe('lead slide: the motion starts before the layout it follows', () => {
  afterEach(() => vi.unstubAllGlobals());

  type Fake = { frames: Array<{ transform: string }>; options: KeyframeAnimationOptions; startTime: number; playState: string; cancelled: boolean; end(): void };
  const px = (transform: string) => Number(/-?[\d.]+/.exec(transform)?.[0] ?? 0);
  /**
   * A page whose layout left is `box.left`. It is drawn there plus its static `translate`
   * plus its live animation's transform: the last keyframe once the animation is over,
   * else `box.at` (how far along it is), else the first keyframe.
   */
  const page = (left: number) => {
    const box: { left: number; at?: number } = { left };
    const made: Fake[] = [];
    const style = { translate: '' };
    const live = () => made.filter((m) => !m.cancelled).pop();
    const el = {
      style,
      get offsetLeft() { return box.left; },
      getBoundingClientRect: () => {
        const anim = live();
        const moved = !anim ? 0 : anim.playState === 'finished' ? px(anim.frames[anim.frames.length - 1].transform) : box.at ?? px(anim.frames[0].transform);
        return { left: box.left + px(style.translate || '0') + moved };
      },
      animate: (frames: Array<{ transform: string }>, options: KeyframeAnimationOptions) => {
        let done: () => void = () => {};
        let stop: (why: Error) => void = () => {};
        const anim = {
          frames, options, startTime: 1000, playState: 'running', cancelled: false,
          finished: new Promise<void>((resolve, reject) => { done = resolve; stop = reject; }),
          // As the real one: a cancel rejects `finished`.
          cancel() { anim.cancelled = true; stop(new Error('AbortError')); },
          end() { anim.playState = 'finished'; done(); },
        };
        anim.finished.catch(() => {});
        made.push(anim);
        return anim;
      },
    } as unknown as HTMLElement;
    return { el, box, made, style };
  };
  const motion = () => vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  const shift = (n: number) => ({ transform: `translateX(${n}px)` });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** Where an animation starts and ends. */
  const path = (anim: Fake) => [anim.frames[0], anim.frames[anim.frames.length - 1]].map((frame) => ({ transform: frame.transform }));

  it('is the distance between two places, in whole pixels', () => {
    expect(slideDistance(56, 240)).toBe(-184);
    expect(slideDistance(240, 56)).toBe(184);
    expect(slideDistance(240, 240.4)).toBe(0);
  });

  it('leads by the distance the layout will move the page, with a transform and nothing else, held at its end', () => {
    motion();
    const { el, made, style } = page(56);
    const slide = createLeadSlide();
    expect(slide.lead(el, 184)).not.toBeNull();
    expect(path(made[0])).toEqual([shift(0), shift(184)]);
    // Still for its first two frames, as a keyframe: a `delay` reaches the compositor late.
    expect(made[0].frames[1]).toMatchObject({ ...shift(0), offset: LEAD_HOLD_MS / (LEAD_HOLD_MS + SLIDE_MS) });
    expect(made[0].options).toEqual({ duration: LEAD_HOLD_MS + SLIDE_MS, fill: 'forwards' });
    expect(style.translate).toBe('');
    expect(slide.running()).not.toBeNull();
  });

  it('lands under the lead: the same transform runs on, and the layout move is taken back', () => {
    motion();
    const { el, box, made, style } = page(56);
    const slide = createLeadSlide();
    slide.lead(el, 184);
    box.at = 120; // part way: drawn at 176
    box.left = 240; // the layout changed
    expect(slide.land(el)).toBe(made[0]);
    expect(made).toHaveLength(1);
    expect(made[0].cancelled).toBe(false);
    expect(style.translate).toBe('-184px 0');
    expect(el.getBoundingClientRect().left).toBe(176);
  });

  it('follows a layout that moves again under a landed lead', () => {
    motion();
    const { el, box, style } = page(56);
    const slide = createLeadSlide();
    slide.lead(el, 184);
    box.left = 240;
    slide.land(el);
    box.left = 56; // the layout went back before the lead ended
    expect(slide.land(el)).not.toBeNull();
    expect(style.translate).toBe('0px 0');
    box.left = 0; // and then the phone layout took the rail away
    slide.land(el);
    expect(style.translate).toBe('56px 0');
  });

  it('a lead turned back before the layout changed lands with nothing to take back, and rests', async () => {
    motion();
    const { el, box, made, style } = page(56);
    const slide = createLeadSlide();
    slide.lead(el, 184);
    box.at = 100;
    slide.lead(el, 0);
    expect(slide.land(el)).toBe(made[1]);
    expect(style.translate).toBe('0px 0');
    made[1].end();
    await tick();
    expect(style.translate).toBe('');
    expect(slide.running()).toBeNull();
    expect(el.getBoundingClientRect().left).toBe(56);
  });

  it('rests when the lead ends after the layout landed: no transform, no translate', async () => {
    motion();
    const { el, box, made, style } = page(56);
    const slide = createLeadSlide();
    slide.lead(el, 184);
    box.left = 240;
    slide.land(el);
    made[0].end();
    await tick();
    expect(made[0].cancelled).toBe(true);
    expect(style.translate).toBe('');
    expect(slide.running()).toBeNull();
    expect(el.getBoundingClientRect().left).toBe(240);
  });

  it('a lead that ended before the layout landed is held there, then rests as the layout lands', async () => {
    motion();
    const { el, box, made, style } = page(56);
    const slide = createLeadSlide();
    slide.lead(el, 184);
    made[0].end();
    await tick();
    expect(made[0].cancelled).toBe(false);
    expect(el.getBoundingClientRect().left).toBe(240);
    box.left = 240;
    expect(slide.land(el)).toBeNull();
    expect(made[0].cancelled).toBe(true);
    expect(style.translate).toBe('');
    expect(el.getBoundingClientRect().left).toBe(240);
  });

  it('closes the difference when the layout moved the page less than the lead did', async () => {
    motion();
    const { el, box, made, style } = page(56);
    const slide = createLeadSlide();
    slide.lead(el, 184);
    made[0].end();
    box.left = 220; // moved 164, the lead held it at +184
    const last = slide.land(el);
    expect(last).toBe(made[1]);
    expect(style.translate).toBe('-164px 0');
    expect(made[1].frames).toEqual([shift(184), shift(164)]);
    made[1].end();
    await tick();
    expect(style.translate).toBe('');
    expect(slide.running()).toBeNull();
    expect(el.getBoundingClientRect().left).toBe(220);
  });

  it('a second click before the layout changed turns the page back from where it is drawn', () => {
    motion();
    const { el, box, made } = page(56);
    const slide = createLeadSlide();
    slide.lead(el, 184);
    box.at = 100; // drawn at 156
    expect(slide.lead(el, 0)).not.toBeNull();
    expect(made[0].cancelled).toBe(true);
    expect(path(made[1])).toEqual([shift(100), shift(0)]);
  });

  it('a second click after the layout landed starts from where the page is drawn', () => {
    motion();
    const { el, box, made, style } = page(56);
    const slide = createLeadSlide();
    slide.lead(el, 184);
    box.left = 240;
    slide.land(el);
    box.at = 150; // drawn at 240 - 184 + 150 = 206
    expect(slide.lead(el, -184)).not.toBeNull();
    expect(style.translate).toBe('');
    expect(path(made[1])).toEqual([shift(-34), shift(-184)]);
  });

  it('does not lead when the page is already drawn where it will rest', () => {
    motion();
    const { el, made } = page(56);
    expect(createLeadSlide().lead(el, 0.4)).toBeNull();
    expect(made).toEqual([]);
  });

  it('settle drops the motion: the page is drawn where the layout puts it', () => {
    motion();
    const { el, box, made, style } = page(56);
    const slide = createLeadSlide();
    slide.lead(el, 184);
    box.left = 240;
    slide.land(el);
    slide.settle();
    expect(made[0].cancelled).toBe(true);
    expect(style.translate).toBe('');
    expect(slide.running()).toBeNull();
    expect(el.getBoundingClientRect().left).toBe(240);
  });

  it('does not lead for a reader who asked for reduced motion', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    const { el, made } = page(56);
    expect(createLeadSlide().lead(el, 184)).toBeNull();
    expect(made).toEqual([]);
  });
});
