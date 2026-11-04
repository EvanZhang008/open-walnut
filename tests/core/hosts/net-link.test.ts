/**
 * A host network machine whose dial failed says why in words every surface can act on.
 *
 * 2026-11-04: an offline PC read "WebSocket connection failed: ECONNRESET (host=home-pc,
 * url=ws://127.0.0.1:59788)", which the classifier filed as "daemon", so Settings said "The
 * session daemon on home-pc did not start". walnut-net opens the forward port before it dials,
 * and drops the connection when the dial fails, so the socket only ever says "reset". The fix
 * asks walnut-net whether it holds a live link to the machine (net-link.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({ status: null as unknown, throws: false }))
vi.mock('../../../src/core/hosts/link.js', () => ({
  link: async () => ({
    send: async (cmd: string) => {
      if (cmd !== 'net.status') throw new Error(`unexpected ${cmd}`)
      if (net.throws) throw new Error('daemon not answering')
      return net.status
    },
  }),
}))

import { explainNetDialFailure, netPeerLinked } from '../../../src/core/hosts/net-link.js'
import { classifyHostConnectError } from '../../../src/core/sessions/host-connect-hint.js'

const ME = '9eff3d7c349c234826b2ac2449a0ba93335b2cfa'
const RESET = new Error('WebSocket connection failed: ECONNRESET (host=home-pc, url=ws://127.0.0.1:59788)')
const peer = (link?: Record<string, unknown>) => ({ node: { peers: [{ id: 'someone-else', link: { path: 'direct' } }, { id: ME, ...(link ? { link } : {}) }] } })

beforeEach(() => { net.status = null; net.throws = false })

describe('netPeerLinked', () => {
  it('a live link (direct or through a relay) is true; no link, path none or no peer row is false', async () => {
    net.status = peer({ path: 'direct' })
    expect(await netPeerLinked(ME)).toBe(true)
    net.status = peer({ path: 'relay' })
    expect(await netPeerLinked(ME)).toBe(true)
    net.status = peer()
    expect(await netPeerLinked(ME)).toBe(false)
    net.status = peer({ path: 'none' })
    expect(await netPeerLinked(ME)).toBe(false)
    net.status = { node: { peers: [] } }
    expect(await netPeerLinked(ME)).toBe(false)
  })

  it('walnut-net not running, or the daemon not answering, says nothing (null)', async () => {
    net.status = { node: null }
    expect(await netPeerLinked(ME)).toBeNull()
    net.throws = true
    expect(await netPeerLinked(ME)).toBeNull()
  })
})

describe('explainNetDialFailure', () => {
  it('no link to the machine: it is not online, which the classifier reads as unreachable, not the daemon', async () => {
    const err = await explainNetDialFailure(RESET, ME, 'home-pc', async () => false)
    expect(err.message).toBe('home-pc is not online on the host network: this machine could not reach it')
    expect(err.message).not.toContain('127.0.0.1')
    expect(classifyHostConnectError(err.message, '', ['home-pc']).kind).toBe('unreachable')
    // The socket's words alone were filed as the daemon's failure.
    expect(classifyHostConnectError(RESET.message, '', ['home-pc']).kind).toBe('daemon')
  })

  it('a live link but no daemon answering: the daemon there, also when the socket said it timed out', async () => {
    const err = await explainNetDialFailure(RESET, ME, 'home-pc', async () => true)
    expect(err.message).toContain('home-pc is reachable, but the Walnut daemon there did not answer')
    expect(classifyHostConnectError(err.message, '', ['home-pc']).kind).toBe('daemon')
    const slow = await explainNetDialFailure(new Error('Opening handshake has timed out'), ME, 'home-pc', async () => true)
    expect(classifyHostConnectError(slow.message, '', ['home-pc']).kind).toBe('daemon')
  })

  it('walnut-net cannot say: the error stays as it came, the same object', async () => {
    expect(await explainNetDialFailure(RESET, ME, 'home-pc', async () => null)).toBe(RESET)
    const err = await explainNetDialFailure('plain text', ME, 'home-pc', async () => null)
    expect(err.message).toBe('plain text')
  })

  it('a host named like a pattern word is no evidence: "daemon-box" offline is still unreachable', async () => {
    const err = await explainNetDialFailure(RESET, ME, 'daemon-box', async () => false)
    expect(classifyHostConnectError(err.message, '', ['daemon-box']).kind).toBe('unreachable')
  })
})
