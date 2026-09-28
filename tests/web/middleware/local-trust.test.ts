/**
 * Which requests a primary (non-cloud) server trusts without a credential:
 * this machine's own clients only. Each refusal below is a real way a request
 * from elsewhere reaches a loopback socket or pretends to be local.
 */
import { describe, it, expect } from 'vitest'
import { classifyLocalRequest, isCrossSiteRefusal, isLoopbackName, isOwnOrigin } from '../../../src/web/middleware/local-trust.js'

/** A request that arrived on the server's port 3456. */
function req(remoteAddress: string, headers: Record<string, string> = {}) {
  return { socket: { remoteAddress, localPort: 3456 }, headers }
}

describe('classifyLocalRequest', () => {
  it('trusts this machine: loopback socket, loopback Host, no Origin or its own', () => {
    const local = [
      req('127.0.0.1', { host: '127.0.0.1:3456' }), // the walnut CLI, curl, the op executor
      req('::1', { host: '[::1]:3456', origin: 'http://[::1]:3456' }),
      req('::ffff:127.0.0.1', { host: 'localhost:3456', origin: 'http://localhost:3456' }), // Mac app, browser
      req('127.0.0.1', { host: 'localhost:5173', origin: 'http://127.0.0.1:3456' }), // Vite dev proxy, Origin restated
      req('127.0.0.1', {}), // raw client without a Host header
    ]
    for (const r of local) expect(classifyLocalRequest(r)).toEqual({ trusted: true })
  })

  // `ssh -L 8080:localhost:3456` from another computer: the socket is loopback on 3456,
  // but the page is http://localhost:8080 and says so in both Origin and Host.
  it('trusts a page behind a port forward to a different local port', () => {
    const forwarded = [
      req('127.0.0.1', { host: 'localhost:8080', origin: 'http://localhost:8080' }),
      req('127.0.0.1', { host: '127.0.0.1:13456', origin: 'http://127.0.0.1:13456' }),
      req('::1', { host: '[::1]:8080', origin: 'http://[::1]:8080' }),
      req('127.0.0.1', { host: 'localhost', origin: 'http://localhost' }), // forwarded to port 80
    ]
    for (const r of forwarded) expect(classifyLocalRequest(r), r.headers.origin).toEqual({ trusted: true })
  })

  it('refuses another page in that forwarding browser, and a rebound name on the forwarded port', () => {
    for (const origin of ['http://localhost:5173', 'http://localhost', 'http://evil.example:8080', 'null']) {
      const t = classifyLocalRequest(req('127.0.0.1', { host: 'localhost:8080', origin }))
      expect(t, origin).toEqual({ trusted: false, reason: 'foreign-origin' })
    }
    expect(classifyLocalRequest(req('127.0.0.1', { host: 'evil.example:8080', origin: 'http://evil.example:8080' })))
      .toEqual({ trusted: false, reason: 'foreign-host' })
    // A Host whose port is not a number proves nothing about what the browser addressed.
    expect(classifyLocalRequest(req('127.0.0.1', { host: 'localhost:x', origin: 'http://localhost:8080' })))
      .toEqual({ trusted: false, reason: 'foreign-origin' })
  })

  it('refuses a page on another local port: a dev server, a forwarded service in the web view', () => {
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:8080', 'http://localhost', 'https://localhost']) {
      const t = classifyLocalRequest(req('127.0.0.1', { host: 'localhost:3456', origin }))
      expect(t, origin).toEqual({ trusted: false, reason: 'foreign-origin' })
    }
  })

  it('refuses every non-loopback socket, private networks included', () => {
    for (const addr of ['192.168.1.20', '10.0.0.2', '172.16.4.4', '::ffff:192.168.1.20', '203.0.113.7', 'fe80::1', '']) {
      expect(classifyLocalRequest(req(addr, { host: 'localhost:3456' }))).toEqual({ trusted: false, reason: 'not-loopback' })
    }
  })

  it('refuses a loopback socket that a local proxy or tunnel forwarded', () => {
    const proxied = [
      { 'x-forwarded-for': '203.0.113.9' }, { forwarded: 'for=203.0.113.9' }, { 'x-real-ip': '10.0.0.7' },
      { 'x-forwarded-host': 'walnut.example' }, { 'x-forwarded-proto': 'https' }, { via: '1.1 proxy' },
    ]
    for (const h of proxied) {
      expect(classifyLocalRequest(req('127.0.0.1', { host: 'localhost:3456', ...h }))).toEqual({ trusted: false, reason: 'proxied' })
    }
  })

  it('refuses a DNS-rebound name and the 0.0.0.0 alias in Host', () => {
    for (const host of ['evil.example:3456', 'evil.example', '0.0.0.0:3456', '[::]:3456', '192.168.1.20:3456', 'localhost.evil.example', 'evil.localhost:3456']) {
      const t = classifyLocalRequest(req('127.0.0.1', { host }))
      expect(t).toEqual({ trusted: false, reason: 'foreign-host' })
      expect(isCrossSiteRefusal(t)).toBe(true)
    }
  })

  it('refuses a page from another site, a sandboxed frame, and non-web schemes', () => {
    for (const origin of ['https://evil.example', 'http://192.168.1.99', 'null', 'http://0.0.0.0:3456', 'chrome-extension://abc', 'file://']) {
      const t = classifyLocalRequest(req('127.0.0.1', { host: 'localhost:3456', origin }))
      expect(t).toEqual({ trusted: false, reason: 'foreign-origin' })
      expect(isCrossSiteRefusal(t)).toBe(true)
    }
  })

  it('a remote or proxied caller is not a cross-site refusal (it gets 401, not 403)', () => {
    expect(isCrossSiteRefusal(classifyLocalRequest(req('192.168.1.20')))).toBe(false)
    expect(isCrossSiteRefusal(classifyLocalRequest(req('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' })))).toBe(false)
  })
})

describe('name helpers', () => {
  it('isLoopbackName', () => {
    for (const n of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) expect(isLoopbackName(n)).toBe(true)
    for (const n of ['0.0.0.0', '::', '[::]', 'a.localhost', 'localhost.example', '128.0.0.1', '192.168.1.2', '']) expect(isLoopbackName(n)).toBe(false)
  })

  it('isOwnOrigin: absent counts as local, "null" does not, and the port must match when known', () => {
    expect(isOwnOrigin(undefined, 3456)).toBe(true)
    expect(isOwnOrigin('http://localhost:3456', 3456)).toBe(true)
    expect(isOwnOrigin('http://localhost:3456', 3457)).toBe(false)
    expect(isOwnOrigin('http://127.0.0.1', 80)).toBe(true)
    expect(isOwnOrigin('https://127.0.0.1', 443)).toBe(true)
    expect(isOwnOrigin('http://127.0.0.1:9999')).toBe(true) // no port known: the name alone
    expect(isOwnOrigin('null', 3456)).toBe(false)
    expect(isOwnOrigin('', 3456)).toBe(false)
  })
})
