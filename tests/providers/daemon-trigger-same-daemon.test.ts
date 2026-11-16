/**
 * Two host aliases of ONE daemon push one trigger set (sameDaemonHosts, daemon-connection.ts).
 *
 * The daemon keeps one armed set per Walnut, whichever socket pushed it. 2026-11-15: a machine
 * joined the host network as `<name>-net` beside its SSH row; both links reached the same daemon
 * process, and the net link's push of its own (empty) set replaced the SSH row's 78 triggers.
 *
 * Each way the server knows two aliases are one daemon is pinned here, all from the daemon's own
 * word (the instance id its hello gives), never a hostname:
 *   - both links up on the same process;
 *   - one link down, its last hello from that same process;
 *   - a pair recorded in the host profiles (same-daemon-record.ts): the daemon restarted and one
 *     link is back, or a server that just started has only one link up, in either order;
 * and the ways it must NOT join them: two daemons, two processes both up (the record is
 * dropped), and a row that now connects somewhere else (the record is void).
 *
 * Real layer: real DaemonConnections over real WebSockets to MockDaemon, in the real pool, with
 * a temp Walnut home (config and host profiles). The set compiler is a stand-in that builds the
 * set from `sameDaemon` as compileTriggersForHost does (its own union:
 * tests/core/routines/trigger-push-same-daemon.test.ts).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-trigger-same-daemon'))

import { MockDaemon } from '../helpers/mock-daemon.js'
import { DaemonConnection, pushTriggersToHost, sameDaemonHosts, setPooledConnectionForTest } from '../../src/providers/daemon-connection.js'
import { setTriggerPayloadProvider, type TriggerPayloadProvider } from '../../src/core/routines/trigger-bridge.js'
import { updateConfig, getConfig } from '../../src/core/config-manager.js'
import { linkTarget } from '../../src/core/hosts/link.js'
import { HOST_PROFILES_DIR, readHostProfile } from '../../src/core/hosts/host-profile.js'
import { __setSshResolverForTest, _resetSameDaemonRecordForTest } from '../../src/core/hosts/same-daemon-record.js'

const NET_KEY = 'b'.repeat(64)
/** What `ssh -G <name>` answers, by name (no real ~/.ssh): each name resolves to itself unless set here. */
let sshConfig: Record<string, string>

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const until = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > until) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** The triggers each alias owns, as the cron store would have them. */
let owned: Record<string, string[]>
/** Every compile: the alias it ran for, and the aliases it was told share the daemon. */
let compiles: Array<{ host: string; sameDaemon: readonly string[] }>
/** Holds the next compile for this alias until released (a slow compile racing a sibling's push). */
let holdNext: { host: string; release: () => void; go: () => void } | null

const provider: TriggerPayloadProvider = async (host, opts) => {
  const sameDaemon = opts?.sameDaemon ?? [host]
  compiles.push({ host, sameDaemon })
  // Read before any hold: a held compile sends the view it took then, as a slow real one would.
  const ids = [...new Set(sameDaemon.flatMap((h) => owned[h] ?? []))].sort()
  if (holdNext?.host === host) {
    const hold = holdNext
    holdNext = null
    await new Promise<void>((resolve) => { hold.release = resolve; hold.go() })
  }
  return {
    payload: { version: 1, triggers: ids.map((id) => ({ id, name: id, everyMs: 300_000, check: { run: 'true' } })) },
    hash: `set:${ids.join(',')}`,
  }
}

/** Arrange for the next compile for `host` to wait; resolves once that compile has started. */
function holdCompile(host: string): { started: Promise<void>; release: () => void } {
  let go!: () => void
  const started = new Promise<void>((r) => { go = r })
  const hold = { host, release: () => {}, go }
  holdNext = hold
  return { started, release: () => hold.release() }
}

