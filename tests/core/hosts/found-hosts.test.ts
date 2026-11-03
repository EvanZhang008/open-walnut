/**
 * Found hosts (src/core/hosts/found-hosts.ts, found-hosts-store.ts): a Host block of
 * ~/.ssh/config is listed and never dialled until the person says yes. Covers the
 * merge, the read rule, the decision for rows an older Walnut left (never flipping
 * a host someone uses), the warmup skipping a host that waits, and the tunnel's
 * placement skipping it while Runs on still leads there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyFoundHostAnswers, decideFoundHost, foundHostUnadopted, foundHostWaits, mergeFoundHosts, withFoundHostAnswer,
  type FoundHostFacts,
} from '../../../src/core/hosts/found-hosts.js'
import { settleFoundHosts, settleFoundHostsDoc } from '../../../src/core/hosts/found-hosts-store.js'
import { HostWarmup, type HostWarmupCandidate } from '../../../src/core/hosts/host-warmup.js'
import { exposePlacement, exposePlaces, validRunOn } from '../../../src/core/expose/placement.js'
import type { ExposeProviderDefinition } from '../../../src/core/expose/types.js'
import type { DiscoveredHost } from '../../../src/core/ssh-config-scanner.js'
import type { Config } from '../../../src/core/types.js'

const NOW = new Date('2026-11-02T09:00:00Z')

function scanned(...hosts: DiscoveredHost[]): Map<string, DiscoveredHost> {
  return new Map(hosts.map((h) => [h.alias, h]))
}

function facts(partial: Partial<Record<keyof FoundHostFacts, string[]>> = {}): FoundHostFacts {
  return {
    sessionHosts: new Set(partial.sessionHosts ?? []),
    taskHosts: new Set(partial.taskHosts ?? []),
    connectedHosts: new Set(partial.connectedHosts ?? []),
    serverHosts: new Set(partial.serverHosts ?? []),
  }
}

describe('mergeFoundHosts', () => {
  const found = scanned(
    { alias: 'lab-mac', hostname: '10.0.0.9', user: 'sam' },
    { alias: 'devbox-fqdn', hostname: 'devbox.example.test' },
    { alias: 'companion', hostname: 'companion.example.test' },
  )

  it('once the server asks, adds a new found host waiting for the yes, off', () => {
    const config = { hosts: {} } as Config
    mergeFoundHosts(config, found, { reserved: new Set(['companion']), asking: true })
    expect(config.hosts!['lab-mac']).toEqual({ hostname: '10.0.0.9', user: 'sam', port: undefined, label: undefined, enabled: false, discovered: true, connect: 'ask' })
    expect(config.hosts!.companion).toBeUndefined()
    expect(foundHostWaits(config.hosts!['lab-mac'])).toBe(true)
  })

  it('before the server asks (the first start of this version), merges as an older Walnut did', () => {
    const config = { hosts: {} } as Config
    mergeFoundHosts(config, found, { asking: false })
    expect(config.hosts!['lab-mac']).toMatchObject({ enabled: true, discovered: true })
    expect(config.hosts!['lab-mac'].connect).toBeUndefined()
  })

  it('never touches an entry already there, by alias or by hostname', () => {
    const config = { hosts: { devbox: { hostname: 'DEVBOX.example.test', enabled: true }, 'lab-mac': { hostname: '10.0.0.9', discovered: true, connect: 'yes', enabled: true } } } as unknown as Config
    mergeFoundHosts(config, found, { asking: true })
    expect(Object.keys(config.hosts!).sort()).toEqual(['companion', 'devbox', 'lab-mac'])
    expect(config.hosts!['lab-mac']).toMatchObject({ connect: 'yes', enabled: true })
  })
})

describe('the read rule', () => {
  it('a found host without the yes reads as off; a yes and a hand-added host keep their switch', () => {
    const hosts = {
      asked: { hostname: 'a', discovered: true, connect: 'ask', enabled: true },
      declined: { hostname: 'b', discovered: true, connect: 'not_now' },
      yes: { hostname: 'c', discovered: true, connect: 'yes', enabled: true },
      older: { hostname: 'd', discovered: true, enabled: true },
      manual: { hostname: 'e', connect: 'ask', enabled: true },
    } as unknown as Config['hosts']
    applyFoundHostAnswers(hosts)
    expect(hosts!.asked.enabled).toBe(false)
    expect(hosts!.declined.enabled).toBe(false)
    expect(hosts!.yes.enabled).toBe(true)
    expect(hosts!.older.enabled).toBe(true)   // undecided older row: read as before until the server decides it
    expect(hosts!.manual.enabled).toBe(true)  // `connect` means nothing on a host added by hand
    expect(foundHostUnadopted(hosts!.yes)).toBe(false)
    expect(foundHostUnadopted(hosts!.older)).toBe(true)
    expect(foundHostUnadopted(hosts!.manual)).toBe(false)
  })

  it('a yes Walnut gave an older row is not the person\'s: the host stays a found one, on, dialled only when used', () => {
    const walnut = withFoundHostAnswer({ hostname: 'f', discovered: true, enabled: true }, 'yes', 'walnut')
    expect(walnut).toMatchObject({ connect: 'yes', connect_by: 'walnut', enabled: true })
    expect(foundHostUnadopted(walnut)).toBe(true)
    // The person's Connect later makes it theirs: the marker goes.
    const person = withFoundHostAnswer(walnut, 'yes')
    expect(person).not.toHaveProperty('connect_by')
    expect(foundHostUnadopted(person)).toBe(false)
  })
})

describe('decideFoundHost (rows an older Walnut left)', () => {
  const row = { hostname: '10.0.0.9', discovered: true, enabled: true }
  const ctx = (f: FoundHostFacts, extra: Partial<Parameters<typeof decideFoundHost>[2]> = {}) => ({ facts: f, persisted: true, ...extra })

  it.each([
    ['connected', facts({ connectedHosts: ['lab-mac'] })],
    ['session', facts({ sessionHosts: ['lab-mac'] })],
    ['task', facts({ taskHosts: ['lab-mac'] })],
    ['server', facts({ serverHosts: ['lab-mac'] })],
  ] as const)('a host in use (%s) is a yes', (reason, f) => {
    expect(decideFoundHost('lab-mac', row, ctx(f))).toEqual({ answer: 'yes', reason })
  })

  it('a host carrying the tunnel by the person\'s pick, or a server switch, is a yes', () => {
    expect(decideFoundHost('lab-mac', row, ctx(facts(), { runOn: 'lab-mac' }))).toEqual({ answer: 'yes', reason: 'tunnel' })
    expect(decideFoundHost('lab-mac', { ...row, server: { enabled: true } }, ctx(facts()))).toEqual({ answer: 'yes', reason: 'server' })
  })

  it('a host the person edited is a yes: a shell setup, a keep choice, or a field that differs from ~/.ssh/config', () => {
    const scan = { alias: 'lab-mac', hostname: '10.0.0.9', label: 'lab-mac' }
    expect(decideFoundHost('lab-mac', { ...row, shell_setup: 'source ~/.nvm/nvm.sh' }, ctx(facts())).answer).toBe('yes')
    expect(decideFoundHost('lab-mac', { ...row, keep: { notes: false } }, ctx(facts())).answer).toBe('yes')
    expect(decideFoundHost('lab-mac', { ...row, label: 'Lab Mac' }, ctx(facts(), { scanned: scan })).answer).toBe('yes')
    expect(decideFoundHost('lab-mac', { ...row, label: 'lab-mac' }, ctx(facts(), { scanned: scan })).answer).toBe('ask')
  })

  it('a host the person turned off is Not now, even with sessions (it stays off)', () => {
    expect(decideFoundHost('lab-mac', { ...row, enabled: false }, ctx(facts({ sessionHosts: ['lab-mac'] })))).toEqual({ answer: 'not_now', reason: 'turned_off' })
  })

  it('a found host nobody used waits for the question', () => {
    expect(decideFoundHost('lab-mac', row, ctx(facts({ sessionHosts: ['devbox'] })))).toEqual({ answer: 'ask', reason: 'unused' })
  })
})

describe('settleFoundHostsDoc', () => {
  it('decides each stored found host with no answer, writes the used in-memory ones as a yes, and starts asking', () => {
    const doc: Record<string, unknown> = {
      hosts: {
        devbox: { hostname: 'devbox.example.test', enabled: true, discovered: false },
        'lab-mac': { hostname: '10.0.0.9', enabled: true, discovered: true },
        'old-pc': { hostname: '10.0.0.10', enabled: true, discovered: true },
        decided: { hostname: '10.0.0.11', enabled: false, discovered: true, connect: 'not_now' },
      },
    }
    const decided = settleFoundHostsDoc(doc, {
      facts: facts({ connectedHosts: ['old-pc'], sessionHosts: ['home-pc'] }),
      scanned: scanned(
        { alias: 'lab-mac', hostname: '10.0.0.9' }, { alias: 'old-pc', hostname: '10.0.0.10' },
        { alias: 'home-pc', hostname: '10.0.0.12', user: 'sam' }, { alias: 'quiet-pc', hostname: '10.0.0.13' },
        { alias: 'devbox-again', hostname: 'devbox.example.test' },
      ),
      now: NOW,
    })
    const hosts = doc.hosts as Record<string, Record<string, unknown>>
    expect(hosts.devbox).toEqual({ hostname: 'devbox.example.test', enabled: true, discovered: false })
    expect(hosts['lab-mac']).toMatchObject({ connect: 'ask', enabled: false })
    expect(hosts['old-pc']).toMatchObject({ connect: 'yes', enabled: true })
    expect(hosts.decided).toMatchObject({ connect: 'not_now', enabled: false })
    // In memory only, used: written so it never goes quiet. Unused: left to the merge (waits).
    expect(hosts['home-pc']).toEqual({ hostname: '10.0.0.12', user: 'sam', discovered: true, connect: 'yes', enabled: true, connect_by: 'walnut' })
    expect(hosts['quiet-pc']).toBeUndefined()
    expect(hosts['devbox-again']).toBeUndefined()
    expect(doc.hosts_found).toEqual({ asking_since: NOW.toISOString() })
    expect(decided.map((d) => [d.alias, d.answer, d.reason, d.added ?? false])).toEqual([
      ['lab-mac', 'ask', 'unused', false], ['old-pc', 'yes', 'connected', false], ['home-pc', 'yes', 'session', true],
    ])
  })

  it('after the first start, re-decides only a stored row that lost its answer (an older Walnut saved it), and adds nothing', () => {
    const doc: Record<string, unknown> = {
      hosts_found: { asking_since: '2026-11-01T00:00:00.000Z' },
      hosts: { 'lab-mac': { hostname: '10.0.0.9', enabled: true, discovered: true } },
    }
    const decided = settleFoundHostsDoc(doc, {
      facts: facts({ sessionHosts: ['lab-mac', 'home-pc'] }),
      scanned: scanned({ alias: 'home-pc', hostname: '10.0.0.12' }),
      now: NOW,
    })
    expect(decided).toEqual([{ alias: 'lab-mac', answer: 'yes', reason: 'session' }])
    expect((doc.hosts as Record<string, unknown>)['home-pc']).toBeUndefined()
    expect(doc.hosts_found).toEqual({ asking_since: '2026-11-01T00:00:00.000Z' })
  })

  it('settleFoundHosts decides nothing when a fact cannot be read (a used host never goes quiet on a read error)', async () => {
    const modify = vi.fn(async () => true)
    const decided = await settleFoundHosts({
      readFacts: async () => { throw new Error('session store locked') },
      scan: async () => new Map(),
      modify,
    })
    expect(decided).toEqual([])
    expect(modify).not.toHaveBeenCalled()
  })

  it('settleFoundHosts writes only when something changed', async () => {
    const doc: Record<string, unknown> = { hosts_found: { asking_since: 'x' }, hosts: { a: { hostname: 'a', discovered: true, connect: 'yes', enabled: true } } }
    let changed: boolean | undefined
    await settleFoundHosts({
      readFacts: async () => facts(),
      scan: async () => new Map(),
      modify: async (mutate) => { changed = mutate(doc); return changed },
    })
    expect(changed).toBe(false)
  })
})

describe('the warmup never dials a host waiting for the yes', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
  afterEach(() => { vi.useRealTimers() })

  /** The candidate the server builds from a config row (src/web/server.ts listHosts). */
  function candidate(key: string, row: NonNullable<Config['hosts']>[string]): HostWarmupCandidate {
    const hosts = { [key]: { ...row } } as Config['hosts']
    applyFoundHostAnswers(hosts)
    const def = hosts![key]
    return { key, sshTarget: { hostname: def.hostname }, enabled: def.enabled, discovered: foundHostUnadopted(def), standing: false }
  }

  it('skips asked and Not now hosts on every sweep (an explicit kick included); dials a yes at startup like a configured host', async () => {
    const dialled: string[] = []
    const warmup = new HostWarmup({
      startupDelayMs: 1, paceMs: 1, resweepIntervalMs: 0, log: { info: () => {}, warn: () => {} },
      listHosts: async () => [
        candidate('asked', { hostname: 'asked.example.test', discovered: true, connect: 'ask', enabled: true }),
        candidate('declined', { hostname: 'declined.example.test', discovered: true, connect: 'not_now' }),
        candidate('said-yes', { hostname: 'yes.example.test', discovered: true, connect: 'yes', enabled: true }),
        // Walnut's own yes for an older row it found in use: dialled when used, as found hosts
        // always were, never warmed at every start (the review of 2026-11-02).
        candidate('walnut-yes', { hostname: 'used.example.test', discovered: true, connect: 'yes', connect_by: 'walnut', enabled: true }),
      ],
      connect: async (key) => { dialled.push(key) },
      isConnected: () => false,
    })
    warmup.start()
    await vi.advanceTimersByTimeAsync(100)
    await warmup.kick('asked')
    await warmup.kick('declined')
    await vi.advanceTimersByTimeAsync(100)
    warmup.stop()
    expect(dialled).toEqual(['said-yes'])
    expect(warmup.snapshot().asked?.state).toBe('skipped')
  })
})

