/**
 * What a host_exec job runs (host-exec-core.ts): the line from a request, where it runs, the shell
 * that runs it, and its output as whole lines: a window into it (lineSpan: the reply's tail and a
 * read), and the lines a wait_for tests (createLineSplitter, host-exec-wait.ts).
 *
 * Which shell (host-exec-v2): the user's login shell starts first (`-l`), so
 * its profile sets PATH and the environment the way the user's sessions get
 * them, and then execs bash (sh on a host with none) to run the line. The
 * agents that send a line write bash, and zsh, the macOS login shell, reads it
 * differently without a word: `log` is a zsh builtin (`log show` says "too
 * many arguments"), a word starting with `=` is a command lookup (`echo ===`
 * fails "== not found"), an unmatched glob or a `?` in a URL stops the line
 * (2026-11-03, a session on a user's Mac). A bash login shell runs the line
 * itself.
 *
 * `argv` runs a program with no shell parsing at all: each argument is quoted
 * for the shell, which only finds the program on the user's PATH (`exec`).
 *
 * Bundled into host-exec-core (the binary daemon and the host-exec-core.cjs sidecar).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { MatchLine } from './host-exec-matcher.js'

const COMMAND_MAX_CHARS = 64 * 1024
const ARGV_MAX = 256
const ARG_MAX_CHARS = 8 * 1024

export type ExecError = { ok: false; code: 'bad_request' | 'cwd_missing' | 'spawn_failed' | 'unknown_job' | 'task_dir_unset' | 'job_exists' | 'may_prompt' | 'busy'; error: string }

/**
 * The whole lines of a window into a job's output: a window that starts inside a line
 * drops that partial line, and one that may end inside a line (the job still writes,
 * or more follows) stops at the last newline. The server hides credential-looking
 * lines one line at a time, so a token cut in two at a window's edge would pass as
 * two harmless halves. A window with no newline at all is kept whole.
 */
export function lineSpan(buf: Buffer, startsMid: boolean, mayEndMid: boolean): { start: number; end: number } {
  let start = 0
  if (startsMid) {
    const nl = buf.indexOf(0x0a)
    if (nl !== -1 && nl + 1 < buf.length) start = nl + 1
    else if (nl === -1) while (start < buf.length && start < 4 && (buf[start] & 0xc0) === 0x80) start++
  }
  let end = buf.length
  if (mayEndMid && end > start && buf[end - 1] !== 0x0a) {
    const nl = buf.lastIndexOf(0x0a)
    if (nl >= start) end = nl + 1
    else {
      // One long line with no newline yet: at least never end inside a character.
      let i = end - 1
      while (i > start && end - i < 4 && (buf[i] & 0xc0) === 0x80) i--
      const lead = buf[i]
      const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
      if (end - i < need) end = i
    }
  }
  return { start, end }
}

/** A reply's output: the tail kept of `bytes` written in all, its last `max` bytes, as whole lines; `running`: the job still writes. */
export function tailLines(tail: Buffer[], max: number, bytes: number, running: boolean): { output: string; truncated: boolean } {
  const buf = Buffer.concat(tail)
  const cut = buf.length > max ? buf.subarray(buf.length - max) : buf
  const { start, end } = lineSpan(cut, cut.length < bytes, running)
  return { output: cut.subarray(start, end).toString('utf8'), truncated: bytes > end - start }
}

/** How far back a read from inside a line looks for that line's start. */
const LINE_BACK_MAX = 64 * 1024

/**
 * The start of the line `at` falls in (at most LINE_BACK_MAX back): `at` itself when it starts one.
 * `pieces`: a \r ends a line too, as the splitter cuts them (a wait's unit; a read shows \n lines).
 */
