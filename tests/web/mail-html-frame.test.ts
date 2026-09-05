/**
 * The frame an HTML mail body renders inside, and the pure hardening pass in front of it.
 *
 * HTML mail is the most hostile input this console renders: it is written by whoever sent the
 * message. Three layers answer that, and only two of them are testable here:
 *
 *   1. the iframe sandbox (no scripts, no same-origin) and the document CSP,
 *   2. `hardenMailHtml`, a pure string pass with no DOM,
 *   3. DOMPurify, which runs LAST in the browser and is the primary sanitizer.
 *
 * Layer 3 CANNOT be graded in this tier: `tests/web/*.test.ts` runs under the node
 * environment, and DOMPurify without a DOM is a passthrough, so a "DOMPurify stripped it"
 * assertion here would pass for the wrong reason. The end-to-end srcdoc (harden + DOMPurify)
 * is asserted in a real browser by tests/e2e/browser/mail-app-read.spec.ts; what this file
 * pins is that the frame's own floor never moves and that the pure pass alone already removes
 * script, event handlers and javascript: URLs.
 */
import { describe, it, expect } from 'vitest';
import {
  MAIL_IFRAME_SANDBOX,
  buildMailSrcdoc,
  countRemoteImages,
  hardenMailHtml,
  mailFrameCsp,
} from '../../web/src/apps/mail/mail-html';

/** The CSP directive list out of a built document. */
function csp(document: string): string {
  const match = document.match(/content="(default-src[^"]*)"/);
  if (!match) throw new Error('no CSP meta in the built document');
  return match[1]!;
}

const HOSTILE = [
  '<p>Hello <b>there</b></p>',
  '<script>alert(1)</script>',
  '<img src="https://tracker.example.invalid/pixel.png" onerror="alert(2)">',
  '<a href="javascript:alert(3)">click</a>',
  '<iframe src="https://example.invalid/frame"></iframe>',
  '<form action="https://example.invalid/post"><input name="x"></form>',
  '<style>p { color: red }</style>',
].join('');

describe('the mail frame security floor', () => {
  it('grants popups and nothing else', () => {
    expect(MAIL_IFRAME_SANDBOX).not.toContain('allow-scripts');
    expect(MAIL_IFRAME_SANDBOX).not.toContain('allow-same-origin');
    expect(MAIL_IFRAME_SANDBOX).toContain('allow-popups');
  });

  it('blocks every remote subresource while images are blocked', () => {
    const directives = mailFrameCsp(false);
    expect(directives).toContain("default-src 'none'");
    expect(directives).toContain('img-src data: cid:');
    // A tracking pixel reports the moment and the IP of the read, so no http(s) origin may
    // appear anywhere in the policy until the human asks for images.
    expect(directives).not.toMatch(/https?:/);
    expect(directives).not.toContain('*');
  });

  it('opens img-src only, and only for the message the human opted into', () => {
    const directives = mailFrameCsp(true);
    expect(directives).toContain('img-src data: cid: https: http:');
    expect(directives).toContain("default-src 'none'");
    // Loading images must not become "load anything": styles stay inline-only and there is
    // still no script-src, so the sandbox is not the only thing standing between the body
    // and the network.
    expect(directives).not.toContain('script-src');
    expect(directives).toContain("style-src 'unsafe-inline'");
  });

  it("pins the frame's own base, so a body cannot re-point relative URLs", () => {
    // The frame's `<base target="_blank">` is what sends links out of the sandbox. A second
    // `<base href>` from the body would repoint every relative URL in the document instead.
    expect(mailFrameCsp(false)).toContain("base-uri 'none'");
    expect(mailFrameCsp(true)).toContain("base-uri 'none'");
  });
});

/**
 * Every OTHER way a body can fetch a picture under `img-src`.
 *
 * These matter because "1 remote image blocked / Load images" is a promise about a NUMBER: the
 * opt-in widens `img-src` for the whole document, so anything else the policy would then release
 * is a picture the human was never told about, and none of these is countable as an `<img>`.
 */
const UNCOUNTABLE_FETCHES = [
  '<video poster="https://tracker.example.invalid/frame.jpg"></video>',
  '<svg><image href="https://tracker.example.invalid/a.png"></image></svg>',
  '<svg><image xlink:href="https://tracker.example.invalid/b.png"></image></svg>',
  '<div style="background-image: url(https://tracker.example.invalid/c.png)">x</div>',
  '<style>.hero { background: url("https://tracker.example.invalid/d.png"); }</style>',
].join('');

describe('buildMailSrcdoc', () => {
  it('carries the CSP before anything else in the head, and a base target', () => {
    const document = buildMailSrcdoc('<p>hi</p>', { allowRemoteImages: false });
    expect(document.startsWith('<!doctype html>')).toBe(true);
    expect(document).toContain('<base target="_blank">');
    // A policy meta only governs what follows it, so its position is part of the contract.
    expect(document.indexOf('Content-Security-Policy')).toBeLessThan(document.indexOf('<base'));
    expect(document).toContain('<meta name="referrer" content="no-referrer">');
    expect(document).toContain('<p>hi</p>');
  });

  it('answers the images-blocked and images-loaded policies for the same body', () => {
    const body = '<img src="https://example.invalid/pixel.png">';
    expect(csp(buildMailSrcdoc(body, { allowRemoteImages: false }))).not.toMatch(/https?:/);
    expect(csp(buildMailSrcdoc(body, { allowRemoteImages: true }))).toContain('https:');
  });

  it('adds nothing of its own that reads like a dangerous URL', () => {
    // The frame's furniture (the reset stylesheet) travels in every document, so any prose it
    // carries is prose the reader has to trust. A comment naming a script scheme made an honest
    // document look like it was smuggling one, and defeats grepping a captured srcdoc.
    const document = buildMailSrcdoc('<p>hi</p>', { allowRemoteImages: false });
    expect(document.toLowerCase()).not.toContain('javascript:');
    expect(document).not.toContain('/*');
  });
});

