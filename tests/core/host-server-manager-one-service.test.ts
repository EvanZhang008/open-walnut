/**
 * The host-server manager (src/core/host-server/manager.ts) and a host's one Walnut service
 * (src/providers/one-service-mode.ts):
 *   - followerFact: what the leader's offer of the service reads (the full follower running, none
 *     and why, or not settled yet);
 *   - a host whose hello says it is this Walnut's service gets no separate follower app: the build
 *     is not sent, the spec of the program kept as working is sent as it is, and the status is read
 *     over the same server.status;
 *   - another Walnut's service on the host changes nothing for this Walnut's own follower;
 *   - each settled reconcile tells the connection, so a switch that is due runs then.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createHostServerManager, type HostServerSettings, type ManagerDeps } from '../../src/core/host-server/manager.js'
import { NoHostFile, type HostFile, type HostFileSource } from '../../src/core/host-server/host-file.js'
import { fakeHost as makeFakeHost, type FakeHost } from '../helpers/host-server-fake-host.js'

const HOME = '/Users/me/.open-walnut'
let dir = ''
let settings: HostServerSettings
let follower: http.Server
let followerPort = 0
let fileAsks: string[] = []
let buildId = '0.6.7-abc1234'

function files(): HostFileSource {
  return {
    buildId: async () => ({ id: buildId, version: buildId.split('-')[0]!, commit: buildId.split('-')[1]! }),
    file: async (target) => {
      fileAsks.push(target)
      return { id: buildId, version: buildId.split('-')[0]!, commit: buildId.split('-')[1]!, target, gz: Buffer.alloc(1024), sha256: 'c'.repeat(64), gzSha256: 'd'.repeat(64) } satisfies HostFile
    },
  }
}

function deps(over: Partial<ManagerDeps> = {}): ManagerDeps {
  return {
    settingsOf: async () => settings,
    label: async () => 'Dev box',
    walnutId: async () => 'wmac01',
    home: HOME,
    holdTunnelPort: async () => 5555,
    releaseTunnelPort: async () => {},
    hostFile: files(),
    stateFile: path.join(dir, 'host-servers.json'),
    now: Date.now,
    installPollMs: 1,
    pollMs: 60_000,
    servingSince: 0,
    ...over,
  }
}

type ServiceHost = FakeHost & { serves: { serves: 'daemon' | 'walnut-serve'; serviceHome: string | null }; modeChecks: number }
function host(): ServiceHost {
  const h = makeFakeHost({ followerPort: () => followerPort }) as ServiceHost
  h.caps.add('replica-host-v1')
  h.serves = { serves: 'daemon', serviceHome: null }
  h.modeChecks = 0
  h.servesAs = () => h.serves
  h.serviceModeChanged = () => { h.modeChecks++ }
  return h
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-one-'))
  settings = { enabled: true, expose: { enabled: false, provider: null, options: {} } }
  fileAsks = []
  buildId = '0.6.7-abc1234'
  follower = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}') }) })
  await new Promise<void>((r) => follower.listen(0, '127.0.0.1', () => r()))
  followerPort = (follower.address() as net.AddressInfo).port
})
afterEach(() => {
  follower.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the follower fact the one Walnut service reads', () => {
  it('unknown before a reconcile, the full follower once it runs, and the connection is told', async () => {
    const m = createHostServerManager(deps())
    expect(m.followerFact('devbox')).toEqual({ kind: 'unknown' })
    const h = host()
    await m.connected(h)
    expect(m.view('devbox')).toMatchObject({ phase: 'running', program: 'replica' })
    expect(m.followerFact('devbox')).toEqual({ kind: 'replica' })
    expect(h.modeChecks).toBe(1)
  })

  it('none, with the reason, for a host turned off, the plain host server, or a fallback', async () => {
    const m = createHostServerManager(deps())
    const h = host()
    settings = { ...settings, program: 'host-server' }
    await m.connected(h)
    expect(m.followerFact('devbox')).toMatchObject({ kind: 'none', why: expect.stringMatching(/plain host server/) })
    settings = { ...settings, program: 'replica' }
    await m.reconcile('devbox')
    h.statusExtra = { program: 'fallback' }
    await m.reconcile('devbox')
    expect(m.followerFact('devbox')).toMatchObject({ kind: 'none', why: expect.stringMatching(/fallback/) })
    settings = { ...settings, enabled: false }
    await m.reconcile('devbox')
    expect(m.followerFact('devbox')).toMatchObject({ kind: 'none', why: expect.stringMatching(/no Walnut server/) })
  })

  it('a setup still under way is not settled', async () => {
    const m = createHostServerManager(deps())
    const h = host()
    let release!: () => void
    h.gate = new Promise<void>((r) => { release = r })
    const run = m.connected(h)
    await vi.waitFor(() => expect(m.view('devbox').phase).toBe('installing'))
    expect(m.followerFact('devbox')).toEqual({ kind: 'unknown' })
    release()
    await run
  })
})

describe('a host that runs as this Walnut\'s one service', () => {
  it('gets no follower app of its own: a newer build is not sent, the kept spec goes as it is, status as before', async () => {
    const m = createHostServerManager(deps())
    const h = host()
    await m.connected(h)
    const first = h.specs.at(-1)!
    expect(fileAsks).toHaveLength(1)
    // The leader switched the host; this Mac then has a newer build, which the service already is.
    h.serves = { serves: 'walnut-serve', serviceHome: HOME }
    buildId = '0.6.8-def5678'
    const uploads = h.uploads.length
    await m.reconcile('devbox')
    expect(fileAsks).toHaveLength(1)
    expect(h.uploads.length).toBe(uploads)
    expect(h.specs.at(-1)).toEqual(first)
    expect(h.calls.filter((c) => c === 'prune')).toHaveLength(1)
    expect(m.view('devbox')).toMatchObject({ phase: 'running', program: 'replica' })
    expect(h.calls.at(-1)).toBe('send server.status')
  })

  it('another Walnut\'s service changes nothing for this Walnut\'s own follower there', async () => {
    const m = createHostServerManager(deps())
    const h = host()
    await m.connected(h)
    h.serves = { serves: 'walnut-serve', serviceHome: '/home/other/.open-walnut' }
    buildId = '0.6.8-def5678'
    await m.reconcile('devbox')
    // The newer build is configured for this Walnut's own follower, as on any host.
    expect(h.specs.at(-1)!.command).toContain('0.6.8-def5678')
  })

  it('with no program kept as working there (an older record), it is set up as before', async () => {
    const m = createHostServerManager(deps())
    const h = host()
    h.serves = { serves: 'walnut-serve', serviceHome: HOME }
    await m.connected(h)
    expect(fileAsks).toHaveLength(1)
    expect(m.view('devbox').phase).toBe('running')
  })
})

describe('another name of a daemon kept under another name', () => {
  function alias(keeper: string): ServiceHost {
    const h = host()
    h.hostKey = 'newbox'
    h.daemonKeeper = async () => keeper
    return h
  }

  it('reads its keeper\'s follower, never its own "another name" view, and hears when the keeper settles', async () => {
    const m = createHostServerManager(deps())
    // The name is linked first: the keeper has not settled, so the machine's mode is not known.
    const other = alias('devbox')
    await m.connected(other)
    expect(m.view('newbox')).toMatchObject({ phase: 'not-eligible', gate: { reason: 'another-name' } })
    expect(m.followerFact('newbox')).toEqual({ kind: 'unknown' })
    const keeper = host()
    await m.connected(keeper)
    expect(m.followerFact('devbox')).toEqual({ kind: 'replica' })
    expect(m.followerFact('newbox')).toEqual({ kind: 'replica' })
    expect(other.modeChecks).toBeGreaterThan(0)
    // The keeper's server goes off: the name reads that too.
    settings = { ...settings, enabled: false }
    await m.reconcile('devbox')
    expect(m.followerFact('newbox')).toMatchObject({ kind: 'none', why: expect.stringMatching(/no Walnut server/) })
  })

  it('reads its own follower again once it is no longer another name', async () => {
    const m = createHostServerManager(deps())
    const keeper = host()
    await m.connected(keeper)
    const other = alias('devbox')
    await m.connected(other)
    expect(m.followerFact('newbox')).toEqual({ kind: 'replica' })
    other.daemonKeeper = async () => 'newbox'
    settings = { ...settings, enabled: false }
    await m.reconcile('newbox')
    expect(m.followerFact('newbox')).toMatchObject({ kind: 'none', why: expect.stringMatching(/no Walnut server/) })
  })

  it('keeps its keeper while its link is down or the daemon\'s answer fails', async () => {
    const m = createHostServerManager(deps())
    const keeper = host()
    await m.connected(keeper)
    const other = alias('devbox')
    await m.connected(other)
    expect(m.followerFact('newbox')).toEqual({ kind: 'replica' })
    // The ask fails: the last keeper holds.
    other.daemonKeeper = async () => { throw new Error('link lost') }
    await m.reconcile('newbox')
    expect(m.followerFact('newbox')).toEqual({ kind: 'replica' })
    // The link drops and a config change reconciles every host (this name off by default).
    other.daemonKeeper = async () => 'devbox'
    other.connected = false
    settings = { ...settings, enabled: false }
    await m.reconcile('newbox')
    expect(m.followerFact('newbox')).toEqual({ kind: 'replica' })
  })

  it('every gate reason is classified: of the machine (its own view) or of a name (the keeper\'s follower)', () => {
    // A new reason fails here until it is placed: one that is about the name, not the machine, must
    // read the keeper's follower in followerFact, or the machine's one service is switched back.
    const src = fs.readFileSync(path.join(__dirname, '../../src/core/host-server/eligibility.ts'), 'utf8')
    const union = /export type FollowerGateReason = ([^\n]+)/.exec(src)![1]!
    const reasons = [...union.matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()
    const classified: Record<string, 'machine' | 'name'> = {
      'no-build': 'machine', memory: 'machine', disk: 'machine', 'this-computer': 'machine', 'another-name': 'name',
    }
    expect(reasons).toEqual(Object.keys(classified).sort())
    const manager = fs.readFileSync(path.join(__dirname, '../../src/core/host-server/manager.ts'), 'utf8')
    for (const [reason, kind] of Object.entries(classified)) {
      if (kind !== 'name') continue
      // The branch that raises a name's gate records the keeper first.
      const at = manager.indexOf(`notEligible(hostKey, '${reason}'`)
      expect(at, reason).toBeGreaterThan(0)
      const block = manager.slice(manager.lastIndexOf('if (', at), at)
      expect(block, reason).toContain('keeperOf.set(hostKey')
    }
  })
})

describe('a failure never takes down a host that runs as this Walnut\'s one service', () => {
  // 2026-11-24: a host on by default ran as this Walnut's one service over a link losing a third of its
  // packets. A reconnect's first report came after the minute, the failed setup's takeDown removed the
  // follower spec, the service restarted as the plain daemon, and only a daemon update (held there)
  // could switch it back: the host ran as two programs for the rest of the day.
  const onByDefault = (): HostServerSettings => ({ enabled: true, byDefault: true, expose: { enabled: false, provider: null, options: {} } })
  const removed = (h: FakeHost) => h.specs.filter((s) => s === null).length

  /** A host set up as a follower, then switched to this Walnut's one service (the record keeps the working program). */
  async function servingHost(): Promise<ServiceHost> {
    const h = host()
    await createHostServerManager(deps()).connected(h)
    expect(h.specs).toHaveLength(1)
    h.serves = { serves: 'walnut-serve', serviceHome: HOME }
    settings = onByDefault()
    return h
  }

  it('a first report that comes after the minute leaves the service running, and its late report shows as running', async () => {
    const h = await servingHost()
    h.reports = false
    const m = createHostServerManager(deps({ firstReportMs: 30, pollMs: 20 }))
    await m.connected(h)
    expect(removed(h)).toBe(0)
    expect(m.view('devbox')).toMatchObject({ phase: 'error', message: expect.stringMatching(/left running.*tries again/s), retryAt: expect.any(Number) })
    expect(m.followerFact('devbox').kind).not.toBe('none')
    expect(h.lane).not.toContain(false)
    // The slow report arrives: the poll reads it, no new setup needed.
    h.reports = true
    await vi.waitFor(() => expect(m.view('devbox').phase).toBe('running'))
    expect(m.followerFact('devbox')).toEqual({ kind: 'replica' })
    expect(removed(h)).toBe(0)
    m.stop()
  })

  it('a configure lost on the link, after a restart here, leaves it running and reads it as the full follower', async () => {
    const h = await servingHost()
    const send = h.send.bind(h)
    h.send = async (cmd, params, ms) => {
      if (cmd === 'server.configure' && (params as { spec?: unknown })?.spec) throw new Error('daemon command timeout: server.configure (15000ms)')
      return send(cmd, params, ms)
    }
    const m = createHostServerManager(deps({ pollMs: 20 }))
    await m.connected(h)
    expect(removed(h)).toBe(0)
    expect(m.view('devbox').phase).not.toBe('off')
    await vi.waitFor(() => expect(m.view('devbox').phase).toBe('running'))
    expect(m.followerFact('devbox')).toEqual({ kind: 'replica' })
    m.stop()
  })

  it('the end of the ladder does not stop the checks for it', async () => {
    const h = await servingHost()
    h.reports = false
    const m = createHostServerManager(deps({ firstReportMs: 10, tryLaterMs: { failed: [5] } }))
    await m.connected(h)
    await vi.waitFor(() => expect(h.calls.filter((c) => c === 'send server.configure').length).toBeGreaterThanOrEqual(3))
    expect(m.view('devbox').message).not.toMatch(/stopped trying/)
    expect(removed(h)).toBe(0)
    m.stop()
  })

  it('a row that reaches this computer, itself the leading one service, is still this computer: nothing sent', async () => {
    // A leader that runs as its own one service says walnut-serve with its own home too (its in-process
    // daemon's hello), so the probe must still rule the row out, or the follower spec it got restarted
    // the leading service at every try (review of 93b40e398b).
    const h = host()
    h.serves = { serves: 'walnut-serve', serviceHome: HOME }
    h.reachesThisComputer = async () => true
    settings = onByDefault()
    const m = createHostServerManager(deps())
    await m.connected(h)
    expect(m.view('devbox')).toMatchObject({ phase: 'not-eligible', gate: { reason: 'this-computer' } })
    expect(h.calls.filter((c) => c === 'send server.configure' || c === 'launch')).toEqual([])
    expect(h.uploads).toEqual([])
    expect(fileAsks).toEqual([])
  })

  it('a hello without the server features reads as not settled, never as no follower', async () => {
    const h = await servingHost()
    h.caps.delete('stream-relay-v1')
    const m = createHostServerManager(deps())
    await m.connected(h)
    expect(m.view('devbox').phase).toBe('checking')
    expect(m.followerFact('devbox')).toEqual({ kind: 'unknown' })
    expect(removed(h)).toBe(0)
  })

  it('a late report the poll reads settles Walnut Health and ends the wait to try again', async () => {
    const h = await servingHost()
    h.reports = false
    const settled: string[] = []
    const failed: string[] = []
    const m = createHostServerManager(deps({ firstReportMs: 10, pollMs: 20, tryLaterMs: { failed: [150] }, health: { failed: (k) => { failed.push(k) }, settled: (k) => { settled.push(k) } } }))
    await m.connected(h)
    expect(failed).toEqual(['devbox'])
    expect(m.view('devbox').retryAt).toEqual(expect.any(Number))
    const configures = h.calls.filter((c) => c === 'send server.configure').length
    h.reports = true
    await vi.waitFor(() => expect(settled).toEqual(['devbox']))
    expect(m.view('devbox').phase).toBe('running')
    // The ladder's timer is gone: no setup runs again by itself.
    await new Promise((r) => setTimeout(r, 300))
    expect(h.calls.filter((c) => c === 'send server.configure').length).toBe(configures)
    m.stop()
  })

  it('no file for the host (with no program kept as working) is no "no follower there"', async () => {
    const h = host()
    h.serves = { serves: 'walnut-serve', serviceHome: HOME }
    h.daemonState = 'running'
    settings = onByDefault()
    const m = createHostServerManager(deps({ hostFile: { ...files(), buildId: async () => { throw new NoHostFile('no walnut file for linux-x64 here') } } }))
    await m.connected(h)
    expect(m.view('devbox').phase).toBe('error')
    expect(m.followerFact('devbox')).toEqual({ kind: 'unknown' })
    expect(removed(h)).toBe(0)
  })

  it('a status read that fails raises no room gate on it (its own memory is no lack of room)', async () => {
    const h = host()
    h.serves = { serves: 'walnut-serve', serviceHome: HOME }
    h.room = 'mem_total_kb=8388608\nmem_avail_kb=262144\ndisk_free_kb=41943040\n'
    settings = onByDefault()
    const send = h.send.bind(h)
    h.send = async (cmd, params, ms) => { if (cmd === 'server.status') throw new Error('daemon command timeout: server.status (10000ms)'); return send(cmd, params, ms) }
    const m = createHostServerManager(deps({ firstReportMs: 10 }))
    await m.connected(h)
    expect(h.calls).not.toContain('room')
    expect(m.view('devbox').phase).not.toBe('not-eligible')
    expect(m.followerFact('devbox').kind).not.toBe('none')
    expect(removed(h)).toBe(0)
    m.stop()
  })

  it('turning its server off is still the person\'s to do: the follower is removed', async () => {
    const h = await servingHost()
    settings = { ...onByDefault(), enabled: false }
    const m = createHostServerManager(deps())
    await m.connected(h)
    expect(removed(h)).toBe(1)
    expect(m.view('devbox').phase).toBe('off')
  })

  for (const offered of [true, null] as const) {
    it(`a hello that says daemon on a host offered the one service (${offered === null ? 'not sure yet' : 'offered'}): a failed start leaves it, and tries again`, async () => {
      // 2026-11-24 review: a start that fell back to the daemon keeps the follower spec; a failure that
      // removed it then would make the fallback for good. The leader still means the host to be its one service.
      const h = host()
      await createHostServerManager(deps()).connected(h)
      h.oneServiceWanted = async () => offered
      settings = onByDefault()
      h.reports = false
      const m = createHostServerManager(deps({ firstReportMs: 10, tryLaterMs: { failed: [5] } }))
      await m.connected(h)
      await vi.waitFor(() => expect(h.calls.filter((c) => c === 'send server.configure').length).toBeGreaterThanOrEqual(4))
      expect(removed(h)).toBe(0)
      expect(m.view('devbox').message).not.toMatch(/stopped trying/)
      expect(m.followerFact('devbox').kind).not.toBe('none')
      m.stop()
    })
  }

  it('a host that runs as the daemon and is not offered the one service keeps the old way: a default host\'s failed start is taken down', async () => {
    const h = host()
    h.oneServiceWanted = async () => false
    await createHostServerManager(deps()).connected(h)
    settings = onByDefault()
    h.reports = false
    const m = createHostServerManager(deps({ firstReportMs: 10 }))
    await m.connected(h)
    expect(h.specs.at(-1)).toBeNull()
    expect(m.view('devbox').phase).toBe('error')
  })

  it('every way manager.ts takes a server down or rules a host out is gated for a one-service host', () => {
    // A new call site fails here until it is classified: one a failure can reach must leave a host whose
    // one service is this Walnut's follower as it is, or that host is switched back to two programs
    // (a removed spec restarts the service as the plain daemon; a "none" follower asks for the daemon mode).
    const src = fs.readFileSync(path.join(__dirname, '../../src/core/host-server/manager.ts'), 'utf8')
    // The manager's own functions and the methods of the object it returns, by where each starts.
    const defs = [...src.matchAll(/\n  (?:async )?function (\w+)\(|\n    (?:async )?(\w+)\([^)\n]*\)[^\n]*\{\n/g)].map((x) => ({ at: x.index!, name: x[1] ?? x[2]! }))
    const defOf = (at: number) => defs.filter((d) => d.at < at).at(-1)!
    const fnStart = (at: number) => defOf(at).at
    const fnName = (at: number) => defOf(at).name
    // The lines that open the blocks a call sits in, and what came before it in its own block
    // (braces balance in this source, template literals too).
    const scope = (at: number): { headers: string; before: string } => {
      const open: number[] = []
      for (let i = fnStart(at); i < at; i++) {
        if (src[i] === '{') open.push(i)
        else if (src[i] === '}') open.pop()
      }
      // The innermost block that ends its line (an inline object literal is no block).
      const block = open.filter((i) => src[i + 1] === '\n').at(-1)!
      return { headers: open.map((i) => src.slice(src.lastIndexOf('\n', i) + 1, i)).join('\n'), before: src.slice(block, at) }
    }
    const notDef = (x: RegExpMatchArray) => !/function \w*$/.test(src.slice(x.index! - 30, x.index!))

    // Every server.configure names its spec: configureSelf reads a missing spec as a removal too.
    const sends = [...src.matchAll(/send\('server\.configure', ([^)]*?), \d/g)]
    expect(sends.map((x) => `${fnName(x.index!)}: ${x[1]}`).sort()).toEqual([
      'configure: { home: deps.home, spec }',
      'retryExpose: { home: deps.home, spec: next }',
      'takeDown: { home: deps.home, spec: null }',
    ])
    // The one removal sits behind the gate.
    const removal = sends.find((x) => x[1]!.includes('spec: null'))!.index!
    expect(src.slice(fnStart(removal), removal)).toMatch(/if \(why !== 'off' && \(why === 'failed' \? await oneServiceMeant\(host\) : oneServiceHere\(host\)\)\)[^]*return false/)

    // Every takeDown names why; only 'off' (the settings) may stop a host's one service.
    const downs = [...src.matchAll(/takeDown\(([^,]+), ([^,]+)(?:, '([a-z-]+)')?/g)].filter(notDef)
    const downWhy: Record<string, RegExp> = {
      off: /if \(!enabled\)/,
      // A remote follower service never probes true; the leader's own row is skipped, then ruled out.
      'this-computer': /!oneServiceHere\(host\) && !\(await $/,
      failed: /if \(byDefault\) await $/,
    }
    expect(downs.map((x) => x[3]).sort()).toEqual(Object.keys(downWhy).sort())
    for (const d of downs) {
      const { headers, before } = scope(d.index!)
      expect(`${headers}\n${before}`, d[3]).toMatch(downWhy[d[3]!]!)
    }
    expect(src).toMatch(/const byDefault = [^\n]*&& !service\n/)
    // The failure paths read "is or is meant to be" (the offer too); the this-computer probe reads only the hello.
    expect(src).toMatch(/const service = await oneServiceMeant\(/)
    expect(src).toMatch(/why === 'failed' \? await oneServiceMeant\(host\) : oneServiceHere\(host\)/)

    // Every gate on the host is classified.
    const gates = [...src.matchAll(/notEligible\(([^,]+), ([^,]+),/g)].filter(notDef).map((x) => ({ reason: x[2]!, at: x.index! }))
    const gateWhy: Record<string, RegExp> = {
      // A name's gate: its follower fact reads the keeper's (the alias tests check keeperOf).
      "'another-name'": /keeper !== hostKey/,
      'judged.gate.reason': /firstOnByDefault\(host/,
      // Only this computer probes true, even when it leads as its own one service.
      "'this-computer'": /self === true/,
      "'no-build'": /!service\b/,
    }
    expect(gates.map((g) => g.reason).sort()).toEqual(Object.keys(gateWhy).sort())
    for (const g of gates) expect(scope(g.at).headers, g.reason).toMatch(gateWhy[g.reason]!)
    expect(src.slice(src.indexOf('async function firstOnByDefault'), src.indexOf('async function firstOnByDefault') + 600)).toContain('oneServiceHere(host)')

    // Every phase the follower fact reads as "none" (ownFollowerFact), written directly, is classified.
    const nones = [...src.matchAll(/phase: '(off|not-eligible|unsupported)'/g)].map((x) => ({ phase: x[1]!, fn: fnName(x.index!), at: x.index! }))
      .filter((x) => x.fn !== 'ownFollowerFact')
    expect(nones.map((x) => `${x.fn}: ${x.phase}`).sort()).toEqual([
      'notEligible: not-eligible', 'notEligible: not-eligible',
      'reconcileOnce: off', 'reconcileOnce: unsupported',
      // A fresh view: the fact is unknown until a reconcile read settings (lastSettings).
      'view: off',
    ])
    for (const x of nones.filter((n) => n.fn === 'reconcileOnce')) {
      const { headers, before } = scope(x.at)
      // 'off' only by the settings; 'unsupported' after a one-service host has left the block.
      if (x.phase === 'off') expect(headers).toMatch(/if \(!enabled\)/)
      else expect(before).toMatch(/if \(await oneServiceMeant\(host\)\) \{[^]*return\n\s*\}/)
    }

    // A build is installed only after the held service is looked at.
    const installs = [...src.matchAll(/await ensureInstalled\(/g)].map((x) => x.index!)
    expect(installs).toHaveLength(1)
    expect(src.lastIndexOf('serviceHolds(host)', installs[0])).toBeGreaterThan(fnStart(installs[0]!))
  })
})
