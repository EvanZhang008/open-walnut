/**
 * routeFeature (src/core/feature-route.ts): engines in order, skips and failures
 * kept in order, a verdict stops the route.
 */
import { describe, expect, it } from 'vitest'
import { routeFeature, type FeatureEngine } from '../../src/core/feature-route.js'

const engine = (id: string, behaviour: { skip?: string; fail?: string; answer?: string }): FeatureEngine<string, string> => ({
  id,
  unavailable: () => behaviour.skip ?? null,
  run: async (input) => {
    if (behaviour.fail) throw new Error(behaviour.fail)
    return `${behaviour.answer ?? id}:${input}`
  },
})

describe('routeFeature', () => {
  it('the first engine that can run and answers wins', async () => {
    const result = await routeFeature([engine('leader', { skip: 'away' }), engine('local', {}), engine('hosted', {})], 'in')
    expect(result).toMatchObject({ ok: true, via: 'local', output: 'local:in' })
    expect(result.attempts).toEqual([{ id: 'leader', outcome: 'skipped', reason: 'away' }])
  })

  it('a failure hands the input on; every attempt is kept in order', async () => {
    const result = await routeFeature([engine('leader', { fail: 'offline' }), engine('local', { fail: 'model missing' }), engine('hosted', {})], 'in')
    expect(result).toMatchObject({ ok: true, via: 'hosted' })
    expect(result.attempts.map((a) => `${a.id}:${a.outcome}:${a.reason}`)).toEqual(['leader:failed:offline', 'local:failed:model missing'])
  })

  it('a verdict about the input stops the route there', async () => {
    let hostedRan = false
    const hosted: FeatureEngine<string, string> = { id: 'hosted', unavailable: () => null, run: async () => { hostedRan = true; return 'x' } }
    const result = await routeFeature([engine('local', { fail: 'damaged input' }), hosted], 'in', (err) => String(err).includes('damaged'))
    expect(result).toMatchObject({ ok: false, verdict: { id: 'local', reason: 'damaged input' } })
    expect(hostedRan).toBe(false)
  })

  it('nothing could answer: not ok, with every reason', async () => {
    const result = await routeFeature([engine('a', { skip: 'no key' }), engine('b', { fail: 'down' })], 'in')
    expect(result.ok).toBe(false)
    expect(result).not.toHaveProperty('verdict')
    expect(result.attempts.map((a) => a.outcome)).toEqual(['skipped', 'failed'])
  })

  it('an availability check that throws is a skip, not a crash', async () => {
    const broken: FeatureEngine<string, string> = { id: 'broken', unavailable: () => { throw new Error('config unreadable') }, run: async () => 'never' }
    const result = await routeFeature([broken, engine('next', {})], 'in')
    expect(result).toMatchObject({ ok: true, via: 'next', attempts: [{ id: 'broken', outcome: 'skipped', reason: 'config unreadable' }] })
  })
})
