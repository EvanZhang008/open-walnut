/**
 * Every push reaches each device through the service its token belongs to, once.
 *
 * The privacy rule this file pins: push content goes to Expo (`exp.host`) ONLY
 * for a token that is an Expo token. The general notification subscriber
 * (src/core/push-notification.ts) used to post every event to Expo for EVERY
 * registered token. The native iPhone app registers raw APNs tokens, so Expo
 * rejected each one, but only after the title and up to 200 characters of the
 * agent's reply had already left the Mac for a third party.
 *
 * Contract under test, for every event the general subscriber handles and for
 * letters:
 *   - an APNs token never appears in a request to exp.host, and an event with only
 *     APNs tokens registered makes no exp.host request at all;
 *   - an APNs token gets exactly one APNs send, an Expo token exactly one Expo
 *     message, whatever the mix;
 *   - the token's SHAPE decides the service; a stored `kind` label that disagrees
 *     cannot route a hex token to Expo;
 *   - the existing gates still hold (a watching WS client, quiet mode, the
 *     interactive/interrupted/delivery_failed skips), and a gated event sends to
 *     neither service.
 *
 * Transport is stubbed at both edges: APNs at the module boundary, Expo at
 * `fetch`. Nothing leaves the process.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

const getConfig = vi.hoisted(() => vi.fn())
/** Mirrors the real atomic helper: hand the mutator the current rows. */
const updatePushTokens = vi.hoisted(() => vi.fn(
  async (mutate: (t: unknown[]) => unknown[] | null) => mutate([]) ?? [],
))
const clientCount = vi.hoisted(() => vi.fn(() => 0))
const sendApns = vi.hoisted(() => vi.fn(async (targets: unknown[]) => ({
  attempted: true, sent: targets.length, failed: 0, deadTokens: [] as string[],
})))
const getSessionByClaudeId = vi.hoisted(() => vi.fn())

