/**
 * No push path writes a device token, or a push service's echo of one, into a log.
 *
 * The old Expo sender logged Expo's ticket message as is, and that message quotes
 * the token it rejected: most of an iPhone's APNs token ended up in the server
 * log. A token is a send capability for that device, and logs leave the box in bug
 * reports. Contract under test:
 *   - every push log line names a device by `tokenTag` (a short hash), never by
 *     the token or a slice of it;
 *   - text a service sends back (an APNs reason or error, an Expo ticket, a
 *     transport error) is scrubbed of the token before it is logged or kept as
 *     the APNs `lastError` that the status route reports.
 *
 * Every log entry is captured at the one place all of them pass (the file
 * transport's `writeLogEntry`), at trace level, so no subsystem or level is
 * skipped. The real APNs sender runs against a fake HTTP/2 connection with a
 * throwaway key, and Expo is stubbed at `fetch`: nothing leaves the process.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type { EventEmitter } from 'node:events'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

const captured = vi.hoisted(() => {
  // Log every level: a debug line must not be able to hide a token either.
  process.env.WALNUT_LOG_LEVEL = 'trace'
  return [] as Array<Record<string, unknown>>
})
/** The rows the fake config store holds. */
const store = vi.hoisted(() => ({ tokens: [] as unknown[] }))
/** What the fake APNs gateway does for each device token. */
const apnsBehavior = vi.hoisted(() => new Map<string, 'echo-reason' | 'echo-error' | 'ok'>())

vi.mock('../../src/constants.js', () => createMockConstants('push-token-logging'))
vi.mock('../../src/logging/logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/logging/logger.js')>()),
  writeLogEntry: (entry: Record<string, unknown>) => { captured.push(entry) },
}))
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ push_tokens: store.tokens }),
  updatePushTokens: async (mutate: (t: unknown[]) => unknown[] | null) => {
    const next = mutate([...store.tokens])
    if (next) store.tokens = next
    return store.tokens
  },
}))
vi.mock('../../src/web/ws/handler.js', () => ({ clientCount: () => 0 }))
vi.mock('node:http2', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:http2')>()
  const { EventEmitter: Emitter } = await import('node:events')
  /** One HTTP/2 stream to the fake gateway: answers per device token. */
  function fakeStream(headers: Record<string, unknown>): EventEmitter {
    const stream = new Emitter() as EventEmitter & Record<string, unknown>
    const token = String(headers[':path']).replace('/3/device/', '')
    stream.setEncoding = () => stream
    stream.close = () => {}
    stream.end = () => {
      setImmediate(() => {
        const behavior = apnsBehavior.get(token) ?? 'ok'
        if (behavior === 'echo-error') {
          stream.emit('error', new Error(`stream reset while sending /3/device/${token}`))
          return
        }
        if (behavior === 'echo-reason') {
          stream.emit('response', { ':status': 400 })
          stream.emit('data', JSON.stringify({ reason: `BadDeviceToken ${token}` }))
        } else {
          stream.emit('response', { ':status': 200 })
        }
        stream.emit('end')
      })
    }
    return stream
  }
  return {
    ...real,
    connect: () => {
      const session = new Emitter() as EventEmitter & Record<string, unknown>
      Object.assign(session, {
        closed: false, destroyed: false,
        unref: () => {}, close: () => {}, destroy: () => {},
        request: (headers: Record<string, unknown>) => fakeStream(headers),
      })
      return session
    },
  }
})

import { bus, EventNames } from '../../src/core/event-bus.js'
import { initPushNotifications } from '../../src/core/push-notification.js'
import { pushLetter } from '../../src/core/push/letter-push.js'
import { registerPushToken, revokeDevicePushTokens, unregisterPushToken } from '../../src/core/push/registry.js'
import { apnsStatus, closeApnsSessions } from '../../src/core/push/apns.js'
import { tokenTag } from '../../src/core/push/send.js'

const APNS_ECHO_REASON = 'a1'.repeat(32)
const APNS_ECHO_ERROR = 'b2'.repeat(32)
const APNS_OK = 'c3'.repeat(32)
const EXPO_DEAD = 'ExponentPushToken[acme-old-phone-1]'
const EXPO_ECHO = 'ExponentPushToken[acme-old-phone-2]'
const ALL_TOKENS = [APNS_ECHO_REASON, APNS_ECHO_ERROR, APNS_OK, EXPO_DEAD, EXPO_ECHO]

/** Each token, plus the pieces of it the old log lines printed. */
function forbiddenPieces(token: string): string[] {
  const expoId = /\[(.+)\]$/.exec(token)?.[1]
  return expoId ? [token, expoId] : [token, token.slice(0, 12)]
}

let keyDir = ''
let fetchMock: ReturnType<typeof vi.fn>
let expoMode: 'tickets' | 'http-500' | 'throw' = 'tickets'

