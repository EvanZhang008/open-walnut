/**
 * A letter's document body — the two formats an agent may write.
 *
 * HTML rides in a sandboxed iframe (email-client posture): no scripts, no
 * same-origin, so agent-written HTML can be opened blind on a phone. The ONLY
 * capability granted is popups, because without it a link in the body would be
 * a dead click — and with no scripts allowed there is no way to intercept the
 * click and route it ourselves. `<base target="_blank">` is what turns every
 * link in the document into a new-tab open.
 *
 * Markdown goes through the SAME renderer the rest of the console uses
 * (renderMarkdownWithRefs), so task/session refs become pills and file paths
 * linkify exactly like they do in chat; the caller supplies the click handler.
 */
import { useMemo } from 'react';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import type { LetterBodyFormat } from '@/api/human-inbox';

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
 */
const FRAME_CSP = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; "
  + "img-src data: blob:; style-src 'unsafe-inline'; font-src data:; form-action 'none'\">"
  + '<meta name="referrer" content="no-referrer">';

/** Readable defaults for a body written without any styling of its own. */
const FRAME_RESET = `<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 4px 2px 12px; font: 14px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; color: #1d1d1f; background: transparent; overflow-wrap: break-word; }
  @media (prefers-color-scheme: dark) { body { color: #f5f5f7; } }
  img, table, pre { max-width: 100%; }
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

export function LetterBody({ body, format, subject, onClick }: {
  body: string;
  format: LetterBodyFormat;
  subject: string;
  /** Delegated markdown link clicks (task pills, file paths). HTML: unused. */
  onClick?: (e: React.MouseEvent) => void;
}) {
  const html = useMemo(
    () => (format === 'html' ? wrapLetterHtml(body) : renderMarkdownWithRefs(body)),
    [body, format],
  );

  if (format === 'html') {
    return (
      <iframe
        className="hib-html-frame"
        sandbox={LETTER_IFRAME_SANDBOX}
        referrerPolicy="no-referrer"
        srcDoc={html}
        title={subject || 'Letter'}
      />
    );
  }
  return (
    <div
      className="hib-md-body markdown-body"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
