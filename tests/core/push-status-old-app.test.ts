/**
 * The status route keeps working for the iPhone builds already installed.
 *
 * `GET /api/push/status` answers with `pushRegistrationStatus` (on a replica, the
 * primary's). Every app build that predates token tags (App Store build 107,
 * TestFlight builds 108 and 109, and earlier) decides "is my row still there?"
 * from that answer alone, with one rule in PushLaunchDecision.swift:
 *
 *   - it decodes only `token_prefix` from each row (`PushTokenRow`), so a new
 *     field such as `token_tag` is ignored;
 *   - `comparablePrefix` lowercases the prefix, strips its trailing dots, and
 *     drops it when fewer than `minComparablePrefix` characters are left;
 *   - `shouldReregister` lowercases its own token and looks for a row whose
 *     prefix starts it.
 *
 * Those installs keep that rule for as long as they run, whatever the source says
 * later. A tag-matching build (110 and later) matches a row by its `token_tag`
 * first and keeps this same rule, unchanged, for a row with no tag, so the
 * source still holds it.
 * This file reads the rule from the Swift source (the numbers and the steps, not
 * a copy typed here) and runs it against the rows the server really returns. If the Swift rule changes on purpose, the installed builds still apply
 * the old one: keep the old numbers here for them until `token_prefix` can go
 * (docs/reference/ios-push-notifications.md, "Finding this phone's row").
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-push-status-old-app'))
vi.mock('../../src/core/push/apns.js', () => ({
  sendApns: vi.fn(async () => ({ attempted: true, sent: 1, failed: 0, deadTokens: [] })),
  apnsStatus: vi.fn(async () => ({ configured: true, environment: 'production', topic: 'test.topic' })),
  recordApnsError: vi.fn(),
  closeApnsSessions: vi.fn(),
}))

import { pushRegistrationStatus, registerPushToken } from '../../src/core/push/registry.js'
import { LEGACY_TOKEN_PREFIX_CHARS } from '../../src/core/push/send.js'
import { WALNUT_HOME } from '../../src/constants.js'

const ROOT = path.resolve(__dirname, '../..')
const DECISION = fs.readFileSync(path.join(ROOT, 'ios-native/Walnut/Core/PushLaunchDecision.swift'), 'utf8')
const API = fs.readFileSync(path.join(ROOT, 'ios-native/Walnut/API/WalnutAPIPush.swift'), 'utf8')

/** The body of the Swift function `name`, up to the closing brace at its own indent. */
function swiftFunc(source: string, name: string): string {
  const m = new RegExp(`^( *)nonisolated static func ${name}\\(([\\s\\S]*?)^\\1\\}`, 'm').exec(source)
  if (!m) throw new Error(`PushLaunchDecision.swift has no ${name}`)
  return m[0]
}

/** The rule as the Swift source has it: the number, and the steps checked one by one. */
function readSwiftRule() {
  const min = /static let minComparablePrefix = (\d+)\b/.exec(DECISION)
  const comparable = swiftFunc(DECISION, 'comparablePrefix')
  const reregister = swiftFunc(DECISION, 'shouldReregister')
  const row = /struct PushTokenRow: Decodable \{([\s\S]*?)\n    \}\n/.exec(API)?.[1] ?? ''
  return {
    min: min ? Number(min[1]) : NaN,
    lowercasesPrefix: /guard var value = raw\?\.lowercased\(\) else \{ return nil \}/.test(comparable),
    stripsTrailingDots: /while value\.hasSuffix\("\."\) \{ value\.removeLast\(\) \}/.test(comparable),
    dropsShortPrefix: /return value\.count >= minComparablePrefix \? value : nil/.test(comparable),
    lowercasesOwnToken: /let mine = myToken\.lowercased\(\)/.test(reregister),
    matchesByStart: /guard let prefix = comparablePrefix\(row\.tokenPrefix\) else \{ return false \}\s*return mine\.hasPrefix\(prefix\)/.test(reregister),
    decodesPrefixKey: /case tokenPrefix = "token_prefix"/.test(row),
    rowIsDecodable: row.length > 0,
  }
}

const RULE = readSwiftRule()

/** `comparablePrefix`, with the Swift source's number. */
function comparablePrefix(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let value = raw.toLowerCase()
  while (value.endsWith('.')) value = value.slice(0, -1)
  return value.length >= RULE.min ? value : null
}

/** `shouldReregister` for a server that lists its rows. */
function oldAppShouldReregister(rows: Array<Record<string, unknown>>, myToken: string): boolean {
  const mine = myToken.toLowerCase()
  return !rows.some((row) => {
    const prefix = comparablePrefix(row.token_prefix)
    return prefix !== null && mine.startsWith(prefix)
  })
}

const PHONE_A = crypto.randomBytes(32).toString('hex')
const PHONE_B = crypto.randomBytes(32).toString('hex')
const EXPO = `ExponentPushToken[${crypto.randomBytes(11).toString('hex')}]`

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
})

afterEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the rule an installed app applies to GET /api/push/status', () => {
  it('is still the rule in PushLaunchDecision.swift: at least 8 characters, dots stripped, lowercase, matched by start', () => {
    expect(RULE).toEqual({
      min: 8,
      lowercasesPrefix: true,
      stripsTrailingDots: true,
      dropsShortPrefix: true,
      lowercasesOwnToken: true,
      matchesByStart: true,
      decodesPrefixKey: true,
      rowIsDecodable: true,
    })
    // The server sends exactly the least that rule accepts, and no more.
    expect(LEGACY_TOKEN_PREFIX_CHARS).toBe(RULE.min)
  })

  it('finds each phone\'s own row in what the server answers, and no row for a token it does not hold', async () => {
    await registerPushToken({ token: PHONE_A, platform: 'ios', keyName: 'acme-phone' })
    await registerPushToken({ token: PHONE_B, platform: 'ios', keyName: 'acme-tablet' })
    await registerPushToken({ token: EXPO, platform: 'ios', keyName: 'acme-old-phone' })
    const status = await pushRegistrationStatus('acme-phone') as { tokens?: Array<Record<string, unknown>> }
    // A listed `tokens` array is what puts the app on its token rule (`decisionRule`).
    expect(Array.isArray(status.tokens)).toBe(true)
    const rows = status.tokens!
    expect(rows).toHaveLength(3)
    // Every APNs row carries a prefix the app can compare, exactly at its minimum.
    for (const token of [PHONE_A, PHONE_B]) {
      const row = rows.find((r) => comparablePrefix(r.token_prefix) === token.slice(0, RULE.min))
      expect(row, token.slice(0, 4)).toBeDefined()
    }
    expect(oldAppShouldReregister(rows, PHONE_A)).toBe(false)
    expect(oldAppShouldReregister(rows, PHONE_B)).toBe(false)
    // The app uploads its token lowercase; one it reads back in capitals still matches.
    expect(oldAppShouldReregister(rows, PHONE_A.toUpperCase())).toBe(false)
    // A phone whose row is gone still learns it, so it registers again.
    expect(oldAppShouldReregister(rows, crypto.randomBytes(32).toString('hex'))).toBe(true)
  })

  it('a row the app cannot compare counts as no row, as the Swift rule says', () => {
    expect(comparablePrefix(`${PHONE_A.slice(0, RULE.min - 1)}...`)).toBeNull()
    expect(comparablePrefix(`${PHONE_A.slice(0, RULE.min).toUpperCase()}...`)).toBe(PHONE_A.slice(0, RULE.min))
    expect(oldAppShouldReregister([{ token_prefix: `${PHONE_A.slice(0, RULE.min - 1)}...` }], PHONE_A)).toBe(true)
  })
})
