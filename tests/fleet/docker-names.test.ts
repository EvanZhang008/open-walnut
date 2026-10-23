/**
 * The fleet's Docker door refuses every name outside walnut-fleet-* before docker
 * runs (tests/fleet/docker.ts), so no fleet call can reach the user's own
 * containers, images or networks. No Docker needed: each refusal happens first.
 */
import { describe, expect, it } from 'vitest'
import * as dk from './docker.js'

describe('fleet Docker names', () => {
  it('takes the fleet\'s own names, with an optional tag', () => {
    for (const n of ['walnut-fleet-a1b2c3', 'walnut-fleet-a1b2c3-devbox', 'walnut-fleet-host:0123456789ab', 'walnut-fleet-base:node22-bookworm-slim']) {
      expect(dk.fleetName(n)).toBe(n)
    }
  })

  it('refuses every other name', () => {
    for (const n of ['', 'node:22-bookworm-slim', 'walnut-fleet', 'walnut-fleet-', 'walnut-fleetx-a', 'other-app:latest', 'walnut-fleet-A1', ' walnut-fleet-a', 'walnut-fleet-a;rm -rf /', 'walnut-fleet-a/b', 'x-walnut-fleet-a']) {
      expect(() => dk.fleetName(n), n).toThrow(/refusing a Docker name/)
    }
  })

  it('every container, network and image call refuses a foreign name before running docker', async () => {
    await expect(dk.pause('other-app')).rejects.toThrow(/refusing/)
    await expect(dk.unpause('other-app')).rejects.toThrow(/refusing/)
    await expect(dk.exec('other-app', 'true')).rejects.toThrow(/refusing/)
    await expect(dk.removeRun(['other-app'], null)).rejects.toThrow(/refusing/)
    await expect(dk.removeRun([], 'bridge')).rejects.toThrow(/refusing/)
    await expect(dk.imageExists('other-app:latest')).rejects.toThrow(/refusing/)
    await expect(dk.runContainer({ name: 'walnut-fleet-a1', image: 'other-app:latest', network: 'walnut-fleet-n1', run: 'a1' })).rejects.toThrow(/refusing/)
    await expect(dk.runContainer({ name: 'walnut-fleet-a1', image: 'walnut-fleet-host:1', network: 'bridge', run: 'a1' })).rejects.toThrow(/refusing/)
  })
})
