/**
 * cloud-chat-outbox: the companion's non-git bank of self-answered chat turns,
 * and the flush ladder that hands them to the primary.
 *
 * The rule the ladder encodes: delete only on a definite answer (adopted, a
 * duplicate, or a domain refusal an identical retry would repeat). Everything
 * transport-shaped (no bridge, an old primary, a timeout, a 5xx) keeps the turn
 * and stops the sweep. A timeout is never a refusal: reading one as a refusal is
 * how the sibling send-queue once dropped two user messages (2026-08-21).
 *
 * The bridge and the relay are mocked at the v1-control-relay seam, where the
 * failure vocabulary is already normalized.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-cloud-chat-outbox', { CLOUD_MODE: true }))

const { callPrimaryControlMock, bridge } = vi.hoisted(() => ({
  callPrimaryControlMock: vi.fn(),
  bridge: { connected: true },
}))
vi.mock('../../src/web/routes/v1-control-relay.js', () => ({ callPrimaryControl: callPrimaryControlMock }))
vi.mock('../../src/web/ws/bridge-registry.js', () => ({
  bridgeForHost: () => ({ connected: bridge.connected }),
  addPrimaryBridgeConnectedHandler: () => () => {},
}))

import {
  CLOUD_CHAT_OUTBOX_DIR, bankCloudTurnStart, finishCloudTurn, listCloudTurns, flushCloudChatOutbox,
} from '../../src/core/cloud-chat-outbox.js'

async function bankAnswered(turnId: string, userText = 'q', answerText = 'a') {
  const entry = await bankCloudTurnStart({ turnId, agentId: 'general', conversationId: 'conv-outbox-1', userText })
  expect(entry).not.toBeNull()
  expect(await finishCloudTurn(entry!, { answerText, engine: 'cloud:lane-1' })).toBe(true)
  return entry!
}

const adopted = (turnId: string) => ({ ok: true, result: { turnId, adopted: true, duplicate: false } })

beforeEach(async () => {
  callPrimaryControlMock.mockReset()
  bridge.connected = true
  await fs.rm(CLOUD_CHAT_OUTBOX_DIR, { recursive: true, force: true })
})

describe('banking', () => {
  it('writes one file per turn, readable back oldest first, filterable by conversation', async () => {
    await bankAnswered('turn-outbox-0001')
    await new Promise((r) => setTimeout(r, 5))
    await bankAnswered('turn-outbox-0002')
    const all = await listCloudTurns()
    expect(all.map((e) => e.turnId)).toEqual(['turn-outbox-0001', 'turn-outbox-0002'])
    expect(all[0]).toMatchObject({ state: 'answered', answerText: 'a', engine: 'cloud:lane-1' })
    expect(await listCloudTurns({ conversationId: 'conv-other-1' })).toEqual([])
  })

  it('refuses a turnId that could not be a filename', async () => {
    expect(await bankCloudTurnStart({ turnId: '../x', agentId: 'general', conversationId: 'conv-outbox-1', userText: 'q' }))
      .toBeNull()
  })
})

describe('the flush ladder', () => {
  it('adopted and duplicate both delete; the payload carries the whole turn', async () => {
    await bankAnswered('turn-outbox-0001')
    await bankAnswered('turn-outbox-0002')
    callPrimaryControlMock
      .mockResolvedValueOnce(adopted('turn-outbox-0001'))
      .mockResolvedValueOnce({ ok: true, result: { turnId: 'turn-outbox-0002', adopted: false, duplicate: true } })
    expect(await flushCloudChatOutbox()).toBe(2)
    expect(await listCloudTurns()).toEqual([])
    const [action, sid, payload] = callPrimaryControlMock.mock.calls[0]
    expect(action).toBe('server.chat.adopt')
    expect(sid).toBe('__server__')
    expect(payload).toMatchObject({
      turnId: 'turn-outbox-0001', agentId: 'general', conversationId: 'conv-outbox-1',
      userText: 'q', answerText: 'a', engine: 'cloud:lane-1',
    })
  })

  it.each([
    ['no bridge after all', { ok: false, failure: { kind: 'bridge_offline', message: 'No live bridge' } }],
    ['an old primary', { ok: false, failure: { kind: 'needs_upgrade', message: 'predates this action' } }],
    ['a relay timeout', { ok: false, failure: { kind: 'error', status: 400, code: 'bad_request', message: 'session.control: primary server timed out' } }],
    ['a primary-side crash', { ok: false, failure: { kind: 'error', status: 500, code: 'internal', message: 'boom' } }],
    ['a replica refusing to adopt', {
      ok: false, failure: { kind: 'error', status: 503, code: 'unavailable', message: 'server.chat.adopt runs only on the primary' },
    }],
  ])('%s keeps the turn and stops the sweep', async (_label, reply) => {
    await bankAnswered('turn-outbox-0001')
    await bankAnswered('turn-outbox-0002')
    callPrimaryControlMock.mockResolvedValue(reply)
    expect(await flushCloudChatOutbox()).toBe(0)
    expect(callPrimaryControlMock).toHaveBeenCalledTimes(1)
    expect(await listCloudTurns()).toHaveLength(2)
  })

  it('a domain refusal drops that turn and moves on', async () => {
    await bankAnswered('turn-outbox-0001')
    await bankAnswered('turn-outbox-0002')
    callPrimaryControlMock
      .mockResolvedValueOnce({ ok: false, failure: { kind: 'error', status: 400, code: 'bad_request', message: 'invalid userAt' } })
      .mockResolvedValueOnce(adopted('turn-outbox-0002'))
    expect(await flushCloudChatOutbox()).toBe(1)
    expect(await listCloudTurns()).toEqual([])
  })

  it('never calls the relay while the bridge is down', async () => {
    await bankAnswered('turn-outbox-0001')
    bridge.connected = false
    expect(await flushCloudChatOutbox()).toBe(0)
    expect(callPrimaryControlMock).not.toHaveBeenCalled()
  })

  it('skips a turn still running in THIS process, and adopts one orphaned by a restart as failed', async () => {
    await bankCloudTurnStart({ turnId: 'turn-outbox-live1', agentId: 'general', conversationId: 'conv-outbox-1', userText: 'live' })
    // A `running` entry written by an earlier process of this server.
    const orphan = {
      v: 1, turnId: 'turn-outbox-dead1', agentId: 'general', conversationId: 'conv-outbox-1',
      userText: 'lost mid-turn', userAt: new Date(Date.now() - 1000).toISOString(), state: 'running',
      bootId: 'an-earlier-process', updatedAt: new Date().toISOString(),
    }
    await fs.writeFile(path.join(CLOUD_CHAT_OUTBOX_DIR, 'turn-outbox-dead1.json'), JSON.stringify(orphan))
    callPrimaryControlMock.mockResolvedValue(adopted('turn-outbox-dead1'))

    expect(await flushCloudChatOutbox()).toBe(1)
    expect(callPrimaryControlMock).toHaveBeenCalledTimes(1)
    const payload = callPrimaryControlMock.mock.calls[0][2] as Record<string, unknown>
    expect(payload.turnId).toBe('turn-outbox-dead1')
    expect(payload.answerText).toBeUndefined()
    expect(String(payload.error)).toContain('restarted')
    expect((await listCloudTurns()).map((e) => e.turnId)).toEqual(['turn-outbox-live1'])
  })

  it('a sweep asked for mid-sweep runs once more, so a turn that finished meanwhile is not left for a minute', async () => {
    await bankAnswered('turn-outbox-0001')
    callPrimaryControlMock.mockImplementation(async (_action: string, _sid: string, payload: { turnId: string }) => {
      if (payload.turnId === 'turn-outbox-0001') {
        // A fallback turn finishes while this sweep is still talking to the primary.
        await bankAnswered('turn-outbox-late1')
        expect(await flushCloudChatOutbox()).toBe(0) // busy: deferred, not dropped
      }
      return adopted(payload.turnId)
    })
    expect(await flushCloudChatOutbox()).toBe(1)
    const deadline = Date.now() + 2_000
    while ((await listCloudTurns()).length > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    expect(await listCloudTurns()).toEqual([])
    expect(callPrimaryControlMock.mock.calls.map((c) => (c[2] as { turnId: string }).turnId))
      .toEqual(['turn-outbox-0001', 'turn-outbox-late1'])
  })

  it('clips an oversized answer instead of sending a frame that would close the bridge', async () => {
    await bankAnswered('turn-outbox-0001', 'q', 'x'.repeat(250_000))
    callPrimaryControlMock.mockResolvedValue(adopted('turn-outbox-0001'))
    await flushCloudChatOutbox()
    const payload = callPrimaryControlMock.mock.calls[0][2] as { answerText: string }
    expect(payload.answerText.length).toBeLessThan(201_000)
    expect(payload.answerText.endsWith('[clipped by Walnut]')).toBe(true)
  })
})
