/**
 * A letter lands → the human's phones buzz.
 *
 * This is a SEPARATE subscriber from push-notification.ts on purpose. That file
 * gates every push on `clientCount() > 0` — "is any browser WebSocket open" —
 * which is exactly the bug being fixed: a Mac console tab left open suppressed
 * every letter push, so letters never reached the phone at all. A letter is
 * addressed TO the human, so whether some browser somewhere is connected has no
 * bearing on it; only the receiving phone's own state can, and only when the
 * user asked for that (`when-inactive`).
 *
 * Runs on the PRIMARY. Letters live there (a replica relays every human-inbox
 * route to it), so the primary's store is the only producer of letter events —
 * and device tokens live here too, because a replica relays `/api/push/register`
 * to this box as well (core/push/relay.ts). Both halves have to be on the same
 * box for a push to happen at all: for months the letters were here and the
 * tokens were on the replica's own unsynced config, so every letter took the
 * `no device registered for push` exit. That exit is now LOGGED — see
 * `finish()`: every letter emits exactly one `letter push` line, whatever
 * happened, so "a letter arrived and nothing was sent" can never again be
 * invisible.
 */

import { bus, eventData, EventNames } from '../event-bus.js'
import { getConfig, updatePushTokens } from '../config-manager.js'
import { log } from '../../logging/index.js'
import type { PushTokenEntry } from '../types.js'
import { sendApns, type ApnsTarget } from './apns.js'
import { apnsPayload, tokenKind, type PushContent } from './send.js'
import {
  ACTIVE_LEASE_MS,
  parseMode,
  selectDevices,
  type DevicePushState,
} from './letter-push-policy.js'

/** Matches `LetterDeepLink.payloadType` in ios-native/Walnut/Core/LetterDeepLink.swift. */
export const LETTER_PUSH_TYPE = 'human_inbox_letter'

/**
 * A lock-screen title shows far less than the store's 200-char subject cap, so
 * trim here rather than letting the OS elide mid-word.
 */
const TITLE_MAX = 100

export interface LetterPushInput {
  letterId: string
  subject: string
  type: string
  textPreview: string
  kind: 'new' | 'reply'
}

/**
 * The notification content for a letter. Pure, so the payload contract can be
 * asserted without a network or a config.
 */
export function letterPushContent(letter: LetterPushInput): PushContent {
  const prefix = letter.kind === 'reply' ? 'Reply: ' : 'New letter: '
  return {
    title: `${prefix}${letter.subject}`.slice(0, TITLE_MAX),
    body: letter.textPreview || 'Open Walnut to read it',
    data: {
      type: LETTER_PUSH_TYPE,
      letterId: letter.letterId,
      letterType: letter.type,
      kind: letter.kind,
    },
    // `action_required` is a human decision someone is blocked on; the rest can
    // ride the power-saving lane. This is the ONLY urgency difference the server
    // applies on its own, and it changes delivery timing, never whether a letter
    // is sent — muting a letter type is the user's visible choice (policy.types).
    priority: letter.type === 'action_required' ? 10 : 5,
    // One letter = one banner, however many times its event is retried.
    collapseId: letter.letterId,
  }
}

/** Read the per-device push state that config carries alongside each token. */
function deviceState(entry: PushTokenEntry): DevicePushState {
  return {
    ...(entry.key_name ? { name: entry.key_name } : {}),
    mode: parseMode(entry.mode),
    ...(typeof entry.active_at === 'number' ? { activeAt: entry.active_at } : {}),
    ...(entry.letter_types ? { types: entry.letter_types } : {}),
  }
}

export interface LetterPushOutcome {
  attempted: boolean
  sent: number
  failed: number
  suppressed: number
  reason?: string
}

/**
 * A configuration gap (no device registered, no APNs key) is PERMANENT until a
 * human acts, so its remediation text is logged once per process rather than once
 * per letter. The per-letter `letter push` line still carries the reason, so the
 * condition stays greppable for every single letter.
 */
const warnedOnce = new Set<string>()

function warnOnce(key: string, message: string, fields: Record<string, unknown>): void {
  if (warnedOnce.has(key)) return
  warnedOnce.add(key)
  log.notif.warn(message, fields)
}