describe('hardenMailHtml', () => {
  const cleaned = hardenMailHtml(HOSTILE);

  it('removes script elements with their contents', () => {
    expect(cleaned).not.toContain('<script');
    expect(cleaned).not.toContain('alert(1)');
  });

  it('removes event-handler attributes', () => {
    expect(cleaned.toLowerCase()).not.toContain('onerror');
    expect(cleaned).not.toContain('alert(2)');
  });

  it('neutralizes javascript: URLs but keeps the link text', () => {
    expect(cleaned.toLowerCase()).not.toContain('javascript:');
    expect(cleaned).toContain('click');
  });

  it('removes frames, embeds and forms', () => {
    for (const tag of ['<iframe', '<form', '<input', '<object', '<embed']) {
      expect(cleaned).not.toContain(tag);
    }
  });

  it('keeps the prose and the sender styling', () => {
    expect(cleaned).toContain('<b>there</b>');
    expect(cleaned).toContain('<style>p { color: red }</style>');
  });

  it('drops document-level tags so the body is always a fragment', () => {
    // The wrap supplies the document. A second <html>/<head> nested inside it is silently
    // rearranged by the parser, which is how a policy meta ends up after the content it was
    // supposed to govern.
    const wrapped = hardenMailHtml('<!doctype html><html><head><base href="https://x.invalid/"></head><body><p>x</p></body></html>');
    expect(wrapped.toLowerCase()).not.toContain('<html');
    expect(wrapped.toLowerCase()).not.toContain('<head');
    expect(wrapped.toLowerCase()).not.toContain('<body');
    expect(wrapped.toLowerCase()).not.toContain('<base');
    expect(wrapped).toContain('<p>x</p>');
  });

  it('leaves an ordinary body byte-identical', () => {
    const plain = '<p>Meeting at 3, agenda attached.</p><ul><li>one</li></ul>';
    expect(hardenMailHtml(plain)).toBe(plain);
  });

  it('strips the remote fetches that "Load images" would release uncounted', () => {
    const kept = hardenMailHtml(UNCOUNTABLE_FETCHES);
    expect(kept.toLowerCase()).not.toContain('poster');
    expect(kept.toLowerCase()).not.toContain('href');
    expect(kept).not.toContain('url(');
    // Media goes with its poster: it can never play under this CSP, and the browser renders an
    // empty <video> as a black player with controls, on top of the prose.
    expect(kept.toLowerCase()).not.toContain('<video');
    // The svg stays: vector content fetches nothing and is often the sender's logo.
    expect(kept.toLowerCase()).toContain('<image');
    expect(kept).toContain('>x</div>');
  });

  it('keeps LOCAL css urls and local svg images, which fetch nothing', () => {
    const local = '<div style="background: url(cid:logo1)">a</div>'
      + '<svg><image href="data:image/png;base64,AAAA"></image></svg>';
    expect(hardenMailHtml(local)).toBe(local);
  });

  it('leaves an <img src> alone, because that one is counted and opt-in', () => {
    const img = '<img src="https://cdn.example.invalid/hero.png" alt="hero">';
    expect(hardenMailHtml(img)).toBe(img);
  });

  it('strips a remote css url from a style attribute without touching its other declarations', () => {
    const styled = '<div style="color: #333; background-image: url(https://t.invalid/p.png); margin: 0">x</div>';
    const kept = hardenMailHtml(styled);
    expect(kept).toContain('color: #333');
    expect(kept).toContain('margin: 0');
    expect(kept).toContain('background-image: none');
  });
});

describe('the blocked-images count is honest by construction', () => {
  it('counts exactly the images "Load images" would let out', () => {
    const body = '<img src="https://cdn.example.invalid/hero.png">' + UNCOUNTABLE_FETCHES;
    // One <img>, and five other remote fetches that no longer exist after hardening: the banner
    // says "1", and 1 is what the opt-in releases.
    expect(countRemoteImages(hardenMailHtml(body))).toBe(1);
  });
});

describe('countRemoteImages', () => {
  it('counts one per remote img, whatever the quoting', () => {
    expect(countRemoteImages('<img src="https://a.invalid/1.png">')).toBe(1);
    expect(countRemoteImages("<img src='http://a.invalid/2.png'>")).toBe(1);
    expect(countRemoteImages('<IMG SRC=https://a.invalid/3.png >')).toBe(1);
    // Protocol relative is remote too: it inherits the frame's scheme and still leaves.
    expect(countRemoteImages('<img src="//a.invalid/4.png">')).toBe(1);
  });

  it('does not count embedded or attachment images', () => {
    expect(countRemoteImages('<img src="data:image/png;base64,AAAA">')).toBe(0);
    expect(countRemoteImages('<img src="cid:part1.abc@mail.invalid">')).toBe(0);
    expect(countRemoteImages('<img alt="no src">')).toBe(0);
  });

  it('counts every remote image in a real-looking newsletter', () => {
    const body = '<h1>News</h1>'
      + '<img src="https://cdn.example.invalid/logo.png">'
      + '<p>text<img src="cid:inline1"></p>'
      + '<img src="https://track.example.invalid/open.gif" width="1" height="1">';
    expect(countRemoteImages(body)).toBe(2);
  });
});
