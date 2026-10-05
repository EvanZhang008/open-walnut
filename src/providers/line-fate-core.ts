/**
 * What became of a user line the daemon may already have written into a CLI
 * (send-dedupe-v1). Pure and self-contained, shared by both daemon twins:
 * daemon-core.ts imports it, daemon-source.ts inlines its text (fn.toString()),
 * so NOTHING here may reference module scope, imports, or helpers.
 *
 * Evidence, strongest first:
 * - The CLI's own word: `command_lifecycle` frames for the line's uuid in the
 *   stream file (the CLI's stdout). started / completed: it ran (in whatever
 *   process). cancelled: a Stop dropped it. discarded / refused: it never ran
 *   and never will in that session.
 * - The daemon's write record (`<stream>.lines`, appended only AFTER the final
 *   newline went into the pipe): the whole line is in the stdin of process
 *   `pid`, so the CLI holds it or is about to read it.
 * - A delivery marker stamped with `pid` followed by a `queued` frame for the
 *   uuid: the CLI parsed the whole line (covers a write whose record was lost).
 *
 * A marker alone proves nothing: it is written before the newline, so a write
 * cut short by the daemon's death leaves a marker for a line the CLI never got.
 * A marker from an older daemon carries no pid and is never counted either way.
 * Null means "not proven in": the caller writes the line (same uuid, so the
 * CLI's own uuid check still skips a line its process already received).
 */

export type LineFateKind = 'ran' | 'cancelled' | 'dropped' | 'waiting'

export interface LineFate { fate: LineFateKind; state?: string }

export interface LineFateQuery {
  uuid: string
  messageIds: string[]
  /** The CLI process running now (null: none). */
  pid: number | null
}

/** What a scan of stream lines has found so far (lineFateScan folds pieces in order). */
export interface LineFateScan {
  /** The most final lifecycle word for the uuid. */
  best: string | null
  /** A delivery marker for these ids stamped with the running pid. */
  markerSeen: boolean
  /** A `queued` frame for the uuid after such a marker. */
  queuedAfterMarker: boolean
}

/**
 * Fold stream text into `prev` (null: a fresh scan). The text must hold whole
 * lines in file order (the daemon feeds a long tail piece by piece, each cut at
 * a newline), so a scan never blocks its loop for the whole window.
 */
export function lineFateScan(text: string, q: LineFateQuery, prev: LineFateScan | null): LineFateScan {
  const uuid = q.uuid
  const ids = q.messageIds || []
  const pid = q.pid
  // The most final word wins: completed after started; a run outranks a later cancel (its turn was aborted).
  const rank: Record<string, number> = { completed: 4, started: 3, cancelled: 2, discarded: 1, refused: 1 }
  let best: string | null = prev ? prev.best : null
  let markerSeen = prev ? prev.markerSeen : false
  let queuedAfterMarker = prev ? prev.queuedAfterMarker : false
  const body = text || ''
  let start = 0
  while (start < body.length) {
    let end = body.indexOf('\n', start)
    if (end === -1) end = body.length
    const line = body.slice(start, end)
    start = end + 1
    if (uuid && line.indexOf('command_lifecycle') !== -1 && line.indexOf(uuid) !== -1) {
      let ev: { type?: string; command_uuid?: string; state?: string } | null = null
      try { ev = JSON.parse(line) } catch { ev = null }
      if (!ev || ev.type !== 'command_lifecycle' || ev.command_uuid !== uuid || typeof ev.state !== 'string') continue
      if (ev.state === 'queued') { if (markerSeen) queuedAfterMarker = true; continue }
      if (rank[ev.state] && (best === null || rank[ev.state] > rank[best])) best = ev.state
    } else if (pid && ids.length > 0 && line.indexOf('walnut-injected') !== -1 && line.indexOf('"walnutPid"') !== -1) {
      let mk: { subtype?: string; walnutPid?: number; walnutMessageId?: string } | null = null
      try { mk = JSON.parse(line) } catch { mk = null }
      if (mk && mk.subtype === 'walnut-injected' && mk.walnutPid === pid && typeof mk.walnutMessageId === 'string'
        && ids.indexOf(mk.walnutMessageId) !== -1) markerSeen = true
    }
  }
  return { best: best, markerSeen: markerSeen, queuedAfterMarker: queuedAfterMarker }
}

/** The fate a finished scan and the daemon's write records prove, or null. */
export function lineFateVerdict(scan: LineFateScan | null, writesText: string, q: LineFateQuery): LineFate | null {
  const ids = q.messageIds || []
  const pid = q.pid
  if (!q.uuid && ids.length === 0) return null
  const best = scan ? scan.best : null
  if (best === 'started' || best === 'completed') return { fate: 'ran', state: best }
  if (best === 'cancelled') return { fate: 'cancelled', state: best }
  if (best === 'discarded' || best === 'refused') return { fate: 'dropped', state: best }
  if (pid && ids.length > 0 && writesText) {
    const records = writesText.split('\n')
    for (let i = records.length - 1; i >= 0; i--) {
      if (!records[i]) continue
      let rec: { pid?: number; ids?: unknown } | null = null
      try { rec = JSON.parse(records[i]) } catch { rec = null }
      if (!rec || rec.pid !== pid || !Array.isArray(rec.ids)) continue
      const got = rec.ids as unknown[]
      if (ids.every((id) => got.indexOf(id) !== -1)) return { fate: 'waiting' }
    }
  }
  if (scan && scan.markerSeen && scan.queuedAfterMarker) return { fate: 'waiting', state: 'queued' }
  return null
}

/** The whole stream text at once (tests and smoke checks; the daemons scan piece by piece). */
export function lineFate(streamText: string, writesText: string, q: LineFateQuery): LineFate | null {
  return lineFateVerdict(lineFateScan(streamText, q, null), writesText, q)
}
