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
 */

import type { PushTokenEntry } from '../types.js'

/** Expo tokens are `ExponentPushToken[...]` / `ExpoPushToken[...]`; APNs is hex. */
export function tokenKind(entry: Pick<PushTokenEntry, 'token' | 'kind'>): 'apns' | 'expo' {
  if (entry.kind === 'apns' || entry.kind === 'expo') return entry.kind
  return /^Expo(nent)?PushToken\[/.test(entry.token) ? 'expo' : 'apns'
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
