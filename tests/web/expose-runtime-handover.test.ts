/**
 * The tunnel handover to a host and its release (src/web/expose-runtime.ts,
 * expose-handover.ts), on the runtime with a fake tunnel child, a fake clock, a
 * fake host view and a fake probe of the address:
 *
 * - when the host is up with this tunnel, the one here stops FIRST, then the host
 *   is asked to connect again, then the handover is recorded: the host's is the
 *   newest connection whatever this computer did meanwhile (a Mac that woke up
 *   and reconnected with the same address, the review case);
 * - a record is kept only while the host keeps holding: after RELEASE_GRACE_MS
 *   without it, this computer asks the address; a Walnut answering keeps it, an
 *   answer nobody gives (or a sign-in page, when the host can be seen) releases it,
 *   and the tunnel runs here again until the host holds it again.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../src/constants.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { registerExposeProvider, _resetExposeProvidersForTesting } from '../../src/core/expose/registry.js'
import { tunnelKey, type PlacementHostView } from '../../src/core/expose/placement.js'
import type { ProbeAnswer } from '../../src/core/expose/probe.js'
import type { ExposeChild } from '../../src/core/expose/supervisor.js'
import type { ExposeProviderDefinition } from '../../src/core/expose/types.js'
import { startExposeRuntime, type ExposeRuntime } from '../../src/web/expose-runtime.js'
import { RELEASE_GRACE_MS, RELEASE_RECHECK_MS } from '../../src/web/expose-handover.js'

const URL_ = 'https://someone-acme-demo.acme-tunnel.example'
const DEF: ExposeProviderDefinition = {
  id: 'acme-tunnel', title: 'Acme Tunnel', command: '/opt/acme/bin/tunnel', args: ['http', '{port}', '--name', '{name}'],
  options: [{ key: 'name', label: 'Tunnel name', default: 'acme-demo' }],
  urlPattern: 'https://[a-z0-9.-]+\\.acme-tunnel\\.example',
  probe: false,
  alwaysOnHostPattern: '^always-on-',
}
const KEY = tunnelKey(DEF, {})

/** What happened, in order: the one here stopped, the host asked to connect again, the record written. */
let events: string[] = []

class FakeChild implements ExposeChild {
  static seq = 300
  readonly pid = FakeChild.seq++
  private lines: Array<(l: string) => void> = []
  private exits: Array<(c: number | null, s: string | null) => void> = []
  killed = false
  onLine(h: (l: string) => void) { this.lines.push(h) }
  onExit(h: (c: number | null, s: string | null) => void) { this.exits.push(h) }
  onSpawnError() {}
  kill(signal: NodeJS.Signals) {
    if (this.killed) return
    this.killed = true
    events.push(`here stopped (${signal})`)
    for (const h of this.exits) h(null, signal)
  }
  say(line: string) { for (const h of this.lines) h(line) }
}

let now = 1_800_000_000_000
let children: FakeChild[] = []
let view: PlacementHostView | null = null
let answer: ProbeAnswer = 'down'
let probes: Array<{ url: string; token: string }> = []
let reconnectFails = false
let runtime: ExposeRuntime
let mainServer: http.Server
const handoverFile = () => path.join(WALNUT_HOME, 'local', 'expose-handover.json')
const record = () => { try { return JSON.parse(fs.readFileSync(handoverFile(), 'utf8')) } catch { return null } }

function hostReport(over: Record<string, unknown> = {}, phase = 'running'): PlacementHostView {
  return {
    phase, since: 1,
    server: { expose: { enabled: true, provider: 'acme-tunnel', providerTitle: 'Acme Tunnel', state: 'connected', since: 5, url: URL_, tunnelKey: KEY, ...over } },
  }
}

function start(): ExposeRuntime {
  return startExposeRuntime({
    app: (_req, res) => { res.end('app') },
    mainServer,
    handoverFile: handoverFile(),
    deps: {
      spawn: () => { const c = new FakeChild(); children.push(c); events.push('here started'); return c },
      now: () => now,
      probe: async (url, _ms, token) => { probes.push({ url, token }); return answer },
      log: { info() {}, warn() {} },
    },
    hosts: {
      view: () => view,
      retry: async () => {},
      reconnect: async (hostKey) => {
        events.push(`host asked to connect again (record ${record() ? 'written' : 'not written'})`)
        if (reconnectFails) throw new Error('the server on that host is not set up')
        expect(hostKey).toBe('devbox')
      },
    },
  })
}

const connectedHere = async () => {
  const c = children.at(-1)!
  c.say(`Public: ${URL_}`)
  expect(runtime.status()).toMatchObject({ state: 'connected', url: URL_, movingTo: { hostKey: 'devbox' } })
  return c
}

beforeAll(async () => {
  mainServer = http.createServer()
  await updateConfig({
    expose: { enabled: true, provider: 'acme-tunnel' },
    hosts: { devbox: { label: 'Dev box', hostname: 'always-on-devbox.invalid', user: 'someone' } },
  } as never)
})
afterAll(() => { mainServer.close() })

beforeEach(() => {
  events = []
  children = []
  probes = []
  view = null
  answer = 'down'
  reconnectFails = false
  fs.rmSync(handoverFile(), { force: true })
  _resetExposeProvidersForTesting()
  registerExposeProvider('acme-plugin', DEF)
  runtime = start()
})
afterEach(async () => { await runtime.stop() })

