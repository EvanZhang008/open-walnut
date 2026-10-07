/**
 * A cloud replica never pushes from its own token rows.
 *
 * The PRIMARY owns push: it holds the token registry and the APNs key, and a
 * replica relays `/api/push/*` to it (core/push/relay.ts). Any `push_tokens` a
 * replica still carries are orphans from before that relay existed, so the general
 * subscriber must send to neither service there, whatever the event.
 *
 * Transport is stubbed at both edges (APNs at the module boundary, Expo at
 * `fetch`), so nothing leaves the process.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

const getConfig = vi.hoisted(() => vi.fn())
const clientCount = vi.hoisted(() => vi.fn(() => 0))
const sendApns = vi.hoisted(() => vi.fn(async () => ({
  attempted: true, sent: 1, failed: 0, deadTokens: [] as string[],
})))

vi.mock('../../src/constants.js', () => createMockConstants('push-cloud', { CLOUD_MODE: true }))
vi.mock('../../src/core/config-manager.js', () => ({ getConfig, updatePushTokens: vi.fn() }))
vi.mock('../../src/web/ws/handler.js', () => ({ clientCount }))
vi.mock('../../src/core/push/apns.js', () => ({ sendApns }))

import { bus, EventNames } from '../../src/core/event-bus.js'
import { initPushNotifications } from '../../src/core/push-notification.js'

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  bus.clear()
  sendApns.mockClear()
  getConfig.mockResolvedValue({
    push_tokens: [
      { token: 'a'.repeat(64), platform: 'ios', kind: 'apns', key_name: 'iPhone', registered_at: new Date().toISOString() },
      { token: 'ExponentPushToken[acme]', platform: 'ios', key_name: 'old-phone', registered_at: new Date().toISOString() },
    ],
  })
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }))
  vi.stubGlobal('fetch', fetchMock)
  initPushNotifications()
})

afterEach(() => {
  bus.clear()
  vi.unstubAllGlobals()
})

describe('on a cloud replica', () => {
  it('a background agent reply and a scheduled-job notice push nothing to either service', async () => {
    bus.emit(EventNames.AGENT_RESPONSE, { text: 'done', source: 'cron' } as never, ['push-notifications'], { source: 'test' })
    bus.emit(EventNames.CRON_NOTIFICATION, { jobName: 'Backup', text: 'done' } as never, ['push-notifications'], { source: 'test' })
    // Fire-and-forget handlers: give them a real window to (not) send.
    for (let i = 0; i < 15; i++) await new Promise((r) => setTimeout(r, 10))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sendApns).not.toHaveBeenCalled()
    expect(getConfig).not.toHaveBeenCalled()
  })
})
