/**
 * host-exec-shown.ts: how much of a command's output an agent reads (the answer policy, answer.ts).
 *
 * 2026-11-21, seven days of calls: the server sends up to the last 256 KB of a run's output, so
 * host_exec answered up to 141,000 characters and 32 of its answers were cut by the agent's own
 * harness; 27% of host_exec_read calls repeated the previous call's exact arguments within 30
 * minutes, polling a job that had printed nothing new. So an agent reads:
 *   - the first lines and the tail of the output (the end of a build or a test log is what
 *     matters), told how much was left out, where the whole log is, and the exact read for it;
 *   - from an offset it chose: what follows it, up to the same size, and the offset that goes on;
 *   - a read that finds nothing new: one sentence, and the wait that replaces the polling.
 * Server code and the web UI read the run as the server sent it; `_full: true` does too.
 */
import { runOutcome, secs } from './host-exec-answers.js'
import { jsonLength, onCharStart, tailText } from './doc-page.js'
import { cutMark, textCost, type AnswerSurface, type ShapeContext } from './answer.js'

/** The most output an answer shows, in characters of JSON (a newline is two), under the op's own cap. */
export const SHOWN_OUTPUT_CHARS = 6_000
/** The whole answer: the output shown plus its outcome, next step and fields. A smaller cap (the CLI's) shows that much less output. */
export const RUN_ANSWER_MAX_CHARS = 10_000
/** The least output an answer shows. */
const SHOWN_MIN = 1_000
/** The first lines kept before the tail, when they are cheap. */
const HEAD_LINES = 6
const HEAD_CHARS = 600
/** Room for the line that says what was left out. */
const MARK_ROOM = 300
/** What a quiet read still shows of the output: its last lines (a caller that lost them, after a compaction, still has them). */
const QUIET_TAIL_LINES = 20
const QUIET_TAIL_CHARS = 2_000

/** Bytes of `s` in UTF-8, as the log on the host counts them. */
export function utf8Bytes(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++ }
    else n += 3
  }
  return n
}

/** The first few lines, when they are short; '' when the first line alone is long. */
function headOf(out: string): string {
  let end = 0
  for (let i = 0; i < HEAD_LINES; i++) {
    const nl = out.indexOf('\n', end)
    if (nl < 0 || nl + 1 > HEAD_CHARS) break
    end = nl + 1
  }
  return out.slice(0, end)
}

/** The end of `out` (after `from`) that fits `budget`, starting at a line's start when one is near. */
function tailOf(out: string, from: number, budget: number, surface: AnswerSurface): string {
  let used = 0
  let start = out.length
  while (start > from && used + textCost(out.charCodeAt(start - 1), surface) <= budget) used += textCost(out.charCodeAt(--start), surface)
  const nl = out.indexOf('\n', start)
  // A line's start, unless that throws away more than a quarter of what fits.
  if (start > from && nl >= 0 && nl + 1 < out.length && nl - start < budget / 4) start = nl + 1
  return out.slice(onCharStart(out, start))
}

/** The start of `out` that fits `budget`, ending at a line's end when one is near. */
function windowOf(out: string, budget: number, surface: AnswerSurface): string {
  let used = 0
  let end = 0
  while (end < out.length && used + textCost(out.charCodeAt(end), surface) <= budget) used += textCost(out.charCodeAt(end++), surface)
  const nl = out.lastIndexOf('\n', end - 1)
  if (end < out.length && nl >= 0 && end - nl < budget / 4) end = nl + 1
  return out.slice(0, onCharStart(out, end))
}

/**
 * Bytes of `s` as the log on the host holds them: utf8Bytes, but a U+FFFD the host's decoding put
 * for a byte that was not UTF-8 (a Latin-1 byte, a binary blob) counts the one byte it stands for.
 */
export function logBytes(s: string): number {
  let n = utf8Bytes(s)
  for (let i = s.indexOf('\ufffd'); i >= 0; i = s.indexOf('\ufffd', i + 1)) n -= 2
  return n
}

