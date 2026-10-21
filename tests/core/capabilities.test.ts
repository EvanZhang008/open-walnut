/**
 * Where a box's capabilities come from (src/core/capabilities.ts, stage 5 of
 * docs/plan/walnut-companion-unified-replica.md): WALNUT_CAPABILITIES on the
 * companion, all four when it sets nothing; never on the Mac or a host replica.
 * The constant is flipped between cases, as the device and session tests do, so
 * the answer must follow it and the env without a reset.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const box = vi.hoisted(() => ({ cloud: false }))
vi.mock('../../src/constants.js', async (orig) => ({
  ...(await orig<typeof import('../../src/constants.js')>()),
  get CLOUD_MODE() { return box.cloud },
}))

import {
  CAPABILITIES, capabilitiesAt, capabilityFacts, capabilityList, defaultCapabilities, hasCapability, resolveCapabilities,
} from '../../src/core/capabilities.js'
import { canStandIn, isCompanion } from '../../src/core/server-role.js'

const saved = process.env.WALNUT_CAPABILITIES
afterEach(() => {
  box.cloud = false
  if (saved === undefined) delete process.env.WALNUT_CAPABILITIES
  else process.env.WALNUT_CAPABILITIES = saved
})

const list = (s: ReadonlySet<string>) => [...s].sort()

describe('resolveCapabilities', () => {
  it.each([
    ['unset', undefined, [...CAPABILITIES]],
    ['blank', '  ', [...CAPABILITIES]],
    ['none', 'none', []],
    ['one name', 'bridge-door', ['bridge-door']],
    ['commas and spaces, repeated', ' public-door, cloud-exec  public-door ,', ['cloud-exec', 'public-door']],
    ['all four', 'public-door bridge-door cloud-exec backup-leader', [...CAPABILITIES]],
  ])('the companion, %s', (_name, raw, want) => {
    const facts = resolveCapabilities(raw, true)
    expect(list(facts.capabilities)).toEqual([...want].sort())
    expect(facts.ignored).toBeNull()
  })

  it.each([['a typo', 'bridge-dor'], ['the old column name', 'replicaCloud'], ['none with a name', 'none,bridge-door'], ['a case slip', 'Bridge-Door']])(
    'the companion refuses %s: it must not read as a door left shut', (_name, raw) => {
      expect(() => resolveCapabilities(raw, true)).toThrow(/is not a capability/)
    })

  it('anything but the companion has none, and a value set there is reported as ignored, never applied or refused', () => {
    expect(resolveCapabilities(undefined, false)).toEqual({ capabilities: new Set(), ignored: null })
    expect(resolveCapabilities('bridge-door,backup-leader', false)).toEqual({ capabilities: new Set(), ignored: 'bridge-door,backup-leader' })
    expect(resolveCapabilities('not-a-thing', false).capabilities.size).toBe(0)
  })

  it('defaults per placement: the companion all four, the Mac and a host none', () => {
    expect(list(defaultCapabilities('cloud'))).toEqual([...CAPABILITIES].sort())
    expect(defaultCapabilities('mac').size).toBe(0)
    expect(defaultCapabilities('host').size).toBe(0)
  })
})

describe('this server', () => {
  it('the Mac: none, even with the variable set', () => {
    process.env.WALNUT_CAPABILITIES = 'bridge-door'
    expect(capabilityList()).toEqual([])
    expect(hasCapability('bridge-door')).toBe(false)
    expect(capabilityFacts().ignored).toBe('bridge-door')
    expect(isCompanion()).toBe(false)
    expect(canStandIn(true)).toBe(false)
  })

  it('the companion follows the constant and the env live, with no reset', () => {
    delete process.env.WALNUT_CAPABILITIES
    box.cloud = true
    expect(isCompanion()).toBe(true)
    expect(capabilityList()).toEqual([...CAPABILITIES])
    expect(canStandIn(true)).toBe(true)
    expect(canStandIn(false)).toBe(false)
    process.env.WALNUT_CAPABILITIES = 'public-door'
    expect(capabilityList()).toEqual(['public-door'])
    expect(hasCapability('backup-leader')).toBe(false)
    expect(canStandIn(true)).toBe(false)
    box.cloud = false
    expect(capabilityList()).toEqual([])
    expect(capabilityFacts().ignored).toBe('public-door')
  })

  it('a bad value throws where it is read, and stops throwing once it is fixed', () => {
    box.cloud = true
    process.env.WALNUT_CAPABILITIES = 'bridge-door,typo'
    expect(() => hasCapability('bridge-door')).toThrow(/"typo" is not a capability/)
    process.env.WALNUT_CAPABILITIES = 'bridge-door'
    expect(hasCapability('bridge-door')).toBe(true)
  })

  it('capabilitiesAt: this box\'s own set where it runs, another placement\'s defaults elsewhere', () => {
    box.cloud = true
    process.env.WALNUT_CAPABILITIES = 'cloud-exec'
    expect(list(capabilitiesAt('cloud'))).toEqual(['cloud-exec'])
    expect(capabilitiesAt('host').size).toBe(0)
    box.cloud = false
    expect(list(capabilitiesAt('cloud'))).toEqual([...CAPABILITIES].sort())
    expect(capabilitiesAt('mac').size).toBe(0)
  })
})
