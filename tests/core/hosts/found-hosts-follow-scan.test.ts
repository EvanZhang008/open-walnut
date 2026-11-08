/**
 * A found host keeps following ~/.ssh/config after the person's yes, field by field, until
 * the person changes that field in Walnut (src/core/hosts/found-hosts.ts `followScan`, the
 * `scanned` record on the row). And one hostname on two ports is two machines (`foundMachineKey`).
 */
import { describe, expect, it } from 'vitest'
import {
  FOUND_HOST_SCAN_FIELDS, followScan, foundMachineKey, keepFoundHostScan, mergeFoundHosts, withFoundHostAnswer,
  type FoundHostRow,
} from '../../../src/core/hosts/found-hosts.js'
import { settleFoundHostsDoc } from '../../../src/core/hosts/found-hosts-store.js'
import type { DiscoveredHost } from '../../../src/core/ssh-config-scanner.js'
import type { Config } from '../../../src/core/types.js'

const NOW = new Date('2026-11-08T09:00:00Z')
const noFacts = { sessionHosts: new Set<string>(), taskHosts: new Set<string>(), connectedHosts: new Set<string>(), serverHosts: new Set<string>() }

function scan(...hosts: DiscoveredHost[]): Map<string, DiscoveredHost> {
  return new Map(hosts.map((h) => [h.alias, h]))
}

/** The row the person's yes writes for a host merged from this scan (answerFoundHost's path). */
function yesRow(host: DiscoveredHost): FoundHostRow {
  const config = { hosts: {} } as Config
  mergeFoundHosts(config, scan(host), { asking: true })
  const merged = config.hosts![host.alias] as FoundHostRow
  return withFoundHostAnswer({ hostname: merged.hostname, user: merged.user, port: merged.port, scanned: merged.scanned }, 'yes', 'person', host)
}

function readWith(stored: FoundHostRow, alias: string, now: DiscoveredHost): FoundHostRow {
  const config = { hosts: { [alias]: stored } } as unknown as Config
  mergeFoundHosts(config, scan(now), { asking: true })
  return config.hosts![alias] as FoundHostRow
}

