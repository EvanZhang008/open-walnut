/**
 * "Walnut servers" on All devices (web/src/components/settings/sections/cloud/walnut-servers.ts):
 * every place this Walnut runs, each machine once, by the name the person knows it by, on the
 * shape the user's own list has: this Mac, the cloud companion, and one always-on host listed in
 * config.yaml twice (the row he named, and a row found in ~/.ssh/config that carries the tunnel).
 */
import { describe, expect, it } from 'vitest'
import { walnutServerRows } from '../../web/src/components/settings/sections/cloud/walnut-servers'
import type { HostServerEntry } from '../../web/src/components/settings/sections/host-servers-status'

const expose = { enabled: false, provider: null, options: {} }
const running = (hostKey: string, url?: string) => ({
  hostKey, enabled: true, phase: 'running' as const, since: 1,
  server: { route: { kind: 'leader' }, ...(url ? { expose: { enabled: true, provider: 'acme-tunnel', state: 'connected' as const, since: 2, url } } : {}) },
})
const host = (over: Partial<HostServerEntry> & { hostKey: string }): HostServerEntry => ({
  label: over.hostKey, settings: { enabled: false, expose }, view: null, ...over,
})

const HOSTS: HostServerEntry[] = [
  host({ hostKey: 'big-box', label: 'Big box', settings: { enabled: true, expose }, view: running('big-box') }),
  host({ hostKey: 'found-box', settings: { enabled: true, carriesTunnel: true, expose }, view: running('found-box', 'https://someone-big.acme-tunnel.example'), knownAs: { hostKey: 'big-box', label: 'Big box' } }),
  host({ hostKey: 'old-box', label: 'Old box' }),
]
const rows = walnutServerRows({ companion: { origin: 'https://companion.example.test' }, hosts: HOSTS, tunnelTitle: 'Acme Tunnel' })

describe('walnutServerRows', () => {
  it('this Mac first as the main one, then the companion, then each host that runs a server', () => {
    expect(rows.map((r) => [r.name, r.role])).toEqual([['This Mac', 'Main'], ['Cloud companion', 'Copy'], ['Big box', 'Copy']])
  })
  it('one machine under two rows is one server, by the name the person gave it, with the tunnel it carries', () => {
    const big = rows.filter((r) => r.name === 'Big box')
    expect(big).toHaveLength(1)
    expect(big[0]).toMatchObject({ id: 'host:big-box', href: '#rh-host-big-box', dot: 'done' })
    expect(big[0].line).toContain('Acme Tunnel opens this Walnut at someone-big.acme-tunnel.example')
    expect(rows.some((r) => r.name === 'found-box' || r.line.includes('found-box'))).toBe(false)
  })
  it('a found row alone (its named row runs nothing) still shows by the machine\'s name', () => {
    const only = walnutServerRows({ companion: null, hosts: [HOSTS[1]], tunnelTitle: 'Acme Tunnel' })
    expect(only.map((r) => r.name)).toEqual(['This Mac', 'Big box'])
  })
  it('the companion: its address, or that it does not answer; none when there is no companion', () => {
    expect(rows[1].line).toMatch(/^At companion\.example\.test\./)
    expect(walnutServerRows({ companion: null, companionError: 'timed out', hosts: [], tunnelTitle: 'Tunnel' })[1])
      .toMatchObject({ name: 'Cloud companion', dot: 'action', line: 'Not answering right now; its tab says why.' })
    expect(walnutServerRows({ companion: null, hosts: null, tunnelTitle: 'Tunnel' }).map((r) => r.name)).toEqual(['This Mac'])
  })
  it('never says "browser link"', () => {
    for (const r of rows) expect(r.line).not.toMatch(/browser link/i)
  })
})
