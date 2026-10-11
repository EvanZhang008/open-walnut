/**
 * How a device token may appear outside the APNs request: as its tag, a hash.
 *
 * `tokenTag` names a device in every server log line and in the status route's
 * `token_tag`, and the iPhone computes the same value for its own token to find
 * its row. Both only work if the tag is a HASH of the token: a tag that were a
 * slice of the token would put that slice in every log and every status answer,
 * and the phone's comparison would still pass. So the tag is pinned to SHA-256
 * by fixed vectors, the same ones ios-native/WalnutTests/PushNotificationTests.swift
 * pins on the app side.
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  LEGACY_TOKEN_PREFIX_CHARS,
  legacyTokenPrefix,
  scrubDeviceTokens,
  tokenTag,
  withoutTokens,
} from '../../src/core/push/send.js'

const VECTOR = '0123456789abcdef'.repeat(4)
const AB = 'ab'.repeat(32)
const APNS = '7f3c9e2a1b8d4f6e0a5c3b9d7e1f2a4c6b8d0e2f4a6c8e0b2d4f6a8c0e2b4d6f'
const OTHER = 'e4d2c0b8a6f4e2d0c8b6a4f2e0d8c6b4a2f0e8d6c4b2a0f8e6d4c2b0a8f6e4d2'
const EXPO = 'ExponentPushToken[acme-old-phone]'

describe('tokenTag', () => {
  it('is the first 8 hex characters of the SHA-256 of the token', () => {
    // Fixed vectors shared with the iOS test suite.
    expect(tokenTag(VECTOR)).toBe('a8ae6e6e')
    expect(tokenTag(AB)).toBe('271a413b')
    for (const token of [APNS, OTHER, EXPO]) {
      expect(tokenTag(token)).toBe(createHash('sha256').update(token).digest('hex').slice(0, 8))
    }
  })

  it('is never a slice of the token', () => {
    for (const token of [VECTOR, AB, APNS, OTHER]) {
      expect(tokenTag(token)).not.toBe(token.slice(0, 8))
      expect(token).not.toContain(tokenTag(token))
    }
  })

  it('tells devices apart', () => {
    expect(new Set([VECTOR, AB, APNS, OTHER, EXPO].map(tokenTag)).size).toBe(5)
  })
})

describe('legacyTokenPrefix', () => {
  it('is 8 characters, the least iPhone builds without token tags accept (minComparablePrefix)', () => {
    expect(LEGACY_TOKEN_PREFIX_CHARS).toBe(8)
    expect(legacyTokenPrefix(APNS)).toBe(APNS.slice(0, 8))
  })
})

describe('withoutTokens', () => {
  it('replaces each token in service text with its tag', () => {
    expect(withoutTokens(`BadDeviceToken ${APNS}`, [APNS])).toBe(`BadDeviceToken token#${tokenTag(APNS)}`)
  })
})

describe('scrubDeviceTokens', () => {
  /**
   * A line exactly as an iPhone build that predates token tags uploads it to POST
   * /api/v1/client-logs and the server stores it: the envelope plus each meta key
   * with the app's `m_` prefix (ClientLogWire.swift), flattened into one object.
   */
  const phoneLine = (token: string): string => JSON.stringify({
    device: 'phone-a', appVersion: '1.0.0 (99)', os: 'iOS 26.0',
    ts: '2026-10-05T08:00:00.000Z', level: 'info', subsystem: 'push', message: 'apns token minted',
    seq: '41', m_tokenPrefix: token.slice(0, 12), m_environment: 'production',
  })
  /** This server's own push lines before tags: the slice under a plain key. */
  const serverLine = (token: string): string => JSON.stringify({
    subsystem: 'notif', message: 'push: apns send failed', tokenPrefix: token.slice(0, 12),
  })

  it('turns a registered token, and the 12-character slice old lines carry, into its tag', () => {
    const text = `${phoneLine(APNS)}\n${serverLine(APNS)}\nsend failed for ${APNS}\n`
    const out = scrubDeviceTokens(text, [APNS])
    expect(out).not.toContain(APNS)
    expect(out).not.toContain(APNS.slice(0, 12))
    expect(out).toContain(`"m_tokenPrefix":"token#${tokenTag(APNS)}"`)
    expect(out).toContain(`"tokenPrefix":"token#${tokenTag(APNS)}"`)
    expect(out).toContain(`send failed for token#${tokenTag(APNS)}`)
  })

  it('masks a slice under a legacy key even when the token is no longer registered', () => {
    const memo = JSON.stringify({ message: 'registration refresh', m_memoTokenPrefix: OTHER.slice(0, 12), m_memoServer: 'none' })
    const out = scrubDeviceTokens(`${phoneLine(OTHER)}\n${memo}\n${serverLine(OTHER)}\n`, [APNS])
    expect(out).not.toContain(OTHER.slice(0, 6))
    expect(out).toContain('"m_tokenPrefix":"[token]"')
    expect(out).toContain('"m_memoTokenPrefix":"[token]"')
    expect(out).toContain('"tokenPrefix":"[token]"')
  })

  it('leaves lines without a token alone', () => {
    const lines = [
      JSON.stringify({ message: 'registration refresh', m_memoTokenPrefix: 'none', m_memoServer: 'none' }),
      JSON.stringify({ message: 'apns token minted', m_tokenTag: tokenTag(APNS) }),
      'ExponentPush is just text here',
    ].join('\n')
    expect(scrubDeviceTokens(lines, [APNS, EXPO])).toBe(lines)
  })

  it('replaces a whole Expo token but not its fixed ExponentPush head', () => {
    const out = scrubDeviceTokens(`ticket for ${EXPO}; ExponentPushToken format`, [EXPO])
    expect(out).toBe(`ticket for token#${tokenTag(EXPO)}; ExponentPushToken format`)
  })
})