describe('the handover: the one here stops first, then the host connects again, then it is recorded', () => {
  it('the review case: the host connected while this computer slept, this one woke and reconnected (now the newest)', async () => {
    await runtime.reconcile()
    const here = await connectedHere()
    // The host's tunnel connected while this computer slept...
    view = hostReport({ since: 10 })
    now += 60_000
    // ...then this computer woke and its CLI reconnected with the same address: it is the newest now.
    here.say(`Public: ${URL_}`)
    events = []
    const s = await runtime.reconcile()
    expect(events).toEqual(['here stopped (SIGTERM)', 'host asked to connect again (record not written)'])
    expect(record()).toMatchObject({ hostKey: 'devbox', key: KEY, url: URL_ })
    expect(s).toMatchObject({ state: 'connected', url: URL_, runsOn: { hostKey: 'devbox' } })
    expect(s.movingTo).toBeUndefined()
    // Nothing more: the record holds the place.
    await runtime.reconcile()
    expect(children).toHaveLength(1)
  })

  it('a host that cannot be asked to connect again is recorded all the same (its own check and the release cover it)', async () => {
    await runtime.reconcile()
    await connectedHere()
    reconnectFails = true
    view = hostReport()
    await runtime.reconcile()
    expect(record()).toMatchObject({ hostKey: 'devbox', key: KEY })
    expect(runtime.status()).toMatchObject({ runsOn: { hostKey: 'devbox' } })
  })

  it('no tunnel here yet (still starting): the host connected takes it the same way', async () => {
    await runtime.reconcile()
    expect(runtime.status()).toMatchObject({ state: 'starting', movingTo: { hostKey: 'devbox' } })
    view = hostReport()
    events = []
    await runtime.reconcile()
    expect(events).toEqual(['here stopped (SIGTERM)', 'host asked to connect again (record not written)'])
    expect(record()).toMatchObject({ hostKey: 'devbox' })
  })
})

describe('the release: a record holds only while the host keeps holding', () => {
  async function handedOver() {
    await runtime.reconcile()
    await connectedHere()
    view = hostReport()
    await runtime.reconcile()
    expect(record()).toMatchObject({ hostKey: 'devbox', url: URL_ })
    events = []
  }

  it('the host gone from view: kept through the grace without asking; then a Walnut answering at the address keeps it', async () => {
    await handedOver()
    view = { phase: 'waiting-for-host', since: 2, message: 'The host is not connected right now.' }
    now += RELEASE_GRACE_MS - 1_000
    await runtime.reconcile()
    expect(probes).toEqual([])
    expect(record()).not.toBeNull()
    now += 2_000
    answer = 'other'
    await runtime.reconcile()
    // Asked through the address, with this computer's own token (a host's listener answers with its own).
    expect(probes).toEqual([{ url: URL_, token: expect.stringMatching(/^[0-9a-f]{32}$/) }])
    expect(record()).not.toBeNull()
    expect(children).toHaveLength(1)
    // A sign-in page in front, the host out of sight: this computer cannot tell, so it keeps out of the way.
    answer = 'unverified'
    now += RELEASE_RECHECK_MS
    await runtime.reconcile()
    expect(record()).not.toBeNull()
    expect(children).toHaveLength(1)
  })

  it('nobody answers at the address: released, it runs here again, and the host takes it over again once it holds it', async () => {
    await handedOver()
    view = null
    now += RELEASE_GRACE_MS + 1
    answer = 'down'
    const s = await runtime.reconcile()
    expect(record()).toBeNull()
    expect(events).toEqual(['here started'])
    expect(s).toMatchObject({ state: 'starting', movingTo: { hostKey: 'devbox' } })
    await connectedHere()
    // The host is back with the tunnel: the same handover again.
    view = hostReport({ since: 99 })
    events = []
    await runtime.reconcile()
    expect(events).toEqual(['here stopped (SIGTERM)', 'host asked to connect again (record not written)'])
    expect(record()).toMatchObject({ hostKey: 'devbox' })
  })

  it('the host in view but not holding (retrying, a sign-in, its server in error): a sign-in page in front no longer keeps it', async () => {
    for (const notHolding of [
      hostReport({ state: 'retrying', url: URL_, lastError: 'Acme Tunnel exited (code 1).' }),
      hostReport({ state: 'needs-sign-in' }),
      { phase: 'error', since: 3, message: 'the install on the host failed' } as PlacementHostView,
    ]) {
      await runtime.stop()
      fs.rmSync(handoverFile(), { force: true })
      children = []
      runtime = start()
      await handedOver()
      view = notHolding
      now += RELEASE_GRACE_MS + 1
      answer = 'unverified'
      await runtime.reconcile()
      expect(record(), JSON.stringify(notHolding)).toBeNull()
      expect(events).toEqual(['here started'])
    }
  })

  it('a restart here with a record: the host gets the whole grace from this start before the address is asked', async () => {
    await handedOver()
    await runtime.stop()
    view = null
    now += 3_600_000
    runtime = start()
    await runtime.reconcile()
    expect(probes).toEqual([])
    expect(record()).not.toBeNull()
    expect(children).toHaveLength(1)
    now += RELEASE_GRACE_MS + 1
    await runtime.reconcile()
    expect(probes).toHaveLength(1)
    expect(record()).toBeNull()
    expect(children).toHaveLength(2)
  })

  it('a host seen holding again resets the clock, and a new address there is kept in the record', async () => {
    await handedOver()
    view = null
    now += RELEASE_GRACE_MS - 1_000
    await runtime.reconcile()
    view = hostReport({ url: 'https://someone-acme-demo.eu.acme-tunnel.example' })
    await runtime.reconcile()
    expect(record()).toMatchObject({ url: 'https://someone-acme-demo.eu.acme-tunnel.example' })
    view = null
    now += RELEASE_GRACE_MS - 1_000
    await runtime.reconcile()
    expect(probes).toEqual([])
    expect(record()).not.toBeNull()
  })
})