function lineStartBefore(fd: number, at: number, pieces = false): number {
  if (at <= 0) return 0
  const back = Math.min(at, LINE_BACK_MAX)
  const buf = Buffer.alloc(back)
  const got = fs.readSync(fd, buf, 0, back, at - back)
  const view = buf.subarray(0, got)
  const nl = pieces ? Math.max(view.lastIndexOf(0x0a), view.lastIndexOf(0x0d)) : view.lastIndexOf(0x0a)
  return nl < 0 ? (back === at ? 0 : at) : at - back + nl + 1
}

/**
 * The start of the line `at` falls in, at most LINE_BACK_MAX back (`at` itself when it starts one or
 * none is found that near); `pieces`: of the piece a \r or a \n ends (2026-11-05 code review: a
 * wait from inside a prompt after 70 KB of `\r` progress found no \n that near and skipped the rest).
 */
export function lineStartOf(logFile: string, at: number, pieces = false): number {
  let fd: number | null = null
  try {
    fd = fs.openSync(logFile, 'r')
    return lineStartBefore(fd, at, pieces)
  } catch {
    return at
  } finally {
    if (fd !== null) try { fs.closeSync(fd) } catch { /* closed */ }
  }
}

/** How many characters the log's bytes from `from` to `to` decode to. */
export function charsBetween(logFile: string, from: number, to: number): number {
  if (to <= from) return 0
  let fd: number | null = null
  try {
    fd = fs.openSync(logFile, 'r')
    const buf = Buffer.alloc(to - from)
    const n = fs.readSync(fd, buf, 0, buf.length, from)
    return buf.subarray(0, n).toString('utf8').length
  } catch {
    return 0
  } finally {
    if (fd !== null) try { fs.closeSync(fd) } catch { /* closed */ }
  }
}

/**
 * The line a strict run's shell writes when a step fails (host-exec-strict.ts on the server shapes
 * it): Walnut's own, so a wait never matches it (2026-11-05 review: wait_for "exit 2" matched
 * `walnut strict: exit 2 [2 0]: cat`, a line the job never printed). The job's id rides in it, so
 * nothing else reads as one: a job printing that text, or another job's log (2026-11-05 review 12:
 * `printf 'walnut strict: exit 9 [9]: X'` in a run without strict came back as its failed step).
 */
export function strictMark(jobId: string, seal?: string): string {
  return `walnut strict ${jobId}${seal ? ` ${seal}` : ''}: exit`
}
/** The seal only the server knows for a run (host-exec-strict.ts): 12 hex digits after the id. */
export const STRICT_SEAL_RE = /^[0-9a-f]{12}$/
const STRICT_MARK_TAIL = /^(?: [0-9a-f]{12})?: exit \d+ \[[\d ]*\](?: line \d+)?: /
export function isStrictMarkLine(text: string, jobId: string | undefined): boolean {
  if (!jobId) return false
  const head = `walnut strict ${jobId}`
  return text.startsWith(head) && STRICT_MARK_TAIL.test(text.slice(head.length))
}

/**
 * A read of a job's log as whole lines: from `offset` (null: the last `max` bytes), at most `max`
 * bytes; `running`: the job still writes. The answer's `offset` is where its output starts: an
 * offset inside a line (a partial match's, or the `scanned` of a wait that ended on one) starts
 * at that line's start, so the server hides a credential in it as one line, never as two halves
 * of two answers (2026-11-04 review).
 */
export function readLogLines(logFile: string, offset: number | null, max: number, running: boolean): { output: string; offset: number; nextOffset: number } {
  let size = 0
  try { size = fs.statSync(logFile).size } catch { /* gone */ }
  let from = offset !== null ? Math.min(offset, size) : Math.max(0, size - max)
  // Nothing after the offset (a read at the log's end): nothing to show, the line before it was shown whole already.
  if (offset !== null && from > 0 && from < size) {
    let fd: number | null = null
    try { fd = fs.openSync(logFile, 'r'); from = lineStartBefore(fd, from) } catch { /* gone */ } finally { if (fd !== null) try { fs.closeSync(fd) } catch { /* closed */ } }
  }
  const len = Math.min(max, size - from)
  let output = ''
  let next = from + len
  if (len > 0) {
    const buf = Buffer.alloc(len)
    let fd: number | null = null
    try {
      fd = fs.openSync(logFile, 'r')
      fs.readSync(fd, buf, 0, len, from)
      // Whole lines only: a tail read starts at a line, and a window that stops before the
      // end, or while the job still writes, stops at one, so nextOffset is a line start
      // (an offset is the reader's own: it is never moved forward, which could skip output).
      const span = lineSpan(buf, offset === null && from > 0, from + len < size || running)
      output = buf.subarray(span.start, span.end).toString('utf8')
      next = from + span.end
      from += span.start
    } catch { /* gone */ } finally { if (fd !== null) try { fs.closeSync(fd) } catch { /* closed */ } }
  }
  return { output, offset: from, nextOffset: next }
}

