/**
 * The session panel's "cannot be reached" notice waits out a short drop (2026-11-11: a
 * link a relay kept ending came back in 3 to 5 s each time, 14 times in 30 minutes, and
 * the notice blinked on and off with every drop: "it keep showing reconnect what happend?").
 *
 *   - a re-dial shows the notice only once it has lasted HOST_DOWN_GRACE_MS, counted from
 *     its start or from when the panel first saw it, whichever is earlier;
 *   - a drop that is back within the grace never shows it;
 *   - a failed or switched-off host shows it at once;
 *   - once shown, it stays until the host is connected again;
 *   - every kind of host problem is classified (a new one fails here until it is).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import type { HostStatus } from '../../web/src/api/hosts'

const state = vi.hoisted(() => ({ current: undefined as unknown }))
vi.mock('@/hooks/useHostStatus', () => ({
  useHostStatus: () => state.current,
  useHostStatusHydration: () => 'done',
  serverNow: () => Date.now(),
  seedHostStatus: () => {},
}))
vi.mock('@/hooks/useIsCloudReplica', () => ({ useIsCloudReplica: () => false }))
vi.mock('@/api/hosts', () => ({ connectHost: async () => state.current, checkHostReadiness: async () => state.current }))
vi.mock('@/utils/log', () => ({ log: { info: () => {}, warn: () => {}, error: () => {} } }))

const { SessionHostDownBanner, hostDownShowsAt, HOST_DOWN_GRACE_MS } = await import('../../web/src/components/sessions/SessionHostErrorBar')
const { hostProblemOf } = await import('../../src/core/hosts/host-problem')

const T0 = 1_900_000_000_000
const up = {
  host: 'devbox', label: 'Dev box', hostname: 'dev.example.com', connected: true, phase: 'connected',
  phaseLabel: '', steps: [], phaseElapsedMs: 0, connectElapsedMs: 0, at: T0, connectedAt: T0 - 60_000,
} as HostStatus
const reconnecting = (since: number) => ({ ...up, connected: false, phase: 'reconnecting', reconnectSince: since, at: since }) as unknown as HostStatus
/** A re-dial in flight with no failure yet reads as no problem (host-problem.ts). */
const dialing = { ...up, connected: false, phase: 'tunnel', at: T0 } as unknown as HostStatus
const failed = { ...up, connected: false, phase: 'failed', kind: 'unreachable', error: 'ssh: no route', hint: 'Not reachable.', retryable: true } as HostStatus
const off = { ...up, connected: false, phase: 'off' } as unknown as HostStatus

let doc: Document
let root: { render: (n: unknown) => void; unmount: () => void } | null = null
let el: HTMLElement
beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  doc = dom.document as unknown as Document
})
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(T0)
  el = doc.createElement('div')
  doc.body.appendChild(el)
  root = createRoot(el)
})
afterEach(async () => {
  if (root) { await act(async () => { root!.unmount() }); root = null }
  doc.body.innerHTML = ''
  vi.useRealTimers()
})

async function show(status: HostStatus | undefined): Promise<void> {
  state.current = status
  await act(async () => { root!.render(createElement(SessionHostDownBanner, { host: 'devbox', label: 'Dev box' })) })
}
async function advance(ms: number): Promise<void> {
  await act(async () => { vi.advanceTimersByTime(ms) })
}
const shown = () => !!el.querySelector('[data-testid="session-host-down"]')

describe('the host-down notice waits out a short drop', () => {
  it('a re-dial shows it only after the grace, and it stays until connected', async () => {
    await show(up)
    await show(reconnecting(T0))
    expect(shown()).toBe(false)
    await advance(HOST_DOWN_GRACE_MS / 2)
    expect(shown()).toBe(false)
    await advance(HOST_DOWN_GRACE_MS / 2 + 100)
    expect(shown()).toBe(true)
    // The next dial reads as no problem for a while: the notice holds.
    await show(dialing)
    expect(shown()).toBe(true)
    await show({ ...up, at: Date.now() })
    expect(shown()).toBe(false)
  })

  it('a drop back within the grace never shows it, drop after drop', async () => {
    await show(up)
    for (let i = 0; i < 5; i++) {
      await show(reconnecting(Date.now()))
      await advance(4_000)
      expect(shown()).toBe(false)
      await show({ ...up, at: Date.now() })
      await advance(20_000)
      expect(shown()).toBe(false)
    }
  })

  it('a re-dial already past the grace when the panel opens shows it at once', async () => {
    await show(reconnecting(T0 - 30_000))
    expect(shown()).toBe(true)
  })

  it('a failed or switched-off host shows it at once', async () => {
    await show(failed)
    expect(shown()).toBe(true)
    await show(up)
    expect(shown()).toBe(false)
    await show(off)
    expect(shown()).toBe(true)
  })
})

describe('hostDownShowsAt classifies every kind of host problem', () => {
  it('each problem type in host-problem.ts has its rule', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/core/hosts/host-problem.ts'), 'utf8')
    const union = src.slice(src.indexOf('export type HostProblem ='), src.indexOf('export type HostProblemType'))
    const types = [...union.matchAll(/type: '([a-z-]+)'/g)].map((m) => m[1]).sort()
    const RULES: Record<string, 'at once' | 'after the grace' | 'never'> = {
      off: 'at once', connect: 'at once', reconnecting: 'after the grace', readiness: 'never', listing: 'never',
    }
    expect(types).toEqual(Object.keys(RULES).sort())
    expect(hostDownShowsAt(hostProblemOf(off), T0)).toBe(0)
    expect(hostDownShowsAt(hostProblemOf(failed), T0)).toBe(0)
    expect(hostDownShowsAt(hostProblemOf(reconnecting(T0)), T0 + 5_000)).toBe(T0 + HOST_DOWN_GRACE_MS)
    expect(hostDownShowsAt(hostProblemOf(up), T0)).toBeNull()
    expect(hostDownShowsAt({ type: 'listing', hint: '', summary: '', headline: '' }, T0)).toBeNull()
  })
})
