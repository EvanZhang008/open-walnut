/**
 * Where a machine is, as noteSeen keeps it (src/core/net/net-seen.ts, net-where.ts), from the
 * two walnut-net statuses it reads: the machine's and this Mac's own.
 *
 * 2026-11-04: home-pc was seen on n0's relay while this Mac ran public relays, and that relay
 * was dropped as one the machine "merely names". A companion was paired while the PC was away,
 * this Mac moved to the companion's relay, and from then on dialled the PC only there and at
 * addresses WSL does not answer: "home-pc did not answer in 20s" for ten hours.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import yaml from 'js-yaml'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-net-seen-relay'))

import { CONFIG_FILE, WALNUT_HOME } from '../../../src/constants.js'
import { getConfig, _resetWriteLockForTest } from '../../../src/core/config-manager.js'
import { noteSeen } from '../../../src/core/net/net-seen.js'
import { relaysOfChoice } from '../../../src/core/net/net-relay.js'
import { AWAY_RELAY_KEEP_MS, relayToKeep, whereOf, withWhere } from '../../../src/core/net/net-where.js'

const PC = 'b'.repeat(64)
const N0 = 'https://usw1-1.relay.n0.iroh.link./'
const COMPANION = 'https://wn.example.invalid/'

function daemon(status: Record<string, unknown>) {
  return { send: async (cmd: string) => { if (cmd !== 'net.status') throw new Error(cmd); return { node: status } } } as never
}
const pc = (home: string | null) => daemon({ addrs: ['203.0.113.69:59344', '172.18.0.9:53482'], homeRelay: home })
const mac = (relayMode: string, homeRelay: string | null) => daemon({ relayMode, homeRelay, peers: [] })
const kept = async () => whereOf((await getConfig() as { net?: unknown }).net)[PC]?.relay

beforeEach(async () => {
  _resetWriteLockForTest()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.writeFile(CONFIG_FILE, yaml.dump({
    version: 1,
    hosts: { 'home-pc': { hostname: 'home-pc.walnut-net.invalid', label: 'home-pc', transport: 'net', endpoint: PC, enabled: true } },
    net: { enabled: true },
  }))
})

describe('noteSeen keeps the relay a machine is on when this Mac is on it too', () => {
  it('this Mac on public relays: the n0 relay the PC is on is kept, so it is found after the Mac moves', async () => {
    await noteSeen(mac('public', N0), pc(N0), 'home-pc', PC, relaysOfChoice('public', []))
    expect(await kept()).toBe(N0)
    // The companion is paired while the PC is away: nothing sees the PC, the relay stays.
    // When this Mac reaches it there and moves it, the companion's relay replaces it.
    await noteSeen(mac('custom', COMPANION), pc(COMPANION), 'home-pc', PC, relaysOfChoice('own', [COMPANION]))
    expect(await kept()).toBe(COMPANION)
  })

  it("on n0's relay another region than this Mac: kept too (any of n0's while this Mac is on public)", async () => {
    await noteSeen(mac('public', 'https://use1-1.relay.n0.iroh.link./'), pc('https://euc1-1.relay.n0.iroh.link./'), 'home-pc', PC, relaysOfChoice('public', []))
    expect(await kept()).toBe('https://euc1-1.relay.n0.iroh.link./')
  })

  it("this Mac on its companion's relay: a machine that names n0's relay is not kept, one still on the relay kept stays", async () => {
    await noteSeen(mac('custom', COMPANION), pc(N0), 'home-pc', PC, relaysOfChoice('own', [COMPANION]))
    expect(await kept()).toBeUndefined()
    await noteSeen(mac('public', N0), pc(N0), 'home-pc', PC, relaysOfChoice('public', []))
    await noteSeen(mac('custom', COMPANION), pc(N0), 'home-pc', PC, relaysOfChoice('own', [COMPANION]))
    expect(await kept()).toBe(N0)
  })

  it("a relay only the machine names is never kept, also while this Mac is on public relays", async () => {
    await noteSeen(mac('public', N0), pc('https://relay.attacker.example/'), 'home-pc', PC, relaysOfChoice('public', []))
    expect(await kept()).toBeUndefined()
  })

  it("the relay this Mac's walnut-net is homed on counts as its own (a newer iroh's relay not in the list yet)", async () => {
    const newer = 'https://usw2-1.relay.n0.iroh.link./'
    await noteSeen(mac('public', newer), pc(newer), 'home-pc', PC, relaysOfChoice('public', []))
    expect(await kept()).toBe(newer)
  })
})

describe('a relay outside this Mac\'s choice is dialled only for a while (2026-11-04 review)', () => {
  const member = { id: PC, role: 'host', name: 'home-pc' } as never
  const relaysOf = (net: unknown, ours: string[], now?: number) => (withWhere([member], net, ours, now)[0] as { relays?: string[] }).relays

  it('a sighting on the kept relay stamps relayAt; the stamp is renewed at most once a day', async () => {
    const t0 = Date.now()
    await noteSeen(mac('public', N0), pc(N0), 'home-pc', PC, relaysOfChoice('public', []))
    const first = whereOf((await getConfig() as { net?: unknown }).net)[PC]
    expect(first.relayAt).toBeGreaterThanOrEqual(t0)
    await noteSeen(mac('public', N0), pc(N0), 'home-pc', PC, relaysOfChoice('public', []))
    expect(whereOf((await getConfig() as { net?: unknown }).net)[PC].relayAt).toBe(first.relayAt)
  })

  it("n0's relay with Your relay picked: dialled for 14 days after the last sighting, then not; the companion's always", async () => {
    await noteSeen(mac('public', N0), pc(N0), 'home-pc', PC, relaysOfChoice('public', []))
    const net = (await getConfig() as { net?: unknown }).net
    const at = whereOf(net)[PC].relayAt!
    const own = relaysOfChoice('own', [COMPANION])
    expect(relaysOf(net, own, at + AWAY_RELAY_KEEP_MS - 1)).toEqual([N0])
    expect(relaysOf(net, own, at + AWAY_RELAY_KEEP_MS + 1)).toBeUndefined()
    // Still this Mac's choice: kept whatever its age.
    expect(relaysOf(net, relaysOfChoice('public', []), at + 10 * AWAY_RELAY_KEEP_MS)).toEqual([N0])
    // Kept before relayAt existed: dialled as before.
    expect(relaysOf({ where: { [PC]: { relay: COMPANION } } }, own, Date.now() + 10 * AWAY_RELAY_KEEP_MS)).toEqual([COMPANION])
  })

  it("the choice decides, not what walnut-net runs yet: picked public while it still runs the companion's, n0's is kept", async () => {
    await noteSeen(mac('custom', COMPANION), pc(N0), 'home-pc', PC, relaysOfChoice('public', []))
    expect(await kept()).toBe(N0)
  })

  it("the kept relay is this Mac's own spelling, never the machine's", () => {
    expect(relayToKeep('https://USW1-1.relay.n0.iroh.link/', relaysOfChoice('public', []), undefined)).toBe(N0)
  })
})
