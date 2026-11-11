/**
 * The new task panel's host picker lists the hosts Walnut found in ~/.ssh/config and has not
 * added yet (2026-11-11, the user: a host that is not connected "should always show in the new
 * task panel"). GET /api/sessions/working-dirs answers them as `found`, beside `hosts`.
 * Only a found host still waiting for the person's yes is one (asked or Not now); an added one
 * is in `hosts`, and a found machine that joined the host network shows once, as the joined one.
 */
import { describe, expect, it } from 'vitest'
import { foundPickableHosts, pickableHosts } from '../../../src/core/hosts/joined-twins.js'

const hosts = {
  devbox: { hostname: 'devbox.example.com', enabled: true },
  labbox: { hostname: 'labbox.example.com', discovered: true, connect: 'ask', enabled: false },
  oldbox: { hostname: 'oldbox.example.com', discovered: true, connect: 'not_now', enabled: false },
  addedfound: { hostname: 'added.example.com', discovered: true, connect: 'yes', enabled: true },
  offbox: { hostname: 'off.example.com', enabled: false },
} as const

describe('foundPickableHosts', () => {
  it('lists the found hosts waiting for a yes (asked and Not now), never an added or turned-off one', () => {
    expect(foundPickableHosts(hosts as never, undefined).map(([a]) => a).sort()).toEqual(['labbox', 'oldbox'])
  })

  it('no host is both found and pickable, so the picker never shows one twice', () => {
    const found = new Set(foundPickableHosts(hosts as never, undefined).map(([a]) => a))
    for (const [alias] of pickableHosts(hosts as never, undefined)) expect(found.has(alias)).toBe(false)
  })

  it('a found machine that joined the host network is left out, like every other host list', () => {
    const net = { enabled: true }
    const withJoined = {
      ...hosts,
      labbox: { ...hosts.labbox, hostname: '192.0.2.7' },
      'Lab-Mac': { transport: 'net', endpoint: '192.0.2.7:7842', enabled: true, hostname: '192.0.2.7' },
    }
    const twins = foundPickableHosts(withJoined as never, net).map(([a]) => a)
    expect(twins).toContain('oldbox')
    // Whether labbox is a twin is joinedTwins' own rule; whatever it says, the found list agrees.
    const pick = new Set(pickableHosts(withJoined as never, net).map(([a]) => a))
    for (const a of twins) expect(pick.has(a)).toBe(false)
  })
})