/**
 * A new log for a run: `<id>.log`, or `<id>.<n>.log` when a run of that id left one before (the host
 * dropped that job an hour on, or restarted). The old log stays as it was, and this run's never
 * holds its lines: a wait tests a run's log from its start (2026-11-04 review: the rerun appended
 * to the old log, and its wait matched the previous run's line at once).
 */
export function openRunLog(dir: string, id: string): { fd: number; logFile: string } {
  for (let n = 1; ; n += 1) {
    const logFile = path.join(dir, n === 1 ? `${id}.log` : `${id}.${n}.log`)
    try {
      return { fd: fs.openSync(logFile, 'wx', 0o600), logFile }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 100) throw err
    }
  }
}

/** Quote one argument for a POSIX shell. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

export function bad(error: string, code: ExecError['code'] = 'bad_request'): ExecError {
  return { ok: false, code, error }
}

/** The shell line a request runs, or an error. */
export function commandLine(req: { command?: unknown; argv?: unknown }): string | ExecError {
  const hasCommand = typeof req.command === 'string' && req.command.trim() !== ''
  const hasArgv = Array.isArray(req.argv) && req.argv.length > 0
  if (hasCommand === hasArgv) return bad('give exactly one of command (a shell line) or argv (a program and its arguments)')
  if (hasCommand) {
    const c = req.command as string
    if (c.length > COMMAND_MAX_CHARS || c.includes('\0')) return bad(`command must be under ${COMMAND_MAX_CHARS} characters, with no NUL`)
    return c
  }
  const argv = req.argv as unknown[]
  if (argv.length > ARGV_MAX || !argv.every((a) => typeof a === 'string' && a.length <= ARG_MAX_CHARS && !a.includes('\0'))) {
    return bad(`argv must be at most ${ARGV_MAX} strings of at most ${ARG_MAX_CHARS} characters, with no NUL`)
  }
  if (!(argv[0] as string)) return bad('argv[0] (the program) is empty')
  return 'exec ' + (argv as string[]).map(shellQuote).join(' ')
}

/** The directory a request runs in on this host (`home` when it names none), real, or an error. */
export function resolveCwd(raw: unknown, home: string): string | ExecError {
  let cwd = typeof raw === 'string' && raw.trim() ? raw.trim() : home
  if (cwd === '~') cwd = home
  else if (cwd.startsWith('~/')) cwd = path.join(home, cwd.slice(2))
  if (!path.isAbsolute(cwd)) return bad(`cwd must be an absolute path or start with ~/ (got "${cwd}")`)
  try {
    const real = fs.realpathSync(cwd)
    if (!fs.statSync(real).isDirectory()) return bad(`${cwd} is not a directory on this host`, 'cwd_missing')
    return real
  } catch {
    return bad(`${cwd} does not exist on this host`, 'cwd_missing')
  }
}

function runsAsProgram(file: string): boolean {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile() } catch { return false }
}

/**
 * Where bash is looked for, in order (the same on every run): a Homebrew or MacPorts bash first,
 * since a Mac's /bin/bash is 3.2 (no `declare -A`, no `${x,,}`, no `mapfile`), then the system one.
 * host-exec-legacy.ts LEGACY_RUNNER tries the same list.
 */
