/**
 * The document an HTML mail body renders inside, and a pure hardening pass in front of it.
 *
 * HTML mail is hostile input: whoever sent the message wrote it. Three layers answer that, and
 * they are deliberately independent, because each one covers what the others cannot:
 *
 *   1. THE FRAME. A sandboxed iframe with no `allow-scripts` and no `allow-same-origin`, plus
 *      a document CSP with no `script-src` at all. Nothing in a body can execute, whatever
 *      survived the sanitizers, and nothing can reach this origin's cookies or storage.
 *   2. THIS FILE. A string pass with no DOM: script elements, event handlers, `javascript:`
 *      URLs (modulo entity encoding, which DOMPurify owns because it parses) and document-level
 *      tags go, every remote fetch that is not an `<img src>` is neutralized, and the remaining
 *      remote images are counted. It exists because it is the part that can be proven in a plain
 *      node test tier, and because the count has to happen before anything is rendered.
 *   3. DOMPurify, applied LAST by `mail-sanitize.ts`, which is the primary sanitizer in a real
 *      browser: it parses, so it sees what a regex cannot.
 *
 * No imports, no DOM, no framework: `tests/web/mail-html-frame.test.ts` runs this under the
 * node environment, where DOMPurify would be a silent passthrough.
 *
 * The sibling precedent is `src/core/human-inbox/letter-frame.ts`, which does the same job for
 * an agent-written letter. Mail's policy is NOT the same and must not be merged with it: a
 * letter allows no network subresource ever, while mail has to be able to load remote images
 * once the human asks for this one message.
 */

/** Popups only: no scripts, no same-origin, no top-level navigation. */
export const MAIL_IFRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

/**
 * The document policy.
 *
 * `img-src data: cid:` is the blocked-images default. A `<img src="https://…">` in a mail body
 * is a tracking pixel until proven otherwise: rendering it reports the moment and the IP of the
 * read to the sender. `data:` is an embedded image and `cid:` an attachment reference, and both
 * are already on this machine.
 *
 * Opting in widens `img-src` and NOTHING else. There is still no `script-src`, styles stay
 * inline-only, and `default-src 'none'` keeps fonts, media, frames and fetches off the network,
 * so "load images" cannot turn into "load anything".
 *
 * `base-uri 'none'` protects the frame's own `<base target="_blank">`: a body that carried a
 * second `<base href="https://…">` would otherwise re-point every relative URL in the document.
 */
export function mailFrameCsp(allowRemoteImages: boolean): string {
  const img = allowRemoteImages ? 'img-src data: cid: https: http:' : 'img-src data: cid:';
  return `default-src 'none'; style-src 'unsafe-inline'; ${img}; font-src data:;`
    + ` form-action 'none'; base-uri 'none'`;
}

/**
 * Readable defaults for a body that brought no styling of its own.
 *
 * Rationale stays OUT of the string: every byte here is re-serialized into the srcdoc of every
 * message, and a comment mentioning a dangerous scheme by name reads like the body carrying one
 * (the read spec asserts on the whole document and caught exactly that).
 *
 * The one rule worth explaining is the last: an anchor whose href was stripped, because it was a
 * script URL, must stop looking like a live link. A blue word that does nothing is the confident
 * wrong answer this repo bans.
 */
const FRAME_RESET = `<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 2px 2px 16px; font: 14px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; color: #1d1d1f; background: transparent; overflow-wrap: break-word; }
  @media (prefers-color-scheme: dark) { body { color: #f5f5f7; } }
  img, table, pre { max-width: 100%; }
  pre { overflow-x: auto; white-space: pre-wrap; }
  table { border-collapse: collapse; }
  blockquote { margin: 0 0 0 12px; padding-left: 10px; border-left: 2px solid rgba(128,128,128,0.4); }
  a { color: #0a84ff; }
  a:not([href]) { color: inherit; text-decoration: none; cursor: default; }
</style>`;

/**
 * Wrap a sanitized body into the frame document.
 *
 * The CSP meta comes FIRST in the head: a policy meta only governs what follows it. `<base
 * target="_blank">` is what makes a link in the body open outside the frame, and it is the only
 * way to do it here, because with no scripts allowed nothing can intercept the click.
 */
export function buildMailSrcdoc(html: string, options: { allowRemoteImages: boolean }): string {
  const head = `<meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${mailFrameCsp(options.allowRemoteImages)}">`
    + '<meta name="referrer" content="no-referrer">'
    + '<base target="_blank">'
    + FRAME_RESET;
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

/** Elements removed with everything inside them. */
const DROP_WITH_CONTENT = /<(script|noscript|template|object|applet)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/**
 * Elements whose tag goes; inner text stays, because that is often the real message.
 *
 * Media is in here for a reason worth keeping: `default-src 'none'` means a `<video>` in a mail
 * body can never load or play anything, but the browser still renders a 300x150 black player with
 * working-looking controls (seen in the reader verification screenshot, sitting on top of the
 * prose). A control that cannot do what it appears to offer is the confident wrong answer this
 * repo bans, and a video's fallback text survives, which is what the sender wrote it for.
 */
const DROP_TAG = new Set([
  'script', 'noscript', 'template', 'object', 'applet', 'embed', 'iframe', 'frame', 'frameset',
  'form', 'input', 'button', 'select', 'option', 'textarea', 'label', 'fieldset',
  'base', 'meta', 'link', 'html', 'head', 'body', 'title',
  'video', 'audio', 'source', 'track',
]);

/** Attributes that fetch or navigate, and are therefore checked for a scheme. */
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'background', 'poster', 'xlink:href', 'data']);