describe('a found host with the yes follows ~/.ssh/config (bug U09)', () => {
  it('a Port fixed in ~/.ssh/config after the yes is the port the next read dials', () => {
    const stored = yesRow({ alias: 'devbox', hostname: '10.0.0.5', user: 'sam', port: 2201 })
    expect(stored).toMatchObject({ port: 2201, connect: 'yes', scanned: { hostname: '10.0.0.5', user: 'sam', port: 2201 } })
    const read = readWith(stored, 'devbox', { alias: 'devbox', hostname: '10.0.0.5', user: 'sam', port: 2222 })
    expect(read).toMatchObject({ hostname: '10.0.0.5', user: 'sam', port: 2222, connect: 'yes', enabled: true, scanned: { port: 2222 } })
    // A Port removed from ~/.ssh/config: the default port again, not the old one.
    const dropped = readWith(read, 'devbox', { alias: 'devbox', hostname: '10.0.0.5', user: 'sam' })
    expect(dropped.port).toBeUndefined()
    expect(dropped.scanned).toEqual({ hostname: '10.0.0.5', user: 'sam' })
  })

  it('a port the person set in Settings is kept; the fields they did not change still follow', () => {
    const stored = { ...yesRow({ alias: 'devbox', hostname: '10.0.0.5', user: 'sam', port: 2201 }), port: 2300 }
    const read = readWith(stored, 'devbox', { alias: 'devbox', hostname: '10.0.0.6', user: 'kim', port: 2222 })
    expect(read).toMatchObject({ hostname: '10.0.0.6', user: 'kim', port: 2300 })
    // The record keeps the scanned port, so the person's port stays theirs on every later read.
    expect(readWith(read, 'devbox', { alias: 'devbox', hostname: '10.0.0.6', user: 'kim', port: 2400 }).port).toBe(2300)
  })

  it('a row with no record (written before it existed) is left as it is', () => {
    const stored: FoundHostRow = { hostname: '10.0.0.5', port: 2201, discovered: true, connect: 'yes', enabled: true }
    expect(readWith(stored, 'devbox', { alias: 'devbox', hostname: '10.0.0.5', port: 2222 }).port).toBe(2201)
  })

  it('the start records a scan on an answered row that still equals ~/.ssh/config, never on one that differs', () => {
    const doc: Record<string, unknown> = {
      hosts_found: { asking_since: '2026-11-01T00:00:00.000Z' },
      hosts: {
        same: { hostname: '10.0.0.5', port: 2201, discovered: true, connect: 'yes', enabled: true },
        edited: { hostname: '10.0.0.7', port: 2300, discovered: true, connect: 'yes', enabled: true },
        mine: { hostname: '10.0.0.8', enabled: true },
      },
    }
    settleFoundHostsDoc(doc, {
      facts: noFacts, now: NOW,
      scanned: scan({ alias: 'same', hostname: '10.0.0.5', port: 2201 }, { alias: 'edited', hostname: '10.0.0.7', port: 22 }, { alias: 'mine', hostname: '10.0.0.8' }),
    })
    const hosts = doc.hosts as Record<string, FoundHostRow>
    expect(hosts.same.scanned).toEqual({ hostname: '10.0.0.5', port: 2201 })
    expect(hosts.edited.scanned).toBeUndefined()
    expect(hosts.mine.scanned).toBeUndefined()
  })

  it('a Remote Hosts save that does not know the record keeps it; a port changed in that save is the person\'s', () => {
    const was = readWith(yesRow({ alias: 'devbox', hostname: '10.0.0.5', port: 2201 }), 'devbox', { alias: 'devbox', hostname: '10.0.0.5', port: 2222 })
    const untouched = keepFoundHostScan({ hostname: '10.0.0.5', port: 2222, discovered: true, connect: 'yes', enabled: true }, was)
    expect(readWith(untouched, 'devbox', { alias: 'devbox', hostname: '10.0.0.5', port: 2233 }).port).toBe(2233)
    const edited = keepFoundHostScan({ hostname: '10.0.0.5', port: 2300, discovered: true, connect: 'yes', enabled: true }, was)
    expect(readWith(edited, 'devbox', { alias: 'devbox', hostname: '10.0.0.5', port: 2233 }).port).toBe(2300)
    // A hand-added host never gets a record.
    expect(keepFoundHostScan({ hostname: 'x', discovered: false }, was)).toEqual({ hostname: 'x', discovered: false })
  })

  it('guard: every connection field the merge copies from a scan into a row follows the scan', () => {
    const full: Required<DiscoveredHost> = { alias: 'box', hostname: '10.0.0.5', user: 'sam', port: 2201, label: 'Box' }
    const config = { hosts: {} } as Config
    mergeFoundHosts(config, scan(full), { asking: true })
    const row = config.hosts!.box as FoundHostRow
    const copied = (Object.keys(full) as (keyof DiscoveredHost)[]).filter((k) => k !== 'alias' && k !== 'label' && row[k] === full[k])
    // A new field the scanner reads and the row carries must be followed, or listed here as one that is not.
    expect([...FOUND_HOST_SCAN_FIELDS].sort()).toEqual(copied.sort())
    const changed: DiscoveredHost = { alias: 'box', hostname: '10.0.0.6', user: 'kim', port: 2222, label: 'Box' }
    const next = followScan(row, changed)
    for (const k of FOUND_HOST_SCAN_FIELDS) expect(next[k]).toBe(changed[k])
  })
})

describe('one hostname on two ports is two machines (bug B)', () => {
  it('two aliases on one hostname with different ports are both listed', () => {
    const config = { hosts: {} } as Config
    mergeFoundHosts(config, scan(
      { alias: 'demo-devbox', hostname: '127.0.0.1', port: 3460 },
      { alias: 'demo-devbox-c', hostname: '127.0.0.1', port: 3461 },
    ), { asking: true })
    expect(Object.keys(config.hosts!).sort()).toEqual(['demo-devbox', 'demo-devbox-c'])
    expect(config.hosts!['demo-devbox-c'].port).toBe(3461)
  })

  it('the same hostname and port is still one machine, and no port means 22', () => {
    const config = { hosts: { mine: { hostname: '127.0.0.1', port: 3460, enabled: true } } } as unknown as Config
    mergeFoundHosts(config, scan(
      { alias: 'demo-devbox', hostname: '127.0.0.1', port: 3460 },
      { alias: 'dup-a', hostname: 'box.example.test' },
      { alias: 'dup-b', hostname: 'BOX.example.test', port: 22 },
    ), { asking: true })
    expect(Object.keys(config.hosts!).sort()).toEqual(['dup-a', 'mine'])
    expect(foundMachineKey('Box.example.test', undefined)).toBe(foundMachineKey('box.example.test', 22))
  })

  it('the first start writes both used aliases of one hostname on two ports', () => {
    const doc: Record<string, unknown> = { hosts: {} }
    settleFoundHostsDoc(doc, {
      facts: { ...noFacts, sessionHosts: new Set(['demo-devbox', 'demo-devbox-c']) }, now: NOW,
      scanned: scan({ alias: 'demo-devbox', hostname: '127.0.0.1', port: 3460 }, { alias: 'demo-devbox-c', hostname: '127.0.0.1', port: 3461 }),
    })
    expect(Object.keys(doc.hosts as object).sort()).toEqual(['demo-devbox', 'demo-devbox-c'])
  })
})
