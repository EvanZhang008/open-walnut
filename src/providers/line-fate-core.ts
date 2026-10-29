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
 *   newline went into the pipe): the whole line went into the stdin pipe of
 *   process `pid`, so the CLI holds it or is about to read it. Unless another
 *   reader of the pipe took the bytes (2026-10-05: an agent's grep named the
 *   live FIFOs on its command line), and then the record would answer
 *   "waiting" forever. So the server challenges a line the CLI never names
 *   (send-lost-line-v1): once the process answers a request written after the
 *   line without a word on it, the server asks with `lostPid`, and that
 *   process's records no longer count. The CLI's own frames always do.
 * - A delivery marker stamped with `pid` followed by a `queued` frame for the
 *   uuid: the CLI parsed the whole line (covers a write whose record was lost).
 * - Never proof of delivery, only of a doubt: a `begin` record, written to the
 *   same file before the line's first byte. A begin with no whole-write record
 *   after it is a write that died part way (the daemon was killed inside it), so
 *   the pipe may hold a cut copy of the line (lineWriteBegun, lineWriteCut).
 *
 * - Never proof of anything about the line, only how long the process has been
 *   still: a waiting answer from a write record carries when that write went in
 *   (`writtenAt`) and, while the line's marker is in view, whether the CLI has
 *   printed nothing since it (`quiet`). A CLI that runs a turn prints (text, tool
 *   calls, a tool_progress beat every 30 s), so a quiet process is one that has
 *   not read its input. The server bounds how long it trusts "waiting" for such a
 *   process (ClaudeCodeSession.LINE_UNREAD_PARK_MS); the daemon decides nothing.
 *
 * A marker alone proves nothing: it is written before the newline, so a write
 * cut short by the daemon's death leaves a marker for a line the CLI never got.
 * A marker from an older daemon carries no pid and is never counted either way.
 * Null means "not proven in": the caller writes the line (same uuid, so the
 * CLI's own uuid check still skips a line its process already received).
 */

export type LineFateKind = 'ran' | 'cancelled' | 'dropped' | 'waiting'

export interface LineFate {
  fate: LineFateKind
  state?: string
  /** waiting, from a write record: when that whole write went into the process (ms). */
  writtenAt?: number
  /** waiting, from a write record: the line's marker is in view and the CLI printed nothing after it. */
  quiet?: true
}

export interface LineFateQuery {
  uuid: string
  messageIds: string[]
  /** The CLI process running now (null: none). */
  pid: number | null
  /**
   * send-lost-line-v1: a process the server proved read past this line without
   * taking it (it answered a request written after the line, and never named
   * the line). Its write records no longer say the line waits in it, as long
   * as the scan saw this process's marker for the line (else they still do).
   */
  lostPid?: number | null
}

/** What a scan of stream lines has found so far (lineFateScan folds pieces in order). */
export interface LineFateScan {
  /** The most final lifecycle word for the uuid. */
  best: string | null
  /** A delivery marker for these ids stamped with the running pid. */
  markerSeen: boolean
  /** A `queued` frame for the uuid after such a marker. */
  queuedAfterMarker: boolean
  /** When the newest such marker was written (ms), or null (none, or none with a time). */
  markerAt?: number | null
  /**
   * The CLI printed a line after the newest such marker. Walnut's own lines do
   * not count: markers (walnut-injected) and the daemon's system notes
   * (turn_retry, turn_retry_stopped, scheduled_task_fire).
   */
  outputAfterMarker?: boolean
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
  let markerAt = prev && typeof prev.markerAt === 'number' ? prev.markerAt : null
  let outputAfterMarker = prev ? prev.outputAfterMarker === true : false
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
      let mk: { subtype?: string; walnutPid?: number; walnutMessageId?: string; timestamp?: string } | null = null
      try { mk = JSON.parse(line) } catch { mk = null }
      if (mk && mk.subtype === 'walnut-injected' && mk.walnutPid === pid && typeof mk.walnutMessageId === 'string'
        && ids.indexOf(mk.walnutMessageId) !== -1) {
        markerSeen = true
        outputAfterMarker = false
        const at = typeof mk.timestamp === 'string' ? Date.parse(mk.timestamp) : NaN
        if (Number.isFinite(at) && (markerAt === null || at > markerAt)) markerAt = at
      }
    } else if (markerSeen && line && line.indexOf('walnut-injected') === -1
      && !(line.indexOf('"type":"system"') !== -1 && (line.indexOf('"subtype":"turn_retry') !== -1
        || line.indexOf('"subtype":"scheduled_task_fire"') !== -1))) {
      // Anything else after the marker is the CLI's own output: it was not still.
      outputAfterMarker = true
    }
  }
  return { best: best, markerSeen: markerSeen, queuedAfterMarker: queuedAfterMarker, markerAt: markerAt, outputAfterMarker: outputAfterMarker }
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
  // A lostPid sets the records aside only while this process's marker for the
  // line is inside the scanned window: then "no frame after it" was looked for.
  // Past the window the CLI has printed megabytes since the line, its frame may
  // simply be out of view, and the record still answers waiting.
  const recordsSetAside = q.lostPid === pid && !!scan && scan.markerSeen
  if (pid && ids.length > 0 && writesText && !recordsSetAside) {
    const records = writesText.split('\n')
    for (let i = records.length - 1; i >= 0; i--) {
      if (!records[i]) continue
      let rec: { pid?: number; uuid?: string; ids?: unknown; at?: unknown } | null = null
      try { rec = JSON.parse(records[i]) } catch { rec = null }
      if (!rec || rec.pid !== pid || !Array.isArray(rec.ids)) continue
      if (q.uuid && rec.uuid && rec.uuid !== q.uuid) continue
      const got = rec.ids as unknown[]
      if (ids.every((id) => got.indexOf(id) !== -1)) {
        // How long the process has been still, for the server's bound (see the header).
        const waiting: LineFate = { fate: 'waiting' }
        if (typeof rec.at === 'number' && Number.isFinite(rec.at)) waiting.writtenAt = rec.at
        if (scan && scan.markerSeen && !scan.outputAfterMarker && !scan.queuedAfterMarker) waiting.quiet = true
        return waiting
      }
    }
  }
  if (scan && scan.markerSeen && scan.queuedAfterMarker) return { fate: 'waiting', state: 'queued' }
  return null
}

