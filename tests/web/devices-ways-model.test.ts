/**
 * Phones & Cloud, top of the pane: the "how your phone reaches Walnut now" line
 * and the three way cards (web/src/components/settings/sections/cloud/ways-model.ts).
 */
import { describe, expect, it } from 'vitest'
import { deriveWays, latestUse, type WaysInput } from '../../web/src/components/settings/sections/cloud/ways-model'

const NOW = Date.parse('2026-10-28T12:00:00Z')
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()
const CLOUD = { kind: 'cloud' as const, origin: 'https://walnut.example.com' }
const LAN = { kind: 'lan' as const, origin: 'http://192.0.2.10:3456' }
const TAILNET = { kind: 'tailnet' as const, origin: 'http://100.101.102.103:3456' }

const base = (over: Partial<WaysInput> = {}): WaysInput => ({
  listState: 'ready',
  phoneUses: [],
  targets: [LAN],
  cloudError: null,
  cloudUnpaired: false,
  tailscale: { installed: false, running: false },
  expose: { enabled: false, provider: null, state: 'off', since: 0 },
  now: NOW,
  ...over,
})

describe('the now line', () => {
  it('a phone last seen through the companion: cloud, framed as in use', () => {
    const { now, ways } = deriveWays(base({
      targets: [LAN, CLOUD],
      phoneUses: [
        { name: 'pocket-phone', via: 'lan', lastUsedAt: ago(90) },
        { name: 'pocket-phone', via: 'cloud', lastUsedAt: ago(2) },
      ],
    }))
    expect(now).toMatchObject({ tone: 'ok', title: 'pocket-phone reaches Walnut through the cloud companion' })
    expect(now.hops).toEqual(['pocket-phone', 'Cloud companion', 'This Mac'])
    expect(now.detail).toBe('Last seen 2 min ago. Works anywhere, even while this Mac sleeps.')
    expect(ways.map((w) => [w.id, w.inUse, w.tag])).toEqual([['cloud', true, 'In use'], ['tailscale', false, 'Off'], ['browser', false, 'Off']])
  })

  it('direct with nothing for away: says plainly that away from home it cannot reach Walnut', () => {
    const { now, ways } = deriveWays(base({ phoneUses: [{ name: 'iphone', via: 'lan', lastUsedAt: ago(5) }] }))
    expect(now.tone).toBe('warn')
    expect(now.title).toBe('iphone reaches this Mac directly')
    expect(now.detail).toContain("Away from home it can't reach Walnut until the cloud companion or Tailscale is on.")
    expect(ways.some((w) => w.inUse)).toBe(false)
  })

  it('direct with Tailscale on: Wi-Fi or Tailscale, no warning', () => {
    const { now } = deriveWays(base({
      targets: [LAN, TAILNET],
      tailscale: { installed: true, running: true },
      phoneUses: [{ name: 'iphone', via: 'lan', lastUsedAt: ago(30) }],
    }))
    expect(now).toMatchObject({ tone: 'ok', detail: 'Last seen 30 min ago, on the same Wi-Fi or over Tailscale.' })
  })

  it('a companion that does not answer: its phones are missing, so the line claims no route', () => {
    // The server sends no cloud phones with cloudError (src/web/routes/devices.ts listCloudDevices).
    const { now, ways } = deriveWays(base({
      cloudError: 'The cloud companion could not answer just now.',
      phoneUses: [{ name: 'iphone', via: 'lan', lastUsedAt: ago(600) }],
    }))
    expect(now.tone).toBe('warn')
    expect(now.title).toBe("Can't tell how your phone reaches Walnut right now")
    expect(now.hops).toBeUndefined()
    expect(ways[0]).toMatchObject({ dot: 'warn', tag: 'Not answering', inUse: false })
  })

  it('read off this Mac (cloud half withheld): the companion counts as on, and no "away" warning', () => {
    const { now, ways } = deriveWays(base({
      cloudWithheld: true,
      phoneUses: [{ name: 'iphone', via: 'lan', lastUsedAt: ago(5) }],
    }))
    expect(ways[0]).toMatchObject({ dot: 'on', status: 'Set up; its details show only on the Mac itself.', action: { primary: false } })
    expect(now.tone).toBe('ok')
    expect(now.detail).not.toContain("can't reach")
  })

  it('loading, failed, none paired, paired but never used', () => {
    expect(deriveWays(base({ listState: 'loading' })).now.title).toBe('Checking how your phone reaches Walnut...')
    expect(deriveWays(base({ listState: 'failed' })).now.tone).toBe('warn')
    expect(deriveWays(base()).now.title).toBe('No phone is paired yet')
    expect(deriveWays(base({ phoneUses: [{ name: 'new-phone', via: 'lan' }] })).now.title).toBe("Your phone hasn't connected yet")
  })

  it('latestUse picks the newest credential use and skips unused ones', () => {
    expect(latestUse([{ name: 'a', via: 'lan' }])).toBeNull()
    expect(latestUse([
      { name: 'a', via: 'lan', lastUsedAt: ago(3) },
      { name: 'b', via: 'cloud', lastUsedAt: ago(1) },
      { name: 'c', via: 'lan' },
    ])?.name).toBe('b')
  })
})

