/**
 * The leader's DaemonConnection routes a stream its host's own service opens (`from: 'follower'`) by its purpose
 * (docs/reference/leader-switch.md, "The leader relay"): the relay purpose only into the switch's relay door, told who
 * it came from by this connection itself (its host key, its daemon's hello machine id), and only while this server
 * holds a permit that is no trial; else the stream is closed and neither the relay door nor the tunnel port sees it.
 * Every other purpose goes to the tunnel port as before. Driven through the connection's real stream endpoint: the
 * daemon's `stream-open` frame in, the connection's answer frames out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-leader-relay-route'))
const seen = vi.hoisted(() => ({
  permit: null as { machine: string; trial: boolean } | null,
  relay: [] as Array<{ from: unknown; stream: Duplex }>,
}))
vi.mock('../../src/core/leader/switch/boot.js', () => ({ currentLeaderPermit: () => seen.permit }))
vi.mock('../../src/core/leader/switch/leader-relay-door.js', () => ({ acceptLeaderRelay: (from: unknown, stream: Duplex) => { seen.relay.push({ from, stream }) } }))
// No tunnel port is open here: a stream that goes the tunnel port's way is closed with its own words, which tell the
// two ways apart (the relay's refusal says something else).
vi.mock('../../src/web/expose-runtime.js', () => ({ getExposeRuntime: () => null }))
const TUNNEL_WAY = 'this Walnut has no door open for host servers'

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { LEADER_RELAY_PURPOSE } from '../../src/lib/leader-relay-names.js'
import { setRevokedHosts } from '../../src/core/session-channel/revoked-hosts.js'

interface Frame { cmd: string; sid: string; error?: string }

/** A connection to host `devbox-b` whose daemon said machine id `hello-b` in its hello, its socket a recorder. */
function connection(): { c: DaemonConnection; frames: Frame[]; open: (sid: string, purpose?: string) => void } {
  const c = new DaemonConnection('devbox-b', null)
  const frames: Frame[] = []
  const raw = c as unknown as { ws: unknown; _helloMachineId: string | null; streamEndpoint: () => { handle: (m: Record<string, unknown>) => boolean } }
  raw.ws = { readyState: 1, send: (m: string) => frames.push(JSON.parse(m) as Frame) }
  raw._helloMachineId = 'hello-b'
  const open = (sid: string, purpose?: string) => { raw.streamEndpoint().handle({ ev: 'stream-open', sid, from: 'follower', ...(purpose ? { purpose } : {}) }) }
  return { c, frames, open }
}

const settle = () => new Promise((r) => setTimeout(r, 30))

beforeEach(() => { seen.permit = null; seen.relay.length = 0 })
const closes = (frames: Frame[]) => frames.filter((f) => f.cmd === 'stream.close').map((f) => [f.sid, f.error])
afterEach(() => setRevokedHosts([]))

describe('a stream of the relay purpose from a host\'s own service', () => {
  it('goes to the relay door with who it came from, read off this connection, while this server leads; never to the tunnel port', async () => {
    seen.permit = { machine: 'machine-a', trial: false }
    const { open, frames } = connection()
    open('r1', LEADER_RELAY_PURPOSE)
    await settle()
    expect(frames.map((f) => f.cmd)).toEqual(['stream.accept'])
    expect(seen.relay.map((r) => r.from)).toEqual([{ hostKey: 'devbox-b', machineId: 'hello-b' }])
  })

  it('is closed, and reaches neither door, with no permit or a trial start\'s', async () => {
    for (const permit of [null, { machine: 'machine-a', trial: true }]) {
      seen.permit = permit
      const { open, frames } = connection()
      open('r2', LEADER_RELAY_PURPOSE)
      await vi.waitFor(() => expect(closes(frames)).toEqual([['r2', 'this server runs no switchable leader']]), { timeout: 10_000 })
    }
    expect(seen.relay).toEqual([])
  })

  it('is closed from a revoked host, permit or not', async () => {
    seen.permit = { machine: 'machine-a', trial: false }
    setRevokedHosts(['devbox-b'])
    const { open, frames } = connection()
    open('r3', LEADER_RELAY_PURPOSE)
    await vi.waitFor(() => expect(closes(frames)).toHaveLength(1), { timeout: 10_000 })
    expect(closes(frames)[0]![1]).toMatch(/devbox-b is revoked/)
    expect(seen.relay).toEqual([])
  })

  it('any other purpose (none, replica, web) goes to the tunnel port as before, never the relay door', async () => {
    seen.permit = { machine: 'machine-a', trial: false }
    const { open, frames } = connection()
    open('r4')
    open('r5', 'replica')
    open('r6', 'web')
    await vi.waitFor(() => expect(closes(frames)).toEqual([['r4', TUNNEL_WAY], ['r5', TUNNEL_WAY], ['r6', TUNNEL_WAY]]), { timeout: 10_000 })
    expect(seen.relay).toEqual([])
  })

  it('both places that take a host service\'s streams (the session socket, the SSH lane) route through the one plug', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/providers/daemon-connection.ts'), 'utf8')
    const sites = [...src.matchAll(/accept: \(info\) => \(info\.from === 'follower' \? ([^\n]*)/g)].map((m) => m[1]!)
    expect(sites).toHaveLength(2)
    for (const s of sites) expect(s).toMatch(/^(conn|this)\.followerStreamPlug\(info\.purpose\)/)
  })
})
