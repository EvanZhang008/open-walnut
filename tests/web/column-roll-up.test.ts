// The DOM half of the roll-up a session column plays when its task is completed from the
// header. The browser flow (ring -> roll-up -> close -> Undo) is pinned in
// tests/e2e/browser/column-complete-roll-up.spec.ts; this file pins the geometry and the
// animation contract with a stand-in element, because the end state decides what the
// sessions area's removal re-inserts and fades.
import { describe, it, expect, vi } from 'vitest';
import { ROLL_UP_MS, rollUpClips, rollUpColumn } from '../../web/src/utils/column-roll-up';

function fakeColumn(opts: { height?: number; headerBottom?: number; header?: boolean } = {}) {
  const { height = 600, headerBottom = 90, header = true } = opts;
  const anim = { onfinish: null as null | (() => void), cancel: vi.fn() };
  const animate = vi.fn(() => anim);
  const col = {
    dataset: {} as Record<string, string>,
    style: { clipPath: '' },
    querySelector: vi.fn(() => (header ? { getBoundingClientRect: () => ({ bottom: headerBottom }) } : null)),
    getBoundingClientRect: () => ({ top: 10, height }),
    animate,
  };
  return { col: col as unknown as HTMLElement, anim, animate, raw: col };
}

describe('rollUpClips', () => {
  it('rolls from the whole column to the header strip', () => {
    expect(rollUpClips(600, 90)).toEqual({ from: 'inset(0px 0px 0px 0px)', to: 'inset(0px 0px 510px 0px)' });
  });
  it('never asks for a strip taller than the column, or a negative one', () => {
    expect(rollUpClips(80, 500).to).toBe('inset(0px 0px 0px 0px)');
    expect(rollUpClips(80, -5).to).toBe('inset(0px 0px 80px 0px)');
  });
  it('rounds fractional heights outward so the header border is never cut', () => {
    expect(rollUpClips(600.6, 89.2).to).toBe('inset(0px 0px 510px 0px)');
  });
});

describe('rollUpColumn', () => {
  it('has nothing to roll into without a header, or without a laid-out column', () => {
    expect(rollUpColumn(fakeColumn({ header: false }).col)).toBeNull();
    expect(rollUpColumn(fakeColumn({ height: 0 }).col)).toBeNull();
  });

  it('animates the column\'s clip-path from whole to the header strip and marks it rolling', () => {
    const { col, animate, raw } = fakeColumn({ height: 600, headerBottom: 90 });
    expect(rollUpColumn(col)).not.toBeNull();
    const [frames, options] = animate.mock.calls[0] as unknown as [Keyframe[], KeyframeAnimationOptions];
    // header bottom 90 is 80px below the column top (10), +1px for its border = 81
    expect(frames).toEqual([{ clipPath: 'inset(0px 0px 0px 0px)' }, { clipPath: 'inset(0px 0px 519px 0px)' }]);
    expect(options.duration).toBe(ROLL_UP_MS);
    expect(options.fill).toBe('forwards');
    expect(raw.dataset.rollingUp).toBe('true');
  });

  it('on finish holds the strip on the element itself, resolves true, and frees the animation', async () => {
    const { col, anim, raw } = fakeColumn();
    const roll = rollUpColumn(col)!;
    anim.onfinish?.();
    await expect(roll.finished).resolves.toBe(true);
    expect(raw.style.clipPath).toBe('inset(0px 0px 519px 0px)');
    expect(anim.cancel).toHaveBeenCalled();
  });

  it('cancel before the end gives the column back whole and resolves false', async () => {
    const { col, anim, raw } = fakeColumn();
    const roll = rollUpColumn(col)!;
    roll.cancel();
    await expect(roll.finished).resolves.toBe(false);
    expect(anim.cancel).toHaveBeenCalled();
    expect(raw.style.clipPath).toBe('');
    expect(raw.dataset.rollingUp).toBeUndefined();
  });

  it('cancel after the end still clears the held strip, and the first outcome stands', async () => {
    const { col, anim, raw } = fakeColumn();
    const roll = rollUpColumn(col)!;
    anim.onfinish?.();
    roll.cancel();
    await expect(roll.finished).resolves.toBe(true); // a promise settles once
    expect(raw.style.clipPath).toBe('');
  });
});
