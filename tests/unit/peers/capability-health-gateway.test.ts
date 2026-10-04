/**
 * Apple Health ops are `remote: 'deny'` (health data is only available to sessions
 * on this Mac), but a session running ON the Walnut host must still reach them: its `walnut`
 * CLI always rides the local daemon's gateway, and the morning-brief and
 * weekly-trend recipes depend on that. The `localHostGateway` tag opens exactly
 * that one door: host '__local__' passes the policy gate, every other host is
 * refused with a reason that names the privacy rule and no way around it, and
 * ordinary destructive ops stay refused everywhere.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { handleGatewayCapability, type CapabilityRouterDeps } from '../../../src/core/peers/capability-router.js'
import { PeerThrottle } from '../../../src/core/peers/peer-throttle.js'
import { getOp } from '../../../src/ops/index.js'
import { HEALTH_LOCAL_ONLY_MESSAGE } from '../../../src/lib/caller-origin.js'

const CALLER = 'a1b2c3d4-1111-2222-3333-444455556666'
const deps = (): CapabilityRouterDeps => ({ throttle: new PeerThrottle(), cloudMode: false })
const HEALTH_OPS = ['health_status', 'health_sleep', 'health_daily', 'health_series', 'health_samples', 'day_review']
const prevBase = process.env.OPEN_WALNUT_API_URL

afterEach(() => {
  if (prevBase === undefined) delete process.env.OPEN_WALNUT_API_URL
  else process.env.OPEN_WALNUT_API_URL = prevBase
})

describe('health ops over the agent gateway', () => {
  it('are tagged read-only, remote deny, primary only and local-host gateway', () => {
    for (const name of HEALTH_OPS) {
      expect(getOp(name)?.tags, name).toMatchObject({ readonly: true, remote: 'deny', primaryOnly: true, localHostGateway: true })
    }
  })

  it('refuses every health op from a remote host, naming why', async () => {
    for (const name of HEALTH_OPS) {
      const args = name === 'health_series' ? { metric: 'steps' } : name === 'health_samples' ? { type: 'q.BodyMass' } : {}
      const r = await handleGatewayCapability('tools.call', CALLER, { name, args }, 'remote-dev', deps())
      expect(r.ok, name).toBe(false)
      if (r.ok) continue
      expect(r.error.code).toBe('bad_request')
      // The rule, and nothing that reads as an invitation to call it another way.
      expect(r.error.message).toBe(`${name} refused: ${HEALTH_LOCAL_ONLY_MESSAGE}`)
      expect(r.error.message).not.toMatch(/call it from|run it on|walnut tools call/)
    }
  })

  it('lets a session on the Walnut host through the policy gate', async () => {
    // Point the executor at a closed port so the call fails at the transport,
    // AFTER the gate: the refusal text must not be the policy one.
    process.env.OPEN_WALNUT_API_URL = 'http://127.0.0.1:1'
    const r = await handleGatewayCapability('tools.call', CALLER, { name: 'health_sleep', args: { last_nights: 3 } }, '__local__', deps())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('internal')
    expect(r.error.message).not.toMatch(/Health data is only available|local-only/)
  })

  it('does not widen the door for ordinary destructive ops', async () => {
    const r = await handleGatewayCapability('tools.call', CALLER, { name: 'task_delete', args: { id: 't_x' } }, '__local__', deps())
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.message).toMatch(/local-only because it is destructive/)
  })
})
