/**
 * What a revoked host's daemon brings up its link is refused before anything runs
 * (src/core/session-channel/revoked-reach.ts, the `daemon-event:` and `stream:` rows the daemon
 * link refuses): a voice input, a phone's new session, control change and message, its triggers'
 * reports, and a stream its own server opens toward the leader. The ban is of the machine, so the
 * link is refused under another name of it too (here `devbox-b`, whose hello names the machine of
 * the revoked `devbox-a`). Each relay is answered with the reason, so the phone and the daemon
 * hear it at once; a trigger fire stays unacked on the host.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-revoked-relay'))
const enqueue = vi.hoisted(() => vi.fn())
vi.mock('../../src/core/session-tracker.js', () => ({ getSessionByClaudeId: enqueue, updateSessionRecord: enqueue, updateSessionRecordConditionally: enqueue }))

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { setRevokedHostResolver, setRevokedHosts } from '../../src/core/session-channel/revoked-hosts.js'
import { setTriggerEventSink } from '../../src/core/routines/trigger-bridge.js'

interface Sent { cmd: string; params: Record<string, unknown> }

function conn(hostKey: string): { c: DaemonConnection; sent: Sent[]; call: (method: string, arg: unknown) => Promise<unknown> } {
  const c = new DaemonConnection(hostKey, null)
  const sent: Sent[] = []
  ;(c as unknown as { send: (cmd: string, params: Record<string, unknown>) => Promise<unknown> }).send = async (cmd, params) => { sent.push({ cmd, params }); return { ok: true } }
  const call = (method: string, arg: unknown) => (c as unknown as Record<string, (a: unknown) => Promise<unknown>>)[method](arg)
  return { c, sent, call }
}

afterEach(() => {
  setRevokedHosts([])
  setRevokedHostResolver(null)
  setTriggerEventSink(null)
})

describe('a revoked host\'s daemon link, under another name of its machine', () => {
  it('answers each relay refused with the reason, and runs nothing', async () => {
    setRevokedHosts([{ hostKey: 'devbox-a', machineId: 'm-devbox' }])
    setRevokedHostResolver({ machineOf: (k) => (k === 'devbox-b' ? 'm-devbox' : null), aliasesOf: () => [] })
    const { sent, call } = conn('devbox-b')
    await call('handleSttRequest', { ev: 'stt-request', relayId: 1, audio: 'AAAA', format: 'wav' })
    await call('handleLaunchRequest', { ev: 'launch-request', relayId: 2, action: 'quick-start', params: { message: 'go' } })
    await call('handleControlRequest', { ev: 'control-request', relayId: 3, action: 'model', sessionId: 's-1', params: { model: 'x' } })
    await call('handleMessageRequest', { ev: 'message-request', relayId: 4, sessionId: 's-1', message: 'hi', messageId: 'qm-mobile-r1' })
    expect(sent.map((s) => [s.cmd, s.params.relayId, s.params.errorKind ?? null])).toEqual([
      ['stt-result', 1, null], ['launch-result', 2, 'host_revoked'], ['control-result', 3, 'forbidden'], ['message-result', 4, 'host_revoked'],
    ])
    for (const s of sent) expect(String(s.params.error)).toMatch(/the host devbox-b is revoked \(its machine is revoked\)/)
    // Nothing read a session or queued a message.
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('keeps its triggers\' fires off the sink (unacked on the host) and closes a stream its server opens', async () => {
    setRevokedHosts([{ hostKey: 'devbox-a', machineId: 'm-devbox' }])
    setRevokedHostResolver({ machineOf: (k) => (k === 'devbox-b' ? 'm-devbox' : null), aliasesOf: () => [] })
    const heard: string[] = []
    setTriggerEventSink((host) => { heard.push(host) })
    await conn('devbox-b').call('dispatchTriggerEvent', { ev: 'trigger.fired', id: 'f-1' })
    expect(heard).toEqual([])
    // Another host's fire still reaches the sink.
    await conn('devbox-c').call('dispatchTriggerEvent', { ev: 'trigger.fired', id: 'f-2' })
    expect(heard).toEqual(['devbox-c'])
    const stream = new PassThrough()
    const closed = new Promise<Error | undefined>((r) => { stream.on('error', (e) => r(e)); stream.on('close', () => r(undefined)) })
    await conn('devbox-b').call('plugFollowerStream', stream)
    expect(String((await closed)?.message)).toMatch(/stream:follower refused, nothing ran: the host devbox-b is revoked/)
  })
})