vi.mock('../../src/constants.js', () => createMockConstants('push-routing'))
vi.mock('../../src/core/config-manager.js', () => ({ getConfig, updatePushTokens }))
vi.mock('../../src/web/ws/handler.js', () => ({ clientCount }))
vi.mock('../../src/core/session-tracker.js', () => ({ getSessionByClaudeId }))
vi.mock('../../src/core/push/apns.js', () => ({
  sendApns,
  apnsStatus: vi.fn(async () => ({ configured: true, environment: 'production', topic: 'test' })),
  recordApnsError: vi.fn(),
  closeApnsSessions: vi.fn(),
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { initPushNotifications } from '../../src/core/push-notification.js'
import { initLetterPush, pushLetter, resetLetterPushForTests } from '../../src/core/push/letter-push.js'
import { setQuiet, stopQuiet } from '../../src/core/quiet/quiet-state.js'
import { log } from '../../src/logging/index.js'
import type { PushTokenEntry } from '../../src/core/types.js'
// Warm the module the lane lookup reaches through a dynamic import, so the first
// push in this file is not slowed by a cold resolve.
import '../../src/core/sessions/personal-ai-lane.js'

const EXPO_URL_PREFIX = 'https://exp.host/'
/** A native iPhone's token: raw hex, as APNs mints it. */
const APNS_TOKEN = 'e'.repeat(64)
const OTHER_APNS_TOKEN = 'f'.repeat(64)
/** A row left by the retired Expo build of the app. */
const EXPO_TOKEN = 'ExponentPushToken[acme-phone-1]'
/** Unicode on purpose (an arrow and two CJK characters): the reply rides as is. */
const REPLY = 'Moved 3 tasks to tomorrow \u2192 \u4eca\u5929 is clear.'

function apnsRow(over: Partial<PushTokenEntry> = {}): PushTokenEntry {
  return {
    token: APNS_TOKEN, platform: 'ios', kind: 'apns', environment: 'production',
    key_name: 'iPhone', registered_at: new Date().toISOString(), mode: 'always', ...over,
  }
}

function expoRow(over: Partial<PushTokenEntry> = {}): PushTokenEntry {
  return {
    token: EXPO_TOKEN, platform: 'ios', key_name: 'old-phone',
    registered_at: new Date().toISOString(), ...over,
  }
}

interface ExpoMessage { to: string; title: string; body: string; data?: Record<string, unknown> }

let fetchMock: ReturnType<typeof vi.fn>
/** What the Expo stub answers per message; the default is an ok ticket. */
let expoTicket: (m: ExpoMessage) => Record<string, unknown> = () => ({ status: 'ok', id: 'ticket' })

function expoCalls(): Array<{ url: string; messages: ExpoMessage[]; raw: string }> {
  return fetchMock.mock.calls
    .filter((c) => String(c[0]).startsWith(EXPO_URL_PREFIX))
    .map((c) => {
      const raw = String((c[1] as { body?: string } | undefined)?.body ?? '[]')
      return { url: String(c[0]), messages: JSON.parse(raw) as ExpoMessage[], raw }
    })
}

type ApnsCall = [Array<{ token: string; environment?: string }>, Record<string, any>, Record<string, unknown>]
function apnsCalls(): ApnsCall[] {
  return sendApns.mock.calls as unknown as ApnsCall[]
}

/**
 * Let the fire-and-forget bus handler finish. With `expectSend`, wait for the
 * first transport call, then until the counts stop moving; without it, still
 * give the handler a real window, so "nothing was sent" can genuinely fail.
 */
async function settle(expectSend: boolean): Promise<void> {
  const count = (): number => fetchMock.mock.calls.length + sendApns.mock.calls.length
  const deadline = Date.now() + 5_000
  if (expectSend) {
    while (count() === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
  } else {
    await new Promise((r) => setTimeout(r, 150))
  }
  let seen = -1
  while (seen !== count() && Date.now() < deadline) {
    seen = count()
    await new Promise((r) => setTimeout(r, 30))
  }
}

async function emit(name: string, data: Record<string, unknown>, expectSend = true): Promise<void> {
  bus.emit(name, data as never, ['push-notifications'], { source: 'test' })
  await settle(expectSend)
}

beforeEach(() => {
  stopQuiet()
  fs.rmSync(path.join(WALNUT_HOME, 'quiet.json'), { force: true })
  bus.clear()
  vi.clearAllMocks()
  clientCount.mockReturnValue(0)
  sendApns.mockImplementation(async (targets: unknown[]) => ({
    attempted: true, sent: targets.length, failed: 0, deadTokens: [],
  }))
  updatePushTokens.mockImplementation(
    async (mutate: (t: unknown[]) => unknown[] | null) => mutate([]) ?? [],
  )
  getSessionByClaudeId.mockImplementation(async (sid: string) => (
    sid === 'lane-sid' ? { claudeSessionId: sid, lane: 'chat:general:conv-abc' } : { claudeSessionId: sid }
  ))
  getConfig.mockResolvedValue({ push_tokens: [apnsRow(), expoRow()] })
  expoTicket = () => ({ status: 'ok', id: 'ticket' })
  fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
    const messages = JSON.parse(init?.body ?? '[]') as ExpoMessage[]
    return { ok: true, status: 200, json: async () => ({ data: messages.map((m) => expoTicket(m)) }) }
  })
  vi.stubGlobal('fetch', fetchMock)
  resetLetterPushForTests()
  initPushNotifications()
})

afterEach(async () => {
  await settle(false)
  bus.clear()
  vi.unstubAllGlobals()
  stopQuiet()
})

describe('an APNs token never reaches exp.host', () => {
  it('an agent reply with only an APNs token registered makes no request to exp.host', async () => {
    getConfig.mockResolvedValue({ push_tokens: [apnsRow()] })
    await emit(EventNames.AGENT_RESPONSE, { text: REPLY, source: 'cron', agentId: 'general' })

    // The leak: before the fix this was one POST to exp.host carrying the APNs
    // token, the title and the reply text.
    expect(expoCalls()).toEqual([])
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain('exp.host')
      expect(String((call[1] as { body?: string } | undefined)?.body ?? '')).not.toContain(APNS_TOKEN)
      expect(String((call[1] as { body?: string } | undefined)?.body ?? '')).not.toContain(REPLY)
    }
    // And the phone is still told, through Apple.
    expect(apnsCalls()).toHaveLength(1)
    const [targets, payload] = apnsCalls()[0]
    expect(targets.map((t) => t.token)).toEqual([APNS_TOKEN])
    expect(payload.aps.alert).toEqual({ title: 'Walnut', body: REPLY })
    expect(payload.type).toBe('agent_response')
  })

  it('the token shape wins over a stored kind label: a hex token marked expo still goes to APNs', async () => {
    getConfig.mockResolvedValue({ push_tokens: [apnsRow({ kind: 'expo' })] })
    await emit(EventNames.AGENT_RESPONSE, { text: REPLY, source: 'heartbeat' })
    expect(expoCalls()).toEqual([])
    expect(apnsCalls()).toHaveLength(1)
    expect(apnsCalls()[0][0].map((t) => t.token)).toEqual([APNS_TOKEN])
  })

  it('an Expo token marked apns still goes to Expo, never to Apple', async () => {
    getConfig.mockResolvedValue({ push_tokens: [expoRow({ kind: 'apns' })] })
    await emit(EventNames.AGENT_RESPONSE, { text: REPLY, source: 'heartbeat' })
    expect(apnsCalls()).toHaveLength(0)
    expect(expoCalls()).toHaveLength(1)
    expect(expoCalls()[0].messages.map((m) => m.to)).toEqual([EXPO_TOKEN])
  })

  it('a letter to an APNs device and an Expo device: each service sees only its own token', async () => {
    const out = await pushLetter({
      letterId: 'lt-m9x2k1-a4f7', subject: 'Review ready', type: 'review',
      textPreview: REPLY, kind: 'new',
    })
    expect(out).toMatchObject({ attempted: true, sent: 2, failed: 0 })
    expect(apnsCalls()).toHaveLength(1)
    expect(apnsCalls()[0][0].map((t) => t.token)).toEqual([APNS_TOKEN])
    const expo = expoCalls()
    expect(expo).toHaveLength(1)
    expect(expo[0].messages.map((m) => m.to)).toEqual([EXPO_TOKEN])
    expect(expo[0].raw).not.toContain(APNS_TOKEN)
    expect(expo[0].messages[0].data).toMatchObject({ type: 'human_inbox_letter', letterId: 'lt-m9x2k1-a4f7' })
  })
})

/**
 * One row per event the general subscriber turns into a push. Every one must
 * reach the APNs token through Apple and the Expo token through Expo, once each.
 */
const EVENTS: Array<{
  name: string
  event: string
  data: Record<string, unknown>
  title: string
  body: string
  type: string
}> = [
  { name: 'a cron agent reply', event: EventNames.AGENT_RESPONSE, data: { text: REPLY, source: 'cron' }, title: 'Walnut', body: REPLY, type: 'agent_response' },
  { name: 'a heartbeat agent reply', event: EventNames.AGENT_RESPONSE, data: { text: REPLY, source: 'heartbeat' }, title: 'Walnut', body: REPLY, type: 'agent_response' },
  { name: 'a triage agent reply', event: EventNames.AGENT_RESPONSE, data: { text: REPLY, source: 'triage' }, title: 'Walnut', body: REPLY, type: 'agent_response' },
  { name: 'a Personal AI lane result', event: EventNames.SESSION_RESULT, data: { sessionId: 'lane-sid', result: REPLY }, title: 'Walnut', body: REPLY, type: 'session_result' },
  { name: 'a coding session result', event: EventNames.SESSION_RESULT, data: { sessionId: 'plain-sid-1234', result: REPLY }, title: 'Session Complete', body: 'Session plain-si finished', type: 'session_result' },
  { name: 'a Personal AI lane error', event: EventNames.SESSION_ERROR, data: { sessionId: 'lane-sid', error: 'CLI exited with code 1' }, title: 'Walnut', body: 'The main AI hit an error: CLI exited with code 1', type: 'session_error' },
  { name: 'a coding session error', event: EventNames.SESSION_ERROR, data: { sessionId: 'plain-sid-1234', error: 'boom' }, title: 'Session Error', body: 'boom', type: 'session_error' },
  { name: 'a scheduled-job notice', event: EventNames.CRON_NOTIFICATION, data: { action: 'notification', jobName: 'Backup', text: 'Nightly backup finished' }, title: 'Scheduled: Backup', body: 'Nightly backup finished', type: 'cron' },
  { name: 'a triage chat entry', event: EventNames.CHAT_HISTORY_UPDATED, data: { entry: { role: 'assistant', source: 'triage', content: REPLY } }, title: 'Unread task update', body: REPLY, type: 'triage' },
]

describe('each event reaches every token once, through the service that fits it', () => {
  for (const c of EVENTS) {
    it(c.name, async () => {
      await emit(c.event, c.data)

      expect(apnsCalls()).toHaveLength(1)
      const [targets, payload] = apnsCalls()[0]
      expect(targets).toEqual([{ token: APNS_TOKEN, environment: 'production' }])
      expect(payload.aps.alert).toEqual({ title: c.title, body: c.body })
      expect(payload.type).toBe(c.type)

      const expo = expoCalls()
      expect(expo).toHaveLength(1)
      expect(expo[0].messages).toHaveLength(1)
      expect(expo[0].messages[0]).toMatchObject({ to: EXPO_TOKEN, title: c.title, body: c.body })
      expect(expo[0].messages[0].data).toMatchObject({ type: c.type })
      expect(expo[0].raw).not.toContain(APNS_TOKEN)
    })
  }

  it('two devices of each kind: one APNs send naming both, one Expo batch naming both', async () => {
    const otherExpo = 'ExpoPushToken[acme-phone-2]'
    getConfig.mockResolvedValue({
      push_tokens: [apnsRow(), apnsRow({ token: OTHER_APNS_TOKEN, key_name: 'iPad' }), expoRow(), expoRow({ token: otherExpo, key_name: 'old-ipad' })],
    })
    await emit(EventNames.AGENT_RESPONSE, { text: REPLY, source: 'cron' })
    expect(apnsCalls()).toHaveLength(1)
    expect(apnsCalls()[0][0].map((t) => t.token).sort()).toEqual([APNS_TOKEN, OTHER_APNS_TOKEN])
    expect(expoCalls()).toHaveLength(1)
    expect(expoCalls()[0].messages.map((m) => m.to).sort()).toEqual([otherExpo, EXPO_TOKEN].sort())
  })

  it('a token stored twice is still sent once', async () => {
    getConfig.mockResolvedValue({ push_tokens: [apnsRow(), apnsRow({ key_name: 'iPhone (old row)' }), expoRow(), expoRow()] })
    await emit(EventNames.AGENT_RESPONSE, { text: REPLY, source: 'cron' })
    expect(apnsCalls()[0][0]).toHaveLength(1)
    expect(expoCalls()[0].messages).toHaveLength(1)
  })

  it('a letter event pushes once per token in total, and only from the letter path', async () => {
    initLetterPush()
    bus.emit(EventNames.HUMAN_INBOX_LETTER, {
      letterId: 'lt-m9x2k1-b5c8', subject: 'Decision needed', type: 'action_required',
      textPreview: REPLY, kind: 'new', senderSessionId: 'sess-1', host: 'local',
    } as never, ['*'], { source: 'test' })
    await settle(true)
    expect(apnsCalls()).toHaveLength(1)
    expect(apnsCalls()[0][1].type).toBe('human_inbox_letter')
    expect(expoCalls()).toHaveLength(1)
    expect(expoCalls()[0].messages.map((m) => m.to)).toEqual([EXPO_TOKEN])
  })
})

describe('gated events send to neither service', () => {
  it('an interactive chat reply (no cron/heartbeat/triage source) is not pushed', async () => {
    await emit(EventNames.AGENT_RESPONSE, { text: REPLY, agentId: 'general' }, false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sendApns).not.toHaveBeenCalled()
  })

  it('a turn the user interrupted is not pushed', async () => {
    await emit(EventNames.SESSION_RESULT, { sessionId: 'lane-sid', result: REPLY, interrupted: true }, false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sendApns).not.toHaveBeenCalled()
  })

  it('a delivery_failed error (one per retry during an outage) is not pushed', async () => {
    await emit(EventNames.SESSION_ERROR, { sessionId: 'lane-sid', error: 'ssh down', errorKind: 'delivery_failed' }, false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sendApns).not.toHaveBeenCalled()
  })

  it('nothing is sent while a web client is watching', async () => {
    clientCount.mockReturnValue(1)
    await emit(EventNames.AGENT_RESPONSE, { text: REPLY, source: 'cron' }, false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sendApns).not.toHaveBeenCalled()
  })

  it('nothing is sent while quiet mode holds, to either service', async () => {
    await setQuiet({ source: 'user' })
    await emit(EventNames.CRON_NOTIFICATION, { jobName: 'Backup', text: 'done' }, false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sendApns).not.toHaveBeenCalled()
  })

  it('no registered device means no request at all', async () => {
    getConfig.mockResolvedValue({ push_tokens: [] })
    await emit(EventNames.AGENT_RESPONSE, { text: REPLY, source: 'cron' }, false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sendApns).not.toHaveBeenCalled()
  })
})

describe('Expo delivery for the legacy rows that remain', () => {
  it('a token Expo reports as DeviceNotRegistered is pruned, and its full token is never logged', async () => {
    getConfig.mockResolvedValue({ push_tokens: [expoRow()] })
    // Expo's ticket message echoes the whole token back; it must not reach a log line.
    expoTicket = (m) => ({
      status: 'error',
      message: `"${m.to}" is not a registered push notification recipient`,
      details: { error: 'DeviceNotRegistered' },
    })
    updatePushTokens.mockImplementation(async (mutate: (t: unknown[]) => unknown[] | null) => mutate([expoRow()]) ?? [])
    const logged: unknown[] = []
    const spies = (['info', 'warn', 'error'] as const).flatMap((level) => [
      vi.spyOn(log.notif, level).mockImplementation((...args: unknown[]) => { logged.push(args) }),
      vi.spyOn(log.web, level).mockImplementation((...args: unknown[]) => { logged.push(args) }),
    ])
    try {
      await emit(EventNames.AGENT_RESPONSE, { text: REPLY, source: 'cron' })

      expect(expoCalls()).toHaveLength(1)
      expect(updatePushTokens).toHaveBeenCalledTimes(1)
      const mutate = updatePushTokens.mock.calls[0][0] as (t: PushTokenEntry[]) => PushTokenEntry[] | null
      const apns = apnsRow()
      expect(mutate([expoRow(), apns])).toEqual([apns])
      expect(JSON.stringify(logged)).not.toContain(EXPO_TOKEN)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  it('an Expo outage is reported, not thrown, and the APNs device is still told', async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 503, json: async () => ({}) }))
    await emit(EventNames.AGENT_RESPONSE, { text: REPLY, source: 'cron' })
    expect(apnsCalls()).toHaveLength(1)
    expect(expoCalls()).toHaveLength(1)
    expect(updatePushTokens).not.toHaveBeenCalled()
  })
})
