/**
 * What became of a user line the daemon may already have written into a CLI
 * (send-dedupe-v1). Pure and self-contained, shared by both daemon twins:
 * daemon-core.ts imports it, daemon-source.ts inlines its text (fn.toString()),
 * so NOTHING here may reference module scope, imports, or helpers.
 *
 * Evidence, strongest first:
 * - The CLI's own word: `command_lifecycle` frames for the line's uuid in the
 *   stream file (the CLI's stdout). completed: it ran (in whatever process).
 *   cancelled: a Stop dropped it. discarded / refused: it never ran and never
 *   will in that session. started: the CLI took it for a turn, which is no
 *   proof of an answer (the CLI may die before its first word). Claude Code's
 *   own rule (conversationRecovery.ts detectTurnInterruption) is that a turn
 *   whose last message is the user's prompt was never answered, and that an
 *   assistant message after it (not an API error) means it was. The stream file
 *   is the CLI's stdout itself, and the CLI prints each assistant message as it
 *   files it in its transcript, so the stream holds every answer the transcript
 *   can: a main-thread assistant frame or a `result` after `started` is the
 *   answer (lineAnswerFrame). Without one, a line started by the process running
 *   now may still be answered (ran, answer 'pending'), and a line started by a
 *   process that is gone never will be: `unanswered`, and the server sends it
 *   once more under a new uuid (line-answer-v1).
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

export type LineFateKind = 'ran' | 'cancelled' | 'dropped' | 'waiting' | 'unanswered'

export interface LineFate {
  fate: LineFateKind
  state?: string
  /**
   * ran with state started (line-answer-v1): 'yes', the CLI printed its answer;
   * 'pending', the process running now took it and has not answered yet. Absent
   * from an older daemon, which cannot tell the two apart.
   */
  answer?: 'yes' | 'pending'
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
  /**
   * line-answer-v1: the server sending this line tells a taken line from an
   * answered one, so a start with no answer from a process that is gone is
   * `unanswered`. Without it (an older server), such a start is `ran` as before:
   * that server would take `unanswered` for a fate it does not know.
   */
  answers?: boolean
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
  /** A `started` frame for the uuid was seen. */
  startedSeen?: boolean
  /** The CLI printed its answer (lineAnswerFrame) after the newest `started` frame for the uuid. */
  answered?: boolean
  /** A marker of the running pid for these ids came before the newest `started` frame: that process took it. */
  startedHere?: boolean
  /** A `cancelled` frame for the uuid came after its newest `started` one: a Stop ended that turn. */
  stoppedAfterStart?: boolean
  /** The process the newest delivery marker (any line) went to: the CLI printing now, as far as the stream says. */
  curPid?: number | null
  /** curPid at the newest `started` frame for the uuid: the process that took it. */
  startPid?: number | null
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
  let startedSeen = prev ? prev.startedSeen === true : false
  let answered = prev ? prev.answered === true : false
  let startedHere = prev ? prev.startedHere === true : false
  let stoppedAfterStart = prev ? prev.stoppedAfterStart === true : false
  let curPid = prev && typeof prev.curPid === 'number' ? prev.curPid : null
  let startPid = prev && typeof prev.startPid === 'number' ? prev.startPid : null
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
      if (ev.state === 'started') {
        // The newest start is the one whose answer counts; which process took it
        // is the one whose marker for these ids came last before it.
        startedSeen = true
        answered = false
        startedHere = markerSeen
        stoppedAfterStart = false
        startPid = curPid
      } else if (ev.state === 'cancelled' && startedSeen) {
        stoppedAfterStart = true
      }
      if (rank[ev.state] && (best === null || rank[ev.state] > rank[best])) best = ev.state
    } else if (startedSeen && !answered && curPid === startPid
      && (line.indexOf('"type":"assistant"') !== -1 || line.indexOf('"type":"result"') !== -1)) {
      // Is this the CLI's answer to the started line? Same rule as lineAnswerFrame
      // (kept inline: the twins run this function's text alone). Only from the
      // process that took it: once a line went to another process (its marker
      // names another pid), what the stream holds is that process's output.
      let ev: { type?: string; parent_tool_use_id?: unknown; error?: unknown; message?: { content?: unknown } } | null = null
      try { ev = JSON.parse(line) } catch { ev = null }
      if (ev && ev.type === 'result') answered = true
      else if (ev && ev.type === 'assistant' && !ev.parent_tool_use_id && !ev.error && ev.message && Array.isArray(ev.message.content)) {
        for (const block of ev.message.content as Array<{ type?: unknown; text?: unknown }>) {
          if (!block || typeof block !== 'object' || block.type === 'thinking' || block.type === 'redacted_thinking') continue
          if (block.type === 'text' && !(typeof block.text === 'string' && block.text.trim() !== '')) continue
          answered = true
          break
        }
      }
      if (markerSeen) outputAfterMarker = true
    } else if (line.indexOf('walnut-injected') !== -1 && line.indexOf('"walnutPid"') !== -1) {
      let mk: { subtype?: string; walnutPid?: number; walnutMessageId?: string; timestamp?: string } | null = null
      try { mk = JSON.parse(line) } catch { mk = null }
      if (mk && mk.subtype === 'walnut-injected' && typeof mk.walnutPid === 'number') curPid = mk.walnutPid
      if (pid && ids.length > 0 && mk && mk.subtype === 'walnut-injected' && mk.walnutPid === pid && typeof mk.walnutMessageId === 'string'
        && ids.indexOf(mk.walnutMessageId) !== -1) {
        markerSeen = true
        outputAfterMarker = false
        const at = typeof mk.timestamp === 'string' ? Date.parse(mk.timestamp) : NaN
        if (Number.isFinite(at) && (markerAt === null || at > markerAt)) markerAt = at
      }
    } else if (line.indexOf('"subtype":"walnut_process"') !== -1) {
      // The daemon spawned a process: its output begins here, whatever it prints.
      let sp: { type?: string; subtype?: string; walnutPid?: number } | null = null
      try { sp = JSON.parse(line) } catch { sp = null }
      if (sp && sp.type === 'system' && sp.subtype === 'walnut_process' && typeof sp.walnutPid === 'number') curPid = sp.walnutPid
    } else if (markerSeen && line && line.indexOf('walnut-injected') === -1
      && !(line.indexOf('"type":"system"') !== -1 && (line.indexOf('"subtype":"turn_retry') !== -1
        || line.indexOf('"subtype":"scheduled_task_fire"') !== -1))) {
      // Anything else after the marker is the CLI's own output: it was not still.
      outputAfterMarker = true
    }
  }
  return {
    best: best, markerSeen: markerSeen, queuedAfterMarker: queuedAfterMarker, markerAt: markerAt, outputAfterMarker: outputAfterMarker,
    startedSeen: startedSeen, answered: answered, startedHere: startedHere, stoppedAfterStart: stoppedAfterStart,
    curPid: curPid, startPid: startPid,
  }
}

