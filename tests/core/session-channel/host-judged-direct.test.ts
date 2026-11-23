/**
 * The one rule for the companion's direct daemon paths (src/core/session-channel/host-judged-direct.ts):
 * a session its host judges (the copy's row says `judge: 'host'`, or a listener link claimed it) is
 * never written into its CLI by the companion. Not by the direct send funnel (deliverDirectToHost),
 * not by the banked-send sweep (the row stays banked, the Mac is not asked to give it back), and a
 * phone send, Stop or prompt answer while no host link stands (a restarted companion) is a 503
 * bridge_offline (the code the phone retries).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-judged-direct', { CLOUD_MODE: true }))

const bridgeRequestMock = vi.fn()
class BridgeOfflineError extends Error {}
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeRequest: bridgeRequestMock, bridgeRequestPrepared: bridgeRequestMock, BridgeOfflineError,
  bridgeForHost: (h: string) => ({ connected: h !== '__local__' }), bridgeHasCapability: () => true, bridgeHosts: () => ['devbox'],
  bridgeAttachSession: async () => {}, bridgeDetachSession: () => {}, attachBridge: () => {}, closeAllBridges: () => {},
  setMobileEventHandler: () => {}, addPrimaryBridgeConnectedHandler: () => () => {}, addBridgeConnectedHandler: () => () => {},
}))
const k = vi.hoisted(() => ({ copy: [] as Array<Record<string, unknown>> }))
// No backup leader on this box: the Mac's bridge alone says it is away (companion-host-ops.ts macAway).
vi.mock('../../../src/core/leader/backup-leader.js', async (orig) => ({ ...(await orig<object>()), getBackupLeader: async () => null }))
vi.mock('../../../src/core/session-projection.js', async (orig) => ({
  ...(await orig<object>()),
  readSessionProjection: async () => ({ version: 1, exportedAt: new Date().toISOString(), sessions: k.copy }),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { directToDaemonAllowed, hostJudgedAlias } from '../../../src/core/session-channel/host-judged-direct.js'
import { _resetCompanionListenerForTesting, attachHostListener } from '../../../src/core/session-channel/companion-listener.js'
import { hostRoute } from '../../../src/core/session-channel/companion-host-ops.js'
import { deliverDirectToHost } from '../../../src/core/sessions/direct-host-send.js'
import { enqueueSessionSend, flushSendQueue, listBankedSends } from '../../../src/core/send-queue.js'

const JUDGED = { id: 'hj-1', host: 'devbox', judge: 'host', process_status: 'idle', started_at: '', last_active_at: '', message_count: 1 }
const PLAIN = { id: 'pl-1', host: 'devbox', process_status: 'idle', started_at: '', last_active_at: '', message_count: 1 }
const commands = () => bridgeRequestMock.mock.calls.map((c) => String(c[1])).filter((c) => c !== 'ping')

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bridgeRequestMock.mockReset()
  _resetCompanionListenerForTesting()
  k.copy = [JUDGED, PLAIN]
})
afterEach(async () => {
  bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
  await flushSendQueue()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('which sessions are their host\'s own', () => {
  it('the copy\'s judge, or a listener\'s claim; any other session may take the direct path', async () => {
    expect(await hostJudgedAlias('hj-1')).toBe('devbox')
    expect(await hostJudgedAlias('pl-1')).toBeNull()
    expect(await directToDaemonAllowed('pl-1', 'test')).toBe(true)
    expect(await directToDaemonAllowed('hj-1', 'test')).toBe(false)
    // Born while the Mac was away: no copy row yet, the link's claim says it.
    const h = attachHostListener('devbox', 'ab'.repeat(16), { send: () => {}, close: () => {} })
    h.onText(JSON.stringify({ ch: 'sf', op: 'rows', rows: [{ claudeSessionId: 'nb-1', judge: 'host', host: 'devbox', process_status: 'idle', startedAt: '', lastActiveAt: '' }], upTo: 1, rowsAt: 1, logId: 'L' }))
    await h.idle()
    expect(await hostJudgedAlias('nb-1')).toBe('devbox')
  })
})

describe('the direct paths refuse it', () => {
  it('the direct send funnel sends nothing and keeps the message (offline, never ambiguous)', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true })
    const out = await deliverDirectToHost({ host: 'devbox', sessionId: 'hj-1', text: 'hi', messageId: 'qm-mobile-d1', stopFence: null })
    expect(out).toMatchObject({ ok: false, kind: 'transport', offline: true, ambiguous: false, hostJudged: true })
    expect(commands()).toEqual([])
  })

  it('the banked-send sweep leaves its row banked: no direct send and no ask to the Mac to give it back', async () => {
    bridgeRequestMock.mockImplementation(async (_h: string, cmd: string) => {
      if (cmd === 'session.message') return { ok: false, error: 'no primary server connected' }
      return { ok: true }
    })
    await enqueueSessionSend('hj-1', 'devbox', 'held', 'qm-mobile-d2', null, { acceptedAt: Date.now(), provablyUnsent: true })
    await flushSendQueue()
    expect((await listBankedSends()).map((op) => op.messageId)).toEqual(['qm-mobile-d2'])
    expect(commands().filter((c) => c !== 'session.message')).toEqual([])
  })

  it('a restarted companion (no link claim yet), the Mac away: send, Stop and a prompt answer are 503 bridge_offline', async () => {
    expect(await hostRoute('hj-1')).toMatchObject({ kind: 'refuse', status: 503, code: 'bridge_offline' })
    expect(await hostRoute('pl-1')).toEqual({ kind: 'none' })
  })
})