/** Test seam — lets a test observe the once-per-process warnings again. */
export function resetLetterPushWarningsForTests(): void { warnedOnce.clear() }

/** Fields every `letter push` line carries, whatever happened. */
function summaryFields(
  letter: LetterPushInput,
  outcome: LetterPushOutcome,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    letterId: letter.letterId, letterType: letter.type, kind: letter.kind,
    attempted: outcome.attempted, sent: outcome.sent, failed: outcome.failed,
    suppressed: outcome.suppressed,
    ...extra,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  }
}

/**
 * Push one letter to the devices whose mode says yes. Returns a summary so tests
 * and the status route can see what happened, including the honest "nothing was
 * attempted, here's why".
 *
 * EXACTLY ONE `letter push` log line per call, and that is structural, not a
 * property of the happy paths: every normal exit goes through `finish()`, a THROW
 * from anywhere gets its own line before being rethrown, and a `finally` guard
 * catches the case where even that failed. A letter that produces no push and no
 * log line is the bug this file exists to prevent — it hid a dead registration
 * path for weeks.
 */
export async function pushLetter(
  letter: LetterPushInput,
  now = Date.now(),
): Promise<LetterPushOutcome> {
  let logged = false
  const mark = (): void => { logged = true }
  try {
    return await attemptLetterPush(letter, now, mark)
  } catch (err) {
    // Rethrown after logging: the caller's handler still records the stack (the
    // bus subscriber logs `letter push: handler error`), but this letter no
    // longer passes through without a line of its own.
    const message = err instanceof Error ? err.message : String(err)
    log.notif.error('letter push', summaryFields(letter, {
      attempted: false, sent: 0, failed: 0, suppressed: 0,
      reason: `push threw: ${message}`,
    }))
    mark()
    throw err
  } finally {
    if (!logged) {
      // Only reachable if the logging itself failed above. Still try: "no line"
      // is the one outcome this function must never produce.
      try {
        log.notif.error('letter push', summaryFields(letter, {
          attempted: false, sent: 0, failed: 0, suppressed: 0,
          reason: 'pushLetter exited without a summary — this is a bug',
        }))
      } catch { /* nothing left to try with */ }
    }
  }
}

