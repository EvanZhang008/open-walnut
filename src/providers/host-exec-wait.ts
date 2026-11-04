/**
 * `wait_for` on host_exec and host_exec_read (host-exec-wait-v1): ONE call returns as soon as a
 * job's output has a line matching a pattern, a TCP port on this host is listening, or a file
 * exists here, instead of the caller polling host_exec_read with guessed sleeps. The wait runs in
 * the host's daemon (host-exec-core.ts, `exec.read {until}`), next to the log, the port and the
 * files, about every 200 ms; the server only relays it (src/core/hosts/host-exec-wait.ts).
 *
 * Output: the daemon reads the log and cuts it into lines (a line ends at \n or \r, as a terminal
 * shows it: a \r ends its line at once, and a \n right after it ends nothing more), and the lines
 * are tested in the killable matcher (host-exec-matcher.ts), never on the daemon's loop. A line
 * counts when it is whole; the last one also once the job ended (the answer says it had no line
 * end, `unfinished`), and the one still being written only with `partial` (a `Password: `
 * prompt), once it has not grown for a check interval (a line arrives in blocks: `port 30` may be
 * the start of `port 3000`). Without `partial` that line is still tested once it is quiet, only to
 * say so when the wait ends with no match (`wouldMatch`). A line is tested on its first
 * LINE_TEST_MAX characters (64 K); a longer one is counted, so the answer can say it was cut, and
 * nothing may hold at its cut (cutPattern). Colour codes are removed before a line is tested.
 *
 * Every wait ends within its bound and a moment: an answer of the matcher that does not come in
 * time is not waited for (its lines stay untested, and the ask is withdrawn when the wait ends),
 * and a port or file look near the bound gets what is left of it (2026-11-04 review: a wait of
 * 0.5 s on a slow matcher answered after 5 s, past the caller's read deadline). The moment: a look
 * still gives the first batch of output already in the log OUTPUT_FLOOR_MS (COLD_FLOOR_MS while
 * the matcher process starts), as a port or file look gets PROBE_FLOOR_MS, so a wait of 0 ms
 * still says whether the line is there now (2026-11-04 review: wait_ms 0 tested no line at all).
 *
 * A look that tests nothing (it only skipped bytes of a line past LINE_TEST_MAX) waits a check
 * interval before the next, so a job printing megabytes with no line end does not keep the
 * daemon's loop busy. The log's size is read at every look, also one that reads none of it (a
 * backlog of lines), so the job's end is judged against what the log holds now.
 *
 * Port and file: host-exec-probe.ts. Cutting the output into lines: host-exec-line.ts.
 */
import fs from 'node:fs'
import { ANSI, stripAnsi, type MatchAsk, type Matcher, type MatchResult } from './host-exec-matcher.js'
import { parseWaitFor, type LinePattern, type WaitFor, type WaitKind } from './host-exec-pattern.js'
import { FILE_LOOK_MS, PORT_PROBE_MS, lookFile, lookPort, probeFile, resolveWaitFile, waitRefusal, type FileLook } from './host-exec-probe.js'
import { WAIT_CHECK_MS, charsBetween, createLineSplitter, isStrictMarkLine, lineStartOf, placeIn, type ExecError, type SplitLine } from './host-exec-line.js'

export { WAIT_PATTERN_MAX, cutPattern, linePattern, parseWaitFor, type LinePattern, type WaitFor, type WaitKind } from './host-exec-pattern.js'
export { localAddresses, lookFile, probeFile, probePort, resolveWaitFile, waitRefusal } from './host-exec-probe.js'
export { LINE_TEST_MAX, WAIT_CHECK_MS, createLineSplitter, lineHead, type LineSplitter, type ScanEdge, type SplitLine } from './host-exec-line.js'

const SCAN_PIECE_BYTES = 64 * 1024
const SCAN_CHECK_BYTES = 1024 * 1024
/** A check gives the matcher at most this long before it looks at the port and the file again. */
const SCAN_CHECK_MS = 250
/**
 * One batch for the matcher: at most this many lines, and about this much text. A batch the
 * matcher cut at its time slice (a slow pattern) makes the next one about twice what it tested,
 * never under BATCH_LINES_MIN, so a slow pattern is not sent the same lines again and again.
 */
