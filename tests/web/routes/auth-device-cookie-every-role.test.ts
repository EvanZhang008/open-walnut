/**
 * Every server role takes the `walnut_device` cookie on a read (2026-10-31).
 *
 * A previewed HTML file's frames, images and stylesheets are loaded by the web
 * view itself, which sends no Authorization header; the phone puts its token in
 * the `walnut_device` cookie for them. The primary and the companion took that
 * cookie, a host replica did not, so a phone routed to a host replica saw its
 * preview refused as "not paired" while every other screen worked.
 *
 * The ratchet: every `*AuthMiddleware` function in src/ reads the cookie
 * through `cookieCredential`, or is listed below with the reason it must not.
 * A new auth middleware that forgets it fails here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { NextFunction, Request, Response } from 'express'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { sha256 } from '../../helpers/replica-host-env.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-auth-cookie-every-role'))

import { _resetReplicaAuthForTesting, replicaAuthMiddleware, replicaDeviceCopy } from '../../../src/replica/auth.js'
import { _resetAuthRateLimitForTesting } from '../../../src/web/middleware/auth-rate-limit.js'

const SRC = path.resolve(__dirname, '../../../src')

/** Auth middlewares that must NOT take the cookie, and why. */
const NO_COOKIE: Record<string, string> = {
  // git smart HTTP: the clients are git itself and the companion's sync, which
  // always send a header; a cookie there would only widen what a page can reach.
  gitAuthMiddleware: 'git clients send a header; no web view loads git URLs',
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** Each `xAuthMiddleware` function in src with its body (up to the next top-level declaration). */
function authMiddlewares(): Array<{ name: string; file: string; body: string }> {
  const found: Array<{ name: string; file: string; body: string }> = []
  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf-8')
    // `function xAuthMiddleware(` and `const xAuthMiddleware = (` / `= async (` / `= function`.
    const re = /(?:function\s+([A-Za-z0-9_]*[Aa]uthMiddleware)\s*\(|(?:const|let)\s+([A-Za-z0-9_]*[Aa]uthMiddleware)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\())/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const rest = text.slice(m.index + m[0].length)
      const end = rest.search(/\n(?:export\s+)?(?:(?:async\s+)?function\s|const\s|let\s)/)
      found.push({ name: (m[1] ?? m[2])!, file: path.relative(SRC, file), body: end < 0 ? rest : rest.slice(0, end) })
    }
  }
  return found
}

describe('every auth middleware takes the device cookie on a read', () => {
  it('finds the known roles (the scan works)', () => {
    const names = authMiddlewares().map((m) => m.name)
    expect(names).toEqual(expect.arrayContaining(['authMiddleware', 'cloudAuthMiddleware', 'replicaAuthMiddleware']))
  })

  it('each one reads cookieCredential or names why not', () => {
    const missing = authMiddlewares()
      .filter((m) => !m.body.includes('cookieCredential(') && !NO_COOKIE[m.name])
      .map((m) => `${m.file}: ${m.name}`)
    expect(missing).toEqual([])
  })

  it('the exceptions still exist (no stale entries)', () => {
    const names = new Set(authMiddlewares().map((m) => m.name))
    for (const name of Object.keys(NO_COOKIE)) expect(names.has(name)).toBe(true)
  })
})

describe('a host replica takes the device cookie', () => {
  const PHONE_TOKEN = 'marina-phone-token'

  async function call(method: string, headers: Record<string, string>): Promise<number> {
    const req = {
      method, path: '/v1/file-raw/local/Users/me/site/01-inbox-lines.html', ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' }, headers,
    } as unknown as Request
    let status = 0
    const res = { status(n: number) { status = n; return res }, json() { return res } } as unknown as Response
    let passed = false
    await replicaAuthMiddleware(req, res, (() => { passed = true }) as NextFunction)
    return passed ? 200 : status
  }

  beforeEach(() => {
    _resetAuthRateLimitForTesting()
    _resetReplicaAuthForTesting()
    expect(replicaDeviceCopy().put({ devices: [{ name: 'marina-phone', tokenHash: sha256(PHONE_TOKEN) }] })).toMatchObject({ ok: true })
  })

  it('a GET with only the cookie passes, as a frame of a previewed page sends it', async () => {
    expect(await call('GET', { cookie: `theme=dark; walnut_device=${encodeURIComponent(PHONE_TOKEN)}` })).toBe(200)
    expect(await call('HEAD', { cookie: `walnut_device=${PHONE_TOKEN}` })).toBe(200)
  })

  it('a write with only the cookie is refused', async () => {
    expect(await call('POST', { cookie: `walnut_device=${PHONE_TOKEN}` })).toBe(401)
  })

  it('a wrong cookie is refused, and a header wins over the cookie', async () => {
    expect(await call('GET', { cookie: 'walnut_device=guess' })).toBe(401)
    expect(await call('GET', { authorization: 'Bearer guess', cookie: `walnut_device=${PHONE_TOKEN}` })).toBe(401)
    expect(await call('GET', { authorization: `Bearer ${PHONE_TOKEN}`, cookie: 'walnut_device=guess' })).toBe(200)
  })
})
