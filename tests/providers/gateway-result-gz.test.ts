/**
 * A big gateway answer goes gzipped to a daemon that reads it (gateway-result-gz-v1).
 * 2026-11-12: answers to a host's sessions were the top upload on its session link, 9 MB
 * in 14 minutes, and the relay on the SSH path ended the link. The daemon side is pinned
 * on the real twins in daemon-gateway-busy-again-twins-e2e.test.ts.
 */
import { describe, it, expect, vi } from 'vitest'
import zlib from 'node:zlib'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

const { DaemonConnection } = await import('../../src/providers/daemon-connection.js')

function packer(caps: string[]) {
  const conn = new DaemonConnection('gz-host', { hostname: '127.0.0.1', user: undefined, port: undefined })
  ;(conn as unknown as { hasCapability: (c: string) => boolean }).hasCapability = (c) => caps.includes(c)
  return (reply: Record<string, unknown>) => (conn as unknown as { packGatewayResult(r: Record<string, unknown>): Promise<Record<string, unknown>> }).packGatewayResult(reply)
}

describe('a big gateway answer goes gzipped', () => {
  const big = { rows: Array.from({ length: 300 }, (_, i) => ({ i, text: `history row ${i} `.repeat(10) })) }

  it('over the threshold, to a daemon with gateway-result-gz-v1: resultGz, a fraction of the bytes, the same JSON', async () => {
    const out = await packer(['gateway-result-gz-v1'])({ relayId: 7, result: big })
    expect(out.result).toBeUndefined()
    expect(out.relayId).toBe(7)
    const gz = String(out.resultGz)
    expect(gz.length).toBeLessThan(JSON.stringify(big).length / 5)
    expect(JSON.parse(zlib.gunzipSync(Buffer.from(gz, 'base64')).toString('utf8'))).toEqual(big)
  })

  it('a small answer, an error, or an older daemon: as it was', async () => {
    const small = { relayId: 1, result: { ok: true } }
    expect(await packer(['gateway-result-gz-v1'])(small)).toBe(small)
    const err = { relayId: 2, error: 'nope', errorCode: 'internal' }
    expect(await packer(['gateway-result-gz-v1'])(err)).toBe(err)
    const old = { relayId: 3, result: big }
    expect(await packer([])(old)).toBe(old)
  })

  it('an answer over the frame cap plain is not gzipped: it gets the small "too large" answer instead', async () => {
    const huge = { relayId: 4, result: { blob: 'x'.repeat(17 * 1024 * 1024) } }
    expect(await packer(['gateway-result-gz-v1'])(huge)).toBe(huge)
  })
})
