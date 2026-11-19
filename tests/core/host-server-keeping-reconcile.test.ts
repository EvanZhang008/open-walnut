/**
 * The plugins that keep their tasks ride each follower's spec (host-server/manager.ts
 * `pluginsKeepTasks`). When that set changes (a plugin that keeps its tasks loads, or goes),
 * the real host-server wiring (src/core/host-server/index.ts) reconciles every host once
 * the burst settles (KEEPING_RECONCILE_MS), at the latest KEEPING_RECONCILE_MAX_MS after it
 * began (settledCall), so the follower gets the new word with no other change. A reload of the
 * same plugin is no change (tests/core/plugin-task-visibility.test.ts). Stand-ins: the host's daemon (a fake,
 * as in host-server-target-wiring.test.ts) and a local app dir in place of an install.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-keeping-reconcile', { CLOUD_MODE: false }))
vi.mock('../../src/web/expose-runtime.js', () => ({
  getExposeRuntime: () => ({ holdTunnelPort: async () => 5555, releaseTunnelPort: async () => {} }),
}))

import { CONFIG_FILE } from '../../src/constants.js'
import { getHostServerManager, hostServerConnected, KEEPING_RECONCILE_MAX_MS, settledCall, _resetHostServerManagerForTesting } from '../../src/core/host-server/index.js'
import type { HostServerHost } from '../../src/core/host-server/manager.js'
import { registerPluginKeepsTasks, resetPluginTaskVisibilityForTesting } from '../../src/core/plugins/plugin-task-visibility.js'

/** The spec settings each `server.configure` carried. */
const sent: Array<Record<string, unknown> | undefined> = []
let running = false

const host: HostServerHost = {
  hostKey: 'devbox',
  connected: true,
  hasCapability: (cap) => ['host-server-v1', 'follower-v1', 'stream-relay-v1'].includes(cap),
  async send(cmd, params) {
    if (cmd === 'server.configure') {
      const spec = params?.spec as { settings?: Record<string, unknown> } | undefined
      sent.push(spec?.settings)
      running = !!spec
      return { ok: true, status: { state: running ? 'running' : 'off', since: 0, restarts: 0 } }
    }
    if (cmd === 'server.status') {
      return { ok: true, status: { state: running ? 'running' : 'off', since: 0, restarts: 0, pid: 4242, ...(running ? { report: { route: { kind: 'leader' } }, reportAgeMs: 1_000 } : {}) } }
    }
    return { ok: false, error: 'unknown' }
  },
  async runRemoteScript(script) {
    if (script === 'printf %s "$HOME"') return '/home/me'
    if (script.endsWith('&& echo dirs')) return 'dirs'
    if (script.includes('require("net")')) return script.split(' ').filter((w) => /^\d{5}$/.test(w)).map((p) => `${p}:free`).join('\n')
    throw new Error('unexpected script: ' + script.slice(0, 80))
  },
  async uploadFile() { throw new Error('no upload: the app dir stands in for an install') },
  async openStream() { throw new Error('no stream: nothing is posted in this test') },
}

beforeAll(() => {
  process.env.WALNUT_HOST_SERVER_APP_DIR = '/work/walnut-tree'
  fs.writeFileSync(CONFIG_FILE, 'hosts:\n  devbox:\n    label: Dev box\n    server:\n      enabled: true\n')
})

afterAll(() => {
  _resetHostServerManagerForTesting()
  resetPluginTaskVisibilityForTesting()
  delete process.env.WALNUT_HOST_SERVER_APP_DIR
})

const keptIn = (s: Record<string, unknown> | undefined) => s?.pluginsKeepTasks

describe('a change of the plugins that keep their tasks', () => {
  it('reconciles the hosts once its burst settles, so the follower\'s spec names the new set', async () => {
    await hostServerConnected(host)
    expect(getHostServerManager()!.view('devbox').phase).toBe('running')
    expect(keptIn(sent.at(-1))).toEqual([])
    const before = sent.length
    // Two plugins load back to back: one reconcile after the wait, naming both.
    registerPluginKeepsTasks('acme-sync')
    registerPluginKeepsTasks('marina-notes')
    await expect.poll(() => keptIn(sent.at(-1)), { timeout: KEEPING_RECONCILE_MAX_MS * 2 }).toEqual(['acme-sync', 'marina-notes'])
    expect(sent.length).toBe(before + 1)
  }, 30_000)
})

describe('settledCall: once per burst, and never later than its maximum wait', () => {
  afterEach(() => { vi.useRealTimers() })

  it('a burst of kicks runs it once, its wait after the last kick', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const s = settledCall(fn, 2_000, 10_000)
    s.kick()
    vi.advanceTimersByTime(1_500)
    s.kick()
    vi.advanceTimersByTime(1_999)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('kicks that never stop run it at the latest its maximum wait after the first, then a new burst starts', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const s = settledCall(fn, 2_000, 10_000)
    for (let t = 0; t < 10_000; t += 1_000) { s.kick(); vi.advanceTimersByTime(1_000) }
    expect(fn).toHaveBeenCalledTimes(1)
    s.kick()
    vi.advanceTimersByTime(2_000)
    expect(fn).toHaveBeenCalledTimes(2)
    // Cancelled: nothing runs.
    s.kick()
    s.cancel()
    vi.advanceTimersByTime(20_000)
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
