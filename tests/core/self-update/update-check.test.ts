/**
 * The update checker: one registry GET, cached in memory, scheduled daily.
 *
 * Pinned here: when it refuses to run (source, replica, opt-out, tests, an
 * unknown version), what a success / a failure / a timeout do to the status,
 * that a failure keeps the previous answer, that concurrent callers share one
 * fetch, and the schedule (20 s, then a day, an hour after a failure).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-update-check'))

import {
  DEFAULT_REGISTRY_URL, FIRST_CHECK_DELAY_MS, RETRY_AFTER_FAILURE_MS, UPDATE_CHECK_INTERVAL_MS,
  UpdateChecker, disabledReason, fetchLatestVersion, formatUpdateNotice, getUpdateChecker, resetUpdateChecker,
  updateCheckOptedOut, type UpdateStatus,
} from '../../../src/core/self-update/update-check.js'
import type { InstallInfo } from '../../../src/core/self-update/install-kind.js'

const NPM: InstallInfo = {
  kind: 'npm', sourceDir: null, packageRoot: '/usr/local/lib/node_modules/open-walnut', manager: 'npm',
  updateCommand: 'npm install -g open-walnut@latest',
}
const SOURCE: InstallInfo = { kind: 'source', sourceDir: '/Users/alice/open-walnut', packageRoot: '/Users/alice/open-walnut', manager: null, updateCommand: null }
const REPLICA: InstallInfo = { ...NPM, kind: 'replica', manager: null, updateCommand: null }
const OTHER: InstallInfo = { kind: 'other', sourceDir: null, packageRoot: '/opt/open-walnut', manager: null, updateCommand: null }

/** A fetch that answers the registry's /latest document with one version, or fails as asked. */
function registry(answer: string | { status: number } | Error | 'hang') {
  const calls: string[] = []
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input))
    if (answer === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })))
      })
    }
    if (answer instanceof Error) throw answer
    if (typeof answer === 'object') return new Response('nope', { status: answer.status })
    return new Response(JSON.stringify({ name: 'open-walnut', version: answer }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, calls }
}

/** Manual timers: the schedule is asserted by the delays asked for, then fired by hand. */
function timers() {
  const pending: Array<{ fn: () => void; ms: number; id: number }> = []
  let next = 1
  return {
    pending,
    setTimer: (fn: () => void, ms: number) => { const id = next++; pending.push({ fn, ms, id }); return id },
    clearTimer: (h: unknown) => { const i = pending.findIndex((p) => p.id === h); if (i >= 0) pending.splice(i, 1) },
    fire: async () => { const p = pending.shift(); p?.fn(); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)) },
  }
}

const ENV = {} as Record<string, string | undefined>
const NOW = () => new Date('2026-09-30T10:00:00.000Z')

afterEach(() => resetUpdateChecker())

describe('disabledReason', () => {
  it('never runs for a source checkout or a replica, whatever else is set', () => {
    expect(disabledReason(SOURCE, ENV, true, DEFAULT_REGISTRY_URL)).toBe('source')
    expect(disabledReason(REPLICA, ENV, true, DEFAULT_REGISTRY_URL)).toBe('replica')
  })

  it('honours WALNUT_NO_UPDATE_CHECK and the ecosystem NO_UPDATE_NOTIFIER', () => {
    expect(disabledReason(NPM, { WALNUT_NO_UPDATE_CHECK: '1' }, true, DEFAULT_REGISTRY_URL)).toBe('opted-out')
    expect(disabledReason(NPM, { NO_UPDATE_NOTIFIER: '1' }, true, DEFAULT_REGISTRY_URL)).toBe('opted-out')
    expect(updateCheckOptedOut({ WALNUT_NO_UPDATE_CHECK: '0' })).toBe(false)
    expect(updateCheckOptedOut({ WALNUT_NO_UPDATE_CHECK: 'false' })).toBe(false)
    expect(updateCheckOptedOut({ WALNUT_NO_UPDATE_CHECK: '' })).toBe(false)
    expect(updateCheckOptedOut({ NO_UPDATE_NOTIFIER: '' })).toBe(false)
  })

  it('stays off the network under vitest unless a stub registry is named', () => {
    expect(disabledReason(NPM, { VITEST: 'true' }, true, DEFAULT_REGISTRY_URL)).toBe('test')
    expect(disabledReason(NPM, { NODE_ENV: 'test' }, true, DEFAULT_REGISTRY_URL)).toBe('test')
    expect(disabledReason(NPM, { VITEST: 'true' }, true, 'http://127.0.0.1:9/latest')).toBeNull()
  })

  it('never tells a build with no version to update', () => {
    expect(disabledReason(NPM, ENV, false, DEFAULT_REGISTRY_URL)).toBe('unknown-version')
    expect(disabledReason(OTHER, ENV, true, DEFAULT_REGISTRY_URL)).toBeNull()
  })

  it('the real process env (vitest) disables the default checker, so no test ever reaches npm', () => {
    const status = getUpdateChecker().status()
    expect(status.enabled).toBe(false)
    expect(['test', 'source', 'other', 'unknown-version', 'opted-out']).toContain(status.reason)
  })
})