describe('the way cards', () => {
  it('cloud: not set up asks to set up; unpaired says so; on names the address', () => {
    expect(deriveWays(base()).ways[0]).toMatchObject({ dot: 'off', status: 'Not set up.', action: { label: 'Set up', primary: true } })
    expect(deriveWays(base({ cloudUnpaired: true })).ways[0].status).toBe('This Mac is no longer paired with it.')
    expect(deriveWays(base({ targets: [LAN, CLOUD] })).ways[0]).toMatchObject({ dot: 'on', tag: 'On', status: 'On at walnut.example.com' })
  })

  it('tailscale: not installed, installed but stopped, running', () => {
    expect(deriveWays(base()).ways[1]).toMatchObject({ dot: 'off', status: 'Not installed on this Mac.', action: { label: 'Set up Tailscale', primary: true } })
    expect(deriveWays(base({ tailscale: { installed: true, running: false } })).ways[1]).toMatchObject({ dot: 'warn', status: 'Installed on this Mac, not running.' })
    expect(deriveWays(base({ targets: [LAN, TAILNET], tailscale: { installed: true, running: true } })).ways[1]).toMatchObject({ dot: 'on', action: { label: 'Settings', primary: false } })
    // Running without a tailnet address: not a way in yet, and the line still warns.
    const noAddr = deriveWays(base({ tailscale: { installed: true, running: true }, phoneUses: [{ name: 'iphone', via: 'lan', lastUsedAt: ago(1) }] }))
    expect(noAddr.ways[1]).toMatchObject({ dot: 'warn', tag: 'Not ready' })
    expect(noAddr.now.tone).toBe('warn')
    // The server's first probe has not answered (or an older server): checking, never "not installed".
    expect(deriveWays(base({ tailscale: undefined })).ways[1]).toMatchObject({ dot: 'off', status: 'Checking...', tag: '' })
  })

  it('browser link: loading, unreadable, connected through a provider on a host, waiting on sign-in', () => {
    expect(deriveWays(base({ expose: null })).ways[2]).toMatchObject({ status: 'Checking...', tag: '' })
    expect(deriveWays(base({ expose: 'failed' })).ways[2].dot).toBe('warn')
    expect(deriveWays(base({
      expose: { enabled: true, provider: 'tunnels', providerTitle: 'Tunnels', state: 'connected', since: 0, runsOn: { hostKey: 'dev', label: 'Dev box', auto: true } },
    })).ways[2]).toMatchObject({ dot: 'on', tag: 'On', status: 'Connected through Tunnels, runs on Dev box.' })
    expect(deriveWays(base({ expose: { enabled: true, provider: 'command', state: 'needs-sign-in', since: 0 } })).ways[2])
      .toMatchObject({ dot: 'warn', tag: 'Needs you' })
  })
})
