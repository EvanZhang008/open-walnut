/**
 * A host's one Walnut service without a copy of the leader's data (src/core/host-server/copyless.ts
 * with manager.ts, experiment `service_without_copy`):
 *   - a host short of memory or disk, and one the person turned off, get the follower spec with
 *     WALNUT_COPIES=none, no exposed port and no copy target (the stream lane stays: its sessions'
 *     channel rides it), when the experiment is on;
 *   - with the experiment off, today's views stay: the gate shown, the switch off;
 *   - no build, this computer and a host whose Walnut is too old keep today's answer;
 *   - no notes, memory or skills copy goes to such a host (host-replica.ts hostKeepFor);
 *   - the host growing past the floors, or the experiment going off, takes it back.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createHostServerManager, type HostServerSettings } from '../../src/core/host-server/manager.js'
import { COPYLESS_CAPABILITY, noteCopyless, runsCopyless } from '../../src/core/host-server/copyless.js'
import { hostServerSettingsFrom } from '../../src/core/host-server/index.js'
import { hostKeepFor } from '../../src/core/host-replica.js'
import { defaultFollowerBench, FREE_SHORT, ROOMY, TURNED_ON } from '../helpers/host-server-default-bench.js'
import type { Config } from '../../src/core/types.js'

const b = defaultFollowerBench()
/** The switch the person turned off on a managed host (index.ts hostServerSettingsFrom). */
const TURNED_OFF: HostServerSettings = { ...TURNED_ON, enabled: false, turnedOff: true }
const DISK_SHORT = 'mem_total_kb=16777216\nmem_avail_kb=12582912\ndisk_free_kb=1048576\n'

afterEach(() => { noteCopyless('devbox', false) })

/** The bench's deps, the one service offered to the host unless a test says otherwise. */
const deps = (over: Parameters<typeof b.deps>[0]) => b.deps({ oneServiceRefused: async () => false, ...over })

function copylessHost(room = FREE_SHORT) {
  const h = b.host()
  h.room = room
  h.caps.add('replica-host-v1')
  h.caps.add(COPYLESS_CAPABILITY)
  return h
}

function withTarget() {
  const registered: string[] = []
  const unregistered: string[] = []
  return {
    registered, unregistered,
    registerTarget: (hostKey: string) => { registered.push(hostKey); return { ready: () => {}, unregister: () => { unregistered.push(hostKey) } } },
  }
}

describe('a host short of memory or disk', () => {
  it.each([['memory', FREE_SHORT], ['disk', DISK_SHORT]] as const)('runs the service without a copy (%s), with the experiment on', async (_why, room) => {
    const t = withTarget()
    const m = createHostServerManager(deps({ copylessWanted: async () => true, registerTarget: t.registerTarget as never }))
    const h = copylessHost(room)
    await m.connected(h)
    expect(m.view('devbox')).toMatchObject({ phase: 'running', copyless: true })
    expect(m.view('devbox').gate).toBeUndefined()
    const spec = h.specs.at(-1)!
    expect(spec.env.WALNUT_COPIES).toBe('none')
    expect(spec.settings?.expose ?? null).toBeNull()
    // Its sessions' channel to the Mac rides the stream lane: kept.
    expect(h.lane.at(-1)).toBe(true)
    expect(t.registered).toEqual([])
    expect(runsCopyless('devbox')).toBe(true)
    m.stop()
  })

  it('shows its gate as today with the experiment off', async () => {
    const m = createHostServerManager(deps({ copylessWanted: async () => false }))
    const h = copylessHost()
    await m.connected(h)
    expect(m.view('devbox')).toMatchObject({ phase: 'not-eligible', gate: { reason: 'memory' } })
    expect(m.view('devbox').copyless).toBeUndefined()
    expect(h.specs).toEqual([])
    expect(runsCopyless('devbox')).toBe(false)
    m.stop()
  })

  it('keeps the gate on a host whose Walnut is too old or not under the service launcher', async () => {
    const m = createHostServerManager(deps({ copylessWanted: async () => true }))
    const old = b.host()
    old.room = FREE_SHORT
    await m.connected(old)
    expect(m.view('devbox')).toMatchObject({ phase: 'not-eligible', gate: { reason: 'memory' } })
    m.stop()
    const m2 = createHostServerManager(deps({ copylessWanted: async () => true }))
    const bare = copylessHost()
    bare.underLauncher = () => false
    await m2.connected(bare)
    expect(m2.view('devbox')).toMatchObject({ phase: 'not-eligible', gate: { reason: 'memory' } })
    m2.stop()
  })

  it('no build for its system is not answered without a copy', async () => {
    const m = createHostServerManager(deps({ copylessWanted: async () => true }))
    const h = copylessHost()
    h.system = 'os=Linux\narch=armv7l\n'
    await m.connected(h)
    expect(m.view('devbox')).toMatchObject({ phase: 'not-eligible', gate: { reason: 'no-build' } })
    expect(m.view('devbox').copyless).toBeUndefined()
    m.stop()
  })

  it('goes back to a full follower once the host has room, and to its gate once the experiment is off', async () => {
    let on = true
    const t = withTarget()
    const m = createHostServerManager(deps({ copylessWanted: async () => on, registerTarget: t.registerTarget as never }))
    const h = copylessHost()
    await m.connected(h)
    expect(m.view('devbox').copyless).toBe(true)
    h.room = ROOMY
    await m.reconcile('devbox', { retry: true })
    expect(m.view('devbox')).toMatchObject({ phase: 'running' })
    expect(m.view('devbox').copyless).toBeUndefined()
    expect(h.specs.at(-1)!.env.WALNUT_COPIES).toBeUndefined()
    expect(t.registered).toEqual(['devbox'])
    expect(runsCopyless('devbox')).toBe(false)
    m.stop()
    // Another host's first start (a follower that ran is never judged by its own memory again).
    const fresh = b.deps()
    const m2 = createHostServerManager(deps({ copylessWanted: async () => on, stateFile: fresh.stateFile + '.2' }))
    const small = copylessHost()
    await m2.connected(small)
    expect(m2.view('devbox').copyless).toBe(true)
    on = false
    await m2.reconcile('devbox', { retry: true })
    expect(m2.view('devbox')).toMatchObject({ phase: 'not-eligible', gate: { reason: 'memory' } })
    expect(small.specs.at(-1)).toBeNull()
    expect(runsCopyless('devbox')).toBe(false)
    m2.stop()
  })
})

