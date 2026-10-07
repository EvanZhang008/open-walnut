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
 * How much of a device token may appear in an API response: the status route's
 * `token_prefix`, which the iOS app matches against its own token.
 *
 * A full token is a SEND CAPABILITY for that device, so nothing outside the
 * registry ever prints one. Log lines use `tokenTag` instead.
 */
export function tokenPrefix(token: string): string {
  return token.slice(0, 12)
}

/**
 * How a device token appears in a LOG line: a short hash, never the token or a
 * slice of it. Stable, so one device's lines still correlate. Logs leave the box
 * in bug reports, and the old Expo sender once wrote most of an APNs token there.
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
