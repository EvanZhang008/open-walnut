/**
 * What the Mac believes the cloud replica already holds, per push key
 * (`projection:<which>` / `transcript:<sid>`), and the one-pass serialization
 * the pushes hash. Used by projection-cache.ts, which owns the lanes.
 *
 * A record is the content hash last DELIVERED and the lane it went over
 * (INGEST_LANE, or the bridge connection id). A push whose content is unchanged
 * on the SAME lane is not sent again (a bridge redial or a replica restart means
 * a new connId, so everything goes again). Applies at write time and in the sweep.
 *
 * Only a delivery writes a record, and any other outcome ERASES it: a failed
 * request may still have landed (timeout or reset after the replica wrote it), so
 * after one the Mac no longer knows what the replica holds. Keeping the older
 * record let content that went A → B(lost answer) → A be skipped as "unchanged"
 * while the replica served B.
 *
 * The hash leaves out the envelope's `exportedAt`: the exporters rewrite an
 * identical list with a fresh stamp (half of all task-list exports on 2026-09-27
 * changed nothing else). The replica serves that stamp as the phone's "Synced X
 * ago", so an unchanged list still reaches it at least every 10 minutes, and a
 * transcript every 30 (DELIVERY_BOUND_MS). A skip is allowed only while the last
 * delivery is younger than that bound minus one self-heal interval: whatever the
 * phase of the last delivery against the 5-minute sweep grid (a write-time push
 * lands between ticks, and every send takes time), the first sweep past the skip
 * window falls inside the bound. With a bare 10-minute window, a list delivered a
 * second after a tick was skipped at the 10-minute tick and went at 15.
 *
 * Why any of this (Mac uplink, 2026-09-25/26): every 5-minute sweep re-sent
 * ~1.7MB (a 1.5MB task list, 158KB of sessions, live transcripts) whether or not
 * anything had changed, and bridge flaps clustered within a second of the ticks.
 */

import crypto from 'node:crypto'

export type PushKind = 'projection-upsert' | 'transcript-upsert'

/** The self-heal sweep's cadence (projection-cache.ts startProjectionCacheSelfHeal). */
export const SELF_HEAL_INTERVAL_MS = 5 * 60_000

/** The longest an unchanged payload goes without reaching the replica. */
export const DELIVERY_BOUND_MS: Readonly<Record<PushKind, number>> = {
  'projection-upsert': 10 * 60_000,
  'transcript-upsert': 30 * 60_000,
}

export const INGEST_LANE = 'ingest'
const RECORDS_MAX = 1_000
const records = new Map<string, { hash: string; via: string; at: number }>()

/** How long a delivery may be trusted for a skip (bound minus one sweep). */
export function skipWindowMs(kind: PushKind): number {
  return DELIVERY_BOUND_MS[kind] - SELF_HEAL_INTERVAL_MS
}

/** Does the replica already hold exactly this content, delivered over `via`? */
export function alreadyHeld(kind: PushKind, key: string | null, hash: string, via: string | null): boolean {
  const held = key && via ? records.get(key) : undefined
  return !!held && held.via === via && held.hash === hash && Date.now() - held.at < skipWindowMs(kind)
}

/** A delivery: the replica now holds `hash` for `key`. */
export function rememberDelivery(key: string | null, hash: string, via: string): void {
  if (!key) return
  records.delete(key)
  records.set(key, { hash, via, at: Date.now() })
  if (records.size > RECORDS_MAX) {
    const oldest = records.keys().next().value
    if (oldest !== undefined) records.delete(oldest)
  }
}

/** Anything but a delivery or a skip: what the replica holds is unknown now. */
export function forgetDelivery(key: string | null): void {
  if (key) records.delete(key)
}

/**
 * Serialize a `{which|sid, data}` payload ONCE, and hash it without
 * `data.exportedAt`. The wire string is built by splicing the stamp back in, so a
 * 1.6MB list is stringified one time, not twice. The wire parses back to the
 * payload (pinned in tests).
 */
export function preparePush(payload: unknown): { wire: string; hash: string } | null {
  const sha1 = (s: string): string => crypto.createHash('sha1').update(s).digest('hex')
  const p = payload as Record<string, unknown> | null
  const data = p && typeof p === 'object' ? p.data : undefined
  if (!p || !data || typeof data !== 'object' || Array.isArray(data) || !('exportedAt' in data)) {
    const wire = JSON.stringify(payload)
    return typeof wire === 'string' ? { wire, hash: sha1(wire) } : null
  }
  const { exportedAt, ...rest } = data as Record<string, unknown>
  const { data: _data, ...head } = p
  const restJson = JSON.stringify(rest)
  const headJson = JSON.stringify(head)
  const stamp = exportedAt === undefined ? undefined : JSON.stringify(exportedAt)
  const dataJson = stamp === undefined ? restJson
    : `{"exportedAt":${stamp}${restJson === '{}' ? '}' : `,${restJson.slice(1)}`}`
  const wire = headJson === '{}' ? `{"data":${dataJson}}` : `${headJson.slice(0, -1)},"data":${dataJson}}`
  return { wire, hash: sha1(`${headJson}\n${restJson}`) }
}

/** Tests only. */
export function _resetProjectionPushStateForTesting(): void {
  records.clear()
}
