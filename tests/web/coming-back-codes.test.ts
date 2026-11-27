/**
 * A 503 that says its answer is coming back by itself (a host reconnecting, Walnut or a plugin
 * starting) is a warning in the browser log, never an error: the page keeps what it shows and asks
 * again (web/src/api/coming-back-codes.ts). 2026-11-27: every server restart's few seconds logged
 * "[api] GET /api/sessions/:id/history -> 503: Reconnecting" as errors, 582 in three days, and the
 * audit that reads the browser error log counted them as failures of the page.
 *
 * The list is pinned to the server's: every code the server answers as "this host is away"
 * (HOST_AWAY_CODES) and the plugin dispatcher's starting code is in it, so a code added there is
 * quiet here too, or this test fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { HOST_AWAY_CODES } from '../../src/web/middleware/host-unreachable-answer.js'
import { COMING_BACK_CODES, isComingBackAnswer } from '../../web/src/api/coming-back-codes'

const ROOT = path.resolve(__dirname, '../..')

describe('the coming-back codes', () => {
  it('hold every code the server answers for a host that is away', () => {
    for (const code of HOST_AWAY_CODES) expect(COMING_BACK_CODES.has(code), code).toBe(true)
  })

  it('hold the plugin dispatcher\'s starting code and Walnut\'s own unreachable code, and nothing else', () => {
    const dispatcher = fs.readFileSync(path.join(ROOT, 'src/web/plugin-route-dispatcher.ts'), 'utf8')
    expect(dispatcher).toContain("'plugin_starting'")
    const files = fs.readFileSync(path.join(ROOT, 'web/src/api/files.ts'), 'utf8')
    expect(files).toContain("WALNUT_UNREACHABLE_CODE = 'walnut_unreachable'")
    expect([...COMING_BACK_CODES].sort()).toEqual([...HOST_AWAY_CODES, 'plugin_starting', 'walnut_unreachable'].sort())
  })

  it('reads both body shapes, and only a 503', () => {
    expect(isComingBackAnswer(503, { error: 'Reconnecting to devbox', code: 'host_reconnecting' })).toBe(true)
    expect(isComingBackAnswer(503, { error: { code: 'needs_leader', message: 'Needs your Mac' } })).toBe(true)
    expect(isComingBackAnswer(502, { code: 'host_reconnecting' })).toBe(false)
    expect(isComingBackAnswer(503, { code: 'budget_needs_upgrade' })).toBe(false)
    expect(isComingBackAnswer(503, 'Service Unavailable')).toBe(false)
  })
})

describe('the API client logs a coming-back 503 as a warning', () => {
  let errors: unknown[][]
  let warnings: unknown[][]
  beforeEach(() => {
    vi.stubGlobal('window', Object.assign(new EventTarget(), { requestAnimationFrame: vi.fn() }))
    errors = []
    warnings = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args) })
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args) })
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  async function get(status: number, body: unknown): Promise<void> {
    vi.resetModules()
    const { apiGet } = await import('../../web/src/api/client')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })))
    await apiGet('/api/sessions/s1/history?since=3').catch(() => {})
  }
  const logged = (lines: unknown[][]) => lines.map((l) => String(l[0])).filter((l) => l.includes('/api/sessions/s1/history'))

  it.each([...COMING_BACK_CODES])('%s', async (code) => {
    await get(503, { error: 'coming back', code })
    expect(logged(errors)).toEqual([])
    expect(logged(warnings).some((l) => l.includes('→ 503'))).toBe(true)
  })

  it('any other 503 stays an error', async () => {
    await get(503, { error: 'the budget host runs an older daemon', code: 'budget_needs_upgrade' })
    expect(logged(errors).some((l) => l.includes('→ 503'))).toBe(true)
  })
})
