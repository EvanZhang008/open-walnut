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
import type { HostFile, HostFileSource } from '../../src/core/host-server/host-file.js'
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
