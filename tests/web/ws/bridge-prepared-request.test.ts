import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('bridge-prepared-request', { CLOUD_MODE: true }))
import { attachBridge, bridgeRequest, bridgeRequestPrepared, closeAllBridges, BridgeOfflineError } from '../../../src/web/ws/bridge-registry.js'
import { decodeCloudSessionSend, _closeCloudSessionPayloadWorkersForTesting } from '../../../src/lib/cloud-session-payload.js'

class Peer extends EventEmitter {
  readyState = 1
  sent: Record<string, unknown>[] = []
  fail = false
  send(raw: string): void {
    if (this.fail) throw new Error('socket write failed')
    this.sent.push(JSON.parse(raw))
  }
  close(code = 1000): void { this.readyState = 3; this.emit('close', code, Buffer.alloc(0)) }
  frame(value: Record<string, unknown>): void { this.emit('message', Buffer.from(JSON.stringify(value))) }
}
function peer(): Peer {
  const current = new Peer()
  attachBridge(current as never, 'bridge-peer')
  current.frame({ ev: 'hello', hostAlias: 'peer', sids: [] })
  return current
}
async function params(): Promise<string> {
  return (await decodeCloudSessionSend(Buffer.from(JSON.stringify({
    host: 'peer', sessionId: 'session-a', message: 'queued body',
    uuid: 'aaaaaaaa-1111-4111-8111-111111111111',
    markers: [{ message: 'queued body', messageId: 'qm-a' }], stopFence: null, id: 999, cmd: 'stop',
  })))).paramsJson
}
afterEach(async () => { closeAllBridges(); vi.useRealTimers(); await _closeCloudSessionPayloadWorkersForTesting() })

describe('prepared bridge RPC framing', () => {
  it('keeps normal RPC framing and settles prepared replies through the same request map', async () => {
    const current = peer()
    const first = bridgeRequest('peer', 'ping', { nonce: 'original' })
    current.frame({ id: 1, ok: true, nonce: 'original' })
    expect(await first).toMatchObject({ nonce: 'original' })
    const encoded = await params()
    const sent = bridgeRequestPrepared('peer', 'send', encoded)
    expect(current.sent[1]).toMatchObject({ id: 2, cmd: 'send', sid: 'session-a', dedupe: true })
    expect(current.sent[1].id).not.toBe(999)
    current.frame({ id: 2, ok: true, duplicate: true })
    expect(await sent).toEqual({ id: 2, ok: true, duplicate: true })
  })

  it('rejects a closing or missing bridge before putting any frame on the socket', async () => {
    const encoded = await params()
    await expect(bridgeRequestPrepared('absent', 'send', encoded)).rejects.toBeInstanceOf(BridgeOfflineError)
    const current = peer()
    current.readyState = 2
    await expect(bridgeRequestPrepared('peer', 'send', encoded)).rejects.toBeInstanceOf(BridgeOfflineError)
    expect(current.sent).toEqual([])
  })

  it('clears a timed-out prepared request and does not let its late reply settle a later RPC', async () => {
    const encoded = await params()
    vi.useFakeTimers()
    const current = peer()
    const timed = bridgeRequestPrepared('peer', 'send', encoded, 50).catch((error: Error) => error.message)
    await vi.advanceTimersByTimeAsync(50)
    expect(await timed).toContain('timed out')
    const next = bridgeRequest('peer', 'ping')
    current.frame({ id: 1, ok: true })
    current.frame({ id: 2, ok: true, pong: true })
    expect(await next).toMatchObject({ id: 2, pong: true })
  })

  it('settles prepared calls on write errors and on disconnect without a fallback send', async () => {
    const encoded = await params()
    const current = peer()
    current.fail = true
    await expect(bridgeRequestPrepared('peer', 'send', encoded)).rejects.toThrow('socket write failed')
    current.fail = false
    const pending = bridgeRequestPrepared('peer', 'send', encoded).catch((error: Error) => error.message)
    current.close()
    expect(await pending).toBe('bridge disconnected')
    expect(current.sent).toHaveLength(1)
  })
})
