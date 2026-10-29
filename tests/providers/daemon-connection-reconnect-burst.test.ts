/**
 * What a reconnect to a remote host uploads in the link's first second
 * (DaemonConnection.setConnected, pushHostSlice, host-slice-pace.ts).
 *
 * 2026-10-28/29: 139 of 289 drops of one host's session link came within 3 s
 * of a reconnect (median 0.27 s). The link goes through a relay that drops the
 * whole SSH connection on an upload burst, and every reconnect sent, at once:
 * the skills (228 KB), the triggers (43 KB), the whole host copy (914 KB) when
 * the probe missed, the routine template (60 KB), then the notes and pictures
 * manifests (345 KB + 242 KB). A copy that never got through left the next
 * probe missing too, so the storm fed itself: 5 to 13 drops in a few minutes.
 *
 * Pinned here, with payloads the size the real builders made from the real data:
 * a reconnect to the same daemon process sends only what it lacks, and nothing
 * large in the link's first seconds; a new daemon process still gets everything;
 * a daemon without the probe or leader.configure gets the copy at once, as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

const KB = 1024
const big = (bytes: number) => 'x'.repeat(bytes)

const state = vi.hoisted(() => ({ sliceVersion: 0, replicaMemo: new Set<string>() }))

vi.mock('../../src/core/host-slice.js', () => ({
  ensureHostSliceSync: () => {},
  // Task churn: every build is a changed copy, so a fresh link's probe misses.
  buildHostSlice: async () => {
    state.sliceVersion++
    return {
      v: 1, home: '/home', host: 'devbox', sessions: [{ sid: 'sid-a' }],
      tasks: [{ id: 't', description: big(914 * KB) }], requests: [], boards: [], boardOf: {},
      hash: `h${state.sliceVersion}`, asOf: state.sliceVersion,
    }
  },
}))
vi.mock('../../src/core/offline-handover.js', () => ({ runOfflineHandover: async () => {} }))
vi.mock('../../src/core/skill-sync.js', () => ({
  buildSkillSyncPayload: async () => ({ hash: 'skills-1', skill: 'walnut', skills: [{ name: 'walnut', body: big(228 * KB) }] }),
}))
vi.mock('../../src/core/config-manager.js', () => ({ getConfig: async () => ({}) }))
vi.mock('../../src/core/hooks/daemon-hooks.js', () => ({ compileDaemonHooks: () => ({ hash: 'hooks-1', rules: [] }) }))
vi.mock('../../src/integrations/cloud-bridge-config.js', () => ({ getBridgeConfigForHost: async () => ({ enabled: false }) }))
vi.mock('../../src/core/routines/trigger-bridge.js', () => ({
  getTriggerPayloadProvider: () => async () => ({ hash: 'triggers-1', payload: { triggers: [{ id: 'a', script: big(43 * KB) }] } }),
}))
vi.mock('../../src/core/leader/primary-leader.js', () => ({
  configureHostLeader: async (o: { send: (cmd: string, p: Record<string, unknown>) => Promise<unknown> }) => {
    await o.send('leader.configure', { home: '/home' })
    return true
  },
}))
vi.mock('../../src/core/host-server/index.js', () => ({ hostServerConnected: async () => {}, hostServerDisconnected: async () => {} }))
vi.mock('../../src/providers/spawn-template.js', () => ({
  // As the real one: nothing goes when the daemon holds this hash.
  pushRoutineSpawnTemplate: async (host: { send: (cmd: string, p: Record<string, unknown>) => Promise<unknown> }, o: { unlessHash?: string | null }) => {
    if (o.unlessHash === 'tpl-1') return 'tpl-1'
    await host.send('leader.spawnTemplate', { use: 'routine', template: big(60 * KB) })
    return 'tpl-1'
  },
}))
// The host replica as the real one keeps it: a manifest goes once per memo, the memo ends with forgetHostReplica.
vi.mock('../../src/core/host-replica.js', () => ({
  forgetHostReplica: (hostKey: string) => { for (const k of [...state.replicaMemo]) if (k.startsWith(`${hostKey}:`)) state.replicaMemo.delete(k) },
  syncHostReplica: async (t: { hostKey: string; send: (cmd: string, p: Record<string, unknown>) => Promise<unknown> }) => {
    for (const [kind, bytes] of [['notes', 345 * KB], ['attachments', 242 * KB]] as const) {
      if (state.replicaMemo.has(`${t.hostKey}:${kind}`)) continue
      await t.send(kind === 'notes' ? 'replica.sync' : 'attachments.sync', { kind, entries: big(bytes) })
      state.replicaMemo.add(`${t.hostKey}:${kind}`)
    }
    return []
  },
}))

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { HOST_SLICE_FRESH_LINK_SETTLE_MS, freshLinkWaitMs } from '../../src/providers/host-slice-pace.js'

const ALL_CAPS = [
  'offline-host-v1', 'host-slice-probe-v1', 'leader-epoch-v1', 'skill-sync-v2', 'hooks-v1', 'triggers-v1',
  'host-replica-v1', 'attachment-copy-v1', 'replica-start-v1', 'clock-host-start-v1', 'clock-routine-v1',
]

interface Sent { cmd: string; bytes: number; at: number; whole?: boolean }

function host(caps = ALL_CAPS) {
  const conn = new DaemonConnection('devbox', { hostname: 'devbox' })
  const c = conn as unknown as Record<string, unknown>
  c._capabilities = caps
  const sent: Sent[] = []
  ;(conn as unknown as { send: unknown }).send = vi.fn(async (cmd: string, params: Record<string, unknown> = {}) => {
    sent.push({ cmd, bytes: JSON.stringify(params).length, at: Date.now(), ...(cmd === 'host.slice' ? { whole: params.slice !== undefined } : {}) })
    // The daemon holds an older copy than every build (task churn), so the probe misses.
    if (cmd === 'host.slice') return params.slice === undefined ? { ok: true, have: false } : { ok: true, changed: true }
    return { ok: true }
  })
  /** One link to the daemon process `instance` (its hello), up at the current clock. */
  const linkUp = (instance: string | null) => {
    c._daemonInstanceId = instance
    ;(conn as unknown as { setConnected(v: boolean): void }).setConnected(true)
  }
  const linkDown = () => (conn as unknown as { setConnected(v: boolean): void }).setConnected(false)
  return { conn, sent, linkUp, linkDown }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

