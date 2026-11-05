/**
 * A document Walnut serves from a file (an agent's report, a page in a repo, an SVG) runs on
 * Walnut's own origin unless it is told otherwise, and a script there reads everything this
 * origin keeps: the Passwords window's unlock in localStorage, the device token, every API.
 * So every response of a type a browser runs as a document with scripts carries a CSP `sandbox`:
 * the page runs scripts, forms, popups and downloads, in an opaque origin of its own (no storage,
 * no cookies of Walnut's, no reach into the console around it). The Files preview talks to it
 * through `postMessage` only (preview-bridge.ts).
 *
 * Guard: tests/web/untrusted-doc-csp.test.ts fails on a route that sets an HTML or SVG type
 * without going through here, unless it is listed there with why it is safe.
 */
import type { Response } from 'express'

export const UNTRUSTED_DOC_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads'

/** A type the browser renders as a document that can run script (HTML, SVG, XHTML, any XML). */
export function isScriptableDocType(ctype: string): boolean {
  const t = ctype.split(';')[0]!.trim().toLowerCase()
  return t === 'text/html' || t === 'text/xml' || t === 'application/xml' || t === 'application/xhtml+xml' || t.endsWith('+xml')
}

/** Set the sandbox on `res` when `ctype` is such a document type. */
export function sandboxUntrustedDoc(res: Response, ctype: string): void {
  if (!isScriptableDocType(ctype)) return
  res.setHeader('Content-Security-Policy', UNTRUSTED_DOC_CSP)
  res.setHeader('X-Content-Type-Options', 'nosniff')
}
