/**
 * The reply requests a host replica shows while the Mac is away: its copy of the Mac's
 * (session-requests.json, the `requests` copy kind) with this host's journal folded over it
 * (overlay.ts keeps the `row` and `settle` records the host's daemon wrote, pending or acked
 * and not yet back in the copy):
 *
 *   row     a request this host opened or moved while away (offline-host-core.ts opTaskSend,
 *           notify, the reply that settled it), shown as the Mac's drain will import it
 *           (offline-merge/request-row.ts); its newest record wins, and a copy row the Mac
 *           already settled keeps its final status (kinds/requests.ts forwardRequest)
 *   settle  a copy's request answered here: replied, at the record's time
 *
 * So request_get finds a request the daemon owns, and open_items lists the caller's open
 * requests both ways, as the daemon's own offline answers did (offline-host-core.ts
 * opRequestGet, opOpenItems). Installed into the request readers by away-wiring.ts
 * (session-requests.ts installAwayRequests); nothing installs it on the Mac or the companion.
 */
import type { SessionRequest } from '../core/session-requests.js'
import type { OfflineRequestRow } from '../providers/offline-host-core.js'
import { requestOfRow } from '../core/offline-merge/request-row.js'
import { forwardRequest } from '../core/replication/kinds/requests.js'
import type { Overlay } from './overlay.js'

/** A journal record as the overlay holds it (overlay.ts OverlayEntry), as far as this reads it. */
export interface RequestRecordEntry { kind: string; seq: number; at: number; record: Record<string, unknown> }

function isRow(r: unknown): r is OfflineRequestRow {
  const o = r as Partial<OfflineRequestRow> | null
  return !!o && typeof o.id === 'string' && /^rq-[a-f0-9]{6,}$/.test(o.id) && typeof o.fromSessionId === 'string'
    && typeof o.toSessionId === 'string' && typeof o.status === 'string' && typeof o.createdAt === 'string'
}

/** The copy's rows with the journal's request records folded over them (see the header). */
export function foldAwayRequests(copy: readonly SessionRequest[], entries: readonly RequestRecordEntry[]): SessionRequest[] {
  const rows = new Map<string, { seq: number; row: OfflineRequestRow }>()
  const settles = new Map<string, { seq: number; at: number; status: string }>()
  for (const e of entries) {
    if (e.kind === 'row' && isRow(e.record.row)) {
      const prev = rows.get(e.record.row.id)
      if (!prev || e.seq > prev.seq) rows.set(e.record.row.id, { seq: e.seq, row: e.record.row })
    } else if (e.kind === 'settle' && typeof e.record.requestId === 'string') {
      const prev = settles.get(e.record.requestId)
      if (!prev || e.seq > prev.seq) settles.set(e.record.requestId, { seq: e.seq, at: e.at, status: typeof e.record.status === 'string' ? e.record.status : 'replied' })
    }
  }
  if (!rows.size && !settles.size) return copy as SessionRequest[]
  const out: SessionRequest[] = []
  const seen = new Set<string>()
  for (const c of copy) {
    seen.add(c.id)
    const own = rows.get(c.id)
    let r = own ? forwardRequest(c, requestOfRow(own.row)) : c
    const s = settles.get(c.id)
    if (s && r.status === 'pending') r = { ...r, status: s.status as SessionRequest['status'], settledAt: new Date(s.at).toISOString() }
    out.push(r)
  }
  for (const [id, { row }] of rows) if (!seen.has(id)) out.push(requestOfRow(row))
  return out
}

/**
 * The request readers' fold (session-requests.ts installAwayRequests), only while the Mac is
 * away: with it, the requests copy is its word, nothing is folded and the daemon is not asked.
 * Away, the overlay is asked first (forced: a request the daemon opened for a call it answered
 * itself is in no earlier answer; away request reads are few), within `waitMs`.
 */
export function awayRequestReader(deps: { macAnswers(): boolean; overlay: Pick<Overlay, 'refresh' | 'entries'>; waitMs?: number }): (rows: SessionRequest[]) => Promise<SessionRequest[]> {
  const waitMs = deps.waitMs ?? 1_500
  return async (rows) => {
    if (deps.macAnswers()) return rows
    await Promise.race([deps.overlay.refresh(0), new Promise<void>((r) => { const t = setTimeout(r, waitMs); t.unref?.() })])
    return foldAwayRequests(rows, deps.overlay.entries())
  }
}