export const BASH_CANDIDATES = ['/opt/homebrew/bin/bash', '/usr/local/bin/bash', '/opt/local/bin/bash', '/bin/bash', '/usr/bin/bash']

/** This host's bash: the first of BASH_CANDIDATES there, else the first on PATH; null for none. */
export function findBash(envPath: string | undefined, isProgram: (file: string) => boolean = runsAsProgram): string | null {
  const onPath = (envPath ?? '').split(':').filter((d) => path.isAbsolute(d)).map((d) => path.join(d, 'bash'))
  return [...BASH_CANDIDATES, ...onPath].find(isProgram) ?? null
}

/** Login shells whose quoting is not POSIX (fish reads `\\` inside single quotes, csh refuses a newline in them). */
const NON_POSIX_LOGIN = new Set(['fish', 'csh', 'tcsh'])
/** Where the line waits for bash under such a login shell (unset before the line runs). */
export const LINE_ENV = 'WALNUT_HOST_EXEC_LINE'

/**
 * How a line runs: the login shell with `-l` sets up the environment, then execs
 * bash (sh when there is none) on the line, which reaches it as one quoted word.
 * A bash login shell runs the line itself. Under fish or csh the line never passes
 * through their quoting: it rides the environment, and bash reads it from there.
 */
export function shellPlan(loginShell: string, bash: string | null, line: string): { args: string[]; shell: string; loginShell: string; env?: Record<string, string> } {
  const login = loginShell || '/bin/sh'
  const inner = bash || '/bin/sh'
  const loginName = path.basename(login)
  if (loginName === 'bash' || login === inner) return { args: ['-l', '-c', line], shell: loginName, loginShell: loginName }
  if (NON_POSIX_LOGIN.has(loginName)) {
    const hop = `exec ${shellQuote(inner)} -c '__walnut_line=$${LINE_ENV}; unset ${LINE_ENV}; eval "$__walnut_line"'`
    // csh and tcsh take -l only as their one flag.
    const args = loginName === 'fish' ? ['-l', '-c', hop] : ['-c', hop]
    return { args, shell: path.basename(inner), loginShell: loginName, env: { [LINE_ENV]: line } }
  }
  return { args: ['-l', '-c', `exec ${shellQuote(inner)} -c ${shellQuote(line)}`], shell: path.basename(inner), loginShell: loginName }
}

/** How often a wait checks (host-exec-wait.ts); a line still being written that long unchanged is quiet. */
export const WAIT_CHECK_MS = 200
/** Each line is tested on its first this many characters. */
export const LINE_TEST_MAX = 64 * 1024
const NL = 0x0a
const CR = 0x0d

/**
 * What follows the bytes pushed so far: more that is already written ('more'), nothing yet
 * ('now': the job runs on), or nothing ever ('done': the job ended and all of it was pushed).
 */
export type ScanEdge = 'more' | 'now' | 'done'

/**
 * A line to test: its text (at most LINE_TEST_MAX), whether it was cut, where it starts, and
 * where the next begins (null: unfinished; `upTo` is then where its bytes here end). `peek`: the
 * unfinished line without `partial`, tested only to tell whether it would match.
 */
export interface SplitLine extends MatchLine {
  start: number; end: number | null; upTo?: number; skip?: true; peek?: true
  /** The line a wait began inside of: its first `after` characters were there before (a match there counts only when it takes in one past them). */
  after?: number
}