const BATCH_LINES = 16_384
const BATCH_LINES_MIN = 256
const BATCH_CHARS = 512 * 1024
/** A wait holds at most this many lines waiting for the matcher, and about this much of their text. */
const PENDING_MAX = 32_768
const PENDING_CHARS = 1024 * 1024
/** The look a wait takes past its bound when the job ended during its last one. */
const LAST_LOOK_MS = 100
/** A port or file look near the bound still gets this long (a look past it would answer nothing). */
const PROBE_FLOOR_MS = 200
/** Under this much time before the answer must go (`hard`), no look is taken. */
const PROBE_MIN_MS = 20
/** The first batch of a look still gets this long for the matcher's answer, and this while the matcher process starts. */
const OUTPUT_FLOOR_MS = 250
const COLD_FLOOR_MS = 1_500
/** At most this much of a line that would match comes back. */
const WOULD_SHOW_MAX = 4096

/**
 * What a wait answers: which condition held (null: none did), what it saw (the line, the address,
 * the path), and how long it took. For `output`: `scanned`, the log offset (a line start) up to
 * which the output was tested; `untested`, the bytes after it the wait ran out before; `long`,
 * the lines longer than LINE_TEST_MAX, of which only the start was tested (how many, where the
 * first one starts). `unfinished`: the matched line had no line end yet (without `partial`, it was
 * tested because the job had ended). `wouldMatch`: no match, but the line still being written
 * (no line end yet) matches; only `partial` counts it. `tooSlow`: the pattern held the matcher
 * past its limit on one line, which ended the wait. `already`: the port or file held at the
 * wait's first look, and `beforeRun` before the job even started (that port, that file);
 * `sinceRun`: held at a later read's first look, but not when the job started (its run looked),
 * so it came while the job ran.
 * `unchecked`: a file that could not be looked at; `size`: the file's size when it was found (0: it
 * exists and nothing is in it yet); `dir`: the path found is a directory. `error`: the wait stopped early, and why.
 * `matchAt` and `wouldMatchAt`: the log offset where that line starts, so the server can show it
 * only as the lines around it allow (src/core/hosts/host-exec-wait.ts shownWait).
 */
export interface WaitedFor {
  matched: WaitKind | null
  match?: string
  ms: number
  scanned?: number
  untested?: number
  long?: { lines: number; at: number; last?: number }
  unfinished?: true
  wouldMatch?: string
  matchAt?: number
  wouldMatchAt?: number
  tooSlow?: true
  /** The wait ended early: the file it waits for is on a path closed to the user there, and nothing else is waited for. */
  unreachable?: true
  already?: true
  beforeRun?: true
  sinceRun?: true
  unchecked?: string
  size?: number
  dir?: true
  error?: string
}
export interface WaitHit { kind: WaitKind; match: string; unfinished?: true; at?: number; size?: number; dir?: true }

/** `jobId`: the job the log is of, whose strict marker lines (host-exec-line.ts strictMark) are Walnut's. */
export interface WaitPlace { logFile: string; cwd: string; home: string; taskDir: string | null; from: number; jobId?: string }
/**
 * One look: a hit, or none; `settled` once every byte of the log so far was tested (always,
 * without `output`); `stop` when the wait cannot go on (the pattern was too slow, the matcher failed);
 * `wouldMatch`, the line still being written when it matches but does not count (no `partial`);
 * `idle`, it tested nothing and asked the matcher nothing (only skipped bytes), so the next look waits.
 */
export interface WaitLook {
  hit: WaitHit | null
  settled: boolean
  scanned?: number
  size?: number
  long?: { lines: number; at: number; last?: number }
  stop?: { tooSlow?: true; error?: string; unreachable?: true }
  unchecked?: string
  wouldMatch?: string
  wouldMatchAt?: number
  idle?: true
}

/**
 * A wait's check, and `close`, which withdraws what it still asks of the matcher (waitUntil calls
 * it at the end). `hard`: no look goes past it, its floors included.
 */
export type WaitCheck = ((ended?: boolean, deadline?: number, hard?: number) => Promise<WaitLook>) & { close?: () => void }

function logSizeOf(file: string): number {
  try { return fs.statSync(file).size } catch { return 0 }
}

