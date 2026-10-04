/**
 * The cloud box as a host of the primary (core/hosts/cloud-box-host.ts):
 * when it appears, what an older or hosting-off companion looks like on every
 * surface, and that the injected row never reaches config.yaml.
 *
 * Real config-manager over an isolated WALNUT_HOME; the daemon pool is real
 * but never dialled (no connection exists for the alias).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-cloud-box-host'))

import { CONFIG_FILE } from '../../../src/constants.js'
import {
  CLOUD_BOX_HOST_ALIAS, capabilityFromStatus, cloudBoxRefusal, injectCloudBoxHost, onCloudBoxStateChange,
  resetCloudBoxStateForTest, setCloudBoxState, tunnelUrlFor, withoutCloudBoxHost, type CloudBoxCapability,
} from '../../../src/core/hosts/cloud-box-host.js'
import { getConfig, saveConfig, updateConfig } from '../../../src/core/config-manager.js'
import { classifyHostConnectError } from '../../../src/core/sessions/host-connect-hint.js'
import { hostActionsFor, hostFailureHeadline, hostProblemOf } from '../../../src/core/hosts/host-problem.js'
import { hostStatusFrame } from '../../../src/core/hosts/host-connect-action.js'
import { buildHostStatus, hostOffersTerminal } from '../../../src/core/hosts/host-status.js'
import { computeLaunchOptions } from '../../../src/core/sessions/mobile-launch.js'
import { describeTunnelRefusal, isLoopbackDomain } from '../../../src/core/hosts/cloud-box-probe.js'

const DOMAIN = 'companion.example.test'

function pair(capability: CloudBoxCapability): void {
  setCloudBoxState({ domain: DOMAIN, secure: true, capability, checkedAt: 1 })
}

beforeEach(async () => {
  resetCloudBoxStateForTest()
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true })
  await fs.writeFile(CONFIG_FILE, [
    'version: 1',
    'user:',
    '  name: Tester',
    'hosts:',
    '  devbox:',
    '    hostname: devbox.example.test',
    '    label: Dev box',
  ].join('\n') + '\n')
})

afterEach(() => resetCloudBoxStateForTest())

describe('capability from the companion status', () => {
  it('an older companion (no daemonTunnel field) needs an update', () => {
    expect(capabilityFromStatus({ mode: 'REPLICA', version: '0.4.0' })).toBe('needs_update')
  })
  it('enabled true is ready, anything else is hosting off', () => {
    expect(capabilityFromStatus({ daemonTunnel: { enabled: true } })).toBe('ready')
    expect(capabilityFromStatus({ daemonTunnel: { enabled: false, reason: 'not_enabled' } })).toBe('exec_off')
  })
  it('a body that is not an object is unknown, never a verdict', () => {
    expect(capabilityFromStatus(null)).toBe('unknown')
    expect(capabilityFromStatus('<html>')).toBe('unknown')
    expect(capabilityFromStatus({ daemonTunnel: 'yes' })).toBe('unknown')
  })
})

describe('refusal sentences', () => {
  it('needs_update and exec_off refuse with the shared sentences; ready and unknown dial', () => {
    pair('needs_update')
    const update = cloudBoxRefusal()!
    expect(update).toMatch(/^Cloud companion needs an update/)
    pair('exec_off')
    const off = cloudBoxRefusal()!
    expect(off).toMatch(/^Cloud companion has session hosting turned off/)
    pair('ready')
    expect(cloudBoxRefusal()).toBeNull()
    pair('unknown')
    expect(cloudBoxRefusal()).toBeNull()

    // Every surface classifies them the same way, with cloud words and no ssh advice.
    expect(classifyHostConnectError(update, DOMAIN).kind).toBe('cloud_update')
    expect(classifyHostConnectError(off, DOMAIN).kind).toBe('cloud_exec_off')
    expect(classifyHostConnectError('Cloud companion tunnel failed: HTTP 502', DOMAIN).kind).toBe('cloud_tunnel')
    expect(hostFailureHeadline('cloud_update', 'Cloud')).toBe('Cloud companion needs an update')
    expect(hostFailureHeadline('cloud_exec_off', 'Cloud')).toBe('Cloud companion has session hosting turned off')
    for (const s of [update, off]) expect(s).not.toMatch(/[–—]/)
  })

  it("every sentence the cloud box writes keeps its kind whatever the host's names are", () => {
    // Every surface classifies with the host's own names (alias, label "Cloud",
    // domain). Blanking those out of the message once turned "Cloud companion
    // needs an update" into "companion needs an update", read as a daemon failure.
    pair('needs_update')
    const update = cloudBoxRefusal()!
    pair('exec_off')
    const off = cloudBoxRefusal()!
    const sentences: Array<[string, string]> = [
      [update, 'cloud_update'],
      [off, 'cloud_exec_off'],
      [describeTunnelRefusal(403, 'cloud_exec_off', ''), 'cloud_exec_off'],
      [describeTunnelRefusal(403, 'not_primary', ''), 'cloud_tunnel'],
      [describeTunnelRefusal(502, 'daemon_start_failed', 'daemon exited: node: command not found'), 'cloud_tunnel'],
      [describeTunnelRefusal(401, undefined, ''), 'cloud_tunnel'],
      [describeTunnelRefusal(502, undefined, 'Connection refused by upstream'), 'cloud_tunnel'],
      ['Cloud companion tunnel failed: WebSocket connection failed: ECONNREFUSED', 'cloud_tunnel'],
    ]
    const hostNames = [CLOUD_BOX_HOST_ALIAS, 'Cloud', DOMAIN]
    for (const [sentence, kind] of sentences) {
      expect(classifyHostConnectError(sentence, DOMAIN, hostNames).kind, sentence).toBe(kind)
      for (const word of new Set(sentence.toLowerCase().match(/[a-z0-9_.-]+/g) ?? [])) {
        expect(classifyHostConnectError(sentence, DOMAIN, [...hostNames, word]).kind, `${sentence} / host named "${word}"`).toBe(kind)
      }
    }
  })

  it('tunnel URL follows the pairing scheme', () => {
    expect(tunnelUrlFor({ domain: DOMAIN, secure: true })).toBe(`wss://${DOMAIN}/daemon-tunnel`)
    expect(tunnelUrlFor({ domain: '127.0.0.1:4000', secure: false })).toBe('ws://127.0.0.1:4000/daemon-tunnel')
  })

  it('only a loopback companion counts as a test one', () => {
    expect(isLoopbackDomain('127.0.0.1:4000')).toBe(true)
    expect(isLoopbackDomain('localhost')).toBe(true)
    expect(isLoopbackDomain('[::1]:4000')).toBe(true)
    expect(isLoopbackDomain(DOMAIN)).toBe(false)
    expect(isLoopbackDomain('127.0.0.1.example.test')).toBe(false)
  })
})

describe('the host row', () => {
  it('appears in config.hosts only while paired, labelled Cloud', async () => {
    expect((await getConfig()).hosts?.[CLOUD_BOX_HOST_ALIAS]).toBeUndefined()
    pair('unknown')
    const row = (await getConfig()).hosts?.[CLOUD_BOX_HOST_ALIAS]
    expect(row).toMatchObject({ hostname: DOMAIN, label: 'Cloud', enabled: true, cloud_box: true })
    setCloudBoxState(null)
    expect((await getConfig()).hosts?.[CLOUD_BOX_HOST_ALIAS]).toBeUndefined()
  })

  it('is never injected on the replica itself', () => {
    pair('ready')
    const cfg: { hosts?: Record<string, unknown> } = { hosts: {} }
    injectCloudBoxHost(cfg, true)
    expect(cfg.hosts).toEqual({})
  })

  it('never reaches config.yaml through saveConfig or updateConfig', async () => {
    pair('ready')
    const cfg = await getConfig()
    expect(cfg.hosts?.[CLOUD_BOX_HOST_ALIAS]).toBeDefined()
    await saveConfig(cfg)
    let raw = await fs.readFile(CONFIG_FILE, 'utf-8')
    expect(raw).not.toContain(CLOUD_BOX_HOST_ALIAS)
    expect(raw).not.toContain('cloud_box')
    expect(raw).toContain('devbox')

    // A Settings-style partial write that sends the whole map back.
    await updateConfig({ hosts: { ...(await getConfig()).hosts, extra: { hostname: 'extra.example.test' } } })
    raw = await fs.readFile(CONFIG_FILE, 'utf-8')
    expect(raw).not.toContain(CLOUD_BOX_HOST_ALIAS)
    expect(raw).toContain('extra.example.test')
    // Still shown in memory afterwards.
    expect((await getConfig()).hosts?.[CLOUD_BOX_HOST_ALIAS]).toBeDefined()
  })

  it('withoutCloudBoxHost returns the same map when there is nothing to strip', () => {
    const hosts = { devbox: { hostname: 'x' } }
    expect(withoutCloudBoxHost(hosts)).toBe(hosts)
    expect(withoutCloudBoxHost({ ...hosts, sneaky: { hostname: 'y', cloud_box: true } })).toEqual(hosts)
  })

  it('listeners hear a pairing, a capability change and an unpairing, not a repeat', () => {
    const seen: Array<string | null> = []
    const off = onCloudBoxStateChange((s) => seen.push(s ? s.capability : null))
    pair('unknown')
    pair('unknown')
    pair('ready')
    setCloudBoxState(null)
    off()
    expect(seen).toEqual(['unknown', 'ready', null])
  })
})

describe('an older or hosting-off companion on the surfaces', () => {
  it('the picker frame is greyed with the update sentence, and offers no Settings fix', async () => {
    pair('needs_update')
    const def = (await getConfig()).hosts![CLOUD_BOX_HOST_ALIAS]
    const frame = hostStatusFrame(CLOUD_BOX_HOST_ALIAS, def as never)
    expect(frame.connected).toBe(false)
    expect(frame.phase).toBe('failed')
    expect(frame.kind).toBe('cloud_update')
    expect(frame.label).toBe('Cloud')
    // No SSH, probe or deploy steps on a host reached through the companion.
    expect(frame.steps.map((s) => s.phase)).toEqual(['tunnel', 'handshake'])
    const problem = hostProblemOf(frame as never)
    expect(problem?.type).toBe('connect')
    expect(problem && 'headline' in problem ? problem.headline : '').toBe('Cloud companion needs an update')
    const actions = hostActionsFor(problem, { surface: 'picker' })
    expect(actions).toEqual(['retry'])
  })

  it('hosting off reads as hosting off', async () => {
    pair('exec_off')
    const def = (await getConfig()).hosts![CLOUD_BOX_HOST_ALIAS]
    const frame = hostStatusFrame(CLOUD_BOX_HOST_ALIAS, def as never)
    expect(frame.kind).toBe('cloud_exec_off')
    expect(frame.error ?? '').toMatch(/^Cloud companion has session hosting turned off/)
  })

  it('offers no terminal (no SSH), in every state, while an SSH host keeps it', async () => {
    const idle = { connected: false, phase: 'idle', phaseElapsedMs: 0, connectElapsedMs: 0 } as never
    for (const cap of ['ready', 'needs_update', 'exec_off'] as const) {
      pair(cap)
      const def = (await getConfig()).hosts![CLOUD_BOX_HOST_ALIAS]
      expect(hostOffersTerminal(def as never)).toBe(false)
      expect(hostStatusFrame(CLOUD_BOX_HOST_ALIAS, def as never).terminal, cap).toBe(false)
      expect(buildHostStatus(CLOUD_BOX_HOST_ALIAS, def as never, idle, undefined, Date.now(), undefined, { off: true }).terminal).toBe(false)
    }
    const ssh = { hostname: 'devbox.example.com', label: 'Dev box' }
    expect(hostOffersTerminal(ssh)).toBe(true)
    expect(buildHostStatus('devbox', ssh, idle)).not.toHaveProperty('terminal')
    expect(buildHostStatus('devbox', ssh, idle, undefined, Date.now(), undefined, { off: true })).not.toHaveProperty('terminal')
  })

  it('the phone launch list offers Cloud only while the companion can host', async () => {
    const aliases = async () => (await computeLaunchOptions()).hosts.map((h) => h.alias)
    expect(await aliases()).not.toContain(CLOUD_BOX_HOST_ALIAS)
    pair('unknown')
    expect(await aliases()).toContain(CLOUD_BOX_HOST_ALIAS)
    pair('ready')
    const hosts = (await computeLaunchOptions()).hosts
    expect(hosts.find((h) => h.alias === CLOUD_BOX_HOST_ALIAS)?.label).toBe('Cloud')
    pair('needs_update')
    expect(await aliases()).not.toContain(CLOUD_BOX_HOST_ALIAS)
    pair('exec_off')
    expect(await aliases()).not.toContain(CLOUD_BOX_HOST_ALIAS)
  })
})
