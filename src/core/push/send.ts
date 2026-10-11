/**
 * Shared push shaping: what a notification looks like, and which service a
 * token belongs to.
 *
 * Two token kinds coexist because the app changed eras, not because two
 * transports are wanted: a native SwiftUI build registers with APNs and yields a
 * raw hex device token, while `ExponentPushToken[...]` rows are leftovers from
 * the retired Expo app. Expo rows stay SENDABLE (an old build on someone's phone
 * still works) but nothing new can mint one, and a raw APNs token can never go
 * to `exp.host` — sending the wrong token to the wrong service is a silent 100%
 * loss, so the kind is decided here, once, from the token's shape.
 *
 * It is also a privacy boundary: Expo is a third party, and what reaches it is
 * the notification text itself. Only a token that IS an Expo token may take
 * content there. Delivery lives in deliver.ts; this file only shapes.
 */

import { createHash } from 'node:crypto'
import type { PushTokenEntry } from '../types.js'

/**
 * Characters of a raw token in the status route's legacy `token_prefix`.
 *
 * Kept ONLY for iPhone app builds that predate token tags, which find their own
 * row by comparing this prefix with their token. Those builds refuse a prefix
 * under 8 characters (`minComparablePrefix` in PushLaunchDecision.swift), so 8 is
 * the least that still works for them; it used to be 12. A build that matches by
 * `token_tag` ignores it. Remove the field once every paired phone runs such a
 * build (see docs/reference/ios-push-notifications.md, "Finding this phone's row";
 * tests/core/push-status-old-app.test.ts pins the rule those builds apply).
 */
export const LEGACY_TOKEN_PREFIX_CHARS = 8

/**
 * The legacy `token_prefix` of the status route: the only place any raw slice of
 * a token leaves the box. A full token is a SEND CAPABILITY for that device, so
 * nothing outside the registry ever prints one; log lines and newer clients use
 * `tokenTag`.
 */
export function legacyTokenPrefix(token: string): string {
  return token.slice(0, LEGACY_TOKEN_PREFIX_CHARS)
}

/**
 * How a device token appears in a log line or in the status route's `token_tag`:
 * a short hash, never the token or a slice of it. Stable, so one device's lines
 * still correlate, and the iPhone computes the same value for its own token.
 * Logs leave the box in bug reports, and the old Expo sender once wrote most of
 * an APNs token there.
 */
export function tokenTag(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 8)
}

/**
 * Replace each token inside a service's text with its tag. A push service can
 * echo the token back in an error (Expo's ticket message quotes it whole), so
 * any service-supplied text is passed through this before it is logged.
 */
export function withoutTokens(text: string | undefined, tokens: readonly string[]): string | undefined {
  if (!text) return text
  let out = text
  for (const token of tokens) {
    if (token) out = out.split(token).join(`token#${tokenTag(token)}`)
  }
  return out
}

/**
 * Log keys under which a raw slice of a token was written: iPhone builds that
 * predate token tags log the first 12 characters of their APNs token as `tokenPrefix` and
 * `memoTokenPrefix` (on the wire `m_tokenPrefix` and `m_memoTokenPrefix`: the
 * app prefixes every meta key, ClientLogWire.swift), and so did this server's
 * push lines before they took tags.
 */
const LEGACY_TOKEN_SLICE_FIELD = /("(?:m_)?(?:tokenPrefix|memoTokenPrefix)"\s*:\s*")([0-9a-fA-F]{6,})(")/g

/** How many characters of a token those legacy log lines carried. */
const LEGACY_LOG_SLICE_CHARS = 12

/**
 * Scrub device tokens out of text this server did not write itself: the
 * diagnostic lines a phone uploads, and old log lines a bug report quotes.
 *
 * Two passes. Every registered token, and its 12-character slice, becomes
 * `token#<tag>`, so a phone's lines still line up with the server's. Then any
 * hex value left under a legacy slice key (a token no longer registered here)
 * becomes `[token]`. An Expo token's slice is not replaced: its first 12
 * characters are the fixed `ExponentPush` and say nothing about the device.
 */
export function scrubDeviceTokens(text: string, tokens: readonly string[]): string {
  let out = withoutTokens(text, tokens) ?? text
  for (const token of tokens) {
    if (!token || isExpoPushToken(token) || token.length <= LEGACY_LOG_SLICE_CHARS) continue
    out = out.split(token.slice(0, LEGACY_LOG_SLICE_CHARS)).join(`token#${tokenTag(token)}`)
  }
  return out.replace(LEGACY_TOKEN_SLICE_FIELD, '$1[token]$3')
}

/** Expo tokens are `ExponentPushToken[...]` / `ExpoPushToken[...]`; APNs is hex. */
export function isExpoPushToken(token: string): boolean {
  return /^Expo(nent)?PushToken\[/.test(token)
}

/**
 * Which service a token belongs to, from its SHAPE alone.
 *
 * A stored `kind` is a label for the status readout, never the routing decision:
 * a row whose label disagrees with its token (a hand edit, an old writer) would
 * otherwise send a hex APNs token, and the notification text with it, to Expo.
 */
export function tokenKind(entry: Pick<PushTokenEntry, 'token' | 'kind'>): 'apns' | 'expo' {
  return isExpoPushToken(entry.token) ? 'expo' : 'apns'
}

/** What one logical notification looks like before it is shaped per transport. */
export interface PushContent {
  title: string
  body: string
  data?: Record<string, unknown>
  /**
   * APNs alert priority. 10 = deliver now (a letter the human is waiting on);
   * 5 = may be batched to save power.
   */
  priority?: number
  /** Unread count to show on the app icon. Omitted leaves the badge alone. */
  badge?: number
  /**
   * Collapse id: a later push with the same id REPLACES an earlier undelivered
   * one on the device instead of stacking. Rides the `apns-collapse-id` HEADER,
   * not the payload — see apns.ts.
   */
  collapseId?: string
}

/**
 * Build the APNs payload.
 *
 * The `data` fields are spread at the TOP LEVEL alongside `aps`, which is what
 * `LetterDeepLink.letterId(fromPush:)` reads first. It also accepts a nested
 * `data` object, so both are emitted — the flat copy is the contract, the nested
 * one keeps an older client working.
 */
export function apnsPayload(content: PushContent): Record<string, unknown> {
  const data = content.data ?? {}
  return {
    aps: {
      alert: { title: content.title, body: content.body },
      sound: 'default',
      // Wakes the app on delivery so the inbox list/badge refreshes even when
      // the banner is never tapped.
      'content-available': 1,
      ...(content.badge !== undefined ? { badge: content.badge } : {}),
    },
    ...data,
    data,
  }
}

/** One message for Expo's push API (`exp.host`), the legacy app's service. */
export interface ExpoPushMessage {
  to: string
  title: string
  body: string
  data?: Record<string, unknown>
  sound: 'default'
  priority: 'high'
}

/** The body cap both former Expo senders applied. */
const EXPO_BODY_MAX = 200

/**
 * Build the Expo messages, one per token. Refuses a token that is not an Expo
 * token, so a caller that skipped `tokenKind` still cannot hand Expo an APNs
 * token together with the notification text.
 */
export function expoMessages(tokens: string[], content: PushContent): ExpoPushMessage[] {
  return tokens.filter(isExpoPushToken).map((to) => ({
    to,
    title: content.title,
    body: content.body.slice(0, EXPO_BODY_MAX),
    ...(content.data ? { data: content.data } : {}),
    sound: 'default' as const,
    priority: 'high' as const,
  }))
}
