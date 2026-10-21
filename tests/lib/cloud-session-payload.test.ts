import { afterEach, describe, expect, it } from 'vitest'
import {
  decodeCloudSessionSend, encodeCloudSessionPayload, InvalidCloudSessionPayloadError,
  _closeCloudSessionPayloadWorkersForTesting,
} from '../../src/lib/cloud-session-payload.js'

const input = {
  host: 'remote-peer', sessionId: 'session-a', message: 'queued line',
  uuid: 'aaaaaaaa-1111-4111-8111-111111111111',
  markers: [{ message: 'queued line', messageId: 'qm-a' }], stopFence: null,
}
afterEach(async () => { await _closeCloudSessionPayloadWorkersForTesting() })

describe('off-loop session payload worker', () => {
  it.each([600 * 1024, 2 * 1024 * 1024])('encodes and decodes %i bytes with 150 Unicode markers unchanged', async (size) => {
    const unicode = String.fromCodePoint(0x4e2d, 0x6587, 0x1f600)
    const message = 'x'.repeat(size) + unicode
    const markers = Array.from({ length: 150 }, (_, i) => ({ message: `${unicode} ${i}`, messageId: `qm-${i}` }))
    const source = { ...input, message, markers, stopFence: 'stop-a', lostPid: 4242 }
    const encoded = await encodeCloudSessionPayload(source)
    expect(JSON.parse(encoded)).toEqual(source)
    const decoded = await decodeCloudSessionSend(Buffer.from(encoded))
    expect(decoded).toMatchObject({ host: input.host, sessionId: input.sessionId, uuid: input.uuid, lostPid: 4242 })
    expect(Object.keys(decoded).sort()).toEqual(['host', 'lostPid', 'paramsJson', 'sessionId', 'uuid'])
    expect(JSON.parse(decoded.paramsJson)).toEqual({
      sid: input.sessionId, message, markers, uuid: input.uuid, stopFence: 'stop-a', lostPid: 4242, dedupe: true,
    })
  })

  it('constructs only daemon send fields and strips untrusted RPC framing keys', async () => {
    const decoded = await decodeCloudSessionSend(Buffer.from(JSON.stringify({
      ...input, id: 77, cmd: 'stop', dedupe: false, mode: 'bypassPermissions',
      markers: [{ ...input.markers[0], cmd: 'start', id: 9 }],
    })))
    expect(JSON.parse(decoded.paramsJson)).toEqual({
      sid: input.sessionId, message: input.message, uuid: input.uuid, markers: input.markers, stopFence: null, dedupe: true,
    })
  })

  it.each(['{', 'null', '[]', '42', '{"host":"remote-peer"}'])('refuses invalid JSON shape %s', async (raw) => {
    await expect(decodeCloudSessionSend(Buffer.from(raw))).rejects.toBeInstanceOf(InvalidCloudSessionPayloadError)
  })

  it('settles encoding errors and leaves the next job usable', async () => {
    const circular: { self?: unknown } = {}
    circular.self = circular
    await expect(encodeCloudSessionPayload(circular)).rejects.toBeInstanceOf(InvalidCloudSessionPayloadError)
    await expect(encodeCloudSessionPayload({ invalid: 1n })).rejects.toBeInstanceOf(InvalidCloudSessionPayloadError)
    await expect(encodeCloudSessionPayload({ value: () => {} })).rejects.toBeInstanceOf(InvalidCloudSessionPayloadError)
    expect(await encodeCloudSessionPayload({ next: true })).toBe('{"next":true}')
  })

  it('bounds worker start and job deadlines, retires timed-out workers, and recovers', async () => {
    await expect(encodeCloudSessionPayload(input, { timeoutMs: 1 })).rejects.toThrow('deadline')
    expect(JSON.parse(await encodeCloudSessionPayload(input))).toEqual(input)
  })

  it('keeps a burst bounded without truncating any accepted payload', async () => {
    const burst = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => encodeCloudSessionPayload({ i, text: 'x'.repeat(600 * 1024) })))
    expect(burst.filter((result) => result.status === 'rejected')).toHaveLength(2)
    for (let i = 0; i < 10; i++) {
      const result = burst[i]
      expect(result.status).toBe('fulfilled')
      if (result.status === 'fulfilled') expect(JSON.parse(result.value)).toEqual({ i, text: 'x'.repeat(600 * 1024) })
    }
  })
})
