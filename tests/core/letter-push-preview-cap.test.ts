/**
 * A letter's push carries at most 300 characters of its text, for a new letter
 * and for a reply, end to end: the real letter store, the real bus and the real
 * letter push subscriber, with APNs stubbed at the module boundary.
 *
 * The number is a promise to the user (the privacy text says "up to 300
 * characters of preview"), so it is pinned as a literal here, not read from
 * LETTER_PREVIEW_MAX_CHARS: raising the constant must fail this file. Two caps
 * hold it: the store bounds the preview it emits (a reply's too, which once
 * passed its full text), and letter-push.ts bounds the body again at the push
 * boundary. Both are checked, the event and the push, so neither can go alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('letter-push-preview-cap'))

const getConfig = vi.hoisted(() => vi.fn())
const updatePushTokens = vi.hoisted(() => vi.fn(async () => []))
const sendApns = vi.hoisted(() => vi.fn(async (targets: unknown[]) => ({
  attempted: true, sent: targets.length, failed: 0, deadTokens: [] as string[],
})))
vi.mock('../../src/core/config-manager.js', () => ({ getConfig, updatePushTokens }))
vi.mock('../../src/core/push/apns.js', () => ({
  sendApns,
  apnsStatus: vi.fn(async () => ({ configured: true, environment: 'production', topic: 'test' })),
}))
vi.mock('../../src/core/notifications/letter-bridge.js', () => ({
  ensureLetterBridge: () => {},
  mirrorLetterReadState: vi.fn(async () => {}),
}))

import { bus, EventNames } from '../../src/core/event-bus.js'
import { agentReply, humanInboxPaths, sendLetter } from '../../src/core/human-inbox/store.js'
import { LETTER_PREVIEW_MAX_CHARS } from '../../src/core/human-inbox/types.js'
import { initLetterPush, letterPushContent, resetLetterPushForTests } from '../../src/core/push/letter-push.js'
import type { PushTokenEntry } from '../../src/core/types.js'

/** The promise, as a literal. */
const PREVIEW_PROMISE = 300
const APNS_TOKEN = 'd'.repeat(64)
/** Over 2,000 characters of words, so a cap cuts on a word edge like a real letter. */
const LONG = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ')
const SENDER = { sessionId: 'sess-acme-1', host: 'local', taskId: 'task-acme-1' }

interface PushedAlert { title: string; body: string }
function pushedBodies(): string[] {
  return sendApns.mock.calls.map((c) => ((c as unknown as [unknown, { aps: { alert: PushedAlert } }])[1]).aps.alert.body)
}

const letterEvents: Array<{ kind: string; textPreview: string }> = []

beforeEach(() => {
  fs.rmSync(humanInboxPaths.dir, { recursive: true, force: true })
  sendApns.mockClear()
  getConfig.mockResolvedValue({
    push_tokens: [{ token: APNS_TOKEN, key_name: 'acme-phone', platform: 'ios', mode: 'always' } as PushTokenEntry],
  })
  // A fresh bus: the letter push subscriber is registered by `initLetterPush` in
  // the test that wants it, never left over from the one before.
  bus.clear()
  resetLetterPushForTests()
  letterEvents.length = 0
  bus.subscribe('preview-cap-probe', (event) => {
    if (event.name !== EventNames.HUMAN_INBOX_LETTER) return
    const data = event.data as { kind: string; textPreview: string }
    letterEvents.push({ kind: data.kind, textPreview: data.textPreview })
  }, { global: true, interest: ['human-inbox:'] })
})

it('the preview cap is the promised 300 characters', () => {
  expect(LETTER_PREVIEW_MAX_CHARS).toBe(PREVIEW_PROMISE)
})

describe('a long letter on the push path', () => {
  it('a new letter: the event and the push carry at most 300 characters, cut on a word edge', async () => {
    initLetterPush()
    await sendLetter({ subject: 'Marina trip plan', type: 'review', markdown: LONG, text: LONG, sender: SENDER })
    await vi.waitFor(() => expect(sendApns).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 25 })
    const [event] = letterEvents
    expect(event.kind).toBe('new')
    expect(event.textPreview.length).toBeLessThanOrEqual(PREVIEW_PROMISE)
    expect(event.textPreview.length).toBeGreaterThan(PREVIEW_PROMISE - 40)
    expect(LONG.startsWith(event.textPreview)).toBe(true)
    const [body] = pushedBodies()
    expect(body).toBe(event.textPreview)
  })

  it('a reply: the event and the push carry at most 300 characters of the reply text', async () => {
    const letter = await sendLetter({ subject: 'Marina trip plan', type: 'review', markdown: 'Short.', text: 'Short.', sender: SENDER })
    initLetterPush()
    await agentReply(letter.id, { text: LONG })
    await vi.waitFor(() => expect(sendApns).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 25 })
    const reply = letterEvents.find((e) => e.kind === 'reply')!
    expect(reply.textPreview.length).toBeLessThanOrEqual(PREVIEW_PROMISE)
    expect(reply.textPreview.length).toBeGreaterThan(PREVIEW_PROMISE - 40)
    expect(LONG.startsWith(reply.textPreview)).toBe(true)
    const [body] = pushedBodies()
    expect(body).toBe(reply.textPreview)
    expect((sendApns.mock.calls[0] as unknown as [unknown, { aps: { alert: PushedAlert } }])[1].aps.alert.title).toBe('Reply: Marina trip plan')
  })
})

describe('the push boundary caps on its own', () => {
  it('a preview over 300 characters from any producer is cut to 300 in the push body', () => {
    const content = letterPushContent({ letterId: 'lt-m9x2k1-a4f7', subject: 'Marina', type: 'info', textPreview: LONG, kind: 'reply' })
    expect(content.body.length).toBeLessThanOrEqual(PREVIEW_PROMISE)
    expect(LONG.startsWith(content.body)).toBe(true)
  })

  it('an empty preview still says something', () => {
    const content = letterPushContent({ letterId: 'lt-m9x2k1-a4f7', subject: 'Marina', type: 'info', textPreview: '', kind: 'new' })
    expect(content.body).toBe('Open Walnut to read it')
  })
})
