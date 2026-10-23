import { describe, it, expect } from 'vitest';
import { ensureReadableText, readableTextColorFor, withReadableInk } from '@/utils/html-contrast';

/**
 * A rich reply that paints a background and no text colour inherits Walnut's text
 * colour: light lavender in assistant code blocks, light grey in the dark theme.
 * The 2026-10-22 report was `<pre style="background:#f6f8fa">` and a yellow
 * `#fff8c5` box reading as pale grey on white. The browser half (DOMPurify really
 * running the hook) is tests/e2e/browser/rich-html-readable-text.spec.ts.
 */

const DARK = '#1f2328';
const LIGHT = '#f0f3f6';

describe('readableTextColorFor', () => {
  it('light backgrounds from the report get dark text', () => {
    expect(readableTextColorFor('flex:1.4;margin:0;padding:10px;background:#f6f8fa;border:1px solid #d0d7de')).toBe(DARK);
    expect(readableTextColorFor('background:#fff8c5;border:1px solid #d4a72c')).toBe(DARK);
    expect(readableTextColorFor('background-color: #f0fff4')).toBe(DARK);
    expect(readableTextColorFor('background:#fff')).toBe(DARK);
    expect(readableTextColorFor('background: white')).toBe(DARK);
    expect(readableTextColorFor('background: rgb(255, 245, 245)')).toBe(DARK);
  });

  it('dark backgrounds get light text', () => {
    expect(readableTextColorFor('background:#1e1e2e')).toBe(LIGHT);
    expect(readableTextColorFor('background-color: rgba(13, 17, 23, 0.95)')).toBe(LIGHT);
    expect(readableTextColorFor('background:navy')).toBe(LIGHT);
  });

  it('an author colour is kept', () => {
    expect(readableTextColorFor('background:#f6f8fa;color:#555')).toBeNull();
    expect(readableTextColorFor('color: var(--fg); background:#fff')).toBeNull();
  });

  it('background-color is not mistaken for color', () => {
    expect(readableTextColorFor('background-color:#fff')).toBe(DARK);
  });

  it('theme variables, gradients, images and see-through tints are left alone', () => {
    expect(readableTextColorFor('background: var(--bg-secondary)')).toBeNull();
    expect(readableTextColorFor('background: linear-gradient(#fff, #eee)')).toBeNull();
    expect(readableTextColorFor('background: url(x.png)')).toBeNull();
    expect(readableTextColorFor('background: rgba(0,0,0,0.05)')).toBeNull();
    expect(readableTextColorFor('background: #ffffff20')).toBeNull();
    expect(readableTextColorFor('background: transparent')).toBeNull();
    expect(readableTextColorFor('border:1px solid #fff')).toBeNull();
    expect(readableTextColorFor('')).toBeNull();
  });

  it('a colour written beside an image or gradient is not the whole background', () => {
    expect(readableTextColorFor('background:#fff url(hero.jpg)')).toBeNull();
    expect(readableTextColorFor('background:#fff linear-gradient(#111,#333)')).toBeNull();
    expect(readableTextColorFor('background-image:url(dark.jpg);background-color:#fff')).toBeNull();
    expect(readableTextColorFor('background-image:none;background-color:#fff')).toBe(DARK);
  });

  it('the later of background and background-color wins, as in CSS', () => {
    expect(readableTextColorFor('background-color:#000;background:#fff')).toBe(DARK);
    expect(readableTextColorFor('background:#fff;background-color:#000')).toBe(LIGHT);
    expect(readableTextColorFor('background:#f6f8fa !important')).toBe(DARK);
  });

  it('an unreadable colour token gives up instead of guessing', () => {
    expect(readableTextColorFor('background: #12345')).toBeNull();
    expect(readableTextColorFor('background: rgb(nope)')).toBeNull();
  });
});

describe('ensureReadableText', () => {
  const armed = (el: Element) => withReadableInk(() => ensureReadableText(el));

  it('appends the colour, keeps the author style and marks the ink', () => {
    const el = document.createElement('pre');
    el.setAttribute('style', 'padding:10px;background:#f6f8fa');
    armed(el);
    expect(el.getAttribute('style')).toBe(`padding:10px;background:#f6f8fa;color:${DARK}`);
    expect(el.getAttribute('data-ink')).toBe('dark');
  });

  it('a trailing semicolon is not doubled', () => {
    const el = document.createElement('div');
    el.setAttribute('style', 'background:#1e1e2e;');
    armed(el);
    expect(el.getAttribute('style')).toBe(`background:#1e1e2e;color:${LIGHT}`);
    expect(el.getAttribute('data-ink')).toBe('light');
  });

  it('elements without a background are untouched', () => {
    const el = document.createElement('div');
    el.setAttribute('style', 'display:flex;gap:12px');
    armed(el);
    expect(el.getAttribute('style')).toBe('display:flex;gap:12px');
    const bare = document.createElement('p');
    armed(bare);
    expect(bare.hasAttribute('style')).toBe(false);
  });

  it('is inert outside withReadableInk (mail, Office previews, copied rich text)', () => {
    const el = document.createElement('td');
    el.setAttribute('style', 'background:#fff');
    ensureReadableText(el);
    expect(el.getAttribute('style')).toBe('background:#fff');
    expect(el.hasAttribute('data-ink')).toBe(false);
  });

  it('a throw inside the run still disarms the hook', () => {
    expect(() => withReadableInk(() => { throw new Error('boom'); })).toThrow('boom');
    const el = document.createElement('div');
    el.setAttribute('style', 'background:#fff');
    ensureReadableText(el);
    expect(el.getAttribute('style')).toBe('background:#fff');
  });
});