beforeAll(() => {
  keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apns-key-'))
  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  const keyPath = path.join(keyDir, 'AuthKey_TEST.p8')
  fs.writeFileSync(keyPath, privateKey)
  process.env.WALNUT_APNS_KEY_ID = 'KEYID12345'
  process.env.WALNUT_APNS_TEAM_ID = 'TEAMID1234'
  process.env.WALNUT_APNS_KEY_PATH = keyPath
  apnsBehavior.set(APNS_ECHO_REASON, 'echo-reason')
  apnsBehavior.set(APNS_ECHO_ERROR, 'echo-error')
  apnsBehavior.set(APNS_OK, 'ok')
})

afterAll(() => {
  closeApnsSessions()
  delete process.env.WALNUT_LOG_LEVEL
  delete process.env.WALNUT_APNS_KEY_ID
  delete process.env.WALNUT_APNS_TEAM_ID
  delete process.env.WALNUT_APNS_KEY_PATH
  vi.unstubAllGlobals()
  fs.rmSync(keyDir, { recursive: true, force: true })
})

beforeEach(() => {
  expoMode = 'tickets'
  fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
    const messages = JSON.parse(init?.body ?? '[]') as Array<{ to: string }>
    if (expoMode === 'throw') throw new Error(`socket hang up while posting ${messages.map((m) => m.to).join(',')}`)
    if (expoMode === 'http-500') return { ok: false, status: 500, json: async () => ({ errors: messages }) }
    return {
      ok: true, status: 200,
      json: async () => ({
        data: messages.map((m) => m.to === EXPO_DEAD
          ? { status: 'error', message: `"${m.to}" is not a registered push notification recipient`, details: { error: 'DeviceNotRegistered' } }
          : { status: 'error', message: `"${m.to}" could not be delivered`, details: { error: `MessageRateExceeded ${m.to}` } }),
      }),
    }
  })
  vi.stubGlobal('fetch', fetchMock)
})

/** Wait for the fire-and-forget bus handler to finish its sends. */
async function settle(): Promise<void> {
  let seen = -1
  for (let i = 0; i < 40 && seen !== captured.length; i++) {
    seen = captured.length
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('push log lines carry a token tag, never a token', () => {
  it('registration, APNs and Expo failures, pruning and revocation all log without a token', async () => {
    for (const [i, token] of ALL_TOKENS.entries()) {
      await registerPushToken({ token, platform: 'ios', environment: 'production', keyName: `device-${i}`, origin: 'local' })
    }
    expect(store.tokens).toHaveLength(ALL_TOKENS.length)

    // The general subscriber: APNs echoes in a reason and in an error, Expo in its tickets.
    initPushNotifications()
    bus.emit(EventNames.AGENT_RESPONSE, { text: 'Weekly review is ready', source: 'cron' } as never, ['push-notifications'], { source: 'test' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { timeout: 5_000, interval: 25 })
    await settle()

    // A letter while Expo is down, then while the Expo request itself throws.
    expoMode = 'http-500'
    await pushLetter({ letterId: 'lt-m9x2k1-a4f7', subject: 'Review ready', type: 'review', textPreview: 'Two files changed.', kind: 'new' })
    expoMode = 'throw'
    await pushLetter({ letterId: 'lt-m9x2k1-b5c8', subject: 'Decision needed', type: 'action_required', textPreview: 'Pick a window.', kind: 'new' })

    await unregisterPushToken(APNS_OK)
    await revokeDevicePushTokens(`device-${ALL_TOKENS.indexOf(EXPO_ECHO)}`)

    // The paths really ran, and each named its device by tag.
    const messages = captured.map((e) => String(e.message))
    for (const expected of ['push: token registered', 'apns: send failed', 'push: Expo ticket error', 'push: Expo API error',
      'push: Expo send failed', 'push: pruned dead device tokens', 'push: token unregistered', 'push: delivery', 'letter push']) {
      expect(messages, expected).toContain(expected)
    }
    const apnsFailures = captured.filter((e) => e.message === 'apns: send failed')
    expect(apnsFailures.map((e) => e.tokenTag)).toEqual(expect.arrayContaining([tokenTag(APNS_ECHO_REASON), tokenTag(APNS_ECHO_ERROR)]))
    // The echo is still readable, with the token replaced by its tag.
    expect(JSON.stringify(apnsFailures)).toContain(`token#${tokenTag(APNS_ECHO_REASON)}`)
    expect(JSON.stringify(apnsFailures)).toContain(`token#${tokenTag(APNS_ECHO_ERROR)}`)

    const everything = JSON.stringify(captured)
    for (const token of ALL_TOKENS) {
      for (const piece of forbiddenPieces(token)) expect(everything, `log leaks ${piece}`).not.toContain(piece)
    }
    // The last APNs error is served by GET /api/push/status: it must be clean too.
    const status = JSON.stringify(await apnsStatus())
    for (const token of ALL_TOKENS) expect(status).not.toContain(token)
  })
})