describe('fetchLatestVersion', () => {
  it('returns the version field', async () => {
    const r = registry('0.6.0')
    await expect(fetchLatestVersion('http://stub/latest', r.impl)).resolves.toBe('0.6.0')
    expect(r.calls).toEqual(['http://stub/latest'])
  })

  it('rejects on a bad status, a bodiless answer and a timeout', async () => {
    await expect(fetchLatestVersion('http://stub', registry({ status: 503 }).impl)).rejects.toThrow('HTTP 503')
    const empty = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    await expect(fetchLatestVersion('http://stub', empty)).rejects.toThrow('no version')
    const html = vi.fn(async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch
    await expect(fetchLatestVersion('http://stub', html)).rejects.toThrow()
    await expect(fetchLatestVersion('http://stub', registry('hang').impl, 20)).rejects.toMatchObject({ name: 'TimeoutError' })
  })
})

describe('UpdateChecker', () => {
  function make(answer: Parameters<typeof registry>[0], over: Partial<ConstructorParameters<typeof UpdateChecker>[0]> = {}) {
    const r = registry(answer)
    const t = timers()
    const checker = new UpdateChecker({
      fetch: r.impl, registryUrl: 'http://stub/latest', current: '0.5.1', currentKnown: true, install: NPM, env: ENV, now: NOW,
      setTimer: t.setTimer, clearTimer: t.clearTimer, ...over,
    })
    return { checker, r, t }
  }

  it('starts unknown: enabled, nothing checked, nothing available', () => {
    const { checker } = make('0.6.0')
    expect(checker.status()).toMatchObject({ enabled: true, current: '0.5.1', latest: null, available: false, checkedAt: null, error: null, checking: false })
    expect(checker.status().reason).toBeUndefined()
  })

  it('a newer release is available with the install command', async () => {
    const { checker, r } = make('0.6.0')
    const s = await checker.checkNow()
    expect(s).toMatchObject({ available: true, latest: '0.6.0', checkedAt: '2026-09-30T10:00:00.000Z', error: null })
    expect(formatUpdateNotice(s)).toBe('A newer Open Walnut is available: 0.5.1 → 0.6.0. Run: npm install -g open-walnut@latest')
    expect(r.calls).toHaveLength(1)
  })

  it('the same version, or a local build ahead of the registry, is not an update', async () => {
    expect((await make('0.5.1').checker.checkNow())).toMatchObject({ available: false, latest: '0.5.1' })
    expect((await make('0.5.0').checker.checkNow())).toMatchObject({ available: false, latest: '0.5.0' })
    expect(formatUpdateNotice(await make('0.5.1').checker.checkNow())).toBeNull()
  })

  it('an install with no manager gets the package page instead of a command', async () => {
    const s = await make('0.6.0', { install: OTHER }).checker.checkNow()
    expect(formatUpdateNotice(s)).toBe('A newer Open Walnut is available: 0.5.1 → 0.6.0. See https://www.npmjs.com/package/open-walnut')
  })

  it('a failure records the error and keeps the last good answer', async () => {
    const r = registry('0.6.0')
    let fail = false
    const flaky = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (fail) throw new TypeError('fetch failed')
      return (r.impl as unknown as (i: string | URL | Request, init?: RequestInit) => Promise<Response>)(input, init)
    }) as unknown as typeof fetch
    const checker = new UpdateChecker({ fetch: flaky, registryUrl: 'http://stub/latest', current: '0.5.1', currentKnown: true, install: NPM, env: ENV, now: NOW })
    await checker.checkNow()
    fail = true
    const s = await checker.checkNow()
    expect(s).toMatchObject({ available: true, latest: '0.6.0', error: 'fetch failed', checkedAt: '2026-09-30T10:00:00.000Z' })
    fail = false
    expect((await checker.checkNow()).error).toBeNull()
  })

  it('a first failure leaves latest null with the error', async () => {
    const s = await make({ status: 500 }).checker.checkNow()
    expect(s).toMatchObject({ enabled: true, latest: null, available: false, error: 'registry answered HTTP 500', checkedAt: null })
    expect(formatUpdateNotice(s)).toBeNull()
  })

  it('a registry timeout is recorded as the error', async () => {
    const quick = vi.fn(async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    }) as unknown as typeof fetch
    const fast = new UpdateChecker({ fetch: quick, registryUrl: 'http://stub/latest', current: '0.5.1', currentKnown: true, install: NPM, env: ENV })
    expect((await fast.checkNow()).error).toContain('aborted')
  })

  it('concurrent callers share one fetch, and checking is true while it runs', async () => {
    const { checker, r } = make('0.6.0')
    const a = checker.checkNow()
    const b = checker.checkNow()
    expect(checker.status().checking).toBe(true)
    const [sa, sb] = await Promise.all([a, b])
    expect(sa).toEqual(sb)
    expect(r.calls).toHaveLength(1)
    // The answer handed to a caller is the finished one (`walnut update --json` printed checking:true once).
    expect(sa.checking).toBe(false)
    expect(checker.status().checking).toBe(false)
  })

  it('a disabled checker answers at once and never fetches', async () => {
    const { checker, r } = make('0.6.0', { install: SOURCE })
    const s = await checker.checkNow()
    expect(s).toMatchObject({ enabled: false, reason: 'source', available: false, latest: null })
    expect(r.calls).toHaveLength(0)
    const { checker: opted, r: r2 } = make('0.6.0', { env: { WALNUT_NO_UPDATE_CHECK: '1' } })
    await opted.checkNow()
    expect(r2.calls).toHaveLength(0)
    expect(opted.status().reason).toBe('opted-out')
  })

  it('schedules the first check 20 s out, then daily; an hour after a failure; stop() disarms', async () => {
    const { checker, r, t } = make('0.6.0')
    checker.start()
    checker.start()
    expect(t.pending.map((p) => p.ms)).toEqual([FIRST_CHECK_DELAY_MS])
    await t.fire()
    expect(r.calls).toHaveLength(1)
    expect(checker.status().available).toBe(true)
    expect(t.pending.map((p) => p.ms)).toEqual([UPDATE_CHECK_INTERVAL_MS])
    checker.stop()
    expect(t.pending).toEqual([])

    const failing = make({ status: 502 })
    failing.checker.start()
    await failing.t.fire()
    expect(failing.t.pending.map((p) => p.ms)).toEqual([RETRY_AFTER_FAILURE_MS])
    failing.checker.stop()
  })

  it('start() is a no-op for a disabled checker', () => {
    const { checker, t } = make('0.6.0', { install: REPLICA })
    checker.start()
    expect(t.pending).toEqual([])
  })

  it('tells listeners after every completed check and lets them leave', async () => {
    const { checker } = make('0.6.0')
    const seen: UpdateStatus[] = []
    const off = checker.onChecked((s) => seen.push(s))
    await checker.checkNow()
    off()
    await checker.checkNow()
    expect(seen).toHaveLength(1)
    expect(seen[0]?.latest).toBe('0.6.0')
  })

  it('reads the registry URL override from the environment', async () => {
    const r = registry('0.6.0')
    const checker = new UpdateChecker({ fetch: r.impl, current: '0.5.1', currentKnown: true, install: NPM, env: { WALNUT_UPDATE_REGISTRY_URL: 'http://127.0.0.1:1/x' }, now: NOW })
    await checker.checkNow()
    expect(r.calls).toEqual(['http://127.0.0.1:1/x'])
  })
})
