/**
 * A source search that fails outright is asked again before the tab says the source is not available
 * (2026-11-12: a deploy restarted the server under an open "@" picker). The guard below keeps every
 * search the hook makes on the retrying path.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SEARCH_RETRY_STEPS_MS } from '../../web/src/stores/source-search'

const SRC = fs.readFileSync(path.join(__dirname, '../../web/src/stores/source-search.ts'), 'utf8')

describe('source search retry', () => {
  it('waits about a restart in all before giving up', () => {
    const total = SEARCH_RETRY_STEPS_MS.reduce((a, b) => a + b, 0)
    expect(total).toBeGreaterThanOrEqual(10_000)
    expect(total).toBeLessThanOrEqual(20_000)
  })
  it('the hook only asks through the retrying search', () => {
    const hook = SRC.slice(SRC.indexOf('export function useSourceSearch'))
    expect(hook).toContain('searchSourceRetrying(')
    expect(hook.replace(/searchSourceRetrying\(/g, '')).not.toMatch(/\bsearchSource\(/)
  })
})

describe('which failures are asked again', () => {
  const apiError = (status: number) => Object.assign(new Error('x'), { name: 'ApiError', status })
  it('a lost connection and a restarting server are', async () => {
    const { passingFailure } = await import('../../web/src/stores/source-search')
    expect(passingFailure(new TypeError('Load failed'))).toBe(true)
    for (const status of [404, 408, 429, 500, 502, 503]) expect(passingFailure(apiError(status))).toBe(true)
  })
  it('a deadline, a cancel and another 4xx are not', async () => {
    const { passingFailure } = await import('../../web/src/stores/source-search')
    expect(passingFailure(new DOMException('t', 'TimeoutError'))).toBe(false)
    expect(passingFailure(new DOMException('a', 'AbortError'))).toBe(false)
    for (const status of [400, 401, 403, 409]) expect(passingFailure(apiError(status))).toBe(false)
  })
})
