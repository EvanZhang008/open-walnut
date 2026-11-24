/**
 * The helper credential (src/lib/self-api-root.ts): what a model helper this server spawns
 * with a shell (the AI search child) carries to reach its own Walnut, on the leader as on a
 * replica (tests/replica/search-helper-credential.test.ts runs the replica end to end).
 *
 * Here: its scope (reads of the helper paths only), the env it rides (a shell child only,
 * never an inherited one), and the leader's auth taking it from a caller loopback does not
 * vouch for (a tunnel port, a proxy) while refusing it everywhere else.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NextFunction, Request, Response } from 'express'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-helper-call-credential'))

import {
  applyWalnutHelperEnv,
  getHelperCallToken,
  getSelfCallToken,
  helperCallAllowed,
  HELPER_CALL_CURL_AUTH,
  isHelperCallToken,
  setSelfApiRoot,
} from '../../src/lib/self-api-root.js'
import { authMiddleware } from '../../src/web/middleware/auth.js'
import { _resetAuthRateLimitForTesting } from '../../src/web/middleware/auth-rate-limit.js'

const ROOT = 'http://127.0.0.1:45997'

afterEach(() => {
  setSelfApiRoot(null)
  _resetAuthRateLimitForTesting()
})

/** One /api call through the real auth middleware: 200 when it passed to next. */
async function call(method: string, apiPath: string, token: string | null): Promise<{ status: number; body: unknown }> {
  const req = {
    method, baseUrl: '/api', path: apiPath, url: apiPath, originalUrl: `/api${apiPath}`, ip: '10.0.0.5',
    // A caller loopback does not vouch for: another machine on the network.
    socket: { remoteAddress: '10.0.0.5', localPort: 45997 },
    headers: { host: '10.0.0.9:45997', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  } as unknown as Request
  let status = 0
  let body: unknown
  const res = {
    status(n: number) { status = n; return res },
    json(b: unknown) { body = b; return res },
    setHeader() { return res },
  } as unknown as Response
  let passed = false
  await authMiddleware(req, res, (() => { passed = true }) as NextFunction)
  return { status: passed ? 200 : status, body }
}

describe('the helper credential', () => {
  it('exists only while a server listens, and is not the self-call token', () => {
    expect(getHelperCallToken()).toBeNull()
    setSelfApiRoot(ROOT, { credential: true })
    const t = getHelperCallToken()!
    expect(t).toMatch(/^[0-9a-f]{64}$/)
    expect(getHelperCallToken()).toBe(t)
    expect(isHelperCallToken(t)).toBe(true)
    expect(isHelperCallToken(t.slice(0, -1) + (t.endsWith('0') ? '1' : '0'))).toBe(false)
    expect(isHelperCallToken(getSelfCallToken()!)).toBe(false)
    setSelfApiRoot(null)
    expect(isHelperCallToken(t)).toBe(false)
  })

  it('reads the helper paths only', () => {
    expect(helperCallAllowed('GET', '/api/search')).toBe(true)
    expect(helperCallAllowed('HEAD', '/api/search')).toBe(true)
    expect(helperCallAllowed('GET', '/api/search/')).toBe(true)
    expect(helperCallAllowed('POST', '/api/search')).toBe(false)
    expect(helperCallAllowed('GET', '/api/search/agent')).toBe(false)
    expect(helperCallAllowed('GET', '/api/tasks')).toBe(false)
    expect(helperCallAllowed('GET', '/api/searchx')).toBe(false)
  })

  it('rides the env of a child with a shell only, and replaces an inherited one', () => {
    setSelfApiRoot(ROOT)
    const shell: NodeJS.ProcessEnv = { WALNUT_HELPER_TOKEN: 'inherited' }
    applyWalnutHelperEnv(shell, ['Bash'])
    expect(shell).toMatchObject({ OPEN_WALNUT_API_URL: ROOT, WALNUT_HELPER_TOKEN: getHelperCallToken() })
    const none: NodeJS.ProcessEnv = { WALNUT_HELPER_TOKEN: 'inherited' }
    applyWalnutHelperEnv(none, [])
    expect(none.OPEN_WALNUT_API_URL).toBe(ROOT)
    expect(none.WALNUT_HELPER_TOKEN).toBeUndefined()
    const reads: NodeJS.ProcessEnv = {}
    applyWalnutHelperEnv(reads, ['Read', 'Grep'])
    expect(reads.WALNUT_HELPER_TOKEN).toBeUndefined()
  })

  it('a prompt names the variable, never the value', () => {
    setSelfApiRoot(ROOT)
    expect(HELPER_CALL_CURL_AUTH).toBe('-H "Authorization: Bearer $WALNUT_HELPER_TOKEN"')
  })
})

describe("the leader's auth and the helper credential", () => {
  it('passes a helper search from a caller loopback does not vouch for, and nothing else', async () => {
    setSelfApiRoot(ROOT)
    const t = getHelperCallToken()!
    expect((await call('GET', '/search', null)).status).toBe(401)
    expect((await call('GET', '/search', t)).status).toBe(200)
    const other = await call('GET', '/tasks', t)
    expect(other.status).toBe(403)
    expect(other.body).toMatchObject({ code: 'helper_scope' })
    expect((await call('POST', '/search', t)).status).toBe(403)
    expect((await call('DELETE', '/tasks/x', t)).status).toBe(403)
  })

  it('refusing it counts no failure toward the auth limit', async () => {
    setSelfApiRoot(ROOT)
    const t = getHelperCallToken()!
    for (let i = 0; i < 15; i++) expect((await call('GET', '/tasks', t)).status).toBe(403)
    // A wrong token after them is a first failure (401), not a full bucket (429).
    expect((await call('GET', '/tasks', 'not-a-token')).status).toBe(401)
  })
})
