/**
 * Where this Walnut's tunnel runs (src/core/expose/placement.ts) and how a host
 * server's settings carry it (core/host-server/index.ts withThisWalnutTunnel):
 * one tunnel, one name, one machine at a time.
 */
import { describe, expect, it } from 'vitest'
import { alwaysOnHosts, exposePlaces, exposePlacement, statusOnHost, validRunOn } from '../../src/core/expose/placement.js'
import { validateExposeDefinition } from '../../src/core/expose/registry.js'
import type { ExposeProviderDefinition } from '../../src/core/expose/types.js'
import { hostServerSettingsFrom, withThisWalnutTunnel } from '../../src/core/host-server/index.js'

const def: ExposeProviderDefinition = {
  id: 'acme-tunnel',
  title: 'Acme Tunnel',
  command: '~/.acme/bin/tunnel',
  args: ['http', '{port}', '--name', '{name}'],
  options: [{ key: 'name', label: 'Tunnel name', default: 'walnut', pattern: '[a-z0-9-]{1,40}' }],
  urlPattern: 'https://[a-z0-9.-]+\\.acme-tunnel\\.example',
  alwaysOnHostPattern: '^always-on-[a-z0-9-]+\\.',
}

const on = { enabled: true }
const hosts = {
  zeta: { label: 'Zeta box', hostname: 'always-on-zeta.example.test', server: on },
  alpha: { label: 'Alpha box', hostname: 'ALWAYS-ON-alpha.example.test', server: on },
  laptop: { hostname: '10.0.0.7', server: on },
  sleeper: { hostname: 'always-on-sleeper.example.test', server: { enabled: false } },
  fresh: { hostname: 'always-on-fresh.example.test' },
  hidden: { hostname: 'always-on-hidden.example.test', enabled: false, server: on },
  cloud: { hostname: 'always-on-cloud.example.test', cloud_box: true, server: on },
  lookalike: { hostname: 'not-always-on-box.example.test', server: on },
}

describe('exposePlacement', () => {
  it('follows the provider: the first always-on host by key, its hostname matched case-insensitively', () => {
    expect(alwaysOnHosts(def, hosts)).toEqual(['alpha', 'fresh', 'sleeper', 'zeta'])
    expect(exposePlacement(undefined, def, hosts)).toEqual({ where: 'host', hostKey: 'alpha', label: 'Alpha box', auto: true })
  })

  it('only a host whose server is on: never one to install a server on unasked, a hidden one, the cloud box, or a lookalike', () => {
    const { sleeper, fresh, hidden, cloud, lookalike, laptop } = hosts
    expect(exposePlacement(undefined, def, { sleeper, fresh, hidden, cloud, lookalike, laptop })).toEqual({ where: 'here', auto: true })
  })

  it('stays here with no pattern, no hosts, a pattern that does not compile, or the built-in command provider', () => {
    expect(exposePlacement(undefined, { ...def, alwaysOnHostPattern: undefined }, hosts)).toEqual({ where: 'here', auto: true })
    expect(exposePlacement(undefined, def, undefined)).toEqual({ where: 'here', auto: true })
    expect(exposePlacement(undefined, { ...def, alwaysOnHostPattern: '(' }, hosts)).toEqual({ where: 'here', auto: true })
    expect(exposePlacement('zeta', { ...def, id: 'command' }, hosts)).toEqual({ where: 'here', auto: false })
  })

  it('the person\'s pick wins: here, any host (an always-on one or not, its server off or not)', () => {
    expect(exposePlacement('here', def, hosts)).toEqual({ where: 'here', auto: false })
    expect(exposePlacement('zeta', def, hosts)).toEqual({ where: 'host', hostKey: 'zeta', label: 'Zeta box', auto: false })
    expect(exposePlacement('laptop', def, hosts)).toEqual({ where: 'host', hostKey: 'laptop', label: 'laptop', auto: false })
    expect(exposePlacement('sleeper', def, hosts)).toMatchObject({ where: 'host', hostKey: 'sleeper' })
    expect(exposePlacement('fresh', def, hosts)).toMatchObject({ where: 'host', hostKey: 'fresh' })
  })

  it('a picked host that is gone, hidden, the cloud box, or not a host of its own (__proto__) puts it back here', () => {
    for (const key of ['removed', 'hidden', 'cloud', '__proto__', 'constructor', 'toString']) {
      expect(exposePlacement(key, def, hosts), key).toEqual({ where: 'here', auto: false })
    }
  })
})

describe('exposePlaces and validRunOn', () => {
  it('offers the always-on hosts, a picked other host, then this computer; nothing without a host to offer', () => {
    expect(exposePlaces(undefined, def, hosts).map((p) => [p.id, p.alwaysOn])).toEqual([['alpha', true], ['fresh', true], ['sleeper', true], ['zeta', true], ['here', false]])
    expect(exposePlaces('laptop', def, hosts).map((p) => p.id)).toEqual(['alpha', 'fresh', 'sleeper', 'zeta', 'laptop', 'here'])
    expect(exposePlaces(undefined, def, { laptop: hosts.laptop })).toEqual([])
    expect(exposePlaces(undefined, { ...def, id: 'command' }, hosts)).toEqual([])
  })

  it('takes here, a host config.yaml names, or null; never the cloud box or a stranger', () => {
    for (const ok of ['here', 'zeta', 'laptop', null]) expect(validRunOn(ok, hosts), String(ok)).toBe(true)
    for (const bad of ['cloud', 'hidden', 'removed', '__proto__', '', 3, {}, undefined]) expect(validRunOn(bad, hosts), String(bad)).toBe(false)
  })

  it('a pattern that is not a regular expression is refused at registration', () => {
    expect(() => validateExposeDefinition({ ...def, alwaysOnHostPattern: '(' })).toThrow(/not a valid pattern/)
    expect(() => validateExposeDefinition(def)).not.toThrow()
  })
})

