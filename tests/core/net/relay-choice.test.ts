/**
 * The host network's relay choice and joining with no companion, the parts that need no
 * network (docs/reference/host-network.md):
 *
 *  - the relay in use: the companion's relay while one is paired, else the user's pick, else
 *    public relays (a machine behind a home router still connects); No relay is refused
 *    for a machine it would cut off;
 *  - where each machine was last seen rides its dial, so one not moved yet is still found;
 *    its relay is only ever one of this Mac's own;
 *  - a relay change asks this Mac's walnut-net what it runs, and a silent one is not old;
 *  - the ticket a Mac with no companion shows: what it carries, and every malformed one
 *    refused rather than half read;
 *  - this Mac's own list with no companion: `net.joined` plus the `transport: net` rows,
 *    never one being removed, never this Mac twice;
 *  - the walnut-net config the daemon writes: `custom` stays the config it always was
 *    (no field, so walnut-net is not restarted for it), public and none take no relays;
 *  - scripts/join.sh is exactly what the generator makes, and asks for a Walnut that
 *    reads tickets.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { choiceOfMode, cutOffByNoRelay, directAddr, relayChoice } from '../../../src/core/net/net-relay.js'
import { mergeAddrs, relayToKeep, whereOf, withWhere } from '../../../src/core/net/net-where.js'
import { runsModes, waitForModes } from '../../../src/core/net/net-seen.js'
import { decodeTicket, encodeTicket, JOIN_SCRIPT_URL, ticketCommand } from '../../../src/core/net/join-ticket.js'
import { joinedOf, localMembers } from '../../../src/core/net/net-rows.js'
import { parseNetConfig } from '../../../src/providers/net-config-core.js'
import { joinScript } from '../../../src/core/net/net-join-script.js'
import { netKey } from '../../helpers/net-keys.js'

const ROOT = path.resolve(__dirname, '../../..')
const MAC = netKey('relay-mac')
const A = netKey('relay-a')
const B = netKey('relay-b')

describe('the relay in use', () => {
  it('is the companion relay while one is paired, else the pick, else public relays', () => {
    // A companion: its relay, whatever was picked (machines that join through it come up on it).
    for (const pick of [undefined, 'own', 'public', 'none', 'bogus']) expect(relayChoice(pick, true)).toBe('own')
    expect(relayChoice(undefined, false)).toBe('public')
    expect(relayChoice('none', false)).toBe('none')
    expect(relayChoice('public', false)).toBe('public')
    // Your relay needs the companion: without one it is public relays.
    expect(relayChoice('own', false)).toBe('public')
  })

  it('reads the choice a running walnut-net is on', () => {
    expect(choiceOfMode('custom')).toBe('own')
    expect(choiceOfMode('public')).toBe('public')
    expect(choiceOfMode('none')).toBe('none')
    expect(choiceOfMode(undefined)).toBeNull()
  })

  it('refuses No relay for a machine reached through a relay or a router, never for one away', () => {
    const lan = { name: 'nas', connected: true, path: 'direct', at: '192.168.1.7:41000', own: ['192.168.1.7:41000', '[fd00::7]:41000'] }
    const viaRelay = { name: 'gpu-box', connected: true, path: 'relay', at: null, own: ['10.0.0.5:41000'] }
    const punched = { name: 'laptop', connected: true, path: 'direct', at: '203.0.113.9:6000', own: ['192.168.0.4:41000'] }
    const away = { name: 'old-box', connected: false, own: [] }
    expect(cutOffByNoRelay([lan, away])).toEqual([])
    expect(cutOffByNoRelay([lan, viaRelay, punched, away])).toEqual(['gpu-box', 'laptop'])
  })

  it('reads the direct address a link runs on', () => {
    const link = { path: 'direct', paths: [{ kind: 'relay', addr: 'Relay(https://r.example/)', selected: false }, { kind: 'direct', addr: 'Ip(192.168.1.7:41000)', selected: true }] }
    expect(directAddr(link)).toBe('192.168.1.7:41000')
    expect(directAddr({ paths: [{ kind: 'direct', addr: 'Ip([fd00::7]:5)', selected: false }] })).toBe('[fd00::7]:5')
    expect(directAddr({ paths: [{ kind: 'relay', addr: 'Relay(https://r.example/)', selected: true }] })).toBeNull()
    expect(directAddr(undefined)).toBeNull()
  })
})

describe('where each machine was last seen', () => {
  const net = { where: {
    [A]: { addrs: ['192.168.1.7:41000', 'nope', '[fd00::7]:41000', '[fe80::1%2]:5'], relay: 'https://use1-1.relay.example.invalid/' },
    [B]: { relay: 'http://plain.example/' },
    nothex: { addrs: ['10.0.0.1:1'] },
  } }

  it('keeps only addresses and relays walnut-net can dial', () => {
    expect(whereOf(net)).toEqual({ [A]: { addrs: ['192.168.1.7:41000', '[fd00::7]:41000'], relay: 'https://use1-1.relay.example.invalid/' } })
    expect(whereOf(undefined)).toEqual({})
  })

  it('rides each machine\'s dial, never the Mac\'s', () => {
    const members = [{ id: MAC, name: 'mac', role: 'mac' as const, addedAt: 1 }, { id: A, name: 'a', role: 'host' as const }, { id: B, name: 'b', role: 'host' as const }]
    expect(withWhere(members, { where: { ...net.where, [MAC]: { addrs: ['1.2.3.4:5'] } } })).toEqual([
      members[0],
      { id: A, name: 'a', role: 'host', addrs: ['192.168.1.7:41000', '[fd00::7]:41000'], relays: ['https://use1-1.relay.example.invalid/'] },
      members[2],
    ])
  })

  it('keeps a relay of its own, and the one a machine that could not move yet is still on', () => {
    const OURS = 'https://relay.example.invalid/'
    const N0 = 'https://use1-1.relay.example.invalid/'
    const OLD_OWN = 'https://old-companion.example.invalid/'
    expect(relayToKeep(OURS, [OURS], undefined)).toBe(OURS)
    // One it merely names is never kept: a machine cannot send this Mac to a relay.
    expect(relayToKeep(N0, [OURS], undefined)).toBeUndefined()
    // After unpairing (no relays of its own) or while it restarts (no relay), nothing moves.
    // OLD_OWN: kept when it was this Mac's own (an earlier companion's), the only way in.
    expect(relayToKeep(OLD_OWN, [], OLD_OWN)).toBe(OLD_OWN)
    expect(relayToKeep(null, [OURS], OLD_OWN)).toBe(OLD_OWN)
    expect(relayToKeep(undefined, [], undefined)).toBeUndefined()
    // It moved off the relay kept to one not ours: the old one is dropped.
    expect(relayToKeep(N0, [OURS], OLD_OWN)).toBeUndefined()
    expect(relayToKeep(OURS, [OURS], OLD_OWN)).toBe(OURS)
  })

  it('puts the new addresses first and keeps at most eight', () => {
    expect(mergeAddrs(['10.0.0.2:1', 'bad'], ['10.0.0.1:1', '10.0.0.2:1'])).toEqual(['10.0.0.2:1', '10.0.0.1:1'])
    expect(mergeAddrs([], Array.from({ length: 12 }, (_, i) => `10.0.0.${i}:1`))).toHaveLength(8)
  })
})

describe("this Mac's walnut-net before a relay change", () => {
  it('has relay modes when its status names one, and says nothing while it does not answer', async () => {
    const daemon = (node: unknown, down = false) => ({ hasCapability: () => true, async send() { if (down) throw new Error('down'); return { ok: true, node } } })
    expect(await runsModes(daemon({ relayMode: 'public' }))).toBe(true)
    expect(await runsModes(daemon({ addrs: [] }))).toBe(false)
    // Starting, or restarting for a change just made: not "too old".
    expect(await runsModes(daemon(null))).toBeNull()
    expect(await runsModes(daemon(null, true))).toBeNull()
  })

  it('asks again while it is silent, for a bounded time', async () => {
    let asked = 0
    const waking = { hasCapability: () => true, async send() { asked++; return { ok: true, node: asked < 3 ? null : { relayMode: 'none' } } } }
    expect(await waitForModes(waking, 5_000)).toBe(true)
    expect(asked).toBe(3)
    // One that never answers, each ask hanging: the wait still ends on time.
    const hung = { hasCapability: () => true, send: (_c: string, _p: unknown, ms?: number) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)) }
    const t0 = Date.now()
    expect(await waitForModes(hung, 1_500)).toBeNull()
    expect(Date.now() - t0).toBeLessThan(3_000)
  })
})

describe('the ticket', () => {
  const t = { mac: MAC, code: 'K7QM-4XTD-92ZD', relayMode: 'public' as const, addrs: ['192.168.1.20:41641', '[fd00::1]:41641'], relay: 'https://relay.example.invalid/' }

  it('carries what the new machine needs and reads back the same', () => {
    const s = encodeTicket(t)
    expect(s).toMatch(/^wn1-[A-Za-z0-9_-]+$/)
    expect(decodeTicket(s)).toEqual(t)
    expect(decodeTicket(encodeTicket({ ...t, relayMode: 'none', relay: null }))).toEqual({ ...t, relayMode: 'none', relay: null })
    expect(ticketCommand(s)).toBe(`curl -fsSL ${JOIN_SCRIPT_URL} | sh -s -- ${s}`)
  })

  it('refuses anything else whole', () => {
    const body = (o: unknown) => 'wn1-' + Buffer.from(JSON.stringify(o)).toString('base64url')
    for (const bad of [
      '', 'wn2-abc', 'wn1-not base64!', 'wn1-' + 'A'.repeat(3000), body({ v: 2, m: MAC, c: t.code, r: 'public' }),
      body({ v: 1, m: 'nothex', c: t.code, r: 'public' }), body({ v: 1, m: MAC, c: 'IIII-OOOO-1111', r: 'public' }),
      body({ v: 1, m: MAC, c: t.code, r: 'custom' }), 42, null,
    ]) expect(decodeTicket(bad)).toBeNull()
    // A bad address or relay is dropped, the rest kept.
    expect(decodeTicket(body({ v: 1, m: MAC, c: t.code, r: 'none', a: ['nope', '10.0.0.1:5'], u: 'http://plain' }))).toEqual({ mac: MAC, code: t.code, relayMode: 'none', addrs: ['10.0.0.1:5'], relay: null })
  })
})

describe("this Mac's own list", () => {
  const hosts = {
    devbox: { hostname: 'devbox.example' },
    'gpu-box': { hostname: 'gpu-box.walnut-net.invalid', label: 'GPU box', transport: 'net', endpoint: A },
    self: { hostname: 'x.walnut-net.invalid', transport: 'net', endpoint: MAC },
  }
  const net = { joined: { [A]: { name: 'gpu-box', platform: 'linux-x64', addedAt: 5 }, [B]: { name: 'laptop', addedAt: 7 }, nothex: { name: 'x' } } }

  it('is the Mac, every row and every joined machine, once each', () => {
    const m = localMembers(hosts, net, MAC, 'mac', new Set())
    expect(m).toEqual([
      { id: MAC, name: 'mac', role: 'mac' },
      { id: A, name: 'GPU box', role: 'host', platform: 'linux-x64', addedAt: 5 },
      { id: B, name: 'laptop', role: 'host', addedAt: 7 },
    ])
  })

  it('leaves out a machine being removed', () => {
    expect(localMembers(hosts, net, MAC, 'mac', new Set([A, B])).map((x) => x.id)).toEqual([MAC])
  })

  it('reads only well formed entries', () => {
    expect(Object.keys(joinedOf(net)).sort()).toEqual([A, B].sort())
    expect(joinedOf({ joined: [] })).toEqual({})
    expect(joinedOf(undefined)).toEqual({})
  })
})

describe("walnut-net's config", () => {
  const members = [{ id: A, name: 'a', accept: true }]

  it('writes the companion relay as it always was, and a mode only for public or none', () => {
    expect(parseNetConfig({ relays: ['https://r.example'], members })).toEqual({ relays: ['https://r.example'], relayRoots: [], members: [{ id: A, name: 'a', accept: true }] })
    expect(parseNetConfig({ relayMode: 'custom', relays: ['https://r.example'], members })).not.toHaveProperty('relayMode')
    expect(parseNetConfig({ relayMode: 'public', members })).toMatchObject({ relayMode: 'public', relays: [] })
    expect(parseNetConfig({ relayMode: 'none', members })).toMatchObject({ relayMode: 'none', relays: [] })
    // Where a member was last seen rides along, in any mode.
    const seen = [{ id: A, name: 'a', accept: false, addrs: ['10.0.0.1:5'], relays: ['https://r.example'] }]
    expect(parseNetConfig({ relayMode: 'public', members: seen }).members).toEqual(seen)
    expect(() => parseNetConfig({ relayMode: 'public', members: [{ id: A, relays: ['ftp://x'] }] })).toThrow(/bad relay URL/)
  })

  it('refuses relays with public or none, and an unknown mode', () => {
    expect(() => parseNetConfig({ relayMode: 'public', relays: ['https://r.example'], members })).toThrow(/takes no relays/)
    expect(() => parseNetConfig({ relayMode: 'none', relayRoots: ['-----BEGIN CERTIFICATE-----x'], members })).toThrow(/takes no relays/)
    expect(() => parseNetConfig({ relayMode: 'n0', members })).toThrow(/not custom, public or none/)
  })
})

describe('scripts/join.sh', () => {
  it('is what the generator makes, and is a valid sh script', () => {
    const file = fs.readFileSync(path.join(ROOT, 'scripts/join.sh'), 'utf8')
    expect(file).toBe(joinScript({ ticket: true }))
    expect(spawnSync('sh', ['-n', path.join(ROOT, 'scripts/join.sh')]).status).toBe(0)
  })

  it('needs a Walnut that reads tickets, and says what to run without one', () => {
    const s = joinScript({ ticket: true })
    expect(s).toContain('net join --help 2>/dev/null | grep -q ticket')
    expect(s).toContain('"$W" net join "$WALNUT_JOIN_TICKET" --steps </dev/null')
    const r = spawnSync('sh', [path.join(ROOT, 'scripts/join.sh')], { encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Run the command your Mac shows under Settings > Remote Hosts > Add a machine.')
    // The companion's script is unchanged in what it runs.
    expect(joinScript({ origin: 'https://wn.example', code: 'AAAA-BBBB-CCCC' })).toContain(`"$W" net join "$WALNUT_JOIN_ORIGIN" "$WALNUT_JOIN_CODE" --steps </dev/null`)
  })
})