describe('two aliases of one daemon push one trigger set', () => {
  let daemon: MockDaemon
  let other: MockDaemon | null = null
  const conns: Array<{ host: string; conn: DaemonConnection }> = []

  beforeEach(async () => {
    owned = { studio: ['ssh-a', 'ssh-b', 'ssh-c'], 'studio-net': [] }
    compiles = []
    holdNext = null
    await fs.rm(HOST_PROFILES_DIR, { recursive: true, force: true })
    _resetSameDaemonRecordForTest()
    sshConfig = {}
    __setSshResolverForTest(async (name) => ({ hostname: sshConfig[name] ?? name, port: 22, user: 'me' }))
    await updateConfig({
      hosts: {
        studio: { hostname: 'studio.example' },
        'studio-net': { hostname: 'studio.walnut-net.invalid', transport: 'net', endpoint: NET_KEY },
        lab: { hostname: 'lab.example' },
      },
    } as never)
    setTriggerPayloadProvider(provider)
    daemon = new MockDaemon()
    daemon.enableTriggers()
    await daemon.start()
  })

  afterEach(async () => {
    dropAll()
    setTriggerPayloadProvider(null)
    __setSshResolverForTest(null)
    await daemon.stop()
    if (other) await other.stop()
    other = null
  })

  /** Every link goes and the pool forgets them: what a server that stops leaves behind. */
  function dropAll(): void {
    for (const { host, conn } of conns.splice(0)) {
      try { conn.disconnect() } catch { /* best effort */ }
      setPooledConnectionForTest(host, null)
    }
  }

  /** A pooled connection for `host`, as the real pool holds one per alias. */
  async function connect(host: string, to: MockDaemon = daemon): Promise<DaemonConnection> {
    const conn = new DaemonConnection(host, linkTarget(host, await getConfig()))
    conns.push({ host, conn })
    setPooledConnectionForTest(host, conn)
    await conn.connectDirect(`ws://127.0.0.1:${to.port}`)
    await conn.pushTriggersNow()
    await waitFor(() => conn.triggersPushed)
    return conn
  }

  /** The sets the daemon was sent whole (not a probe), as trigger id lists. */
  const setsSent = (d: MockDaemon = daemon) => d.getCommandHistoryFor('triggers.configure')
    .filter((c) => c.payload.probe !== true)
    .map((c) => ((c.payload.config as { triggers: Array<{ id: string }> }).triggers).map((t) => t.id))
  const probes = (d: MockDaemon = daemon) => d.getCommandHistoryFor('triggers.configure').filter((c) => c.payload.probe === true)
  const recorded = async (host: string) => Object.keys((await readHostProfile(host)).sameDaemon ?? {})

  it('the second alias to come up pushes the whole set, never its own empty one, and the first asks again', async () => {
    const ssh = await connect('studio')
    expect(setsSent()).toEqual([['ssh-a', 'ssh-b', 'ssh-c']])
    let rechecked = 0
    const recheck = ssh.recheckTriggers.bind(ssh)
    ssh.recheckTriggers = () => { rechecked++; recheck() }

    const net = await connect('studio-net')
    expect(await sameDaemonHosts('studio-net')).toEqual(['studio', 'studio-net'])
    expect(compiles.filter((c) => c.host === 'studio-net').every((c) => c.sameDaemon.join() === 'studio,studio-net')).toBe(true)
    // The net link's first push named the set the daemon already held: nothing crossed, nothing was disarmed.
    expect(setsSent()).toEqual([['ssh-a', 'ssh-b', 'ssh-c']])
    expect(probes().at(-1)?.payload.hash).toBe('set:ssh-a,ssh-b,ssh-c')
    // The SSH link did not trust the hash it sent last: it asked the daemon again.
    await waitFor(() => rechecked === 1)
    await ssh.pushTriggersNow()
    await net.pushTriggersNow()
    expect(setsSent().every((ids) => ids.length === 3)).toBe(true)
    // Both profiles record the pair, each side with what its row connects to.
    expect(await recorded('studio')).toEqual(['studio-net'])
    expect((await readHostProfile('studio-net')).sameDaemon?.studio).toMatchObject({ self: `net:${NET_KEY}`, other: JSON.stringify(['ssh', 'me', 'studio.example', '22']) })
  })

  it('a dense armed set stays whole when an empty sibling connects', async () => {
    owned.studio = Array.from({ length: 100 }, (_, i) => `watch-${i.toString().padStart(3, '0')}`)
    await connect('studio')
    const net = await connect('studio-net')
    await net.pushTriggersNow()
    expect(setsSent().every((ids) => ids.length === 100)).toBe(true)
    owned['studio-net'] = ['net-a']
    pushTriggersToHost('studio-net')
    await waitFor(() => setsSent().some((ids) => ids.length === 101))
    expect(setsSent().at(-1)).toEqual(['net-a', ...owned.studio])
  })

  it('a routine of the net alias changes: the set that goes still carries every SSH trigger', async () => {
    await connect('studio')
    await connect('studio-net')
    owned['studio-net'] = ['net-a']
    pushTriggersToHost('studio-net')
    await waitFor(() => setsSent().some((ids) => ids.includes('net-a')))
    expect(setsSent().at(-1)).toEqual(['net-a', 'ssh-a', 'ssh-b', 'ssh-c'])
  })

  it('a push compiled while a sibling is mid-push waits for it, and compiles after it, not before', async () => {
    const ssh = await connect('studio')
    const net = await connect('studio-net')
    // The SSH link's recheck for the net link's arrival is done.
    await new Promise((r) => setTimeout(r, 100))
    await ssh.pushTriggersNow()
    owned['studio-net'] = ['net-a']
    const held = holdCompile('studio-net')
    const netPush = net.pushTriggersNow()
    await held.started
    // The SSH alias changes meanwhile: its push may not compile, let alone send, inside the net link's turn.
    owned.studio = ['ssh-a', 'ssh-b', 'ssh-c', 'ssh-d']
    const before = compiles.length
    const sshPush = ssh.pushTriggersNow()
    await new Promise((r) => setTimeout(r, 200))
    expect(compiles.length).toBe(before)
    held.release()
    await Promise.all([netPush, sshPush])
    // The net link's set (compiled before the change) went first, then the SSH link compiled anew:
    // the last set the daemon holds is the newest view, not the stale one sent late.
    expect(compiles.slice(before).map((c) => c.host)).toEqual(['studio'])
    expect(setsSent().at(-1)).toEqual(['net-a', 'ssh-a', 'ssh-b', 'ssh-c', 'ssh-d'])
  })

  it('a compile interrupted by disconnect never writes its old set after a new link connects', async () => {
    const ssh = await connect('studio')
    await connect('studio-net')
    await ssh.pushTriggersNow()
    owned.studio = ['old-watch']
    const held = holdCompile('studio')
    const oldPush = ssh.pushTriggersNow()
    await held.started
    ssh.disconnect()
    owned.studio = ['new-watch']
    const next = new DaemonConnection('studio', linkTarget('studio', await getConfig()))
    conns.push({ host: 'studio', conn: next })
    setPooledConnectionForTest('studio', next)
    await next.connectDirect(`ws://127.0.0.1:${daemon.port}`)
    const count = setsSent().length
    held.release()
    await oldPush
    await next.pushTriggersNow()
    expect(setsSent().slice(count).every((ids) => !ids.includes('old-watch'))).toBe(true)
    expect(setsSent().at(-1)).toEqual(['new-watch'])
  })

  it('one link down: the other keeps its triggers armed, and a change of the down alias still reaches the daemon', async () => {
    const ssh = await connect('studio')
    await connect('studio-net')
    ssh.disconnect()
    expect(await sameDaemonHosts('studio-net')).toEqual(['studio', 'studio-net'])
    owned.studio = ['ssh-a', 'ssh-b']
    // The routine is the SSH alias's, and its own link is down: the net link carries the change.
    pushTriggersToHost('studio')
    await waitFor(() => setsSent().some((ids) => ids.join() === 'ssh-a,ssh-b'))
    expect(setsSent().at(-1)).toEqual(['ssh-a', 'ssh-b'])
  })

  it('after a restart of that daemon, the first link back keeps the other alias in its set', async () => {
    const ssh = await connect('studio')
    const net = await connect('studio-net')
    ssh.disconnect()
    net.disconnect()
    daemon.newProcess()
    owned['studio-net'] = ['net-a']
    await net.connectDirect(`ws://127.0.0.1:${daemon.port}`)
    await net.pushTriggersNow()
    expect(net.daemonInstanceId).toBe(daemon.instanceId)
    expect(ssh.daemonInstanceId).not.toBe(daemon.instanceId)
    expect(await sameDaemonHosts('studio-net')).toEqual(['studio', 'studio-net'])
    await waitFor(() => setsSent().some((ids) => ids.includes('net-a')))
    expect(setsSent().at(-1)).toEqual(['net-a', 'ssh-a', 'ssh-b', 'ssh-c'])
  })

  for (const back of ['studio-net', 'studio'] as const) {
    it(`a server that just started, with only ${back} back, pushes every alias's triggers from the record`, async () => {
      await connect('studio')
      await connect('studio-net')
      expect(await recorded('studio')).toEqual(['studio-net'])
      // The server goes: every link and the whole pool with it. The new one knows only the record.
      dropAll()
      _resetSameDaemonRecordForTest()
      daemon.newProcess()
      owned['studio-net'] = ['net-a']
      daemon.clearCommandHistory()
      const conn = await connect(back)
      expect(await sameDaemonHosts(back)).toEqual(['studio', 'studio-net'])
      expect(compiles.at(-1)?.sameDaemon).toEqual(['studio', 'studio-net'])
      expect(setsSent().length).toBeGreaterThan(0)
      expect(setsSent().every((ids) => ids.join() === 'net-a,ssh-a,ssh-b,ssh-c')).toBe(true)
      // The other link never comes back: nothing ever disarms its triggers.
      await conn.pushTriggersNow()
      expect(setsSent().every((ids) => ids.includes('ssh-a'))).toBe(true)
    })
  }

  it('a row that now connects somewhere else voids the record', async () => {
    await connect('studio')
    await connect('studio-net')
    dropAll()
    await updateConfig({ hosts: { studio: { hostname: 'elsewhere.example' }, 'studio-net': { hostname: 'studio.walnut-net.invalid', transport: 'net', endpoint: NET_KEY } } } as never)
    daemon.clearCommandHistory()
    await connect('studio-net')
    expect(await sameDaemonHosts('studio-net')).toEqual(['studio-net'])
    expect(setsSent()).toEqual([[]])
  })

  it('a HostName changed in ~/.ssh/config, with the row as it was, voids the record too', async () => {
    await connect('studio')
    await connect('studio-net')
    dropAll()
    _resetSameDaemonRecordForTest()
    sshConfig['studio.example'] = 'another-box.example'
    daemon.clearCommandHistory()
    await connect('studio-net')
    expect(await sameDaemonHosts('studio-net')).toEqual(['studio-net'])
    expect(setsSent()).toEqual([[]])
  })

  it('a down link with a cached matching process cannot re-record a changed target', async () => {
    const ssh = await connect('studio')
    const net = await connect('studio-net')
    ssh.disconnect()
    await updateConfig({ hosts: { studio: { hostname: 'elsewhere.example' }, 'studio-net': { hostname: 'studio.walnut-net.invalid', transport: 'net', endpoint: NET_KEY } } } as never)
    expect(ssh.daemonInstanceId).toBe(net.daemonInstanceId)
    expect(ssh.liveInstanceId).toBeNull()
    expect(await sameDaemonHosts('studio-net')).toEqual(['studio-net'])
    expect((await readHostProfile('studio-net')).sameDaemon?.studio?.other).toBe(JSON.stringify(['ssh', 'me', 'studio.example', '22']))
  })

  it('editing an online link target never persists a pair for a machine that link did not dial', async () => {
    await connect('studio')
    await connect('studio-net')
    await updateConfig({ hosts: { studio: { hostname: 'elsewhere.example' }, 'studio-net': { hostname: 'studio.walnut-net.invalid', transport: 'net', endpoint: NET_KEY } } } as never)
    // Both sockets still name the same process, but their config now says two targets.
    await sameDaemonHosts('studio-net')
    expect((await readHostProfile('studio-net')).sameDaemon?.studio?.other).toBe(JSON.stringify(['ssh', 'me', 'studio.example', '22']))
    dropAll()
    daemon.clearCommandHistory()
    await connect('studio-net')
    expect(await sameDaemonHosts('studio-net')).toEqual(['studio-net'])
  })

  it('three aliases seen in overlapping pairs all return when only the first link comes back', async () => {
    const a = await connect('studio')
    await connect('studio-net')
    a.disconnect()
    owned.lab = ['lab-a']
    const c = await connect('lab')
    expect(await c.helloTargetIdentity()).toBe(JSON.stringify(['ssh', 'me', 'lab.example', '22']))
    expect(await recorded('lab')).toEqual(['studio-net'])
    dropAll()
    _resetSameDaemonRecordForTest()
    daemon.newProcess()
    daemon.clearCommandHistory()
    await connect('studio')
    expect(await sameDaemonHosts('studio')).toEqual(['lab', 'studio', 'studio-net'])
    // The daemon may still hold that exact set, so the cold link can probe rather than resend it.
    expect(probes().at(-1)?.payload.hash).toBe('set:lab-a,ssh-a,ssh-b,ssh-c')
    expect(setsSent().every((ids) => ids.join() === 'lab-a,ssh-a,ssh-b,ssh-c')).toBe(true)
  })

  it('a changed intermediate target breaks the transitive relation', async () => {
    const a = await connect('studio')
    await connect('studio-net')
    a.disconnect()
    await connect('lab')
    dropAll()
    await updateConfig({ hosts: { studio: { hostname: 'studio.example' }, 'studio-net': { hostname: 'studio.walnut-net.invalid', transport: 'net', endpoint: 'a'.repeat(64) }, lab: { hostname: 'lab.example' } } } as never)
    await connect('studio')
    expect(await sameDaemonHosts('studio')).toEqual(['studio'])
  })

  it('a failed hello after reconnect never confirms the cached process on the new link', async () => {
    const ssh = await connect('studio')
    await connect('studio-net')
    expect(ssh.liveInstanceId).toBe(daemon.instanceId)
    ssh.disconnect()
    const old = ssh.daemonInstanceId
    ;(ssh as unknown as { _sendHandshake: () => Promise<unknown> })._sendHandshake = async () => ({ ok: false })
    await ssh.connectDirect(`ws://127.0.0.1:${daemon.port}`)
    expect(ssh.daemonInstanceId).toBe(old)
    expect(ssh.liveInstanceId).toBeNull()
  })

  it('an SSH name ssh cannot resolve is never recorded', async () => {
    __setSshResolverForTest(async () => null)
    await connect('studio')
    await connect('studio-net')
    // Joined while both are up on one process, as always; nothing is written to trust later.
    expect(await sameDaemonHosts('studio-net')).toEqual(['studio', 'studio-net'])
    expect(await recorded('studio')).toEqual([])
    expect(await recorded('studio-net')).toEqual([])
  })

  it('two daemons never share a set', async () => {
    other = new MockDaemon()
    other.enableTriggers()
    await other.start()
    owned = { studio: ['ssh-a'], lab: ['lab-a'] }
    await connect('studio')
    await connect('lab', other)
    expect(await sameDaemonHosts('studio')).toEqual(['studio'])
    expect(await sameDaemonHosts('lab')).toEqual(['lab'])
    expect(setsSent()).toEqual([['ssh-a']])
    expect(setsSent(other)).toEqual([['lab-a']])
    expect(await recorded('studio')).toEqual([])
  })

  it('a recorded pair up on two different processes is refused and dropped', async () => {
    const ssh = await connect('studio')
    const net = await connect('studio-net')
    expect(await recorded('studio')).toEqual(['studio-net'])
    other = new MockDaemon()
    other.enableTriggers()
    await other.start()
    net.disconnect()
    await net.connectDirect(`ws://127.0.0.1:${other.port}`)
    await net.pushTriggersNow()
    expect(ssh.connected && net.connected).toBe(true)
    expect(await sameDaemonHosts('studio-net')).toEqual(['studio-net'])
    expect(await sameDaemonHosts('studio')).toEqual(['studio'])
    await waitFor(async () => (await recorded('studio')).length === 0 && (await recorded('studio-net')).length === 0)
  })

  it('an alias with no instance id and no record is its alias alone, as before', async () => {
    expect(await sameDaemonHosts('nowhere')).toEqual(['nowhere'])
  })
})
