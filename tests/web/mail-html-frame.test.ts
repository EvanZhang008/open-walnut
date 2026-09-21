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
  fixedTableWidth,
  hardenMailHtml,
  mailFrameCsp,
  replaceCidImages,
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

  /**
   * The frame is PAPER, in both of the app's themes.
   *
   * The reset used to follow the OS colour scheme (dark text turning light over a transparent
   * page), which left the SENDER's own colours where they were: a newsletter's blue headings on a
   * black field, which is what made the reader look broken. Html mail is authored for white, so the
   * frame declares white and says so to the browser with `color-scheme`.
   */
  it('renders the body on white paper whatever the app theme is', () => {
    const document = buildMailSrcdoc('<p>hi</p>', { allowRemoteImages: false });
    expect(document).toContain('color-scheme: light');
    expect(document).toContain('background: #fff');
    // The two halves of the old theme-aware hack. Either one coming back re-opens the bug.
    expect(document).not.toContain('prefers-color-scheme');
    expect(document).not.toContain('background: transparent');
  });

  /**
   * A fixed-width newsletter table has to fit the paper in WEBKIT too, which is the engine the Mac
   * app renders in. `max-width: 100%` is enough for Chromium and does nothing for a table box in
   * WebKit, so the same mail lost its last two columns behind an overlay scrollbar. Measured at a
   * 432px paper: 720px wide in WebKit against 384px in Chromium.
   *
   * The first answer, a stylesheet rule dropping every declared width (`width: auto !important`),
   * fitted the paper and broke every card: a card is a stack of one-row 610px tables whose cells
   * carry the side borders, and `auto` shrank each row to its own content (measured 82 to 977px on
   * one account notice, eighteen tables, one intended width). So the frame carries no table width
   * rule and no table margin at all; the fit is `fitFixedTable`'s `min()` in the string pass,
   * tested below.
   */
  it('carries no table width rule and no table margin of its own', () => {
    const document = buildMailSrcdoc('<table width="720"><tr><td>x</td></tr></table>', { allowRemoteImages: false });
    expect(document).not.toContain('table[width]');
    expect(document).not.toContain('width: auto');
    // A bottom margin on `table` opened a gap between every two rows of a card.
    expect(document).not.toMatch(/,\s*table\s*\{[^}]*margin/);
    expect(document).not.toMatch(/\btable\s*\{[^}]*margin/);
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

/**
 * A table with a fixed pixel width is told to fit the paper with `min(<width>, 100%)`, in the
 * string pass, because WebKit ignores `max-width` on a table box and a stylesheet `width: auto`
 * broke every card built from stacked fixed-width tables (see the frame test above).
 */
describe('a fixed-width table fits the paper without losing its width', () => {
  it('turns a width attribute into an inline min() and keeps the attribute for old engines', () => {
    const kept = hardenMailHtml('<table width="720" cellpadding="8"><tr><td>x</td></tr></table>');
    expect(kept).toContain('<table width="720" cellpadding="8" style="width:min(720px,100%) !important">');
    // Only the opening tag changes; a `</table>` has no width to fit.
    expect(kept).toContain('</table>');
  });

  it('reads a pixel width from the inline style, and wins over a sender !important', () => {
    const kept = hardenMailHtml('<table style="width:640px !important; color: red"><tr><td>x</td></tr></table>');
    expect(kept).toContain('<table style="color: red;width:min(640px,100%) !important">');
    expect(kept).not.toContain('width:640px !important');
  });

  it('lets the inline declaration outrank the attribute when both are present', () => {
    expect(fixedTableWidth('width="600" style="width: 300px"')).toEqual({ px: 300, style: '' });
    expect(fixedTableWidth(' width=600px')).toEqual({ px: 600, style: '' });
  });

  it('leaves a percentage width alone: a shell table asking to fill the paper is already right', () => {
    const shell = '<table width="100%"><tr><td>x</td></tr></table>';
    expect(hardenMailHtml(shell)).toBe(shell);
    const styledShell = '<table style="width: 100%"><tr><td>x</td></tr></table>';
    expect(hardenMailHtml(styledShell)).toBe(styledShell);
    // A percentage in the style overrides a pixel attribute, so there is nothing to fit.
    expect(fixedTableWidth('width="600" style="width:100%"')).toBeNull();
  });

  it('leaves a table with no width, and a non-table with a width, byte-identical', () => {
    const bare = '<table><tr><td width="600">x</td></tr></table>';
    expect(hardenMailHtml(bare)).toBe(bare);
    const image = '<img src="cid:a" width="600">';
    expect(hardenMailHtml(image)).toContain('walnut-cid-image');
    expect(fixedTableWidth('')).toBeNull();
    expect(fixedTableWidth('width="0"')).toBeNull();
    expect(fixedTableWidth('width="wide"')).toBeNull();
  });

  it('still strips a remote css url from the style it rewrites', () => {
    const kept = hardenMailHtml('<table width="610" style="background: url(https://t.invalid/p.png); color: #333"><tr><td>x</td></tr></table>');
    expect(kept).toContain('background: none; color: #333;width:min(610px,100%) !important');
    expect(kept).not.toContain('t.invalid');
  });

  it('keeps the count of remote images honest on a table-heavy body', () => {
    const body = '<table width="610"><tr><td><img src="https://cdn.invalid/a.png" height="40"></td></tr></table>'
      + '<table width="610"><tr><td><img src="https://cdn.invalid/b.png" width="60%"></td></tr></table>';
    expect(countRemoteImages(hardenMailHtml(body))).toBe(2);
  });
});

/**
 * An image that points INTO the message (a `cid:` part) can never arrive: this console serves no
 * attachment bytes, and the frame's policy could not fetch them if it did. So the browser painted
 * its broken-image glyph in the middle of the prose, which reads as a broken reader rather than as
 * "this picture is in the attachment".
 */
describe('an attachment-referencing image becomes a chip', () => {
  it('keeps the alt text the sender wrote for exactly this case', () => {
    const kept = hardenMailHtml('<p><img src="cid:masthead.42@mail.invalid" alt="Ferry masthead"></p>');
    expect(kept).not.toContain('<img');
    expect(kept).toContain('<span class="walnut-cid-image">Ferry masthead</span>');
  });

  it('says what it is when there is no alt text', () => {
    expect(replaceCidImages("<img src='cid:part1'>")).toBe('<span class="walnut-cid-image">inline image</span>');
    expect(replaceCidImages('<IMG SRC="CID:part1" WIDTH="20">')).toContain('inline image');
    expect(replaceCidImages('<img alt="  " src="cid:part1">')).toContain('inline image');
  });

  it('replaces every one of them, wherever they sit', () => {
    const table = '<table><tr><td><img src="cid:a" alt="one"></td>'
      + '<td><img src="cid:b" alt="two"></td></tr></table>';
    const kept = replaceCidImages(table);
    expect(kept).toContain('>one</span>');
    expect(kept).toContain('>two</span>');
    expect(kept).not.toContain('<img');
  });

  it('leaves every other image alone, including the ones that do arrive', () => {
    for (const img of [
      '<img src="data:image/png;base64,AAAA" alt="dot">',
      '<img src="https://cdn.example.invalid/hero.png" alt="hero">',
      '<img src="/relative/logo.png">',
      // The SVG element is not an `<img>`, and its local href fetches nothing.
      '<svg><image href="data:image/png;base64,AAAA"></image></svg>',
    ]) {
      expect(replaceCidImages(img)).toBe(img);
    }
  });

  it('escapes markup an alt attribute may legally carry', () => {
    const kept = replaceCidImages('<img src="cid:a" alt="a<b & c">');
    expect(kept).toContain('a&lt;b & c');
    expect(kept).not.toContain('<b');
  });

  it('is not counted as a remote image, before or after', () => {
    const body = '<img src="cid:inline1"><img src="https://cdn.example.invalid/hero.png">';
    expect(countRemoteImages(hardenMailHtml(body))).toBe(1);
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
