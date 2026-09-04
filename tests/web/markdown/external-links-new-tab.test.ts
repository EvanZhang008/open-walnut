import { describe, it, expect, beforeAll } from 'vitest';
import { isExternalHttpHref, markExternalAnchor } from '@/utils/markdown';

/**
 * External links in rendered chat open in a NEW tab. Neither marked nor DOMPurify
 * sets `target`, so a `[docs](https://…)` in a reply used to navigate the whole
 * console away (2026-09-03 report). The fix is one DOMPurify hook on the shared
 * singleton; this pins the hook body and the "external" decision. The rendered
 * result in a real browser is covered by
 * tests/e2e/browser/external-links-new-tab.spec.ts (this tier's linkedom window
 * has no `document.implementation`, so DOMPurify itself does not run here).
 */

const ORIGIN = 'http://localhost:3456';

beforeAll(() => {
  const w = globalThis.window as unknown as { location?: { origin?: string } };
  if (!w.location?.origin) {
    Object.defineProperty(w, 'location', {
      configurable: true,
      value: { href: `${ORIGIN}/`, origin: ORIGIN },
    });
  }
});

function anchor(href: string, attrs: Record<string, string> = {}): Element {
  const a = document.createElement('a');
  a.setAttribute('href', href);
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
  return a;
}

describe('isExternalHttpHref', () => {
  it('is true only for http(s) hrefs on another origin', () => {
    expect(isExternalHttpHref('https://example.com/x')).toBe(true);
    expect(isExternalHttpHref('http://example.com')).toBe(true);
    expect(isExternalHttpHref('//cdn.example.com/a.js')).toBe(true);
    expect(isExternalHttpHref(' https://example.com ')).toBe(true);
  });

  it('is false for in-app and non-web hrefs', () => {
    expect(isExternalHttpHref(`${ORIGIN}/tasks/abc`)).toBe(false);
    expect(isExternalHttpHref('/tasks/abc')).toBe(false);
    expect(isExternalHttpHref('#')).toBe(false);
    expect(isExternalHttpHref('')).toBe(false);
    expect(isExternalHttpHref('mailto:a@b.co')).toBe(false);
    expect(isExternalHttpHref('vscode://file/x.ts')).toBe(false);
    expect(isExternalHttpHref('javascript:alert(1)')).toBe(false);
  });
});

describe('markExternalAnchor (the DOMPurify afterSanitizeAttributes hook)', () => {
  it('adds target=_blank and a hardened rel to an external anchor', () => {
    const a = anchor('https://example.com/x');
    markExternalAnchor(a);
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('overrides a weaker rel the model wrote, so the new tab never gets window.opener', () => {
    const a = anchor('https://example.com/x', { rel: 'nofollow' });
    markExternalAnchor(a);
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('leaves same-origin, relative, pill, and mailto anchors alone', () => {
    for (const href of [`${ORIGIN}/tasks/abc`, '/tasks/abc', '#', 'mailto:a@b.co']) {
      const a = anchor(href, { class: 'task-link' });
      markExternalAnchor(a);
      expect(a.hasAttribute('target'), href).toBe(false);
      expect(a.hasAttribute('rel'), href).toBe(false);
    }
  });

  it('ignores non-anchor elements', () => {
    const img = document.createElement('img');
    img.setAttribute('href', 'https://example.com/x');
    markExternalAnchor(img);
    expect(img.hasAttribute('target')).toBe(false);
  });
});
