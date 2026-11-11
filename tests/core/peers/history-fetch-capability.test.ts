/**
 * `history.fetch` (a daemon's restore of a session kept in remote storage): only this server's
 * own local daemon may ask, for a project dir of this machine; a replica refuses every capability.
 */
import { describe, expect, it } from 'vitest'
import { handleGatewayCapability } from '../../../src/core/peers/capability-router.js'
import { PeerThrottle } from '../../../src/core/peers/peer-throttle.js'

const deps = (cloudMode = false) => ({ throttle: new PeerThrottle(), cloudMode })

describe('history.fetch capability', () => {
  it('refuses a remote host', async () => {
    const out = await handleGatewayCapability('history.fetch', 'external', { dir: '/x', sessionId: 's' }, 'clouddev', deps())
    expect(out).toMatchObject({ ok: false, error: { code: 'bad_request' } })
  })
  it('refuses a dir that is not a project dir of this machine', async () => {
    const out = await handleGatewayCapability('history.fetch', 'external', { dir: '/etc', sessionId: 's' }, '__local__', deps())
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.message).toMatch(/not a session of this machine/)
  })
  it('a replica refuses it like every capability', async () => {
    const out = await handleGatewayCapability('history.fetch', 'external', { dir: '/x', sessionId: 's' }, '__local__', deps(true))
    expect(out.ok).toBe(false)
  })
})
