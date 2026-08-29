/**
 * The letter reader's HTML frame — the document the console wraps an agent's
 * body in before handing it to a sandboxed iframe.
 *
 * Contract under test:
 *   - the security floor never moves: no scripts, no same-origin, and a CSP
 *     that allows NO network subresource (a tracker pixel in a letter would
 *     otherwise report the moment and IP the human read it);
 *   - `media-src data: blob:` IS part of that floor, because a daily digest
 *     embeds its podcast as `<audio src="data:audio/mpeg;base64,…">` and under
 *     `default-src 'none'` the player renders and then silently refuses to play
 *     — a failure with no error message anywhere;
 *   - the agent's markup is never rewritten, whatever shape it arrives in: a
 *     bare fragment, a full document, a document with its own `<head>`.
 */
import { describe, it, expect } from 'vitest';
import { wrapLetterHtml, LETTER_IFRAME_SANDBOX } from '../../web/src/components/inbox/letter-html-frame';

/** Pull the CSP directive list out of the wrapped document. */
function csp(html: string): string {
  const m = html.match(/content="(default-src[^"]*)"/);
  if (!m) throw new Error('no CSP meta in the wrapped document');
  return m[1];
}

const AUDIO_BODY =
  '<h1>Daily digest</h1><audio controls src="data:audio/mpeg;base64,AAAAAAAA"></audio>';

describe('letter frame security floor', () => {
  it('never grants scripts or same-origin', () => {
    expect(LETTER_IFRAME_SANDBOX).not.toContain('allow-scripts');
    expect(LETTER_IFRAME_SANDBOX).not.toContain('allow-same-origin');
  });

  it('allows data:/blob: media so an embedded audio digest can play', () => {
    const directives = csp(wrapLetterHtml(AUDIO_BODY));
    expect(directives).toContain('media-src data: blob:');
  });

  it('still allows no network subresource of any kind', () => {
    const directives = csp(wrapLetterHtml(AUDIO_BODY));
    expect(directives).toContain("default-src 'none'");
    // Every relaxation is data:/blob:/inline — nothing that can reach a host.
    expect(directives).not.toMatch(/https?:/);
    expect(directives).not.toContain('*');
  });
});

describe('wrapLetterHtml', () => {
  it('keeps an embedded data: audio URI byte-identical', () => {
    expect(wrapLetterHtml(AUDIO_BODY)).toContain(AUDIO_BODY);
  });

  it('wraps a bare fragment into one document with a new-tab base target', () => {
    const out = wrapLetterHtml('<p>hi</p>');
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(out).toContain('<base target="_blank">');
    expect(out).toContain('<p>hi</p>');
    // Exactly one document — a nested <html> is silently unwrapped by browsers.
    expect(out.match(/<html/gi)).toHaveLength(1);
  });

  it('splices into a body that is already a full document instead of nesting one', () => {
    const out = wrapLetterHtml('<html><head><title>T</title></head><body>x</body></html>');
    expect(out.match(/<html/gi)).toHaveLength(1);
    expect(out.match(/<head/gi)).toHaveLength(1);
    expect(out).toContain('<title>T</title>');
    // The CSP must land INSIDE the head, and first — a policy meta only governs
    // what follows it.
    expect(out.indexOf('default-src')).toBeLessThan(out.indexOf('<title>'));
  });

  it('gives a document with <html> but no <head> a head of its own', () => {
    const out = wrapLetterHtml('<html><body>x</body></html>');
    expect(out.match(/<head/gi)).toHaveLength(1);
    expect(csp(out)).toContain('media-src');
  });
});
