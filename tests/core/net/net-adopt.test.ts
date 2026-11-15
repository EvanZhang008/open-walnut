import { describe, expect, it } from 'vitest'
import { adoptHostRows, adoptionRoute, type HostAdoption } from '../../../src/core/net/net-adopt.js'
import { netHostname, type HostRows } from '../../../src/core/net/net-rows.js'

const endpoint = '60d53783dcf0c6e95fe6c2ff390fd3131d42a167eecee7eac15e57e69ed36f5b'
const input: HostAdoption = { host: 'devbox', joined: 'devbox-net', endpoint, hostname: 'devbox.example.test', route: adoptionRoute({ hostname: 'devbox.example.test', user: 'runner', discovered: false }) }
const rows = (): HostRows => ({
  devbox: { hostname: input.hostname, user: 'runner', enabled: true, label: 'Build machine', discovered: false, server: { enabled: true }, weight: 80 },
  'devbox-net': { hostname: netHostname('devbox-net'), transport: 'net', endpoint, enabled: true },
  other: { hostname: 'other.example.test', enabled: false },
})

describe('an existing host adopts its own joined network endpoint', () => {
  it('keeps the original alias and every setting, with no automatic SSH fallback', () => {
    const before = rows()
    const after = adoptHostRows(before, input)
    expect(after.devbox).toEqual({ ...before.devbox, transport: 'net', endpoint, hostname: netHostname('devbox') })
    expect(after).not.toHaveProperty('devbox-net')
    expect(after.other).toBe(before.other)
    expect(before).toHaveProperty('devbox-net')
    expect(after.devbox).not.toHaveProperty('sshFallback')
  })

  it('preserves concurrent setting edits but refuses a changed machine', () => {
    const before = rows()
    before.devbox.label = 'Renamed'
    before.devbox.enabled = false
    expect(adoptHostRows(before, input).devbox).toMatchObject({ label: 'Renamed', enabled: false })
    before.devbox.hostname = 'replacement.example.test'
    expect(() => adoptHostRows(before, input)).toThrow('existing host changed')
  })

  it.each([
    ['changed port', (r: HostRows) => { r.devbox.port = 2222 }],
    ['changed user', (r: HostRows) => { r.devbox.user = 'other' }],
    ['missing source', (r: HostRows) => { delete r.devbox }],
    ['missing joined', (r: HostRows) => { delete r['devbox-net'] }],
    ['joined endpoint replaced', (r: HostRows) => { r['devbox-net'].endpoint = 'a'.repeat(64) }],
    ['joined transport stripped', (r: HostRows) => { delete r['devbox-net'].transport }],
    ['ambiguous endpoint', (r: HostRows) => { r.copy = { ...r['devbox-net'] } }],
    ['source already another network host', (r: HostRows) => { r.devbox.transport = 'net' }],
  ])('refuses %s without modifying any row', (_label, change) => {
    const before = rows()
    change(before)
    const snapshot = structuredClone(before)
    expect(() => adoptHostRows(before, input)).toThrow()
    expect(before).toEqual(snapshot)
  })

  it('never takes a prototype property as a host row', () => {
    expect(() => adoptHostRows(rows(), { ...input, host: '__proto__' })).toThrow('row is missing')
  })

  it('refuses an invalid or unverified endpoint', () => {
    expect(() => adoptHostRows(rows(), { ...input, endpoint: 'not-a-key' })).toThrow('verified network endpoint')
  })
})