export interface LineSplitter {
  /** The next bytes of the output, in order. */
  push(bytes: Buffer): void
  /**
   * The lines ready to test, in order, at most `max` of them and about `maxChars` of text: each
   * whole line, the start of a long one (once; the rest of it then comes as a `skip` entry where it
   * ends), and at the edge the unfinished one: at 'done' always, at 'now' once it has not grown for
   * `quietMs` (with `partial` as a line, else as a `peek`). `writtenAt`: when the bytes pushed so
   * far were last written to (the log's mtime), so a line that sat there before this splitter saw
   * it is quiet since then, not since its first take (2026-11-04 review: each read builds a new
   * splitter, and a `Password: ` prompt seconds old was not tested by a short wait).
   */
  take(edge: ScanEdge, partial: boolean, max?: number, maxChars?: number, writtenAt?: number): SplitLine[]
  /** Lines longer than LINE_TEST_MAX so far: how many, the offset of the first, and of the last. */
  readonly long: { lines: number; at: number; last: number } | null
  /** The bytes pushed and not taken yet. */
  readonly held: number
  /** The last take stopped at its `max`, with whole lines still held. */
  readonly backlog: boolean
}

/**
 * A line's first LINE_TEST_MAX characters, decoding only the bytes they take (a slice of a larger
 * decoded string would keep all of it alive while the line waits for the matcher).
 */
export function lineHead(line: Buffer): { text: string; cut: boolean } {
  // At most 4 bytes a character, and a character of 4 bytes is 2 in a JavaScript string.
  if (line.length <= LINE_TEST_MAX) return { text: line.toString('utf8'), cut: false }
  let units = 0
  let at = 0
  for (; at < line.length; at += 1) {
    const b = line[at]!
    if ((b & 0xc0) === 0x80) continue // inside a character
    const w = b >= 0xf0 ? 2 : 1
    if (units + w > LINE_TEST_MAX) break
    units += w
  }
  const text = line.subarray(0, at).toString('utf8')
  // Bytes that are no UTF-8 decode as one replacement character each: rare, and cut here.
  if (text.length > LINE_TEST_MAX) return { text: text.slice(0, LINE_TEST_MAX), cut: true }
  return { text, cut: at < line.length }
}

/**
 * Output cut into lines on bytes: \n and \r never occur inside a UTF-8 character, so a line
 * decodes whole. A \r ends its line at once (a progress line that stops on one is whole); a \n
 * right after it, in this push or the next, ends nothing more (a CRLF), and is a `skip` entry.
 * `midLine`: the bytes start inside a line, whose part here is no line of its own; `afterCR`: they
 * start right after a \r.
 */
