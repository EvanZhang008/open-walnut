/**
 * Origin rewrite for the Vite dev proxy (web/vite.config.ts and the Playwright
 * fixture in tests/e2e/browser/test-server.ts).
 *
 * The Walnut server trusts a browser page without a credential only when the
 * page's Origin is the server's own origin (src/web/middleware/local-trust.ts).
 * A page the dev server serves carries the dev server's origin instead, so the
 * proxy, which is part of the same local setup, restates a request from its OWN
 * pages as coming from its target. Any other Origin (another site, another local
 * port) passes through unchanged and the server still refuses it.
 */

interface ProxyLike {
  on(event: 'proxyReq' | 'proxyReqWs', listener: (...args: any[]) => void): unknown
}

interface ReqLike {
  headers: Record<string, string | string[] | undefined>
}

interface OutgoingLike {
  setHeader(name: string, value: string): void
}

export function restateOwnOrigin(proxy: ProxyLike, target: string): void {
  const targetOrigin = new URL(target.replace(/^ws/, 'http')).origin
  const rewrite = (proxyReq: OutgoingLike, req: ReqLike): void => {
    const origin = req.headers.origin
    const host = req.headers.host
    if (typeof origin !== 'string' || typeof host !== 'string') return
    if (origin === `http://${host}` || origin === `https://${host}`) proxyReq.setHeader('origin', targetOrigin)
  }
  proxy.on('proxyReq', rewrite)
  proxy.on('proxyReqWs', rewrite)
}