/**
 * Why a file look found nothing, when that is not simply "not there": a file system that did not
 * answer, looks stuck elsewhere, a path this user may not reach, a symlink to nothing (2026-11-04
 * usability review: each read "before it appeared"). A look cut short by the answer's own bound
 * (under PROBE_FLOOR_MS) says nothing.
 */
function fileUnchecked(file: string, found: FileLook, ms: number): string | undefined {
  if (found.state === 'unanswered') return ms < PROBE_FLOOR_MS ? undefined : `could not check \`${file}\`: its file system did not answer within ${ms >= 1_000 ? `${ms / 1000} s` : `${ms} ms`} (a stuck network mount?)`
  if (found.state === 'busy') return `could not check \`${file}\`: other file checks on this host are stuck (a network mount that does not answer)`
  if (found.state === 'denied') return `could not check \`${file}\`: permission denied (a directory on its path is closed to the user there)`
  if (found.state === 'dangling') return `found \`${file}\` as a symlink to a path that does not exist: it counts once its target exists`
  return undefined
}

/**
 * How many characters of `text` before `at` are left once its colour codes are removed: a code the
 * offset falls inside counts as removed up to the offset (2026-11-05 code review: an offset between
 * `\x1b[3` and `2m` made the rest of that line unmatchable).
 */
function strippedBefore(text: string, at: number): number {
  if (!text.includes('\x1b')) return at
  let cut = 0
  for (const m of text.matchAll(ANSI)) {
    if (m.index! >= at) break
    cut += Math.min(m.index! + m[0].length, at) - m.index!
  }
  return at - cut
}

/**
 * The ask for the line a wait began inside of: a match there counts only when it ends past the
 * characters that were there before (`line.after`), so the match a wait before this one saw is not
 * seen again. A matcher that reads `after` steps through the matches itself, at the cost of one
 * test a match (2026-11-05 review: a lookahead over the rest of the line cost the old matches times
 * the new characters, and an ordinary pattern on a long line came back too slow), with the pattern's
 * trailing repeat kept, as where a match ends counts here (`port \d+` on `port 30` then `00`); an
 * older matcher gets the lookahead. Null when nothing new is on the line yet (no match there can count).
 */
function resumedAsk(pattern: LinePattern, line: SplitLine): { pattern: LinePattern; resume: { after: number; fallback: LinePattern } } | null {
  const after = strippedBefore(line.text, line.after ?? 0)
  const left = stripAnsi(line.text).length - after
  if (left <= 0) return null
  const tail = `(?=[\\s\\S]{0,${left - 1}}$)`
  return {
    pattern: { source: pattern.resume?.source ?? pattern.source, flags: pattern.flags, cut: pattern.resume?.cut ?? pattern.cut },
    resume: { after, fallback: { source: `(?:${pattern.source})${tail}`, flags: pattern.flags, cut: `(?:${pattern.cut})${tail}` } },
  }
}

/**
 * One wait's check in the daemon: the log from `from` on (only what it has not tested), cut into
 * lines here and tested in `matcher`; the file; the port. `ended`: the job has ended, so all of its
 * output is in the log and its last line counts. A check gives its lines at most SCAN_CHECK_MS, so
 * the port and the file are looked at again in between, and never past `deadline`: a batch the
 * matcher has not answered by then stays asked, and the next look takes up its answer. A `from`
 * past the log's end is its end, so `scanned` never says more than the log holds.
 */
