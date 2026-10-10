/**
 * The one way a notification leaves this box: each device token goes to the
 * service that minted it, exactly once.
 *
 * Every push sender calls `deliverPush` (letters in letter-push.ts, the general
 * notifications in push-notification.ts), so the routing rule lives in one place:
 * an APNs token goes to Apple, an Expo token to Expo, decided by the token's
 * shape (send.ts `tokenKind`). The general sender used to post every event to
 * Expo for EVERY token. Expo rejected the native app's APNs tokens, but only
 * after the title and the agent's reply had already reached a third party.
 *
 * WHO decides whether to push (quiet mode, per-device modes, "is a client
 * watching") stays with each caller. This file only delivers.
 */

import { updatePushTokens } from '../config-manager.js'
import { log } from '../../logging/index.js'
import type { PushTokenEntry } from '../types.js'
import { sendApns, type ApnsTarget } from './apns.js'
import { partitionByPairing, pruneUnpairedRows } from './paired-rows.js'
import { apnsPayload, expoMessages, tokenKind, tokenTag, withoutTokens, type PushContent } from './send.js'

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

/** Same bound as an APNs send: a push must never pin the caller's handler. */
const EXPO_TIMEOUT_MS = 10_000

export interface PushDeliveryOutcome {
  /** False when no transport was even tried (e.g. APNs has no credential). */
  attempted: boolean
  sent: number
  failed: number
  /** Why APNs attempted nothing, when it had targets. */
  reason?: string
  /** Distinct targets per service. */
  apns: number
  expo: number
  /** Tokens a service reported dead. They are pruned from config here. */
  deadTokens: string[]
  /** Rows skipped because their device is no longer paired (paired-rows.ts); pruned here too, unless judged by auth.json.bak. */
  unpaired: number
}

/** Split rows by service, one target per distinct token. */
function routeTargets(entries: PushTokenEntry[]): { apns: ApnsTarget[]; expo: string[] } {
  const apns: ApnsTarget[] = []
  const expo: string[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.token)) continue
    seen.add(entry.token)
    if (tokenKind(entry) === 'expo') expo.push(entry.token)
    else apns.push({ token: entry.token, ...(entry.environment ? { environment: entry.environment } : {}) })
  }
  return { apns, expo }
}

/**
 * Deliver one notification to these devices.
 *
 * Does not catch a THROW from the APNs sender (it never throws by contract):
 * the letter path logs a throw as its per-letter line and rethrows, and the
 * general subscriber's handler logs it. Expo failures are reported, not thrown.
 */
export async function deliverPush(
  entries: PushTokenEntry[],
  content: PushContent,
): Promise<PushDeliveryOutcome> {
  // A row whose device was revoked is never sent, whatever path missed it.
  const { live, unpaired, prune } = await partitionByPairing(entries)
  const targets = routeTargets(live)
  const outcome: PushDeliveryOutcome = {
    attempted: false, sent: 0, failed: 0,
    apns: targets.apns.length, expo: targets.expo.length, deadTokens: [],
    unpaired: unpaired.length,
  }

  if (targets.apns.length > 0) {
    const out = await sendApns(targets.apns, apnsPayload(content), {
      ...(content.priority !== undefined ? { priority: content.priority } : {}),
      // One logical notification = one banner, however often its event repeats.
      ...(content.collapseId ? { collapseId: content.collapseId } : {}),
    })
    outcome.attempted = outcome.attempted || out.attempted
    outcome.sent += out.sent
    outcome.failed += out.failed
    if (!out.attempted && out.reason) outcome.reason = out.reason
    outcome.deadTokens.push(...out.deadTokens)
  }

  if (targets.expo.length > 0) {
    const out = await sendExpo(targets.expo, content)
    outcome.attempted = outcome.attempted || out.attempted
    outcome.sent += out.sent
    outcome.failed += out.failed
    outcome.deadTokens.push(...out.deadTokens)
  }

  if (outcome.deadTokens.length > 0) await pruneDead(outcome.deadTokens)
  // Judged by auth.json.bak only: held back, never deleted (paired-rows.ts).
  if (unpaired.length > 0 && prune) await pruneUnpairedRows(unpaired)
  return outcome
}

interface ExpoPushTicket {
  status?: 'ok' | 'error'
  message?: string
  details?: { error?: string }
}

/** Expo delivery for the legacy rows. Never throws. */
async function sendExpo(
  tokens: string[],
  content: PushContent,
): Promise<{ attempted: boolean; sent: number; failed: number; deadTokens: string[] }> {
  const messages = expoMessages(tokens, content)
  if (messages.length === 0) return { attempted: false, sent: 0, failed: 0, deadTokens: [] }
  try {
    const resp = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
      signal: AbortSignal.timeout(EXPO_TIMEOUT_MS),
    })
    if (!resp.ok) {
      log.notif.warn('push: Expo API error', { status: resp.status, tokens: messages.length })
      return { attempted: true, sent: 0, failed: messages.length, deadTokens: [] }
    }
    const result = await resp.json() as { data?: ExpoPushTicket[] }
    const tickets = Array.isArray(result.data) ? result.data : []
    let sent = 0
    const deadTokens: string[] = []
    // Tickets come back in message order. A ticket's `message` quotes the whole
    // token, which is a send capability, so it is never logged; the error code is.
    messages.forEach((m, i) => {
      const ticket = tickets[i]
      if (ticket?.status === 'ok') { sent++; return }
      const error = ticket?.details?.error
      if (error === 'DeviceNotRegistered') deadTokens.push(m.to)
      log.notif.warn('push: Expo ticket error', {
        tokenTag: tokenTag(m.to),
        error: withoutTokens(error, [m.to]) ?? (ticket ? 'unknown' : 'no ticket'),
      })
    })
    return { attempted: true, sent, failed: messages.length - sent, deadTokens }
  } catch (err) {
    log.notif.warn('push: Expo send failed', {
      error: withoutTokens(err instanceof Error ? err.message : String(err), tokens),
    })
    return { attempted: true, sent: 0, failed: messages.length, deadTokens: [] }
  }
}

async function pruneDead(dead: string[]): Promise<void> {
  try {
    let removed = 0
    // Atomic read-modify-write: a prune racing a fresh registration on the plain
    // read-then-updateConfig path would drop the new device's row.
    await updatePushTokens((tokens) => {
      const keep = tokens.filter((t) => !dead.includes(t.token))
      removed = tokens.length - keep.length
      return removed === 0 ? null : keep
    })
    if (removed > 0) log.notif.info('push: pruned dead device tokens', { removed })
  } catch (err) {
    log.notif.warn('push: could not prune dead tokens', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
