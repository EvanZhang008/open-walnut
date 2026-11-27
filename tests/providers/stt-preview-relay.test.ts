/**
 * A live draft of the phone's voice mode, relayed by the companion to the Mac ('stt-preview-v1'):
 * the daemon carries the `preview` flag to the Mac's server, and the Mac runs a preview pass while
 * a piece of a take heard ahead waits (take-ahead.ts). Without the flag the relay is the take's own
 * transcription, exactly as before.
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-stt-preview-relay'))
const transcribeAudio = vi.hoisted(() => vi.fn(async () => ({ text: 'turn on the lights', durationMs: 9 })))
vi.mock('../../src/core/stt/index.js', () => ({ transcribeAudio }))
const released = vi.hoisted(() => vi.fn())
const noteLiveDraft = vi.hoisted(() => vi.fn(() => released))
const sttConfig = vi.hoisted(() => ({ stt: {} as Record<string, unknown> }))
vi.mock('../../src/core/config-manager.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/config-manager.js')>()), getConfig: async () => sttConfig,
}))
vi.mock('../../src/core/stt/take-ahead.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/stt/take-ahead.js')>()), noteLiveDraft,
}))

import { createDaemonBridgeRelays } from '../../src/providers/daemon-bridge-relays.js'
import { DaemonConnection } from '../../src/providers/daemon-connection.js'

type Ws = { name: string }

function relays() {
  const events: Array<{ ws: Ws; ev: string; data: Record<string, unknown> }> = []
  const server: Ws = { name: 'server' }
  const deps = {
    walnutScope: {} as never,
    gatewayClientHomes: new WeakMap<Ws, string>(),
    pickTrustedClient: () => ({ client: server, quiet: 0, quietForMs: null }),
    noPrimaryError: () => 'no primary',
    answersForOtherWalnut: () => false,
    bridgeHomeOf: () => '',
    bridgeLinkFor: () => null,
    wsId: () => 1,
    setTimeout: ((fn: () => void) => ({ fn })) as unknown as typeof globalThis.setTimeout,
    clearTimeout: (() => {}) as typeof globalThis.clearTimeout,
    logMsg: () => {},
    sendOk: () => {},
    sendError: () => {},
    sendEvent: (ws: Ws, ev: string, data: Record<string, unknown>) => { events.push({ ws, ev, data }) },
    sendFrame: () => {},
  }
  return { r: createDaemonBridgeRelays<Ws>(deps as never), events }
}

describe('the daemon relays a draft flag to the Mac', () => {
  it('carries preview only when it is true, and never invents it', () => {
    const { r, events } = relays()
    const bridge: Ws = { name: 'bridge' }
    r.cmdSttRelay(bridge, 1, { audio: 'AAAA', format: 'wav', language: 'en', preview: true })
    r.cmdSttRelay(bridge, 2, { audio: 'AAAA', format: 'wav' })
    r.cmdSttRelay(bridge, 3, { audio: 'AAAA', format: 'wav', preview: 'yes' })
    expect(events.map((e) => [e.ev, e.data.preview])).toEqual([
      ['stt-request', true], ['stt-request', undefined], ['stt-request', undefined],
    ])
    expect('preview' in events[1]!.data).toBe(false)
  })
})

describe("the Mac's answer to a relayed request", () => {
  function conn() {
    const c = new DaemonConnection('__local__', null)
    const sent: Array<{ cmd: string; params: Record<string, unknown> }> = []
    ;(c as unknown as { send: (cmd: string, params: Record<string, unknown>) => Promise<unknown> }).send = async (cmd, params) => { sent.push({ cmd, params }); return { ok: true } }
    const handle = (event: Record<string, unknown>) => (c as unknown as { handleSttRequest: (e: unknown) => Promise<void> }).handleSttRequest(event)
    return { sent, handle }
  }

  it('runs a draft as a preview pass, holding take-ahead pieces while it runs', async () => {
    transcribeAudio.mockClear(); noteLiveDraft.mockClear(); released.mockClear()
    const { sent, handle } = conn()
    await handle({ ev: 'stt-request', relayId: 7, audio: 'AAAA', format: 'wav', preview: true })
    expect(transcribeAudio.mock.calls[0]![1]).toMatchObject({ audio: 'AAAA', format: 'wav', preview: true })
    expect(noteLiveDraft).toHaveBeenCalledTimes(1)
    expect(released).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([{ cmd: 'stt-result', params: { relayId: 7, text: 'turn on the lights', durationMs: 9 } }])
  })

  it("runs the take's own transcription as before when the flag is absent", async () => {
    transcribeAudio.mockClear(); noteLiveDraft.mockClear()
    const { handle } = conn()
    await handle({ ev: 'stt-request', relayId: 8, audio: 'AAAA', format: 'wav' })
    expect(transcribeAudio.mock.calls[0]![1]).not.toHaveProperty('preview')
    expect(noteLiveDraft).not.toHaveBeenCalled()
  })

  it('never sends a draft to the hosted API, even when it is the Mac\'s own engine', async () => {
    transcribeAudio.mockClear(); noteLiveDraft.mockClear()
    sttConfig.stt = { engine: 'openai' }
    try {
      const { sent, handle } = conn()
      await handle({ ev: 'stt-request', relayId: 10, audio: 'AAAA', format: 'wav', preview: true })
      expect(transcribeAudio).not.toHaveBeenCalled()
      expect(noteLiveDraft).not.toHaveBeenCalled()
      expect(sent[0]!.params).toMatchObject({ relayId: 10, error: 'Live words need a voice engine on your own machine' })
      // The take itself still goes to the engine the person chose.
      await handle({ ev: 'stt-request', relayId: 11, audio: 'AAAA', format: 'wav' })
      expect(transcribeAudio).toHaveBeenCalledTimes(1)
    } finally {
      sttConfig.stt = {}
    }
  })

  it('lets the take-ahead pieces go on when the draft fails', async () => {
    transcribeAudio.mockClear(); released.mockClear()
    transcribeAudio.mockRejectedValueOnce(new Error('The speech model is still loading'))
    const { sent, handle } = conn()
    await handle({ ev: 'stt-request', relayId: 9, audio: 'AAAA', format: 'wav', preview: true })
    expect(released).toHaveBeenCalledTimes(1)
    expect(sent[0]!.params).toMatchObject({ relayId: 9, error: 'The speech model is still loading' })
  })
})
