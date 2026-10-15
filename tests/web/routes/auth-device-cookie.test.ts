/**
 * The `walnut_device` cookie: a signed-in browser's `<img src="/api/...">`, HTML
 * preview frame and downloads cannot send an Authorization header, so its token
 * rides a cookie. The middleware takes it for GET and HEAD only, so a cookie can
 * never write; a header always wins over it.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-auth-cookie'))

import { authMiddleware, cookieCredential } from '../../../src/web/middleware/auth.js'
import { createDevice } from '../../../src/core/device-auth.js'
import { _resetAuthRateLimitForTesting } from '../../../src/web/middleware/auth-rate-limit.js'

type Outcome = { next: boolean; status?: number; body?: any; deviceName?: string }

async function run(method: string, headers: Record<string, string>): Promise<Outcome> {
  const remoteAddress = '192.168.1.20'
  const req = { method, socket: { remoteAddress, localPort: 3456 }, ip: remoteAddress, headers, path: '/local-image' } as Record<string, unknown>
  const out: Outcome = { next: false }
  const res = {
    status(code: number) { out.status = code; return res },
    set(_name: string, _value: string) { return res },
    json(body: unknown) { out.body = body; return res },
  }
  await authMiddleware(req as never, res as never, () => { out.next = true })
  out.deviceName = req.deviceName as string | undefined
  return out
}

let token = ''
beforeAll(async () => { token = (await createDevice('cookie-phone')).token })
beforeEach(() => _resetAuthRateLimitForTesting())

describe('cookieCredential', () => {
  it('reads the cookie among others, decoded, for GET and HEAD only', () => {
    const cookie = `edge_session=abc; walnut_device=${encodeURIComponent('t/k+n=')}; theme=dark`
    expect(cookieCredential({ method: 'GET', headers: { cookie } } as never)).toBe('t/k+n=')
    expect(cookieCredential({ method: 'HEAD', headers: { cookie } } as never)).toBe('t/k+n=')
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(cookieCredential({ method, headers: { cookie } } as never)).toBe('')
    }
  })

  it('is empty without the cookie, for a lookalike name, and for a broken escape', () => {
    expect(cookieCredential({ method: 'GET', headers: {} } as never)).toBe('')
    expect(cookieCredential({ method: 'GET', headers: { cookie: 'xwalnut_device=1; walnut_device_old=2' } } as never)).toBe('')
    expect(cookieCredential({ method: 'GET', headers: { cookie: 'walnut_device=%E0%A4%A' } } as never)).toBe('')
  })
})

describe('authMiddleware with the device cookie (primary mode, another device)', () => {
  it('a GET with a valid cookie passes and is identified', async () => {
    expect(await run('GET', { cookie: `walnut_device=${token}` })).toMatchObject({ next: true, deviceName: 'cookie-phone' })
  })

  it('a write with only the cookie is refused as not signed in', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const out = await run(method, { cookie: `walnut_device=${token}` })
      expect(out).toMatchObject({ next: false, status: 401 })
      expect(out.body).toMatchObject({ code: 'not_paired' })
    }
  })

  it('a GET with a refused cookie says token_refused, so the console shows the revoked notice', async () => {
    expect((await run('GET', { cookie: 'walnut_device=nope' })).body).toMatchObject({ code: 'token_refused' })
  })

  it('a revoked phone reloading the console keeps hearing token_refused, and a signed-in one is not locked out', async () => {
    // One page load sends dozens of requests with the same dead token (header and
    // cookie). Counted once, it never reaches the limit for the shared address.
    for (let i = 0; i < 60; i++) {
      const out = await run('GET', i % 2 ? { cookie: 'walnut_device=revoked-token' } : { authorization: 'Bearer revoked-token' })
      expect(out.status).toBe(401)
      expect(out.body).toMatchObject({ code: 'token_refused' })
    }
    expect(await run('GET', { cookie: `walnut_device=${token}` })).toMatchObject({ next: true, deviceName: 'cookie-phone' })
  })

  it('ten different guesses lock the address with a code the console can read', async () => {
    for (let i = 0; i < 10; i++) await run('GET', { authorization: `Bearer guess-${i}` })
    const out = await run('GET', { authorization: `Bearer ${token}` })
    expect(out).toMatchObject({ next: false, status: 429 })
    expect(out.body).toMatchObject({ code: 'rate_limited' })
  })

  it('a header wins over the cookie', async () => {
    expect(await run('GET', { authorization: 'Bearer nope', cookie: `walnut_device=${token}` })).toMatchObject({ next: false, status: 401 })
    expect(await run('POST', { authorization: `Bearer ${token}`, cookie: 'walnut_device=nope' })).toMatchObject({ next: true })
  })
})