export function createWaitCheck(waitFor: WaitFor, pattern: LinePattern | null, place: WaitPlace, matcher: Matcher | null): WaitCheck {
  const from = Math.min(Math.max(0, place.from), logSizeOf(place.logFile))
  // From inside a line (an offset a reader chose, or the `scanned` past a match on an unfinished
  // line): that whole line is tested, as a read shows it, and a match on it counts only when it
  // takes in output from the offset on, so the match a wait before this one saw is not seen again
  // (2026-11-05 review: from offset 10 of `Password: typed`, a wait for /typed/ skipped the rest of
  // that line and missed it). A line whose start is too far back: its rest is no line of its own.
  // The bytes from that start to the offset may hold lines ended by a \r (a progress bar before a
  // prompt): those ended before the offset and are not tested again (2026-11-05 review: an old
  // prompt after `Downloading 100%\r` matched again, and a line wholly before the offset matched).
  const at = pattern ? placeIn(place.logFile, from) : 'start'
  const lineFrom = at === 'inside' ? lineStartOf(place.logFile, from, true) : from
  const resumed = lineFrom < from
  const splitter = pattern ? createLineSplitter(lineFrom, { midLine: at === 'inside' && !resumed, afterCR: at === 'afterCR' }) : null
  const file = waitFor.file !== undefined ? resolveWaitFile(waitFor.file, place) : null
  const pending: SplitLine[] = []
  let pendingChars = 0
  let pos = lineFrom
  let size = 0
  /**
   * When the log was last written to, as of the last look at its size. A whole second may be a
   * file system that keeps whole seconds (or two): the write may have come up to 2 s later.
   */
  let writtenAt: number | undefined
  const noteWritten = (mtimeMs: number) => { writtenAt = mtimeMs % 1000 === 0 ? mtimeMs + 2_000 : mtimeMs }
  let scanned = from
  let unchecked: string | undefined
  let fileNote: string | undefined
  let portNote: string | undefined
  /**
   * Lines tested only on their head: counted as the matcher tests them, never as they are cut from
   * the log (2026-11-05 code review: a read that took six long lines and tested two said six).
   */
  let long: { lines: number; at: number; last: number } | null = null
  /** Since when every look found the file's path closed to the user (null: the last look did not). */
  let deniedSince: number | null = null
  let wouldMatch: { text: string; at: number } | undefined
  /** The batch the matcher was asked and has not answered (it is the head of `pending`). */
  let asking: (MatchAsk & { batch: SplitLine[]; chars: number }) | null = null
  let batchLines = BATCH_LINES
  /** What this look may still read of the log: SCAN_CHECK_BYTES a look, so the port and the file get their turn. */
  let lookBytes = SCAN_CHECK_BYTES

  /** Take the first `n` pending lines off, moving `scanned` past each whole one. */
  function drop(n: number): SplitLine[] {
    const gone = pending.splice(0, n)
    for (const l of gone) {
      pendingChars -= l.text.length
      // A line ended before the offset (one a resumed wait skips) never moves `scanned` back.
      if (l.end !== null && l.end > scanned) scanned = l.end
    }
    return gone
  }

  /**
   * Read what the log has gained into the splitter, holding at most SCAN_CHECK_BYTES there, and
   * take at most PENDING_MAX lines (and PENDING_CHARS of text) from it while less than a batch
   * waits: dense output (a line of a few bytes each) and long lines never pile up in memory.
   */
  function readLog(ended: boolean): void {
    // A batch is still waiting besides the one the matcher has (that one is the head of `pending`).
    const full = pending.length - (asking?.batch.length ?? 0) >= batchLines || pendingChars - (asking?.chars ?? 0) >= BATCH_CHARS
    const room = Math.min(PENDING_MAX - pending.length, PENDING_CHARS - pendingChars)
    if (!full && room > 0 && lookBytes > 0 && !splitter!.backlog && splitter!.held < SCAN_CHECK_BYTES) readMore(Math.min(SCAN_CHECK_BYTES - splitter!.held, lookBytes))
    // Nothing read (a backlog held, a batch waits): the log's size now all the same, so a job that
    // ended since the last read is never judged done on what the log held then (2026-11-04 review:
    // the last lines of a dense job were never tested, and a line still being written was taken for
    // its last line), and `untested` counts what the log holds now.
    else try { const st = fs.statSync(place.logFile); size = st.size; noteWritten(st.mtimeMs) } catch { /* gone: the last size stands */ }
    if (full || room <= 0) return
    // At the log's end, what the splitter holds was all written by `writtenAt`.
    const taken = splitter!.take(pos < size ? 'more' : ended ? 'done' : 'now', waitFor.partial === true, PENDING_MAX - pending.length, PENDING_CHARS - pendingChars, pos >= size ? writtenAt : undefined)
    for (const l of taken) {
      // A strict run's own line about the step that failed is Walnut's, never the job's.
      if (!l.skip && isStrictMarkLine(l.text, place.jobId)) { l.skip = true; l.text = '' }
      if (resumed && !l.skip && l.start < from) {
        if (l.end !== null && l.end <= from) { l.skip = true; l.text = '' } else l.after = charsBetween(place.logFile, l.start, from)
      }
      pending.push(l)
      pendingChars += l.text.length
    }
  }

  function readMore(most: number): void {
    let fd: number
    try { fd = fs.openSync(place.logFile, 'r') } catch { return }
    try {
      const st = fs.fstatSync(fd)
      size = st.size
      noteWritten(st.mtimeMs)
      let left = most
      while (pos < size && left > 0) {
        const piece = Buffer.alloc(Math.min(SCAN_PIECE_BYTES, size - pos, left))
        const n = fs.readSync(fd, piece, 0, piece.length, pos)
        if (n <= 0) break
        pos += n
        left -= n
        lookBytes -= n
        splitter!.push(n < piece.length ? piece.subarray(0, n) : piece)
      }
    } catch { /* gone: what was read stands */ } finally {
      try { fs.closeSync(fd) } catch { /* closed */ }
    }
  }

  /** The matcher's answer, or null when `until` comes first (the ask stays, for the next look). */
  async function answerBy(ask: MatchAsk, until: number): Promise<MatchResult | null> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), Math.max(0, until - Date.now())) })
    try {
      return await Promise.race([ask.result, late])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Test the pending lines in turn until a hit, a stop, nothing left, or `until`; the first batch
   * until `floor` at least. `worked`: it asked the matcher or waited for its answer.
   */
  async function testLines(ended: boolean, until: number, floor: number): Promise<{ hit?: string; unfinished?: true; at?: number; stop?: WaitLook['stop']; worked: boolean }> {
    let worked = false
    for (;;) {
      const by = worked ? until : Math.max(until, floor)
      if (!asking) {
        if (worked) readLog(ended)
        while (pending.length && pending[0]!.skip) drop(1)
        if (!pending.length || Date.now() >= by) return { worked }
        // The line the wait began inside of: tested alone, for a match past what was there before.
        const head = pending[0]!
        if (head.after !== undefined) {
          const resumedAt = resumedAsk(pattern!, head)
          if (!resumedAt) {
            // Nothing new on it yet: no match there can count.
            drop(1)
            if (!head.peek && head.end !== null) wouldMatch = undefined
            continue
          }
          asking = { ...matcher!.ask(resumedAt.pattern, [head], resumedAt.resume), batch: [head], chars: head.text.length }
        } else {
          const batch: SplitLine[] = []
          let chars = 0
          for (const l of pending) {
            if (l.skip || l.after !== undefined || batch.length >= batchLines || (batch.length && chars + l.text.length > BATCH_CHARS)) break
            batch.push(l)
            chars += l.text.length
          }
          asking = { ...matcher!.ask(pattern!, batch), batch, chars }
        }
        // The next lines are cut from the log while the matcher tests these.
        readLog(ended)
      }
      worked = true
      const r = await answerBy(asking, by)
      // Not answered in time: its lines stay untested, and the ask stays for the next look.
      if (r === null) return { worked }
      const { batch } = asking
      asking = null
      if ('slow' in r) return { stop: { tooSlow: true }, worked }
      if ('error' in r) return { stop: { error: r.error }, worked }
      batchLines = r.hit === null && r.tested < batch.length ? Math.max(BATCH_LINES_MIN, r.tested * 2) : Math.min(BATCH_LINES, batchLines * 2)
      const tested = drop(Math.max(1, r.tested))
      for (const l of tested) if (l.cut && !l.peek) long = long ? { lines: long.lines + 1, at: long.at, last: l.start } : { lines: 1, at: l.start, last: l.start }
      // A whole line came after the one still being written: what it would have matched is gone.
      if (tested.some((l) => !l.peek && l.end !== null)) wouldMatch = undefined
      const peeked = tested.find((l) => l.peek)
      if (peeked && r.hit === null) wouldMatch = undefined
      if (r.hit !== null) {
        const line = batch[r.hit]!
        // The line still being written, with no `partial`: it does not count, the answer only says it would.
        if (line.peek) { wouldMatch = { text: (r.text ?? line.text).slice(0, WOULD_SHOW_MAX), at: line.start }; continue }
        // A match on a line still being written: a later wait goes on after what it saw of it.
        if (line.end === null && line.upTo !== undefined) scanned = line.upTo
        return { hit: r.text ?? line.text, at: line.start, ...(line.end === null ? { unfinished: true as const } : {}), worked }
      }
    }
  }

  const check = async (ended = false, deadline = Number.POSITIVE_INFINITY, hard = Number.POSITIVE_INFINITY): Promise<WaitLook> => {
    let settled = true
    let idle = false
    const out = (): Pick<WaitLook, 'scanned' | 'size' | 'long' | 'unchecked' | 'wouldMatch' | 'wouldMatchAt'> => ({
      ...(splitter ? { scanned, size: Math.max(size, pos), ...(long ? { long } : {}) } : {}),
      ...(unchecked ? { unchecked } : {}),
      ...(wouldMatch !== undefined ? { wouldMatch: wouldMatch.text, wouldMatchAt: wouldMatch.at } : {}),
    })
    if (splitter) {
      if (!matcher) return { hit: null, settled: true, stop: { error: 'this host has no pattern matcher' }, ...out() }
      lookBytes = SCAN_CHECK_BYTES
      readLog(ended)
      const floor = Math.min(hard, Date.now() + (matcher.warm === false ? COLD_FLOOR_MS : OUTPUT_FLOOR_MS))
      const r = await testLines(ended, Math.min(deadline, Date.now() + SCAN_CHECK_MS), floor)
      if (r.hit !== undefined) return { hit: { kind: 'output', match: r.hit, at: r.at, ...(r.unfinished ? { unfinished: true as const } : {}) }, settled: true, ...out() }
      if (r.stop) return { hit: null, settled: false, stop: r.stop, ...out() }
      settled = pos >= size && pending.length === 0 && !splitter.backlog
      idle = !r.worked
    }
    // A look near the bound gets what is left of it (PROBE_FLOOR_MS at least, never past `hard`); the two look at once.
    const left = deadline - Date.now()
    const room = hard - Date.now()
    const fileMs = Math.min(Math.max(PROBE_FLOOR_MS, Math.min(FILE_LOOK_MS, left)), room)
    const portMs = Math.min(Math.max(PROBE_FLOOR_MS, Math.min(PORT_PROBE_MS, left)), room)
    // Too little time left for a look before the answer must go: none is taken, and none is said to have failed.
    const [found, port] = await Promise.all([
      file !== null && fileMs >= PROBE_MIN_MS ? lookFile(file, fileMs) : null,
      waitFor.port !== undefined && portMs >= PROBE_MIN_MS ? lookPort(waitFor.port, portMs) : null,
    ])
    if (file !== null && found) {
      if (found.state === 'yes') return { hit: { kind: 'file', match: file, ...(found.size !== null ? { size: found.size } : {}), ...(found.dir ? { dir: true as const } : {}) }, settled: true, ...out() }
      fileNote = fileUnchecked(file, found, fileMs)
      deniedSince = found.state === 'denied' ? deniedSince ?? Date.now() : null
    }
    if (port?.at) return { hit: { kind: 'port', match: port.at }, settled: true, ...out() }
    // Tables not read: "not listening" was never seen (a look cut short by the answer's bound says nothing).
    if (port) portNote = port.unread && portMs >= PROBE_FLOOR_MS ? `could not check port ${waitFor.port}: this host's socket tables could not be read within ${portMs >= 1_000 ? `${portMs / 1000} s` : `${portMs} ms`} (a host under heavy load, or a stuck network mount holding its file reads)` : undefined
    unchecked = [fileNote, portNote].filter(Boolean).join('; ') || undefined
    // A path closed to the user there for DENIED_GIVE_UP_MS, and nothing else to wait for: no look
    // will find it, so the wait ends now instead of at its bound (2026-11-05 review).
    if (deniedSince !== null && !splitter && waitFor.port === undefined && Date.now() - deniedSince >= DENIED_GIVE_UP_MS) {
      return { hit: null, settled: true, stop: { unreachable: true }, ...out() }
    }
    return { hit: null, settled, ...(idle && !settled ? { idle: true as const } : {}), ...out() }
  }
  return Object.assign(check, { close: () => { asking?.withdraw(); asking = null } })
}