/** The fate a finished scan and the daemon's write records prove, or null. */
export function lineFateVerdict(scan: LineFateScan | null, writesText: string, q: LineFateQuery): LineFate | null {
  const ids = q.messageIds || []
  const pid = q.pid
  if (!q.uuid && ids.length === 0) return null
  const best = scan ? scan.best : null
  if (best === 'completed') return { fate: 'ran', state: best }
  if (best === 'started') {
    // line-answer-v1: taken is not answered (see the header).
    if (scan!.answered) return { fate: 'ran', state: best, answer: 'yes' }
    // A Stop ended the turn it started: the user's choice, never sent again (as answered: nothing waits for more).
    if (scan!.stoppedAfterStart) return { fate: 'ran', state: best, answer: 'yes' }
    // Taken by the process running now: its answer may still come. A whole write of
    // these ids into it says so as well as a marker does (the marker may be out of view).
    let here = !!pid && scan!.startedHere === true
    if (!here && pid && ids.length > 0 && writesText) {
      const records = writesText.split('\n')
      for (let i = records.length - 1; i >= 0 && !here; i--) {
        if (!records[i]) continue
        let rec: { pid?: number; uuid?: string; ids?: unknown } | null = null
        try { rec = JSON.parse(records[i]) } catch { rec = null }
        if (!rec || rec.pid !== pid || !Array.isArray(rec.ids)) continue
        if (q.uuid && rec.uuid && rec.uuid !== q.uuid) continue
        const got = rec.ids as unknown[]
        if (ids.every((id) => got.indexOf(id) !== -1)) here = true
      }
    }
    if (here) return { fate: 'ran', state: best, answer: 'pending' }
    // Taken by a process that is gone, which never answered: it never will. An
    // older server knows no such fate: for it, taken is ran (as before).
    return q.answers ? { fate: 'unanswered', state: best } : { fate: 'ran', state: best }
  }
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
 * Is this stream frame the CLI's answer to the line it took (line-answer-v1)?
 * Claude Code's rule for an answered turn (conversationRecovery.ts
 * detectTurnInterruption, after its filters): an assistant message on the main
 * thread that is not an API error (`error` set: isApiErrorMessage) and not only
 * thinking or blank text (filterOrphanedThinkingOnlyMessages,
 * filterWhitespaceOnlyAssistantMessages). A tool call counts, unlike CC's resume
 * filter for an unresolved one: the tool may have run, and a second run of the
 * prompt would run it again. A `result` ends the turn whatever it says (an error
 * result is shown to the user as the turn's end). lineFateScan applies the same
 * rule inline; a parity test holds the two together.
 */
export function lineAnswerFrame(ev: unknown): boolean {
  if (!ev || typeof ev !== 'object') return false
  const e = ev as { type?: unknown; parent_tool_use_id?: unknown; error?: unknown; message?: { content?: unknown } }
  if (e.type === 'result') return true
  if (e.type !== 'assistant' || e.parent_tool_use_id || e.error || !e.message || !Array.isArray(e.message.content)) return false
  for (const block of e.message.content as Array<{ type?: unknown; text?: unknown }>) {
    if (!block || typeof block !== 'object' || block.type === 'thinking' || block.type === 'redacted_thinking') continue
    if (block.type === 'text' && !(typeof block.text === 'string' && block.text.trim() !== '')) continue
    return true
  }
  return false
}

/** What a scan of a Claude Code transcript has found for one line so far (transcriptLineScan). */
export interface TranscriptLineScan {
  /** The line is in the transcript: the CLI took it (its prompt entry, or the queued_command it was folded into). */
  found: boolean
  /** An answer to it followed (same rule as lineAnswerFrame, on transcript entries). */
  answered: boolean
  /** A later prompt began another turn before any answer: the line's turn ended unanswered. */
  closed: boolean
}

/**
 * line-answer-v1, when the stream no longer holds the line's frames (a resume
 * left a stream file of STREAM_ROTATE_BYTES, or they fell out of the scan
 * window): what Claude Code's own transcript says of the line. Read the
 * harness's way (sessionStorage.ts, conversationRecovery.ts): the line is in
 * the session when an entry carries its uuid (print.ts doesMessageExistInSession:
 * such a line is skipped as a duplicate and acked `completed`, never run), or a
 * queued_command attachment names it as `source_uuid` (a line taken mid-turn).
 * Its turn was answered when a main-thread assistant entry (not isSidechain,
 * not isApiErrorMessage, not only thinking or blank text) comes after it before
 * the next prompt; a prompt first (a user entry that is not meta, not a compact
 * summary, not a tool result) means the turn ended unanswered. The text must
 * hold whole lines in file order; pieces fold like lineFateScan.
 */
export function transcriptLineScan(text: string, uuid: string, prev: TranscriptLineScan | null): TranscriptLineScan {
  let found = prev ? prev.found : false
  let answered = prev ? prev.answered : false
  let closed = prev ? prev.closed : false
  const body = text || ''
  let start = 0
  while (uuid && start < body.length) {
    let end = body.indexOf('\n', start)
    if (end === -1) end = body.length
    const line = body.slice(start, end)
    start = end + 1
    const named = line.indexOf(uuid) !== -1
    if (!named && (!found || answered || closed)) continue
    if (!named && line.indexOf('"type":"assistant"') === -1 && line.indexOf('"type":"user"') === -1) continue
    let e: {
      type?: string; uuid?: string; isSidechain?: boolean; isMeta?: boolean; isCompactSummary?: boolean; isApiErrorMessage?: boolean
      attachment?: { type?: string; source_uuid?: string }; message?: { content?: unknown }
    } | null = null
    try { e = JSON.parse(line) } catch { e = null }
    if (!e || typeof e !== 'object' || e.isSidechain === true) continue
    if (e.uuid === uuid || (e.type === 'attachment' && e.attachment && e.attachment.type === 'queued_command' && e.attachment.source_uuid === uuid)) {
      // The newest entry of the line is the one whose answer counts.
      found = true
      answered = false
      closed = false
      continue
    }
    if (!found || answered || closed) continue
    const content = e.message ? e.message.content : undefined
    if (e.type === 'assistant') {
      if (e.isApiErrorMessage === true || !Array.isArray(content)) continue
      for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
        if (!block || typeof block !== 'object' || block.type === 'thinking' || block.type === 'redacted_thinking') continue
        if (block.type === 'text' && !(typeof block.text === 'string' && block.text.trim() !== '')) continue
        answered = true
        break
      }
    } else if (e.type === 'user' && e.isMeta !== true && e.isCompactSummary !== true) {
      const toolResult = Array.isArray(content) && content.some((b: { type?: unknown } | null) => !!b && b.type === 'tool_result')
      if (!toolResult) closed = true
    }
  }
  return { found: found, answered: answered, closed: closed }
}

/** The fate a transcript scan proves for a line whose stream frames are gone, or null (the CLI never took it). */
export function transcriptLineVerdict(scan: TranscriptLineScan | null): LineFate | null {
  if (!scan || !scan.found) return null
  return scan.answered ? { fate: 'ran', state: 'started', answer: 'yes' } : { fate: 'unanswered', state: 'started' }
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