export function createLineSplitter(start = 0, opts: { quietMs?: number; now?: () => number; midLine?: boolean; afterCR?: boolean } = {}): LineSplitter {
  const quietMs = opts.quietMs ?? WAIT_CHECK_MS
  const clock = opts.now ?? Date.now
  let buf: Buffer = Buffer.alloc(0)
  let base = start // offset of buf[0]
  let lineAt = start // offset where the line buf[0] is in starts
  let skipping = opts.midLine === true
  let crEnded = opts.afterCR === true // the last line ended at a \r that was the last byte so far
  let partTested = -1 // the unfinished line's length when it was last tested as a line
  let partPeeked = -1 // ... and when it was last peeked at (a peek never stands for a test)
  let partSeen = -1
  let partSeenAt = 0
  let long: { lines: number; at: number; last: number } | null = null
  let backlog = false
  const noteLong = (at: number) => { long = long ? { lines: long.lines + 1, at: long.at, last: at } : { lines: 1, at, last: at } }
  return {
    push(bytes) {
      if (bytes.length) buf = buf.length ? Buffer.concat([buf, bytes]) : bytes
    },
    take(edge, partial, max = Number.POSITIVE_INFINITY, maxChars = Number.POSITIVE_INFINITY, writtenAt) {
      const out: SplitLine[] = []
      let i = 0
      let nl = -1
      let cr = -1
      let chars = 0
      backlog = false
      // The \n of a CRLF whose \r ended the last line.
      if (crEnded && buf.length) {
        crEnded = false
        if (buf[0] === NL) {
          out.push({ text: '', cut: false, start: lineAt, end: base + 1, skip: true })
          i = 1
          lineAt = base + 1
        }
      }
      for (;;) {
        if (out.length >= max || chars >= maxChars) { backlog = true; break }
        if (nl !== Infinity && nl < i) { const at = buf.indexOf(NL, i); nl = at === -1 ? Infinity : at }
        if (cr !== Infinity && cr < i) { const at = buf.indexOf(CR, i); cr = at === -1 ? Infinity : at }
        const end = Math.min(nl, cr)
        if (end === Infinity) break
        const next = end + (buf[end] === CR && buf[end + 1] === NL ? 2 : 1)
        if (buf[end] === CR && next === end + 1 && next === buf.length) crEnded = true
        if (skipping) {
          out.push({ text: '', cut: false, start: lineAt, end: base + next, skip: true })
        } else {
          // A line within the limit decodes straight from its bytes (no view of them made first).
          if (end - i <= LINE_TEST_MAX) {
            const text = buf.toString('utf8', i, end)
            out.push({ text, cut: false, start: lineAt, end: base + next })
            chars += text.length
          } else {
            const h = lineHead(buf.subarray(i, end))
            if (h.cut) noteLong(lineAt)
            out.push({ text: h.text, cut: h.cut, start: lineAt, end: base + next })
            chars += h.text.length
          }
        }
        skipping = false
        i = next
        lineAt = base + i
      }
      if (i > 0) {
        buf = buf.subarray(i)
        base += i
        partTested = -1
        partPeeked = -1
        partSeen = -1
      }
      if (backlog) return out
      const part = wholeChars(buf)
      if (!part.length) return out
      if (!skipping) {
        const h = lineHead(part)
        if (h.cut) {
          // Its first characters are all here: tested once, the rest of the line skipped.
          noteLong(lineAt)
          out.push({ text: h.text, cut: true, start: lineAt, end: null, upTo: base + part.length })
          skipping = true
        } else {
          const t = clock()
          if (part.length !== partSeen) { partSeen = part.length; partSeenAt = writtenAt !== undefined ? Math.min(t, writtenAt) : t }
          const quiet = edge === 'now' && t - partSeenAt >= quietMs
          const line = { text: h.text, cut: false, start: lineAt, end: null, upTo: base + part.length }
          if (quiet && !partial) {
            // Without partial: looked at only to say it would match; at the job's end it is tested as a line.
            if (part.length !== partPeeked) { partPeeked = part.length; out.push({ ...line, peek: true }) }
          } else if (part.length !== partTested && (edge === 'done' || quiet)) {
            partTested = part.length
            out.push(line)
          }
        }
      }
      // A skipped line's bytes are never needed again.
      if (skipping) {
        buf = buf.subarray(part.length)
        base += part.length
      }
      return out
    },
    get long() { return long },
    get held() { return buf.length },
    get backlog() { return backlog },
  }
}

/** The bytes up to the last whole UTF-8 character (an unfinished line may stop inside one). */
function wholeChars(b: Buffer): Buffer {
  let i = b.length - 1
  while (i > 0 && b.length - i < 4 && (b[i]! & 0xc0) === 0x80) i--
  const lead = b[i] ?? 0
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  return b.length - i < need ? b.subarray(0, i) : b
}

/**
 * Where `at` falls in the log: inside a line (the byte before it ends no line, or `at` splits a
 * CRLF), right after a \r with nothing after it yet (a \n may still come and end nothing), or at
 * a line's start.
 */
export function placeIn(logFile: string, at: number): 'inside' | 'afterCR' | 'start' {
  if (at <= 0) return 'start'
  let fd: number | null = null
  try {
    fd = fs.openSync(logFile, 'r')
    const b = Buffer.alloc(2)
    const n = fs.readSync(fd, b, 0, 2, at - 1)
    if (n < 1) return 'start'
    if (b[0] !== NL && b[0] !== CR) return 'inside'
    if (b[0] === CR) return n === 2 ? (b[1] === NL ? 'inside' : 'start') : 'afterCR'
    return 'start'
  } catch {
    return 'start'
  } finally {
    if (fd !== null) try { fs.closeSync(fd) } catch { /* closed */ }
  }
}
