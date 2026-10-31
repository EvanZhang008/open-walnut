/**
 * The fleet view reads every host's daemon through the Mac's own links, so a
 * host's replica answering it while the Mac is away would list itself as the
 * primary and every other host as down: it answers "needs your Mac" instead.
 */
import { describe, expect, it } from 'vitest'
import { classify } from '../../src/replica/route-table.js'
import { NEEDS_LEADER_REASONS } from '../../web/src/api/leader-presence.js'

describe('the fleet routes on a replica', () => {
  it('need the Mac, with a reason the person reads', () => {
    for (const path of ['/api/v1/hosts', '/api/v1/hosts/devbox', '/api/v1/hosts/__local__?days=1']) {
      const d = classify('GET', path.split('?')[0])
      expect(d.away, path).toBe('needs-leader')
      expect(d.why).toBe('fleet_needs_mac')
    }
    expect(NEEDS_LEADER_REASONS.fleet_needs_mac).toBeTruthy()
    // The host profile next to it is unchanged: a plain read.
    expect(classify('GET', '/api/v1/hosts/devbox/profile').away).toBe('read')
  })
})
