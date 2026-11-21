/**
 * Quiet mode stops push (src/core/push-notification.ts + src/core/push/letter-push.ts).
 *
 *   - the generic sender (cron results, session results, triage) sends NOTHING
 *     while a quiet hold is live, and sends again the moment it clears. None of
 *     its events is a permission ask, so no hold lets any of them through.
 *   - a letter push is skipped with its per-letter summary saying why, an
 *     `action_required` letter too (2026-11-17, the user: nothing outside the window
 *     during a focus block); the end of quiet sends ONE push for what waited
 *     (src/core/push/quiet-hold.ts).
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
// The inbox as the reminder after quiet reads it: l-second was read meanwhile, the others wait.
// The tasks a focus scope reads: a subtask under the focused task, and one elsewhere.
vi.mock('../../src/core/task-manager.js', () => ({
  scopeTaskLookup: async () => (id: string) => ({
    'task-focus': { id: 'task-focus', project: 'Personal' },
    'task-sub': { id: 'task-sub', project: 'Personal', parent_task_id: 'task-focus' },
    'task-other': { id: 'task-other', project: 'Acme' },
  } as Record<string, { id: string; project: string; parent_task_id?: string }>)[id],
}))
vi.mock('../../src/core/human-inbox/store.js', () => ({
  getLetter: async (id: string) => ({ id, read: id === 'l-second' }),
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { initPushNotifications } from '../../src/core/push-notification.js'
import { pushLetter } from '../../src/core/push/letter-push.js'
import { clearQuiet, setQuiet, stopQuiet } from '../../src/core/quiet/quiet-state.js'
import { heldPushes, resetQuietHold } from '../../src/core/push/quiet-hold.js'

let fetchMock: ReturnType<typeof vi.fn>

async function cronAndSettle(): Promise<void> {
  bus.emit(EventNames.CRON_NOTIFICATION, { jobName: 'Backup', text: 'done' } as never, ['push-notifications'], { source: 'test' })
  // The handler is fire-and-forget; give it a real window to (not) send.
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 10))
}

beforeEach(() => {
  // Memory AND disk: a hold persisted by the previous test would reload here.
  stopQuiet()
  resetQuietHold()
  fs.rmSync(path.join(WALNUT_HOME, 'quiet.json'), { force: true })
  fs.rmSync(path.join(WALNUT_HOME, 'local', 'quiet-held-push.json'), { force: true })
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
    // The one reminder for what waited, then the new one; each once per service (the Expo
    // row through Expo, the APNs row through Apple).
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(sendApns).toHaveBeenCalledTimes(2)
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

  it('holds an action_required letter too, and the end of quiet sends one push for all that waited', async () => {
    await setQuiet({ source: 'plugin:walnut-rhythm', allowPermissions: true })
    const asked = await pushLetter(letter('action_required'))
    expect(asked).toMatchObject({ attempted: false, reason: 'quiet mode is on' })
    await pushLetter({ ...letter('info'), letterId: 'l-second', subject: 'Second' })
    await cronAndSettle()
    expect(sendApns).not.toHaveBeenCalled()
    expect(heldPushes().count).toBe(3)

    await clearQuiet('plugin:walnut-rhythm')
    for (let i = 0; i < 50 && sendApns.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    expect(sendApns).toHaveBeenCalledTimes(1)
    const payload = JSON.stringify((sendApns.mock.calls[0] as unknown as [unknown, unknown])[1])
    // The letter read meanwhile is not in it: what still waits is the decision and the receipt.
    expect(payload).toContain('2 things waited for you')
    expect(payload).not.toContain('Second')
    expect(heldPushes().count).toBe(0)
  })

  it('a hold that names a task lets that task and its subtasks through, and holds the rest', async () => {
    await setQuiet({ source: 'plugin:walnut-rhythm', scope: { tasks: ['task-focus'] } })
    expect(await pushLetter({ ...letter('info'), senderTaskId: 'task-sub' })).toMatchObject({ sent: 2 })
    expect(await pushLetter({ ...letter('info'), letterId: 'l-other', senderTaskId: 'task-other' }))
      .toMatchObject({ attempted: false, reason: 'quiet mode is on' })
    expect(await pushLetter({ ...letter('info'), letterId: 'l-none' })).toMatchObject({ reason: 'quiet mode is on' })
  })

  it('a second hold without a scope still holds the focused task', async () => {
    await setQuiet({ source: 'plugin:walnut-rhythm', scope: { tasks: ['task-focus'] } })
    await setQuiet({ source: 'user' })
    expect(await pushLetter({ ...letter('info'), senderTaskId: 'task-focus' })).toMatchObject({ reason: 'quiet mode is on' })
  })

  it('what quiet holds outlives a restart, and goes out once quiet is off', async () => {
    await setQuiet({ source: 'user' })
    await pushLetter(letter('action_required'))
    expect(sendApns).not.toHaveBeenCalled()
    // The restart: the process forgets, the files stay; the next server starts after quiet ended.
    resetQuietHold()
    await clearQuiet('user')
    stopQuiet()
    initPushNotifications()
    for (let i = 0; i < 50 && sendApns.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
    expect(sendApns).toHaveBeenCalledTimes(1)
    expect(JSON.stringify((sendApns.mock.calls[0] as unknown as [unknown, unknown])[1])).toContain('Subject')
  })

  it('pushes normally when not quiet', async () => {
    const out = await pushLetter(letter('info'))
    expect(out.sent).toBeGreaterThan(0)
  })
})
