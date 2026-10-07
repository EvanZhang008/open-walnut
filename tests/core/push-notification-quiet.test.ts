/**
 * Quiet mode stops push (src/core/push-notification.ts + src/core/push/letter-push.ts).
 *
 *   - the generic sender (cron results, session results, triage) sends NOTHING
 *     while a quiet hold is live, and sends again the moment it clears. None of
 *     its events is a permission ask, so no hold lets any of them through.
 *   - a letter push is skipped with its per-letter summary saying why, EXCEPT an
 *     `action_required` letter (someone is blocked on the decision) while the
 *     holds allow permissions. A hold with allowPermissions:false stops that too.
 *
 * Transport is stubbed (Expo at `fetch`, APNs at the module boundary), so nothing
 * leaves the process.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

const clientCount = vi.hoisted(() => vi.fn(() => 0))
const getConfig = vi.hoisted(() => vi.fn())
const sendApns = vi.hoisted(() => vi.fn(async () => ({
  attempted: true, sent: 1, failed: 0, deadTokens: [] as string[],
})))

vi.mock('../../src/constants.js', () => createMockConstants('push-quiet-test'))
vi.mock('../../src/web/ws/handler.js', () => ({ clientCount }))
vi.mock('../../src/core/config-manager.js', () => ({ getConfig, updatePushTokens: vi.fn() }))
vi.mock('../../src/core/push/apns.js', () => ({ sendApns }))

import { WALNUT_HOME } from '../../src/constants.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { initPushNotifications } from '../../src/core/push-notification.js'
import { pushLetter } from '../../src/core/push/letter-push.js'
import { clearQuiet, setQuiet, stopQuiet } from '../../src/core/quiet/quiet-state.js'

let fetchMock: ReturnType<typeof vi.fn>

async function cronAndSettle(): Promise<void> {
  bus.emit(EventNames.CRON_NOTIFICATION, { jobName: 'Backup', text: 'done' } as never, ['push-notifications'], { source: 'test' })
  // The handler is fire-and-forget; give it a real window to (not) send.
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 10))
}

beforeEach(() => {
  // Memory AND disk: a hold persisted by the previous test would reload here.
  stopQuiet()
  fs.rmSync(path.join(WALNUT_HOME, 'quiet.json'), { force: true })
  bus.clear()
  sendApns.mockClear()
  clientCount.mockReturnValue(0)
  getConfig.mockResolvedValue({
    push_tokens: [
      { token: 'ExponentPushToken[test]', platform: 'ios', key_name: 'expo', registered_at: new Date().toISOString() },
      { token: 'a'.repeat(64), platform: 'ios', kind: 'apns', key_name: 'iPhone', registered_at: new Date().toISOString(), mode: 'always' },
    ],
  })
  fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
    const messages = JSON.parse(init?.body ?? '[]') as unknown[]
    return { ok: true, json: async () => ({ data: messages.map(() => ({ status: 'ok' })) }) }
  })
  vi.stubGlobal('fetch', fetchMock)
  initPushNotifications()
})

afterEach(() => {
  bus.clear()
  vi.unstubAllGlobals()
  stopQuiet()
})

describe('generic push', () => {
  it('sends nothing while quiet, and sends again once the hold clears', async () => {
    await setQuiet({ source: 'user' })
    await cronAndSettle()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sendApns).not.toHaveBeenCalled()

    await clearQuiet('user')
    await cronAndSettle()
    // One send per service: the Expo row through Expo, the APNs row through Apple.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sendApns).toHaveBeenCalledTimes(1)
  })

  it('is not let through by allowPermissions (none of its events is an ask)', async () => {
    await setQuiet({ source: 'plugin:walnut-rhythm', allowPermissions: true })
    await cronAndSettle()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sendApns).not.toHaveBeenCalled()
  })
})

describe('letter push', () => {
  const letter = (type: string) => ({
    letterId: `l-${type}`, subject: 'Subject', type, textPreview: 'preview', kind: 'new' as const,
  })

  it('skips an informational letter while quiet, saying why', async () => {
    await setQuiet({ source: 'user' })
    const out = await pushLetter(letter('info'))
    expect(out).toMatchObject({ attempted: false, sent: 0, reason: 'quiet mode is on' })
    expect(sendApns).not.toHaveBeenCalled()
  })

  it('still pushes an action_required letter while the holds allow permissions', async () => {
    await setQuiet({ source: 'user' })
    const out = await pushLetter(letter('action_required'))
    expect(out.sent).toBeGreaterThan(0)
    expect(sendApns).toHaveBeenCalledTimes(1)
  })

  it('a hold with allowPermissions:false silences action_required too', async () => {
    await setQuiet({ source: 'plugin:walnut-rhythm', allowPermissions: false })
    const out = await pushLetter(letter('action_required'))
    expect(out).toMatchObject({ attempted: false, reason: 'quiet mode is on' })
    expect(sendApns).not.toHaveBeenCalled()
  })

  it('pushes normally when not quiet', async () => {
    const out = await pushLetter(letter('info'))
    expect(out.sent).toBeGreaterThan(0)
  })
})