describe('a host the person turned off', () => {
  it('runs the service without a copy, its switch still off, with the experiment on', async () => {
    b.settings = TURNED_OFF
    const t = withTarget()
    const m = createHostServerManager(deps({ copylessWanted: async () => true, registerTarget: t.registerTarget as never }))
    const h = copylessHost(ROOMY)
    await m.connected(h)
    expect(m.view('devbox')).toMatchObject({ enabled: false, phase: 'running', copyless: true })
    expect(h.specs.at(-1)!.env.WALNUT_COPIES).toBe('none')
    expect(t.registered).toEqual([])
    m.stop()
  })

  it('stays off as today with the experiment off, or when it cannot run without a copy', async () => {
    b.settings = TURNED_OFF
    const m = createHostServerManager(deps({ copylessWanted: async () => false }))
    const h = copylessHost(ROOMY)
    await m.connected(h)
    expect(m.view('devbox')).toMatchObject({ enabled: false, phase: 'off' })
    expect(h.calls).not.toContain('room')
    m.stop()
    const m2 = createHostServerManager(deps({ copylessWanted: async () => true }))
    const old = b.host()
    await m2.connected(old)
    expect(m2.view('devbox')).toMatchObject({ enabled: false, phase: 'off' })
    expect(old.specs.filter(Boolean)).toEqual([])
    m2.stop()
  })

  it('a host that runs as this Walnut\'s one service already counts as under a launcher, whatever its hello says of one', async () => {
    b.settings = TURNED_OFF
    const m = createHostServerManager(deps({ copylessWanted: async () => true }))
    const served = copylessHost(ROOMY)
    served.underLauncher = () => false
    served.servesAs = () => ({ serves: 'walnut-serve', serviceHome: '/Users/me/.open-walnut' })
    await m.connected(served)
    expect(m.view('devbox')).toMatchObject({ enabled: false, copyless: true })
    expect(served.specs.at(-1)!.env.WALNUT_COPIES).toBe('none')
    m.stop()
  })

  it('stays off when the one service is not for this host (the launcher off, or its own service_offer: false)', async () => {
    b.settings = TURNED_OFF
    const asked: string[] = []
    const m = createHostServerManager(deps({ copylessWanted: async () => true, oneServiceRefused: async (k) => { asked.push(k); return true } }))
    const h = copylessHost(ROOMY)
    await m.connected(h)
    expect(asked).toEqual(['devbox'])
    expect(m.view('devbox')).toMatchObject({ enabled: false, phase: 'off' })
    expect(h.specs.filter(Boolean)).toEqual([])
    expect(runsCopyless('devbox')).toBe(false)
    m.stop()
  })

  it('stays off while the host\'s system is not known (the probe named none)', async () => {
    b.settings = TURNED_OFF
    const m = createHostServerManager(deps({ copylessWanted: async () => true }))
    const h = copylessHost(ROOMY)
    h.system = ''
    await m.connected(h)
    expect(m.view('devbox')).toMatchObject({ enabled: false, phase: 'off' })
    expect(h.specs.filter(Boolean)).toEqual([])
    m.stop()
  })

  it('stays off on this computer', async () => {
    b.settings = TURNED_OFF
    const m = createHostServerManager(deps({ copylessWanted: async () => true }))
    const h = copylessHost(ROOMY)
    h.reachesThisComputer = async () => true
    await m.connected(h)
    expect(m.view('devbox')).toMatchObject({ enabled: false, phase: 'off' })
    expect(h.specs.filter(Boolean)).toEqual([])
    m.stop()
  })

  it('a stored enabled:false on a host never on by default stays the plain off', () => {
    const managed = hostServerSettingsFrom({ enabled: false }, undefined, true)
    expect(managed).toMatchObject({ enabled: false, turnedOff: true })
    const unmanaged = hostServerSettingsFrom({ enabled: false }, undefined, false)
    expect(unmanaged.turnedOff).toBeUndefined()
  })
})

describe('no notes, memory or skills copy', () => {
  it('goes to a host that runs without a copy', () => {
    const config = { hosts: { devbox: {} } } as unknown as Config
    expect(hostKeepFor(config, 'devbox')).toMatchObject({ notes: true, memory: true, skills: true })
    noteCopyless('devbox', true)
    expect(hostKeepFor(config, 'devbox')).toEqual({ notes: false, notesExclude: [], memory: false, skills: false, attachments: false })
  })
})