/**
 * Every remote fetch the blocked-images promise covers, other than an `<img src>`.
 *
 * `img-src` governs all of these, so widening it for one message releases them TOO, and none of
 * them is countable as an image: a `<video poster>` and an `<svg><image href>` render a picture
 * the banner never mentioned, and a CSS `url()` renders one with no element to count at all. They
 * are removed rather than counted, which keeps "N remote images blocked" true by construction and
 * keeps "Load images" to exactly the N the human was shown.
 */
const ALWAYS_STRIP_ATTRS = new Set(['srcset', 'poster', 'lowsrc', 'dynsrc']);

/** SVG's own image element, whose `href` is a fetch that no `<img>` scan sees. */
const SVG_IMAGE_URL_ATTRS = new Set(['href', 'xlink:href']);

const CSS_URL = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

/** Neutralize remote `url(…)` in CSS, leaving local (`data:`, `cid:`, relative) targets alone. */
function stripRemoteCssUrls(css: string): string {
  return css.replace(CSS_URL, (whole, _quote: string, target: string) => (
    isRemoteUrl(target) ? 'none' : whole
  ));
}

const DANGEROUS_SCHEME = /^\s*(javascript|vbscript|livescript|mocha|data:text\/html)/i;

/** A `<style>` element and its CSS. */
const STYLE_BLOCK = /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi;

/** One tag, whatever it holds: quoted attribute values may contain `>`. */
const TAG = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

/** One attribute inside a tag's attribute run. */
const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g;

function attrValue(assignment: string | undefined): string {
  if (!assignment) return '';
  const raw = assignment.replace(/^\s*=\s*/, '').trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

/**
 * Strip what a mail body must never carry, without a DOM.
 *
 * What it removes, and why each one is here rather than left to DOMPurify: script and its text
 * (a passthrough sanitizer in a DOM-less environment would leave it), `on*=` handlers,
 * `javascript:`-style URLs, frames and forms (a form in a mail body is a phishing control that
 * posts to the sender), and DOCUMENT-level tags. That last one is not about safety: a body that
 * is a whole `<html>` document, nested inside the frame's own document, gets silently
 * rearranged by the parser, and the policy meta can end up after the content it governs.
 *
 * A body that carries nothing hostile comes back byte-identical.
 */
export function hardenMailHtml(raw: string): string {
  if (!raw) return '';
  return raw
    // Comments first: a conditional comment can hide markup from a later pass.
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(DROP_WITH_CONTENT, '')
    // A `<style>` block's CSS is not markup, so the attribute pass below never sees it.
    .replace(STYLE_BLOCK, (_whole, open: string, css: string, close: string) => (
      `${open}${stripRemoteCssUrls(css)}${close}`
    ))
    .replace(TAG, (whole, name: string, attrs: string) => {
      const tag = name.toLowerCase();
      if (DROP_TAG.has(tag)) return '';
      if (!attrs) return whole;
      let changed = false;
      const kept = attrs.replace(ATTR, (attr, key: string, assignment: string | undefined) => {
        const lower = key.toLowerCase();
        // A handler is an execution path; the rest are fetches the image count cannot see.
        if (lower.startsWith('on') || ALWAYS_STRIP_ATTRS.has(lower)) { changed = true; return ''; }
        if (tag === 'image' && SVG_IMAGE_URL_ATTRS.has(lower) && isRemoteUrl(attrValue(assignment))) {
          changed = true;
          return '';
        }
        if (lower === 'style') {
          const value = attrValue(assignment);
          const clean = stripRemoteCssUrls(value);
          if (clean === value) return attr;
          changed = true;
          return `${key}="${clean.replace(/"/g, '&quot;')}"`;
        }
        if (URL_ATTRS.has(lower) && DANGEROUS_SCHEME.test(attrValue(assignment))) {
          changed = true;
          return '';
        }
        return attr;
      });
      if (!changed) return whole;
      // Only the ENDS are trimmed. Collapsing inner whitespace would reach inside a kept
      // attribute's value (`alt="two  spaces"`, a multi-declaration `style`), and a double
      // space between attributes is nothing to a parser.
      const tidy = kept.trim();
      const closing = whole.startsWith('</') ? '</' : '<';
      return `${closing}${name}${tidy ? ` ${tidy}` : ''}>`;
    });
}

const IMG_TAG = /<img\b[^>]*>/gi;
const IMG_SRC = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/** Remote means "leaves this machine": http, https, and protocol-relative, which inherits one. */
function isRemoteUrl(value: string): boolean {
  return /^(?:https?:)?\/\//i.test(value.trim());
}

/**
 * How many images in this body would phone home.
 *
 * The count is what the banner says, so it counts ELEMENTS rather than distinct URLs: "3 remote
 * images blocked" has to match what the reader would see appear. `cid:` and `data:` images are
 * already local and are never counted, or every message with an inline logo would offer to load
 * something that is already there.
 *
 * `<img src>` is the ONLY remote-image path left by then, which is what makes this honest: every
 * other way to fetch a picture under `img-src` (`poster`, `srcset`, an SVG `<image href>`, a CSS
 * `url()`) is removed by `hardenMailHtml`, so there is nothing uncounted for "Load images" to let
 * out.
 */
export function countRemoteImages(html: string): number {
  let remote = 0;
  for (const tag of html.match(IMG_TAG) ?? []) {
    const match = IMG_SRC.exec(tag);
    const value = match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
    if (isRemoteUrl(value)) remote += 1;
  }
  return remote;
}