/** How long a file wait goes on while its path is closed to the user there (a job may open it). */
export const DENIED_GIVE_UP_MS = 2_000

/** How long a match on the last line a job wrote waits for that job's end, in case it was exiting. */
export const END_GRACE_MS = 150

/** The job's end, or `ms` (whichever comes first). */
function endOrAfter(job: { ended: () => boolean; onEnd: (wake: () => void) => () => void }, ms: number): Promise<void> {
  if (ms <= 0 || job.ended()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let off = () => {}
    const timer = setTimeout(() => { off(); resolve() }, ms)
    off = job.onEnd(() => { clearTimeout(timer); resolve() })
  })
}

/**
 * Check now, then about every WAIT_CHECK_MS, until a condition holds, the job ended and its whole
 * output was tested (so output written just before the end counts), the check stops the wait, or
 * `waitMs` passed. Output a check left untested is taken up at once. `onEnd` registers a wake for
 * the job's end and returns its removal.
 */
export async function waitUntil(
  check: ((ended: boolean, deadline: number, hard: number) => Promise<WaitLook>) & { close?: () => void },
  job: { ended: () => boolean; onEnd: (wake: () => void) => () => void },
  waitMs: number,
  hardMs = Number.POSITIVE_INFINITY,
): Promise<WaitedFor> {
  const t0 = Date.now()
  // `hardMs`: the answer goes by then, every look's floor and the last look included (the server's
  // read of it gives up soon after: 2026-11-04 review, an answer at the bound became host_offline).
  const hard = t0 + Math.max(0, hardMs)
  let deadline = Math.min(t0 + waitMs, hard)
  let lastLook = false
  try {
    for (let first = true; ; first = false) {
      const ended = job.ended()
      const look = await check(ended, deadline, hard)
      const ms = Date.now() - t0
      const seen = {
        ...(look.scanned !== undefined ? { scanned: look.scanned } : {}),
        ...(look.long ? { long: look.long } : {}),
        ...(look.unchecked ? { unchecked: look.unchecked } : {}),
      }
      if (look.hit) {
        // The line that matched is the last the job wrote so far: a moment for the job's end, so a
        // job that printed it as it exited (a buffered python writes all of it at its exit) reads as
        // ended, not as "keeps running" (2026-11-05 review: it ended 1 ms after such an answer).
        if (look.hit.kind === 'output' && !job.ended() && look.scanned !== undefined && look.size !== undefined && look.scanned >= look.size) {
          await endOrAfter(job, Math.min(END_GRACE_MS, hard - Date.now()))
        }
        // What a look could not check (a symlink whose target was missing) is no news once it matched.
        const { unchecked: _unchecked, ...seenHit } = seen
        return {
          matched: look.hit.kind, match: look.hit.match, ms, ...seenHit, ...(look.hit.unfinished ? { unfinished: true as const } : {}),
          ...(look.hit.at !== undefined ? { matchAt: look.hit.at } : {}), ...(look.hit.size !== undefined ? { size: look.hit.size } : {}),
          ...(look.hit.dir ? { dir: true as const } : {}),
          ...(first && look.hit.kind !== 'output' ? { already: true as const } : {}),
        }
      }
      if (look.stop) return { matched: null, ms, ...seen, ...look.stop }
      const left = deadline - Date.now()
      // The job ended during this look, at the bound: one short look more, so what it wrote last is
      // tested (or counted as untested) before the answer says nothing matched.
      if (left <= 0 && !ended && !lastLook && job.ended() && hard - Date.now() >= PROBE_MIN_MS) { lastLook = true; deadline = Math.min(hard, Date.now() + LAST_LOOK_MS); continue }
      if ((ended && look.settled) || left <= 0) {
        const untested = look.scanned !== undefined && look.size !== undefined && !look.settled ? look.size - look.scanned : 0
        return {
          matched: null, ms, ...seen, ...(untested > 0 ? { untested } : {}),
          ...(look.wouldMatch !== undefined ? { wouldMatch: look.wouldMatch, ...(look.wouldMatchAt !== undefined ? { wouldMatchAt: look.wouldMatchAt } : {}) } : {}),
        }
      }
      // Output left to test: the next look at once, unless this one tested nothing (it only skipped bytes).
      if (!look.settled && !look.idle) { await new Promise<void>((resolve) => setImmediate(resolve)); continue }
      await new Promise<void>((resolve) => {
        let off = () => {}
        const timer = setTimeout(() => { off(); resolve() }, Math.min(WAIT_CHECK_MS, left))
        off = job.onEnd(() => { clearTimeout(timer); resolve() })
      })
    }
  } finally {
    // What the matcher was still asked for this wait is withdrawn: never sent, or its answer dropped.
    check.close?.()
  }
}