describe('the tunnel placement skips a host waiting for the yes', () => {
  const def: ExposeProviderDefinition = {
    id: 'acme-tunnel', title: 'Acme Tunnel', command: '~/.acme/bin/tunnel', args: ['http', '{port}'],
    options: [], urlPattern: 'https://[a-z0-9.-]+\\.acme-tunnel\\.example', alwaysOnHostPattern: '^always-on-[a-z0-9-]+\\.',
  }
  const waiting = withFoundHostAnswer({ hostname: 'always-on-lab.example.test', label: 'Lab box' }, 'ask')

  it('Auto stays here while the only always-on host waits, and Runs on offers it as Connect first', () => {
    const hosts = { lab: waiting }
    expect(exposePlacement(undefined, def, hosts)).toEqual({ where: 'here', auto: true })
    expect(exposePlaces(undefined, def, hosts)).toEqual([
      { id: 'here', label: 'This computer', alwaysOn: false },
      { id: 'lab', label: 'Lab box', alwaysOn: true, needsConnect: true },
    ])
    expect(validRunOn('lab', hosts)).toBe(false)
  })

  it('a found host that is a machine joined on the host network is not offered a second time', () => {
    const joined = { hostname: 'x.walnut-net.invalid', label: 'always-on-lab', transport: 'net', endpoint: 'c'.repeat(64) }
    const hosts = { lab: waiting, 'lab-joined': joined } as unknown as Parameters<typeof exposePlaces>[2]
    expect(exposePlaces(undefined, def, hosts, {})).toEqual([])
  })

  it('a picked host that still waits is not used either; after the yes Auto places there', () => {
    expect(exposePlacement('lab', def, { lab: waiting })).toEqual({ where: 'here', auto: false })
    // A row that kept enabled:true by mistake still does not carry it while the answer says wait.
    expect(exposePlacement(undefined, def, { lab: { ...waiting, enabled: true } })).toEqual({ where: 'here', auto: true })
    const yes = withFoundHostAnswer(waiting, 'yes')
    expect(exposePlacement(undefined, def, { lab: yes })).toEqual({ where: 'host', hostKey: 'lab', label: 'Lab box', auto: true })
    expect(exposePlaces(undefined, def, { lab: yes }).some((p) => p.needsConnect)).toBe(false)
  })

  it('Not now hosts are offered the same way, and a hand-added always-on host is unchanged', () => {
    const declined = withFoundHostAnswer(waiting, 'not_now')
    const hosts = { lab: declined, zeta: { hostname: 'always-on-zeta.example.test', label: 'Zeta' } }
    expect(exposePlacement(undefined, def, hosts)).toEqual({ where: 'host', hostKey: 'zeta', label: 'Zeta', auto: true })
    expect(exposePlaces(undefined, def, hosts).map((p) => [p.id, p.needsConnect ?? false])).toEqual([
      ['zeta', false], ['here', false], ['lab', true],
    ])
  })
})