describe('statusOnHost', () => {
  const placed = { hostKey: 'zeta', label: 'Zeta box', auto: true }
  const runsOn = placed

  it('is the host server\'s own report while it runs, without the host\'s port', () => {
    const view = { phase: 'running', since: 1, server: { expose: { enabled: true, provider: 'acme-tunnel', state: 'connected' as const, since: 5, url: 'https://someone-walnut.acme-tunnel.example', port: 42001 } } }
    expect(statusOnHost(placed, def, view)).toEqual({ enabled: true, provider: 'acme-tunnel', providerTitle: 'Acme Tunnel', runsOn, state: 'connected', since: 5, url: 'https://someone-walnut.acme-tunnel.example' })
    const signIn = { ...view, server: { expose: { enabled: true, provider: 'acme-tunnel', state: 'needs-sign-in' as const, since: 6, hint: 'Sign in on the host.' } } }
    expect(statusOnHost(placed, def, signIn)).toMatchObject({ state: 'needs-sign-in', hint: 'Sign in on the host.', runsOn })
    // Another provider's tunnel is the host's own from before: still starting this one.
    const other = { ...view, server: { expose: { enabled: true, provider: 'other-tunnel', state: 'connected' as const, since: 5, url: 'https://box.other.example' } } }
    expect(statusOnHost(placed, def, other)).toMatchObject({ state: 'starting', runsOn })
  })

  it('says what it waits for before the server reports a tunnel', () => {
    expect(statusOnHost(placed, def, null)).toMatchObject({ state: 'starting', lastError: 'Starting Walnut on Zeta box.', runsOn })
    expect(statusOnHost(placed, def, { phase: 'waiting-for-host', since: 2 })).toMatchObject({ state: 'starting', lastError: 'Waiting to connect to Zeta box.' })
    expect(statusOnHost(placed, def, { phase: 'installing', since: 3, message: 'Installing Walnut 1.2.3 on the host.' })).toMatchObject({ state: 'starting', lastError: 'Installing Walnut 1.2.3 on the host.' })
    // Running, its tunnel settings not applied yet: still starting.
    expect(statusOnHost(placed, def, { phase: 'running', since: 4, server: { expose: { enabled: false, provider: null, state: 'off', since: 0 } } })).toMatchObject({ state: 'starting' })
  })

  it('a server that failed is retrying, with its reason', () => {
    expect(statusOnHost(placed, def, { phase: 'error', since: 7, message: 'the install on the host failed: no compiler' }))
      .toMatchObject({ state: 'retrying', since: 7, lastError: 'the install on the host failed: no compiler', runsOn })
  })
})

describe('withThisWalnutTunnel', () => {
  const lookup = (id: string) => (id === def.id ? def : null)
  const config = (expose: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    expose: { enabled: true, provider: 'acme-tunnel', ...expose },
    hosts: { zeta: { hostname: 'always-on-zeta.example.test', server: on, ...extra }, laptop: { hostname: '10.0.0.7' }, yard: { hostname: '10.0.0.8' } },
  })
  const off = hostServerSettingsFrom(undefined)

  it('the host that carries it runs a server and this computer\'s tunnel, whatever its own switches say', () => {
    const own = hostServerSettingsFrom({ enabled: false, expose: { enabled: true, provider: 'acme-tunnel', options: { name: 'zeta' } } })
    expect(withThisWalnutTunnel('zeta', own, config({ run_on: 'zeta', options: { name: 'walnut' } }), lookup)).toMatchObject({
      enabled: true, carriesTunnel: true, expose: { enabled: true, provider: 'acme-tunnel', options: { name: 'walnut' } },
    })
    expect(withThisWalnutTunnel('laptop', off, config({}), lookup)).toEqual(off)
  })

  it('changes nothing while this computer\'s tunnel is off, or its provider is not installed', () => {
    expect(withThisWalnutTunnel('zeta', off, config({ enabled: false }), lookup)).toEqual(off)
    expect(withThisWalnutTunnel('zeta', off, config({ provider: 'gone' }), lookup)).toEqual(off)
  })

  it('a pick of this computer leaves the host its own settings', () => {
    const own = hostServerSettingsFrom({ enabled: true, expose: { enabled: true, provider: 'acme-tunnel', options: { name: 'zeta' } } })
    expect(withThisWalnutTunnel('zeta', own, config({ run_on: 'here' }), lookup)).toEqual(own)
  })

  it('holds back a host\'s own tunnel that would take this computer\'s address (same provider, same name, defaults filled in)', () => {
    const own = hostServerSettingsFrom({ enabled: true, expose: { enabled: true, provider: 'acme-tunnel', options: {} } })
    const out = withThisWalnutTunnel('zeta', own, config({ run_on: 'here', options: { name: 'walnut' } }), lookup)
    expect(out.expose).toMatchObject({ enabled: false, blocked: expect.stringMatching(/same address/) })
    expect(out.enabled).toBe(true)
    // Also while another host carries it: two hosts would take it from each other too.
    expect(withThisWalnutTunnel('yard', own, config({ run_on: 'zeta' }), lookup).expose).toMatchObject({ enabled: false, blocked: expect.any(String) })
    // A name of its own is its own address.
    const named = hostServerSettingsFrom({ enabled: true, expose: { enabled: true, provider: 'acme-tunnel', options: { name: 'yard' } } })
    expect(withThisWalnutTunnel('yard', named, config({ run_on: 'zeta' }), lookup)).toEqual(named)
  })
})
