/**
 * The last layer before an HTML mail body reaches the frame: DOMPurify, on the shared instance.
 *
 * Split from `mail-html.ts` on purpose. That file is pure and DOM-free so it can be proven in
 * the node test tier; this one needs a real browser DOM, because DOMPurify without
 * `document.implementation` is a silent passthrough (measured in the linkedom tier). So the
 * order is: harden as a string, then PARSE and sanitize here, then wrap. DOMPurify runs last
 * because it is the only layer that sees the document the browser will actually build.
 *
 * The shared instance carries an `afterSanitizeAttributes` hook from `@/utils/markdown` that
 * marks external anchors. Nothing here depends on it: the frame's own `<base target="_blank">`
 * is what routes a link out of the sandbox, and it applies whether that module was loaded or not.
 */
import DOMPurify from 'dompurify';
import { buildMailSrcdoc, countRemoteImages, hardenMailHtml } from './mail-html';

/**
 * Named even though DOMPurify's defaults already cover most of it: this list is the CONTRACT,
 * and a default that changes in a future release must not quietly widen what a stranger's mail
 * may contain. `style` stays allowed (an email is a styled document) and is safe here because
 * the frame's CSP allows inline style and no network fetch a stylesheet could reach.
 */
const MAIL_SANITIZE = {
  FORBID_TAGS: [
    'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
    'form', 'input', 'button', 'select', 'textarea', 'base', 'meta', 'link',
  ],
  FORBID_ATTR: ['srcset', 'formaction', 'ping'],
  ALLOW_DATA_ATTR: false,
};

export interface MailBodyFrame {
  srcdoc: string;
  /** Remote images in the SANITIZED body: what the banner offers to load. */
  remoteImages: number;
}

/**
 * Sanitize one body and build the two answers the reader needs from it.
 *
 * The count is taken AFTER sanitizing, so the banner counts what would actually render rather
 * than what arrived. An `<img>` DOMPurify dropped is not an image the human can load.
 */
export function buildMailBodyFrame(rawHtml: string, allowRemoteImages: boolean): MailBodyFrame {
  const clean = DOMPurify.sanitize(hardenMailHtml(rawHtml), MAIL_SANITIZE);
  const html = typeof clean === 'string' ? clean : String(clean);
  return {
    srcdoc: buildMailSrcdoc(html, { allowRemoteImages }),
    remoteImages: countRemoteImages(html),
  };
}
