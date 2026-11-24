/**
 * A machine on the host network is addressed by the network, never by the Remote Hosts
 * editor (src/core/net/net-hosts.ts, used by PUT /api/config): an editor save that
 * leaves one out, or an older editor that drops its transport and endpoint, keeps it
 * as it was; the person's own settings on it (label, switches, capability tags) are
 * theirs to change; and an editor cannot make a new `net` row of its own.
 */
import { describe, expect, it } from 'vitest'
import { keepNetHosts, NetHostAliasTaken, NET_ROW_FIELD_WRITER, PERSON_FIELD_OK } from '../../../src/core/net/net-hosts.js'
import { writeConfigSection } from '../../../src/core/config-section-write.js'

const E = 'e'.repeat(64)
const current = {
  devbox: { hostname: 'devbox.example', user: 'me', enabled: true },
  'gpu-box': { hostname: 'gpu-box.walnut-net.invalid', label: 'gpu-box', transport: 'net', endpoint: E, enabled: true, capabilities: ['gpu'] },
}

describe('keepNetHosts', () => {
  it('keeps a net machine the editor left out', () => {
    const out = keepNetHosts({ devbox: { hostname: 'devbox.example', enabled: true } }, current)
    expect(out['gpu-box']).toEqual(current['gpu-box'])
    expect(out.devbox).toEqual({ hostname: 'devbox.example', enabled: true })
  })

  it('an older editor that drops transport and endpoint cannot turn it into an SSH host', () => {
    const out = keepNetHosts({ 'gpu-box': { hostname: 'gpu-box.walnut-net.invalid', enabled: false, label: 'GPU' } }, current)
    expect(out['gpu-box']).toEqual({ ...current['gpu-box'], enabled: false, label: 'GPU' })
  })

  it('a net row the editor invents is only an SSH row', () => {
    const out = keepNetHosts({ x: { hostname: 'x', transport: 'net', endpoint: 'f'.repeat(64) } }, current)
    expect(out.x).toEqual({ hostname: 'x' })
  })

  it('an SSH host saved under the name of a net machine is refused, not swallowed', () => {
    expect(() => keepNetHosts({ 'gpu-box': { hostname: 'gpu.example', user: 'me' } }, current)).toThrow(NetHostAliasTaken)
    // The same name with no hostname (only a switch or a label) is not a new host.
    expect(keepNetHosts({ 'gpu-box': { enabled: false } }, current)['gpu-box']).toMatchObject({ enabled: false, transport: 'net' })
  })

  it('removing an SSH host still works', () => {
    const out = keepNetHosts({}, current)
    expect(out.devbox).toBeUndefined()
    expect(out['gpu-box']).toBeDefined()
  })

  // 2026-11-23: a pod host saved with capabilities ["cloud", "always-on"] kept none of them,
  // so it read as a local machine for placement.
  it('takes the person\'s capability tags and switches on a net machine', () => {
    const out = keepNetHosts({ 'gpu-box': { capabilities: ['cloud', 'always-on'], autofix: false, place: false } }, current)
    expect(out['gpu-box']).toEqual({ ...current['gpu-box'], capabilities: ['cloud', 'always-on'], autofix: false, place: false })
  })

  it('a person field the sender leaves out stays as stored, null removes it, a bad shape is ignored', () => {
    expect(keepNetHosts({ 'gpu-box': { label: 'GPU' } }, current)['gpu-box']).toMatchObject({ capabilities: ['gpu'], label: 'GPU' })
    expect(keepNetHosts({ 'gpu-box': { capabilities: null } }, current)['gpu-box']).not.toHaveProperty('capabilities')
    expect(keepNetHosts({ 'gpu-box': { capabilities: 'cloud', enabled: 'yes' } }, current)['gpu-box']).toEqual(current['gpu-box'])
  })

  it('never takes the network\'s fields or another path\'s from the sender', () => {
    const out = keepNetHosts({ 'gpu-box': { hostname: 'gpu-box.walnut-net.invalid', endpoint: 'f'.repeat(64), port: 2222, server: { enabled: true }, cloud_box: true } }, current)
    expect(out['gpu-box']).toEqual(current['gpu-box'])
  })

  it('a host\'s own engine settings are taken only when a start could read them', () => {
    expect(PERSON_FIELD_OK.engines({ codex: { provider: { base_url: 'http://127.0.0.1:18402/v1', name: 'host-relay' } } })).toBe(true)
    expect(PERSON_FIELD_OK.engines({})).toBe(true)
    expect(PERSON_FIELD_OK.engines({ codex: { provider: { name: 'no-url' } } })).toBe(false)
    expect(PERSON_FIELD_OK.engines({ codex: { provider: { base_url: 'ftp://x' } } })).toBe(false)
    expect(PERSON_FIELD_OK.engines({ codex: { provider: { base_url: 'http://x/v1', name: 'openai' } } })).toBe(false)
    expect(PERSON_FIELD_OK.engines([])).toBe(false)
  })

  it('every field a person writes has a shape it is checked against', () => {
    const person = Object.entries(NET_ROW_FIELD_WRITER).filter(([, w]) => w === 'person').map(([f]) => f).sort()
    expect(Object.keys(PERSON_FIELD_OK).sort()).toEqual(person)
  })
})

// A writer that does not hold the whole map (an agent, the CLI: PUT /api/config with
// mergeEntries) goes through keepNetHosts({ merge: true }), then writeConfigSection merges each
// entry into the row as the write lock finds it (src/web/routes/config.ts).
describe('keepNetHosts in a merged write, end to end with the section write', () => {
  const write = (sent: Record<string, Record<string, unknown> | null>, readBefore: Record<string, unknown>, atLock: Record<string, unknown>) => {
    const kept = keepNetHosts(sent as Record<string, Record<string, unknown> | undefined>, readBefore, { merge: true })
    const body = Object.fromEntries(Object.entries(kept).filter(([key]) => Object.hasOwn(sent, key)))
    return writeConfigSection('hosts', atLock, body, { mergeEntries: true }) as Record<string, Record<string, unknown>>
  }

  it('sets and removes the person\'s tags', () => {
    expect(write({ 'gpu-box': { capabilities: ['cloud'] } }, current, current)['gpu-box'].capabilities).toEqual(['cloud'])
    expect(write({ 'gpu-box': { capabilities: null } }, current, current)['gpu-box']).not.toHaveProperty('capabilities')
  })

  it('keeps an address the network changed after the sender read the map', () => {
    const moved = { ...current, 'gpu-box': { ...current['gpu-box'], endpoint: 'f'.repeat(64) } }
    const out = write({ 'gpu-box': { label: 'GPU', endpoint: E } }, current, moved)
    expect(out['gpu-box']).toEqual({ ...moved['gpu-box'], label: 'GPU' })
  })

  it('a null for the whole row does not remove a net machine, and other hosts stay', () => {
    const out = write({ 'gpu-box': null }, current, current)
    expect(out['gpu-box']).toEqual(current['gpu-box'])
    expect(out.devbox).toEqual(current.devbox)
  })
})
