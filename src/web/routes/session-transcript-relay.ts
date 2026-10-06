/**
 * A session's transcript pages for a phone on the cloud companion, read on the Mac.
 *
 * 2026-10-04 report: on the phone, scrolling up in most sessions ended at a
 * folded "Ran 8 commands" line with nothing above it, and no Load earlier row.
 * The phone talks to the companion, and the companion read a session as a
 * 512 KB bridge tail (about the last 100 entries) and refused older pages, so
 * the paging the Mac serves was never reachable from the phone.
 *
 * Now a rich read on the companion is relayed to the PRIMARY over the same
 * `session.control` relay every other primary-owned read rides (action
 * `transcript`), and the companion hands back the primary's own build: the same
 * rows, the same rich fields, the same cursors (`before`, `visible`, `since`).
 * When the Mac cannot be reached, the newest page still comes from the bridge
 * tail or the synced file as before (that answer does not say `pageable`), and
 * an older page is a 503 the phone shows as "try again".
 */
import { log } from '../../logging/index.js'

/** One page request, as both boxes read it. */
export interface TranscriptPageParams {
  rich: boolean
  before?: string
  since?: string
  visible?: number
}

/**
 * A transcript cursor: ISO-8601 only. Cursors are compared as strings against
 * the transcript's own timestamps, so "Jan 1 2026" would parse and still sort wrong.
 */
export function isTranscriptCursor(v: string): boolean {
  return v.length <= 40 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && !Number.isNaN(Date.parse(v))
}

/** Same safe-id alphabet readSessionTranscript enforces (ids land in filenames). */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/

// ── The primary's half ──

/**
 * Most bytes one relayed page may put on the bridge: the budget the replica's
 * own tail read already ships per poll (session-stream-v1 TRANSCRIPT_TAIL_BYTES).
 * A typical rich page is 100 to 175 KB, but 600 entries of long tool inputs can
 * pass a megabyte, and bulk on the one bridge stream is what ended it in the
 * field (bridge-ingest.ts), taking every phone attach with it.
 */
export const TRANSCRIPT_RELAY_MAX_BYTES = 512 * 1024

interface PageRow { timestamp?: unknown }

/**
 * A page cut to `maxBytes` by dropping its OLDEST rows, marked `truncated` so the
 * client asks for the rest with the next `before`. The cut never splits rows that
 * share a timestamp (one history message's rows do): the next `before` is the
 * first kept row's timestamp, which excludes that whole run, so a half left
 * behind would never be read. When even the newest run is over the budget it is
 * kept whole, since nothing smaller is a valid page.
 */
export function capRelayedPage<T extends { truncated: boolean; messages: PageRow[] }>(page: T, maxBytes = TRANSCRIPT_RELAY_MAX_BYTES): T {
  const rows = page.messages
  const shell = Buffer.byteLength(JSON.stringify({ ...page, messages: [] }))
  const sizes = rows.map((r) => Buffer.byteLength(JSON.stringify(r)) + 1)
  let used = shell + sizes.reduce((a, b) => a + b, 0)
  if (used <= maxBytes) return page
  let k = 0
  while (k < rows.length && used > maxBytes) used -= sizes[k++]
  while (k > 0 && k < rows.length && rows[k - 1].timestamp === rows[k].timestamp) k++
  if (k >= rows.length) {
    k = rows.length - 1
    while (k > 0 && rows[k - 1].timestamp === rows[k].timestamp) k--
  }
  return { ...page, truncated: true, messages: rows.slice(k) }
}

/**
 * Build the page the replica asked for, exactly as the primary's own
 * GET /api/v1/sessions/:id/transcript builds it, cut to the bridge budget
 * (capRelayedPage). The replica adds `rich` / `pageable` the way the route does.
 */
export async function handlePrimaryTranscriptRelay(
  sessionId: string,
  raw: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!SAFE_SESSION_ID.test(sessionId)) throw new Error(`Invalid session id: ${sessionId}`)
  const cursor = (name: 'before' | 'since'): string | undefined => {
    const v = raw[name]
    if (v === undefined) return undefined
    if (typeof v !== 'string' || !isTranscriptCursor(v)) throw new Error(`${name} must be an ISO-8601 timestamp`)
    return v
  }
  const before = cursor('before')
  const since = cursor('since')
  const { buildSessionTranscript, TRANSCRIPT_VISIBLE_MAX } = await import('../../core/session-projection.js')
  const visible = typeof raw.visible === 'number' && Number.isInteger(raw.visible) && raw.visible > 0
    ? Math.min(raw.visible, TRANSCRIPT_VISIBLE_MAX)
    : undefined
  const page = await buildSessionTranscript(sessionId, {
    rich: raw.rich === true,
    ...(before ? { before } : {}),
    ...(since ? { since } : {}),
    ...(visible ? { visible } : {}),
  })
  return capRelayedPage(page) as unknown as Record<string, unknown>
}

// ── The replica's half ──

/**
 * Relay budgets, inside the phone's own 30 s request timeout. An older page has
 * no fallback and may be slow: the first one of a remote whale reads the whole
 * file over SSH on the Mac (measured 4.9 s on a 2,300-row session). A newest
 * page does have one (the bridge tail, then the synced file, which can cost
 * another 10 s resolving the session's host), so it gives the Mac less: a bridge
 * that still looks connected while the Mac sleeps must not hold every poll.
 */
export const TRANSCRIPT_PAGE_RELAY_TIMEOUT_MS = 20_000
export const TRANSCRIPT_NEWEST_RELAY_TIMEOUT_MS = 10_000

/** The relay targets the primary's daemon, whatever host the session runs on. */
const PRIMARY_HOST = '__local__'

export type RelayedTranscript =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; reason: string }

class RelayMiss extends Error {}

/**
 * One page as the PRIMARY builds it, or why not (bridge down, an older primary
 * without the action, a malformed reply). Coalesced per session and cursor: a
 * burst of phone polls for the same page is one relay, and a cached answer is
 * reused only while nothing new reached the session (ws/bridge-read-history.ts).
 */
export async function relayTranscriptToPrimary(sessionId: string, params: TranscriptPageParams): Promise<RelayedTranscript> {
  const { coalescedSessionRead } = await import('../ws/bridge-read-history.js')
  const key = `${sessionId}|transcript|${params.rich ? 1 : 0}|${params.before ?? ''}|${params.since ?? ''}|${params.visible ?? ''}`
  try {
    const body = await coalescedSessionRead(PRIMARY_HOST, sessionId, () => readFromPrimary(sessionId, params), key)
    return { ok: true, body }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log.web.info('transcript relay: the primary did not answer, falling back', { sessionId, before: params.before, reason })
    return { ok: false, reason }
  }
}

async function readFromPrimary(sessionId: string, params: TranscriptPageParams): Promise<Record<string, unknown>> {
  const { callPrimaryControl } = await import('./v1-control-relay.js')
  const outcome = await callPrimaryControl(
    'transcript',
    sessionId,
    {
      rich: params.rich,
      ...(params.before ? { before: params.before } : {}),
      ...(params.since ? { since: params.since } : {}),
      ...(params.visible ? { visible: params.visible } : {}),
    },
    params.before ? TRANSCRIPT_PAGE_RELAY_TIMEOUT_MS : TRANSCRIPT_NEWEST_RELAY_TIMEOUT_MS,
  )
  if (!outcome.ok) throw new RelayMiss(`${outcome.failure.kind}: ${outcome.failure.message}`)
  if (!Array.isArray(outcome.result.messages)) throw new RelayMiss('malformed reply: no messages')
  return outcome.result
}