/**
 * Must a resend that writes its line put a newline ahead of it? Yes for a line
 * with a uuid that nothing proves in (verdict null) whose delivery marker for
 * the process running now is in the stream. The write then went into this
 * process's stdin at least up to its marker, which sits between the body and
 * the newline, and may have died before the newline (the write record comes
 * only after it, and the newline is the write that waits on a full pipe). The
 * copy written straight after that body would merge with it into one malformed
 * line, and the CLI exits on a malformed line. A lone newline ends it, so the
 * CLI reads it whole and runs it, then drops the copy by its uuid; where the
 * newline did go in, the extra one is an empty line, which the CLI skips.
 * Also yes when an earlier write of the line into this process began and never
 * finished (`begunAt`, lineWriteBegun): its body may be in the pipe without its
 * marker. Without either, nothing of the line went into this process, so no
 * newline: a first write into a process carries none (send-lost-line-v1 keeps
 * that rule). Without a uuid the CLI could run both, so such a line is written
 * as before.
 */
export function lineTornEnd(verdict: LineFate | null, q: LineFateQuery, scan: LineFateScan | null, begunAt: number | null = null): boolean {
  return !!q.uuid && verdict === null && ((!!scan && scan.markerSeen) || begunAt !== null)
}

/**
 * When a write of this line into this process began and never finished (the
 * daemon notes a `begin` before a line's first byte goes in, see recordLineBegun):
 * the time the newest such write began. Null when a whole write of the line comes
 * after every unfinished begin, or there is none. An `unbegun` (that attempt ended
 * with not one byte in, so it left nothing) takes back only the begin of its own
 * attempt, the one right before it: an older attempt that died part way still
 * stands (r5 gate N3: begin, begin, unbegun used to read as "nothing begun", so a
 * third resend was neither ended nor said cut). Begins and unbegun carry their
 * ids under `begin` / `unbegun`, never `ids`, so a reader that knows only
 * whole-write records never takes them for one.
 */