/** The index in `s` where its first `bytes` log bytes end (logBytes), on a character's start. */
function charAtLogBytes(s: string, bytes: number): number {
  let n = 0
  let i = 0
  while (i < s.length && n < bytes) {
    const c = s.charCodeAt(i)
    n += c === 0xfffd ? 1 : c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff && i + 1 < s.length ? 4 : 3
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < s.length ? 2 : 1
  }
  return i
}

/**
 * What a read from the caller's own offset shows, and where it goes on. The host starts a read at
 * the start of the line the offset falls in (host-exec-line.ts readLogLines), so a window that ended
 * inside a line, read on from its own end, comes back from that line's start: the part before the
 * offset asked was shown already and is left out here, so each read goes on where the last one
 * stopped, inside a long line too. The offset that goes on is at least one byte on (when the host has
 * more) and never past the host's own end of its window: hidden credential lines and bytes that were
 * not UTF-8 make the text's length differ from the log's. 2026-11-24: a 256 KB xcodebuild command
 * line gave the same offset 7,700 times to an iOS fleet script, two reads a second for an hour.
 */
export function fromAskedOffset(out: string, asked: number, hostFrom: number, hostNext: unknown, budget: number, surface: AnswerSurface): { start: number; body: string; shown: string; nextOffset: number } {
  const back = asked > hostFrom ? charAtLogBytes(out, asked - hostFrom) : 0
  const body = out.slice(back)
  const start = back ? asked : hostFrom
  const shown = windowOf(body, budget, surface)
  const end = typeof hostNext === 'number' ? hostNext : Infinity
  let nextOffset = Math.min(start + logBytes(shown), end)
  if (nextOffset <= asked && end > asked && end !== Infinity) nextOffset = end
  return { start, body, shown, nextOffset }
}

const readCall = (b: Record<string, unknown>, offset: unknown, more: Record<string, unknown> = {}): string =>
  `host_exec_read ${JSON.stringify({ host: b.host, job_id: b.jobId, ...(typeof offset === 'number' ? { offset } : {}), ...more })}`

/**
 * A read of a job still running that found nothing new: a repeat of this session's last tail read
 * with the same output (the server marks it `noNewOutput`, per calling session), or a read from an
 * offset at the log's end. A repeat still shows the output's last lines and how to see all of it
 * again, since a session that compacted lost what it read. A job being stopped, or a wait_for read,
 * says its own state instead.
 */
function nothingNew(b: Record<string, unknown>, args: Record<string, unknown>): Record<string, unknown> | null {
  if (b.running !== true || b.waitedFor || b.shellExited === true || b.stopAsked === true || b.timedOut === true || b.blocked || b.deadlineInMs === 0) return null
  const repeat = b.noNewOutput && typeof b.noNewOutput === 'object' ? b.noNewOutput as { sinceMs?: unknown } : null
  const atEnd = typeof args.offset === 'number' && b.output === ''
  if (!repeat && !atEnd) return null
  const end = typeof b.outputBytes === 'number' ? b.outputBytes : typeof b.nextOffset === 'number' ? b.nextOffset : 0
  const since = repeat && typeof repeat.sinceMs === 'number' ? ` since your last read ${secs(repeat.sinceMs)} ago (the log is at ${end} bytes)` : ` after offset ${end}`
  const out = typeof b.output === 'string' ? b.output : ''
  const again = repeat
    ? ` Its output is unchanged since that read; its last lines are here, and ${readCall(b, typeof b.offset === 'number' ? b.offset : 0)} or this read with "_full": true shows all of it again.`
    : ''
  return {
    host: b.host, jobId: b.jobId, running: true, ms: b.ms, outputBytes: b.outputBytes, nextOffset: end,
    ...(typeof b.heldMs === 'number' ? { heldMs: b.heldMs } : {}),
    ...(repeat && out ? { output: tailText(out, QUIET_TAIL_CHARS, QUIET_TAIL_LINES) } : {}),
    ...(typeof b.logFile === 'string' ? { logFile: b.logFile } : {}),
    outcome: `Job ${String(b.jobId)} on ${String(b.host)} is still running (${secs(b.ms)} so far) and printed nothing new${since}.${again}`,
    next: `Do not poll it: ${readCall(b, end, { wait_ms: 60_000 })} answers when it ends (a minute at most); with wait_for {"output":"<the line it prints when done>"} and wait_ms up to 600000 the answer comes the moment that line appears.`,
  }
}