async function attemptLetterPush(
  letter: LetterPushInput,
  now: number,
  mark: () => void,
): Promise<LetterPushOutcome> {
  /** One line per letter, always. `warn` whenever nothing reached a device. */
  const finish = (
    outcome: LetterPushOutcome,
    extra: Record<string, unknown> = {},
  ): LetterPushOutcome => {
    const fields = summaryFields(letter, outcome, extra)
    if (outcome.sent === 0) log.notif.warn('letter push', fields)
    else log.notif.info('letter push', fields)
    mark()
    return outcome
  }

  let tokens: PushTokenEntry[] = []
  try {
    tokens = (await getConfig()).push_tokens ?? []
  } catch (err) {
    return finish({
      attempted: false, sent: 0, failed: 0, suppressed: 0,
      reason: `config unreadable: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
  if (tokens.length === 0) {
    warnOnce('no-tokens',
      'letter push: no device is registered for push — no letter will notify until one is',
      {
        hint: 'iOS: open the Inbox tab and allow notifications. A phone paired to a cloud '
          + 'replica registers through it and the replica relays the token here; check '
          + 'GET /api/push/status on THIS box, which is the only store that counts.',
      })
    return finish({
      attempted: false, sent: 0, failed: 0, suppressed: 0,
      reason: 'no device registered for push',
    }, { devices: 0 })
  }

  const chosen = selectDevices(
    tokens.map((t) => ({ entry: t, ...deviceState(t) })),
    letter.type,
    now,
    ACTIVE_LEASE_MS,
  )
  const suppressed = tokens.length - chosen.length
  if (chosen.length === 0) {
    return finish({
      attempted: false, sent: 0, failed: 0, suppressed,
      reason: 'all devices are foreground-active or muted this letter type',
    }, { devices: tokens.length, targeted: 0 })
  }

  const content = letterPushContent(letter)
  const payload = apnsPayload(content)

  const apnsTargets: ApnsTarget[] = []
  const expoTokens: string[] = []
  for (const { device } of chosen) {
    const entry = device.entry
    if (tokenKind(entry) === 'expo') expoTokens.push(entry.token)
    else apnsTargets.push({ token: entry.token, ...(entry.environment ? { environment: entry.environment } : {}) })
  }

  let sent = 0
  let failed = 0
  let attempted = false
  let reason: string | undefined

  let pruned = 0
  if (apnsTargets.length > 0) {
    const out = await sendApns(apnsTargets, payload, {
      priority: content.priority,
      // One letter = one banner: a redelivered event replaces the earlier
      // undelivered notification instead of stacking a second one.
      ...(content.collapseId ? { collapseId: content.collapseId } : {}),
    })
    attempted = attempted || out.attempted
    sent += out.sent
    failed += out.failed
    if (!out.attempted) {
      reason = out.reason
      // The missing-credential text itself is warned once per process inside
      // apns.ts; this names the letter that just lost its push.
      warnOnce('apns-unconfigured',
        'letter push: APNs is not configured on this box — letters cannot notify',
        { reason: out.reason })
    }
    if (out.deadTokens.length > 0) {
      pruned = out.deadTokens.length
      await pruneDead(out.deadTokens)
    }
  }
  if (expoTokens.length > 0) {
    const out = await sendExpoLetter(expoTokens, content)
    attempted = attempted || out.attempted
    sent += out.sent
    failed += out.failed
  }

  return finish(
    { attempted, sent, failed, suppressed, ...(reason ? { reason } : {}) },
    {
      devices: tokens.length, targeted: chosen.length,
      ...(pruned > 0 ? { deadTokensPruned: pruned } : {}),
    },
  )
}

/** Expo delivery for legacy tokens (kept minimal — nothing new mints these). */
async function sendExpoLetter(
  tokens: string[],
  content: PushContent,
): Promise<{ attempted: boolean; sent: number; failed: number }> {
  try {
    const resp = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(tokens.map((to) => ({
        to, title: content.title, body: content.body.slice(0, 200),
        data: content.data, sound: 'default' as const, priority: 'high' as const,
      }))),
    })
    if (!resp.ok) return { attempted: true, sent: 0, failed: tokens.length }
    const result = await resp.json() as { data?: Array<{ status: string }> }
    let sent = 0
    let failed = 0
    for (const t of result.data ?? []) { if (t.status === 'error') failed++; else sent++ }
    return { attempted: true, sent, failed }
  } catch (err) {
    log.notif.warn('letter push: Expo send failed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return { attempted: true, sent: 0, failed: tokens.length }
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
    if (removed > 0) log.notif.info('letter push: pruned dead device tokens', { removed })
  } catch (err) {
    log.notif.warn('letter push: could not prune dead tokens', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

let subscribed = false

/**
 * Subscribe to letter events. Idempotent — server boot and a test can both call
 * it without doubling every push.
 */
export function initLetterPush(): void {
  if (subscribed) return
  subscribed = true
  // `global` + `interest`: a non-global subscriber only receives events whose
  // destinations name it or are `['*']`. The letter store emits `['*']` today, so
  // a non-global subscriber works by luck — narrowing that emit later would stop
  // letter pushes silently. `interest` is the other half: without it a global
  // subscriber is woken by every high-frequency streaming delta just to
  // early-return, which is exactly the fan-out that caused event-loop starvation
  // before.
  bus.subscribe('letter-push', async (event) => {
    if (event.name !== EventNames.HUMAN_INBOX_LETTER) return
    try {
      const data = eventData<typeof EventNames.HUMAN_INBOX_LETTER>(event)
      // Envelope only. `textPreview` is capped at 300 chars at write time; the
      // document body never rides a push (it stays behind
      // GET /api/v1/human-inbox/:id).
      await pushLetter({
        letterId: data.letterId,
        subject: data.subject,
        type: data.type,
        textPreview: data.textPreview,
        kind: data.kind,
      })
    } catch (err) {
      // A push must never break the letter that triggered it.
      log.notif.error('letter push: handler error', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }, { global: true, interest: ['human-inbox:'] })
  log.notif.info('letter push service initialized')
}

/** Test seam — lets a test re-subscribe on a fresh bus. */
export function resetLetterPushForTests(): void { subscribed = false }
