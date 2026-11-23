/**
 * The host network's member lists follow the leader switch's write permission
 * (src/core/net/net-mac.ts netLeadOf, macConfig, hostConfig): with no permit running (the
 * experiment switchable_leader off, or no witnesses) the lists are the ones by role, byte for byte;
 * under a permit, the machine of this server dials every other member and the machines let in only
 * the record's holder, and during a handover the machine it is handed from too, so the new leader
 * can dial every machine (the old leader's included) once its record stands, and nobody else can.
 * The entries keep their shape: {id, name, accept, addrs?, relays?} for this machine, {id, name,
 * accept: true} for the others, deduped by id as before.
 */
import { describe, expect, it } from 'vitest'
import { hostConfig, macConfig, netLeadOf, type NetState } from '../../../src/core/net/net-mac.js'
import { netKey } from '../../helpers/net-keys.js'

const MAC = netKey('lead-mac')
const DEV = netKey('lead-dev')
const OLD = netKey('lead-old')
const PC = netKey('lead-pc')

function state(over: Partial<NetState> = {}): NetState {
  return {
    enabled: true, macId: MAC, companion: true, relay: 'own', relays: ['https://relay.example.invalid/'], relayRoots: ['root-1'],
    members: [
      { id: MAC, name: 'mac', role: 'mac', addedAt: 1 },
      { id: DEV, name: 'clouddev', role: 'host', addrs: ['10.0.0.5:41000'], relays: ['https://relay.example.invalid/'] },
      { id: OLD, name: 'olddev', role: 'host' },
      { id: PC, name: 'pc', role: 'host', addrs: ['192.168.1.7:41000'] },
    ],
    syncedAt: null, error: null,
    ...over,
  }
}

describe('with no permit running, the lists are the ones by role, byte for byte', () => {
  it('this Mac dials every host and lets none in; each host lets in the Mac', () => {
    const s = state()
    expect(netLeadOf(null, MAC, () => null)).toBeNull()
    // The JSON the daemon is sent, pinned as it was before the switch existed.
    expect(JSON.stringify(macConfig(s))).toBe(JSON.stringify({
      relays: ['https://relay.example.invalid/'], relayRoots: ['root-1'],
      members: [
        { id: DEV, name: 'clouddev', accept: false, addrs: ['10.0.0.5:41000'], relays: ['https://relay.example.invalid/'] },
        { id: OLD, name: 'olddev', accept: false },
        { id: PC, name: 'pc', accept: false, addrs: ['192.168.1.7:41000'] },
      ],
    }))
    expect(JSON.stringify(hostConfig(s))).toBe(JSON.stringify({
      relays: ['https://relay.example.invalid/'], relayRoots: ['root-1'],
      members: [{ id: MAC, name: 'mac', accept: true }],
    }))
    // A relay mode with none listed, and the lead explicitly absent: the same.
    const pub = state({ relay: 'public', relays: [], relayRoots: [] })
    expect(JSON.stringify(macConfig(pub, null))).toBe(JSON.stringify(macConfig(pub)))
    expect(JSON.stringify(hostConfig(pub, null))).toBe(JSON.stringify({ relayMode: 'public', relays: [], relayRoots: [], members: [{ id: MAC, name: 'mac', accept: true }] }))
  })

  it('a permit with no record yet (it waits for the witnesses) changes nothing either', () => {
    expect(netLeadOf({ machine: 'm-mac', record: null }, MAC, () => null)).toBeNull()
    expect(netLeadOf({ machine: 'm-mac', record: { holder: 'm-mac', kind: 'grant' } }, null, () => null)).toBeNull()
  })
})

describe('under a running permit the lists follow its record', () => {
  const endpointOf = (m: string): string | null => ({ 'm-mac': MAC, 'm-dev': DEV, 'm-old': OLD })[m] ?? null

  it('the holder dials every other member (the Mac too) and lets none in; the others let in only the holder', () => {
    // clouddev leads (a switch moved the leader there): its own network id is DEV.
    const s = state({ macId: DEV })
    const lead = netLeadOf({ machine: 'm-dev', record: { holder: 'm-dev', kind: 'renew' } }, DEV, endpointOf)
    expect(lead).toEqual({ accept: [DEV] })
    const mine = macConfig(s, lead as { accept: string[] }).members as Array<{ id: string; accept: boolean }>
    expect(mine.map((m) => [m.id, m.accept])).toEqual([[MAC, false], [OLD, false], [PC, false]])
    expect((hostConfig(s, lead as { accept: string[] }).members as unknown[])).toEqual([{ id: DEV, name: 'clouddev', accept: true }])
    // The old leader (the Mac) is let in by no machine: its dial after the switch is closed before any stream.
    expect(JSON.stringify(hostConfig(s, lead as { accept: string[] }))).not.toContain(MAC)
  })

  it('during the handover the old holder dials as before and every machine, the old one included, lets the new holder in', () => {
    // The Mac hands over to clouddev: the record's holder is clouddev, from the Mac.
    const s = state()
    const lead = netLeadOf({ machine: 'm-mac', record: { holder: 'm-dev', kind: 'handover', from: 'm-mac' } }, MAC, endpointOf)
    expect(lead).toEqual({ accept: [MAC, DEV] })
    const mine = macConfig(s, lead as { accept: string[] }).members as Array<{ id: string; accept: boolean }>
    // The Mac still dials every host; clouddev may now dial the Mac (its daemon after the stop).
    expect(mine.map((m) => [m.id, m.accept])).toEqual([[DEV, true], [OLD, false], [PC, false]])
    expect((hostConfig(s, lead as { accept: string[] }).members as Array<{ id: string }>).map((m) => m.id)).toEqual([MAC, DEV])
  })

  it('a machine the record does not name (another one leads) gives no list; an unknown handover target is only left out', () => {
    expect(netLeadOf({ machine: 'm-old', record: { holder: 'm-dev', kind: 'renew' } }, OLD, endpointOf)).toBe('not-mine')
    expect(netLeadOf({ machine: 'm-old', record: { holder: 'm-dev', kind: 'handover', from: 'm-mac' } }, OLD, endpointOf)).toBe('not-mine')
    expect(netLeadOf({ machine: 'm-mac', record: { holder: 'm-gone', kind: 'handover', from: 'm-mac' } }, MAC, endpointOf)).toEqual({ accept: [MAC] })
  })

  it('the entries keep their shape and their one-per-id: no field is added, renamed or dropped', () => {
    const s = state({ macId: DEV })
    const lead = { accept: [DEV] }
    const keys = (cfg: Record<string, unknown>) => (cfg.members as Array<Record<string, unknown>>).map((m) => Object.keys(m).join(','))
    expect(keys(macConfig(s, lead))).toEqual(['id,name,accept', 'id,name,accept', 'id,name,accept,addrs'])
    expect(keys(hostConfig(s, lead))).toEqual(['id,name,accept'])
    const ids = (macConfig(s, lead).members as Array<{ id: string }>).map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