/**
 * What an agent reads of a host_exec, host_exec_pinned or host_exec_read answer (`result` is
 * the answer runOutcome made): at most SHOWN_OUTPUT_CHARS of output (less under a smaller `max`,
 * counted as `surface` prints it), and the read for the rest.
 */
export function shownRun({ result, args, max = RUN_ANSWER_MAX_CHARS, surface = 'mcp' }: Pick<ShapeContext, 'result' | 'args'> & Partial<Pick<ShapeContext, 'max' | 'surface'>>): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const b = result as Record<string, unknown>
  const quiet = nothingNew(b, args)
  if (quiet) return quiet
  const out = typeof b.output === 'string' ? b.output : ''
  const shownMax = Math.max(SHOWN_MIN, Math.min(SHOWN_OUTPUT_CHARS, SHOWN_OUTPUT_CHARS - (RUN_ANSWER_MAX_CHARS - max)))
  if (jsonLength(out, surface) <= shownMax) return result
  // Where this output starts in the log (a tail starts past the log's start).
  const at = typeof b.offset === 'number' ? b.offset : Math.max(0, (typeof b.outputBytes === 'number' ? b.outputBytes : 0) - utf8Bytes(out))
  // Hidden credential lines and strict's own line change the text, not the log: offsets are then near, not exact.
  const about = b.redactedLines || b.failedStep ? 'about ' : ''
  const log = typeof b.logFile === 'string' && b.logFile ? `${b.logFile} on ${String(b.host)}` : `its log on ${String(b.host)}`
  if (typeof args.offset === 'number') {
    // A read from an offset the caller chose: what follows it, and the offset that goes on.
    const { start, body, shown, nextOffset } = fromAskedOffset(out, args.offset, at, b.nextOffset, shownMax - 60, surface)
    const { outcome: _o, next: _n, ...raw } = b
    const more = nextOffset < (typeof b.nextOffset === 'number' ? b.nextOffset : at + logBytes(out)) || b.more === true
    return {
      ...(runOutcome({ ...raw, output: `${shown}… ${cutMark(body.length - shown.length)}`, offset: start, nextOffset, more }, args) as Record<string, unknown>),
      outputShown: `${shown.length} of the ${body.length} characters from offset ${start}; ${about}offset ${nextOffset} of ${log} goes on: ${readCall(b, nextOffset)}.`,
    }
  }
  // The head of the log, when this output starts there; then the tail.
  const head = at === 0 && b.truncated !== true ? headOf(out) : ''
  const tail = tailOf(out, head.length, shownMax - jsonLength(head, surface) - MARK_ROOM, surface)
  const from = at + utf8Bytes(head)
  const to = at + utf8Bytes(out.slice(0, out.length - tail.length))
  const left = out.length - head.length - tail.length
  // The cut mark where the text was cut (answer.ts): a write can tell this output from a whole one.
  const mark = `… ${cutMark(left)} (${about}bytes ${from} to ${to} of the log: ${readCall(b, from)} reads on from there)\n`
  const lines = head ? head.split('\n').length - 1 : 0
  return {
    ...b,
    output: `${head}${mark}${tail}`,
    outputShown: `${lines ? `The first ${lines} lines and the` : 'The'} last ${tail.length} characters of ${out.length}; ${left} characters in between were left out. `
      + `The whole log is ${log}: ${readCall(b, from)} reads what was left out${b.truncated === true ? `, ${readCall(b, 0)} the log from its start` : ''}.`,
  }
}