export function lineWriteBegun(writesText: string, q: LineFateQuery): number | null {
  const ids = q.messageIds || []
  const pid = q.pid
  if (!pid || ids.length === 0 || !writesText) return null
  const records = writesText.split('\n')
  // Newest first: each unbegun cancels the next begin met (its own attempt's).
  let takenBack = 0
  for (let i = records.length - 1; i >= 0; i--) {
    if (!records[i]) continue
    let rec: { pid?: number; uuid?: string; ids?: unknown; begin?: unknown; unbegun?: unknown; at?: unknown } | null = null
    try { rec = JSON.parse(records[i]) } catch { rec = null }
    if (!rec || rec.pid !== pid) continue
    if (q.uuid && rec.uuid && rec.uuid !== q.uuid) continue
    const got = Array.isArray(rec.ids) ? rec.ids as unknown[] : Array.isArray(rec.begin) ? rec.begin as unknown[]
      : Array.isArray(rec.unbegun) ? rec.unbegun as unknown[] : null
    if (!got || !ids.every((id) => got.indexOf(id) !== -1)) continue
    if (Array.isArray(rec.ids)) return null
    if (Array.isArray(rec.unbegun)) { takenBack++; continue }
    if (takenBack > 0) { takenBack--; continue }
    return typeof rec.at === 'number' ? rec.at : 0
  }
  return null
}

/**
 * Is what an earlier, unfinished write of this line left in the pipe possibly
 * cut inside its body? Then the CLI will exit on it (Claude Code exits on a line
 * that does not parse) without running the line, whatever is written after it,
 * and the process must not count as having the line. Yes for a uuid line nothing
 * proves in whose newest write began (`begunAt`) with no marker of this process
 * written since: the marker goes in right after the body's last byte, so a marker
 * at or after the begin means the whole body is in (then the newline of
 * lineTornEnd is all it needs).
 */
export function lineWriteCut(verdict: LineFate | null, q: LineFateQuery, scan: LineFateScan | null, begunAt: number | null): boolean {
  if (!q.uuid || verdict !== null || begunAt === null) return false
  const markerAt = scan && typeof scan.markerAt === 'number' ? scan.markerAt : null
  return !(markerAt !== null && markerAt >= begunAt)
}

/** How much of one FIFO write of a line went into the pipe before the write ended. */
export type LineWritten = 'none' | 'prefix' | 'body' | 'line'

/**
 * Classify a FIFO write that ended (well or not) from how far it got: `offset`
 * bytes of a `length`-byte buffer whose first `lead` bytes are newlines put
 * ahead of the line (a torn end, a rewrite). Those newlines alone leave nothing
 * a CLI can run: 'none'. Every byte but the last newline: 'body' (a whole line
 * the next newline would complete). Anything between: 'prefix'. All of it:
 * 'line'. A write that failed after anything past the newlines went in may have
 * left the line, or part of it, with the CLI, so it is not a "nothing was sent".
 */
export function lineWrittenPart(offset: number, length: number, lead: number): LineWritten {
  if (length > 0 && offset >= length) return 'line'
  if (offset <= lead) return 'none'
  if (offset >= length - 1) return 'body'
  return 'prefix'
}

/** The whole stream text at once (tests and smoke checks; the daemons scan piece by piece). */
export function lineFate(streamText: string, writesText: string, q: LineFateQuery): LineFate | null {
  return lineFateVerdict(lineFateScan(streamText, q, null), writesText, q)
}
