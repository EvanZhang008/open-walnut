/**
 * The document an agent's HTML letter body is rendered inside, and the security
 * floor that comes with it.
 *
 * Split out of LetterBody.tsx so the floor is testable without a DOM or React
 * (tests/web/letter-html-frame.test.ts): every rule here is a promise made to
 * someone opening an agent-written document blind on a phone, and a promise that
 * silently changes is the failure mode worth pinning.
 */

/** Grants popups only: no scripts, no same-origin, no top-level navigation. */
export const LETTER_IFRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

/**
 * No SUBRESOURCE may leave the machine. The sandbox blocks scripts, but a
 * `<img src="https://…">` in a letter body would still phone home the moment the
 * human opens it (read time + IP), including blind on the phone — which the whole
 * design says is safe. Real mail clients block remote content for this reason.
 *
 * Delivered as a `<meta>` inside the document rather than the iframe's `csp`
 * attribute: the attribute is Chromium-only and is about required-CSP on a
 * NETWORK fetch, while a srcdoc document enforces this meta everywhere. Inline
 * styles and data-URI images stay allowed (that is exactly what agents are told
 * to write); a link click still opens a new tab, since CSP doesn't gate that.
 *
 * `media-src data: blob:` is the same bargain for sound: a daily digest embeds
 * its podcast as `<audio src="data:audio/mpeg;base64,…">`, and under
 * `default-src 'none'` that is silently refused — the player renders and simply
 * never plays, with no error anywhere. Still no network: an `https://` media URL
 * stays blocked, so opening a letter reveals nothing about when it was read.
 * The iOS reader carries the identical policy (LetterHTMLBody.swift), so the two
 * surfaces can never drift into different floors.
 */
const FRAME_CSP = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; "
  + "img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:; form-action 'none'\">"
  + '<meta name="referrer" content="no-referrer">';

/** Readable defaults for a body written without any styling of its own. */
const FRAME_RESET = `<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 4px 2px 12px; font: 14px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; color: #1d1d1f; background: transparent; overflow-wrap: break-word; }
  @media (prefers-color-scheme: dark) { body { color: #f5f5f7; } }
  img, table, pre, audio, video { max-width: 100%; }
  audio { width: 100%; }
  pre { overflow-x: auto; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid rgba(128,128,128,0.35); padding: 4px 8px; text-align: left; }
  a { color: #0a84ff; }
</style>`;

/**
 * Wrap an agent's HTML into a complete document with a `<base target="_blank">`.
 * A body that already IS a full document keeps its own markup: the base tag is
 * spliced into its head (or in front of its content) rather than nesting a
 * second `<html>`, which browsers silently unwrap into something else.
 */
export function wrapLetterHtml(html: string): string {
  // CSP first in <head>: a policy meta only governs what comes after it.
  const head = `${FRAME_CSP}<base target="_blank">${FRAME_RESET}`;
  if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, (m) => `${m}${head}`);
  if (/<html[\s>]/i.test(html)) return html.replace(/<html([^>]*)>/i, (m) => `${m}<head>${head}</head>`);
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${html}</body></html>`;
}