type WaitRefused = { ok: false; error: string; code: ExecError['code'] }

/** A wait_for as exec.read or exec.run got it, checked for this job's place: the condition and its pattern, or the refusal. */
function checkedWait(raw: unknown, taskDir: string | null): { ok: true; waitFor: WaitFor; pattern: LinePattern | null } | WaitRefused {
  const parsed = parseWaitFor(raw)
  if (!parsed.ok) return { ok: false, error: parsed.error, code: 'bad_request' }
  const refusal = waitRefusal(parsed.waitFor, taskDir)
  return refusal ? { ok: false, error: refusal, code: 'task_dir_unset' } : parsed
}

/**
 * What held before a job started: the ports that listened and the files (resolved paths) that
 * existed; `looked`: what its run looked at (a record from before this field has none).
 */
export interface HeldBefore { ports: number[]; files: string[]; looked?: { ports: number[]; files: string[] } }

/**
 * The wait_for that exec.run carries (the one the server waits on next), before the run starts: one
 * that could never hold here is refused, and what of it already holds is noted, by port and by
 * path, so the answer can say the run did not make it (a stale server on the port, an old build's
 * file), and only for that port or file.
 */
export async function waitBefore(raw: unknown, place: { cwd: string; home: string; taskDir: string | null },
  look: { port: typeof lookPort; file: typeof probeFile } = { port: lookPort, file: probeFile }): Promise<{ ok: true; before: HeldBefore } | WaitRefused> {
  const w = checkedWait(raw, place.taskDir)
  if (!w.ok) return w
  const file = w.waitFor.file !== undefined ? resolveWaitFile(w.waitFor.file, place) : null
  const [port, there] = await Promise.all([
    w.waitFor.port !== undefined ? look.port(w.waitFor.port) : null,
    file !== null ? look.file(file) : null,
  ])
  // Looked only where the look saw something either way: a table not read in time or a file it could
  // not stat says nothing of whether the run made it (2026-11-05 code review: a later read's first
  // look then said it came while the job ran).
  const looked = {
    ports: w.waitFor.port !== undefined && port && !port.unread ? [w.waitFor.port] : [],
    files: file !== null && (there === 'yes' || there === 'no' || there === 'dangling') ? [file] : [],
  }
  const before: HeldBefore = { ports: [], files: [], looked }
  if (port?.at && w.waitFor.port !== undefined) before.ports.push(w.waitFor.port)
  if (there === 'yes' && file !== null) before.files.push(file)
  return { ok: true, before }
}

