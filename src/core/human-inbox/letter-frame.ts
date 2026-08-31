/**
 * The document an agent's HTML letter body is rendered inside, and the security
 * floor that comes with it. ONE source for every surface.
 *
 * Pure and browser-safe on purpose (no node imports): the console imports it
 * through the `@open-walnut/letter-frame` vite alias, and the server imports it
 * directly to wrap a STREAMED body — a big document is served from
 * `/api/v1/human-inbox/:id/body?frame=1` rather than inlined into JSON, and it
 * must land inside exactly the same frame the inline path builds. Two copies of
 * this file would mean a 100MB letter quietly rendering under a weaker policy
 * than a 100KB one.
 *
 * Every rule here is a promise made to someone opening an agent-written document
 * blind on a phone, so it is pinned by tests/web/letter-html-frame.test.ts.
 */

/** Grants popups only: no scripts, no same-origin, no top-level navigation. */
export const LETTER_IFRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

/**
 * No SUBRESOURCE may leave the machine. The sandbox blocks scripts, but a
 * `<img src="https://…">` in a letter body would still phone home the moment the
 * human opens it (read time + IP), including blind on the phone — which the whole
 * design says is safe. Real mail clients block remote content for this reason.
 *
 * `media-src data: blob:` is the same bargain for sound and picture: a daily
 * digest embeds its podcast as `<audio src="data:audio/mpeg;base64,…">` and a
 * clip as `<video src="data:video/mp4;base64,…">`, and under `default-src 'none'`
 * both are silently refused — the player renders and simply never plays, with no
 * error anywhere. Still no network: an `https://` media URL stays blocked, so
 * opening a letter reveals nothing about when it was read.
 */
export const LETTER_FRAME_CSP_VALUE = "default-src 'none'; img-src data: blob:; "
  + "media-src data: blob:; style-src 'unsafe-inline'; font-src data:; form-action 'none'";

/**
 * The same policy as a `<meta>` inside the document rather than the iframe's
 * `csp` attribute: the attribute is Chromium-only and is about required-CSP on a
 * NETWORK fetch, while a srcdoc document enforces this meta everywhere.
 */
const FRAME_CSP = `<meta http-equiv="Content-Security-Policy" content="${LETTER_FRAME_CSP_VALUE}">`
  + '<meta name="referrer" content="no-referrer">';

/** Readable defaults for a body written without any styling of its own. */
const FRAME_RESET = `<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 4px 2px 12px; font: 14px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; color: #1d1d1f; background: transparent; overflow-wrap: break-word; }
  @media (prefers-color-scheme: dark) { body { color: #f5f5f7; } }
  img, table, pre, audio, video { max-width: 100%; }
  audio { width: 100%; }
  /* A clip has intrinsic dimensions; keep its aspect ratio when the frame is
     narrower than the source instead of squashing it to the max-width. */
  video { height: auto; }
  pre { overflow-x: auto; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid rgba(128,128,128,0.35); padding: 4px 8px; text-align: left; }
  a { color: #0a84ff; }
</style>`;

/** CSP first in `<head>`: a policy meta only governs what comes after it. */
const FRAME_HEAD = `${FRAME_CSP}<base target="_blank">${FRAME_RESET}`;

/**
 * Wrap an agent's HTML into a complete document with a `<base target="_blank">`.
 * A body that already IS a full document keeps its own markup: the base tag is
 * spliced into its head (or in front of its content) rather than nesting a
 * second `<html>`, which browsers silently unwrap into something else.
 */
export function wrapLetterHtml(html: string): string {
  const plan = planLetterFrame(html);
  return plan.head + html.slice(plan.consumed) + plan.tail;
}

/**
 * The same wrap, expressed so a body can be STREAMED instead of held in memory.
 *
 * `peek` is only the LEADING text of the document — the server reads a bounded
 * window rather than a 100MB body to find out whether it brings its own
 * `<head>`, and every branch decides on markup that can legally appear only at
 * the very start.
 *
 *   head      write these bytes first
 *   consumed  how much of `peek` the head already contains (stream from here)
 *   tail      write these bytes after the body ends
 *
 * A document whose `<head>` somehow begins beyond the peek falls into the
 * wrap-it-whole branch. That is safe rather than wrong: it still gets the policy
 * and a valid document, just nested one level deeper than ideal.
 */
export function planLetterFrame(peek: string): { head: string; consumed: number; tail: string } {
  if (/<head[\s>]/i.test(peek)) {
    return { head: peek.replace(/<head([^>]*)>/i, (m) => `${m}${FRAME_HEAD}`), consumed: peek.length, tail: '' };
  }
  if (/<html[\s>]/i.test(peek)) {
    return {
      head: peek.replace(/<html([^>]*)>/i, (m) => `${m}<head>${FRAME_HEAD}</head>`),
      consumed: peek.length,
      tail: '',
    };
  }
  return {
    head: `<!doctype html><html><head><meta charset="utf-8">${FRAME_HEAD}</head><body>`,
    consumed: 0,
    tail: '</body></html>',
  };
}
