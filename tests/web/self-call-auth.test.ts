/**
 * A cloud-mode server's own op calls prove themselves.
 *
 * Incident this pins (2026-10-06): the cloud companion, leading while the Mac
 * slept, ran a host's `task_update` through its op executor, which calls the
 * companion's own /api/v1 over loopback. Cloud mode has no loopback waiver, so
 * every such call was refused with 401 and the update never happened.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import type { Request, Response } from 'express'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-self-call-auth', { CLOUD_MODE: true }))

import { getSelfCallToken, isSelfCallToken, setSelfApiRoot } from '../../src/lib/self-api-root.js'
import { authMiddleware } from '../../src/web/middleware/auth.js'
import { executeOp } from '../../src/ops/index.js'

afterEach(() => {
  setSelfApiRoot(null)
  vi.unstubAllGlobals()
})

function run(authorization?: string): Promise<{ passed: boolean; status?: number }> {
  return new Promise((resolve) => {
    const req = {
      headers: authorization ? { authorization } : {},
      path: '/v1/tasks/t1', method: 'PATCH', ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request
    const res = {
      status(code: number) { return { json: () => resolve({ passed: false, status: code }) } },
    } as unknown as Response
    void authMiddleware(req, res, () => resolve({ passed: true }))
  })
}

describe('the self-call credential', () => {
  it('exists only inside a listening server, and stays the same for its life', () => {
    expect(getSelfCallToken()).toBeNull()
    setSelfApiRoot('http://127.0.0.1:45678', { credential: true })
    const token = getSelfCallToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(getSelfCallToken()).toBe(token)
    expect(isSelfCallToken(token!)).toBe(true)
    expect(isSelfCallToken(token!.slice(0, -1) + (token!.endsWith('0') ? '1' : '0'))).toBe(false)
    expect(isSelfCallToken('')).toBe(false)
    // A stopped server answers for nothing.
    setSelfApiRoot(null)
    expect(isSelfCallToken(token!)).toBe(false)
  })

  it('lets a cloud-mode server reach itself, and nothing else in', async () => {
    expect((await run()).status).toBe(401)
    setSelfApiRoot('http://127.0.0.1:45678', { credential: true })
    expect(await run(`Bearer ${getSelfCallToken()}`)).toEqual({ passed: true })
    expect((await run()).status).toBe(401)
    expect((await run('Bearer not-the-token')).status).toBe(401)
  })

  it('is sent by the executor only to this server, never to another root', async () => {
    setSelfApiRoot('http://127.0.0.1:45678', { credential: true })
    const seen: Array<{ url: string; auth: string | undefined }> = []
    vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, auth: init.headers.Authorization })
      return new Response(JSON.stringify({ task: { id: 't1' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    await executeOp('task_get', { id: 't1' }, { origin: 'local' })
    await executeOp('task_get', { id: 't1' }, { origin: 'local', apiBase: 'http://127.0.0.1:9' })
    expect(seen).toHaveLength(2)
    expect(seen[0].url.startsWith('http://127.0.0.1:45678/api/')).toBe(true)
    expect(seen[0].auth).toBe(`Bearer ${getSelfCallToken()}`)
    expect(seen[1].url.startsWith('http://127.0.0.1:9/api/')).toBe(true)
    expect(seen[1].auth).toBeUndefined()
  })

  it('stays off for a server that did not ask for it (the Mac: loopback-trusted, no header)', async () => {
    setSelfApiRoot('http://127.0.0.1:45678')
    expect(getSelfCallToken()).toBeNull()
    const seen: Array<string | undefined> = []
    vi.stubGlobal('fetch', async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers.Authorization)
      return new Response(JSON.stringify({ task: { id: 't1' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    await executeOp('task_get', { id: 't1' }, { origin: 'local' })
    expect(seen).toEqual([undefined])
    // A token minted while it was on proves nothing once it is off.
    setSelfApiRoot('http://127.0.0.1:45678', { credential: true })
    const token = getSelfCallToken()!
    setSelfApiRoot('http://127.0.0.1:45678')
    expect(isSelfCallToken(token)).toBe(false)
  })
})