/** exec.read's wait on one job: its log from `from`, its port and file, until one holds, it ended, or `waitMs` passed. */
export async function waitOnJob(
  raw: unknown,
  job: WaitPlace & { before: HeldBefore; ended: () => boolean; onEnd: (wake: () => void) => () => void },
  matcher: Matcher | null,
  waitMs: number,
  hardMs?: number,
): Promise<WaitedFor | WaitRefused> {
  const w = checkedWait(raw, job.taskDir)
  if (!w.ok) return { ...w, error: `${w.error}; the wait did not start` }
  const waited = await waitUntil(createWaitCheck(w.waitFor, w.pattern, job, matcher), job, waitMs, hardMs)
  // That port or that file held before the run started: the run did not make it.
  if ((waited.matched === 'port' && w.waitFor.port !== undefined && job.before.ports.includes(w.waitFor.port))
    || (waited.matched === 'file' && waited.match !== undefined && job.before.files.includes(waited.match))) waited.beforeRun = true
  // Held at this wait's first look, though the run looked and it was not there: it came while the job ran.
  else if (waited.already && ((waited.matched === 'port' && w.waitFor.port !== undefined && job.before.looked?.ports.includes(w.waitFor.port))
    || (waited.matched === 'file' && waited.match !== undefined && job.before.looked?.files.includes(waited.match)))) waited.sinceRun = true
  return waited
}