const bytesBetween = (sent: Sent[], from: number, to: number) => sent.filter((s) => s.at >= from && s.at < to).reduce((a, s) => a + s.bytes, 0)
const cmds = (sent: Sent[], from = 0) => sent.filter((s) => s.at >= from).map((s) => (s.cmd === 'host.slice' ? (s.whole ? 'host.slice:whole' : 'host.slice:probe') : s.cmd))

describe('a reconnect does not upload a burst in the link\'s first seconds', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    state.sliceVersion = 0
    state.replicaMemo.clear()
  })
  afterEach(() => { vi.useRealTimers() })

  it('reconnecting to the same daemon process sends under 64 KB in its first second, and the copy after the link settled', async () => {
    const { sent, linkUp, linkDown } = host()
    linkUp('d-1')
    await settle()
    await vi.advanceTimersByTimeAsync(HOST_SLICE_FRESH_LINK_SETTLE_MS + 1_000)
    await settle()
    // The first link gave this daemon everything once.
    expect(cmds(sent)).toEqual(expect.arrayContaining(['skills.sync', 'host.slice:whole', 'leader.spawnTemplate', 'replica.sync', 'attachments.sync']))

    // The relay drops the link; the same daemon process answers the next one.
    await vi.advanceTimersByTimeAsync(60_000)
    linkDown()
    await settle()
    const at = Date.now()
    linkUp('d-1')
    await settle()
    await vi.advanceTimersByTimeAsync(1_000)
    await settle()
    // Before: skills 228 KB + whole copy 914 KB + template 60 KB + manifests 587 KB in the first second.
    expect(bytesBetween(sent, at, at + 1_000)).toBeLessThan(64 * KB)
    expect(cmds(sent, at)).not.toContain('skills.sync')
    expect(cmds(sent, at)).not.toContain('host.slice:whole')
    expect(cmds(sent, at)).not.toContain('leader.spawnTemplate')
    expect(cmds(sent, at)).toContain('host.slice:probe')
    // The socket is bound without the copy (leader.configure binds it on the daemon).
    expect(cmds(sent, at)).toContain('leader.configure')

    // Once the link has been up for the settle window, the changed copy goes, once.
    await vi.advanceTimersByTimeAsync(HOST_SLICE_FRESH_LINK_SETTLE_MS)
    await settle()
    expect(cmds(sent, at).filter((c) => c === 'host.slice:whole')).toHaveLength(1)
    expect(sent.find((s) => s.whole && s.at >= at)!.at - at).toBeGreaterThanOrEqual(HOST_SLICE_FRESH_LINK_SETTLE_MS)
    // The daemon process still holds the manifests it was sent: none go again.
    expect(cmds(sent, at)).not.toContain('replica.sync')
    expect(cmds(sent, at)).not.toContain('attachments.sync')
  })

  it('a storm of links dropping within a second sends no whole copy at all, then one when a link holds', async () => {
    const { sent, linkUp, linkDown } = host()
    linkUp('d-1')
    await settle()
    await vi.advanceTimersByTimeAsync(HOST_SLICE_FRESH_LINK_SETTLE_MS + 1_000)
    await settle()
    const start = Date.now()
    for (let i = 0; i < 5; i++) {
      linkDown()
      await settle()
      await vi.advanceTimersByTimeAsync(4_000)
      linkUp('d-1')
      await settle()
      await vi.advanceTimersByTimeAsync(800)
      await settle()
    }
    expect(cmds(sent, start).filter((c) => c === 'host.slice:whole')).toHaveLength(0)
    expect(bytesBetween(sent, start, Date.now())).toBeLessThan(5 * 64 * KB)
    await vi.advanceTimersByTimeAsync(HOST_SLICE_FRESH_LINK_SETTLE_MS)
    await settle()
    expect(cmds(sent, start).filter((c) => c === 'host.slice:whole')).toHaveLength(1)
  })

  it('a new daemon process gets the skills, the template and the manifests again', async () => {
    const { sent, linkUp, linkDown } = host()
    linkUp('d-1')
    await settle()
    await vi.advanceTimersByTimeAsync(HOST_SLICE_FRESH_LINK_SETTLE_MS + 1_000)
    await settle()
    linkDown()
    await settle()
    const at = Date.now()
    linkUp('d-2')
    await settle()
    // It never had a copy of ours: everything goes at once, so it can answer if the Mac goes now.
    await vi.advanceTimersByTimeAsync(500)
    await settle()
    expect(cmds(sent, at)).toEqual(expect.arrayContaining(['skills.sync', 'host.slice:whole', 'leader.spawnTemplate', 'replica.sync', 'attachments.sync']))
  })

  it('the first link to a daemon gets the whole copy and the manifests at once', async () => {
    const { sent, linkUp } = host()
    const at = Date.now()
    linkUp('d-1')
    await settle()
    await vi.advanceTimersByTimeAsync(500)
    await settle()
    expect(cmds(sent, at)).toEqual(expect.arrayContaining(['host.slice:probe', 'host.slice:whole', 'replica.sync', 'attachments.sync']))
  })

  it('a daemon that names no instance is treated as new on every link', async () => {
    const { sent, linkUp, linkDown } = host()
    linkUp(null)
    await settle()
    linkDown()
    await settle()
    const at = Date.now()
    linkUp(null)
    await settle()
    expect(cmds(sent, at)).toContain('skills.sync')
  })

  it('a daemon without the probe, or without leader.configure, gets the whole copy at once (it binds only on a copy)', async () => {
    for (const drop of ['host-slice-probe-v1', 'leader-epoch-v1']) {
      const { sent, linkUp } = host(ALL_CAPS.filter((c) => c !== drop))
      linkUp('d-1')
      await settle()
      expect(cmds(sent)).toContain('host.slice:whole')
    }
  })

  it('the settle wait: none for an unknown or old link, the rest of the window for a new one', () => {
    expect(freshLinkWaitMs(0, 5_000)).toBe(0)
    expect(freshLinkWaitMs(1_000, 1_000)).toBe(HOST_SLICE_FRESH_LINK_SETTLE_MS)
    expect(freshLinkWaitMs(1_000, 1_000 + HOST_SLICE_FRESH_LINK_SETTLE_MS)).toBe(0)
    expect(freshLinkWaitMs(1_000, 6_000, 10_000)).toBe(5_000)
  })
})
