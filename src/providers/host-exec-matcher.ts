/**
 * The killable matcher behind wait_for (host-exec-wait.ts). A job's output lines are tested
 * against the caller's pattern in a child process of the daemon, never on the daemon's loop: no
 * runtime here can stop a RegExp once it runs (under bun neither a vm timeout nor
 * Worker.terminate interrupts one), and no static check tells every slow pattern (2026-11-04
 * review: patterns a cost check passed held the loop 3 to 6 s a line). A line that holds the
 * matcher past LINE_LIMIT_MS of its own CPU time is stopped by killing the process, and only the
 * wait it belongs to ends, saying so.
 *
 * One matcher serves every wait of the daemon, one batch at a time, in the order the waits asked
 * (oldest first), and a batch ends after about BATCH_MS, so no wait starves another; it runs at
 * a lower priority, so it takes at most one core and yields to the rest of the machine. It
 * starts on the first output wait and exits when idle. The daemon runs itself for it (the
 * standalone binary with --wait-matcher, the JS twin with -e and its host-exec-core.cjs); a
 * host-exec core given no way to start one answers every output wait with that error.
 *
 * "Too slow" is decided only from CPU time the matcher used, never from the wall clock: its own
 * watch thread reports the process's CPU on stderr while a line runs (a `ps` on a loaded Mac can
 * take longer than its timeout), and the OS's count (/proc, ps) stands in where it cannot. A
 * matcher nothing can read the CPU of, or that burns none (a starved machine), is stopped only
 * when it has not answered for SILENT_MAX_MS, and the wait says it could not check, not that the
 * pattern is slow (2026-11-04 review: a SIGSTOPped matcher was called too slow after 2 s).
 * A wait that ends before its batch was answered withdraws it (`ask`): a batch not sent yet is
 * never sent, and the late answer of one in flight is dropped.
 */
import { execFile, type ChildProcess, type SpawnOptions } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { Worker } from 'node:worker_threads'
import type { LinePattern } from './host-exec-pattern.js'

/** One line may hold the matcher this long, of its own CPU time, before it is stopped. */
export const LINE_LIMIT_MS = 250
/** A batch ends after this long, so every wait's lines take turns. */
const BATCH_MS = 20
/** A matcher that does not answer this long, and shows no line over the limit, is stopped (a hung process, a starved machine). */
const SILENT_MAX_MS = 10_000
/** The watch thread looks this often: its daemon still there, and the CPU a running line burns. */
const WATCH_MS = 100
/** It reports the CPU when the process used at least this much since its last look (an idle matcher says nothing). */
const REPORT_MIN_MS = 5
/** How many compiled patterns a matcher keeps. */
const PATTERNS_KEPT = 64
const START_MAX_MS = 15_000
const IDLE_MS = 30_000
/** At most this much of a matched line comes back. */
const SHOW_MAX = 4096

/** How to start a matcher: the daemon's own executable and the arguments that make it one. */
export interface MatcherStart { command: string; args: string[] }
export interface MatchLine { text: string; cut: boolean }
/** `tested` lines were tested (`hit` the index of the one that matched); `slow`: a line ran past the limit. */
export type MatchResult = { tested: number; hit: number | null; text?: string } | { slow: true } | { error: string }
/** What a withdrawn ask answers (its wait ended before the matcher did). */
export const WITHDRAWN = 'the wait ended before the matcher answered'
type Spawn = (command: string, args: string[], opts: SpawnOptions) => ChildProcess

// CSI (colours, cursor moves), OSC (titles, links) and the two-character escapes.
export const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g

/** A terminal line without its colour and cursor codes, as a person reads it. */
export function stripAnsi(s: string): string {
  return s.includes('\x1b') ? s.replace(ANSI, '') : s
}

/** This process's CPU time, ms. */
function ownCpu(): number {
  const u = process.cpuUsage()
  return (u.user + u.system) / 1000
}

/**
 * Runs on a thread of the matcher while its own thread tests lines: ends the process once the
 * daemon that started it is gone (its parent changed), since a line that runs away holds the
 * matcher's own thread, which then never sees its input close; and writes the process's CPU time
 * to stderr (`{"cpu":ms}`, a line far under the size a pipe writes whole) while it grows, so the
 * daemon reads it without asking the OS. A function, so the signal stays in plain sight (the
 * signal-call ratchet counts it); it runs from its source text, so it uses nothing but `process`
 * (fs comes from process.getBuiltinModule, absent on an old node: then no report, and the daemon
 * asks the OS).
 */
function watchThread(parent: number, everyMs: number, minMs: number): void {
  const get = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule
  const fs = typeof get === 'function' ? get('fs') as { writeSync: (fd: number, s: string) => void } : null
  let told = 0
  setInterval(() => {
    if (process.ppid !== parent) process.kill(process.pid, 'SIGKILL')
    if (!fs) return
    const u = process.cpuUsage()
    const cpu = (u.user + u.system) / 1000
    if (cpu - told < minMs) return
    told = cpu
    try { fs.writeSync(2, `{"cpu":${cpu}}\n`) } catch { /* the daemon is gone: the next look ends this */ }
  }, everyMs)
}

/**
 * Whether `g` (a pattern with the g flag) matches `line` somewhere that ends past its first `after`
 * characters: the match the regex finds first from each start, the starts taken in turn, so the cost
 * is one search a match, as a test of the line is. A start with several possible ends counts the one
 * the regex prefers there (the greedy one), as the help says.
 */
export function endsPast(g: RegExp, line: string, after: number): boolean {
  for (let at = 0, first = true; at <= line.length; first = false) {
    g.lastIndex = at
    const m = g.exec(line)
    if (!m) return false
    if (m.index + m[0].length > after) return true
    const c = line.charCodeAt(m.index)
    at = m.index + (g.unicode && c >= 0xd800 && c <= 0xdbff ? 2 : 1)
    // After the line's first match, only starts in the RESUME_BACK characters before `after`: a
    // start costs one match attempt, which a repeat in the middle (`\w.*done`) makes as long as
    // the line (2026-11-05 code review: a 40 000 character line came back too slow).
    if (first) at = Math.max(at, after - RESUME_BACK)
  }
  return false
}

/** How far before a resumed line's offset its matches may start, past the line's first match. */
export const RESUME_BACK = 1_024

/**
 * The matcher's own side: tests in on stdin, each carrying its pattern, answers out on stdout,
 * one JSON object per line, until stdin ends (the daemon closed it or died).
 */
export function runWaitMatcher(): Promise<void> {
  try { os.setPriority(10) } catch { /* not allowed here: as it is */ }
  // `ready` waits for the watch thread to be up, so the CPU its start takes is counted before the
  // first batch, never against it (the daemon judges a batch by the CPU since the last message).
  const watching = new Promise<void>((resolve) => {
    const late = setTimeout(resolve, 2_000)
    late.unref?.()
    const up = () => { clearTimeout(late); resolve() }
    try {
      const watch = new Worker(`(${watchThread.toString()})(${process.ppid}, ${WATCH_MS}, ${REPORT_MIN_MS})`, { eval: true })
      watch.unref()
      watch.once('online', up)
      watch.once('error', up) // no watch: the daemon's stdin still ends it
      watch.once('exit', up)
    } catch {
      up() // no threads here: as it is
    }
  })
  const patterns = new Map<string, { re: RegExp; cut: RegExp; g?: RegExp; gcut?: RegExp }>()
  const say = (m: Record<string, unknown>) => { process.stdout.write(`${JSON.stringify(m)}\n`) }
  const queue: string[] = []
  let busy = false
  let rest = ''
  const work = async (): Promise<void> => {
    if (busy) return
    busy = true
    try {
      while (queue.length) {
        let m: { t?: string; id?: number; source?: string; flags?: string; cut?: string; lines?: Array<[string, number]>; text?: string; cuts?: number[]; n?: number; after?: number }
        try { m = JSON.parse(queue.shift()!) } catch { continue }
        if (m.t !== 'test') continue
        // Two forms: `lines` ([text, cut] pairs, from a daemon older than this matcher) and `text`
        // (the lines joined with \n, which no line holds, and `cuts`, the indexes of the cut ones).
        const texts = typeof m.text === 'string' ? m.text.split('\n') : Array.isArray(m.lines) ? m.lines.map((l) => l[0]) : null
        if (!texts) continue
        if (typeof m.n === 'number' && texts.length !== m.n) {
          say({ t: 'result', id: m.id, error: `the matcher got ${texts.length} lines where ${m.n} were sent`, cpu: ownCpu() })
          continue
        }
        const cuts = Array.isArray(m.lines) ? m.lines.flatMap((l, i) => (l[1] ? [i] : [])) : Array.isArray(m.cuts) ? m.cuts : []
        // Each test names its pattern; the compiled ones are kept, the least recently used dropped.
        const key = `${String(m.flags)}/${String(m.source)}/${String(m.cut)}`
        let p = patterns.get(key)
        if (p) patterns.delete(key)
        else {
          try { p = { re: new RegExp(String(m.source), m.flags), cut: new RegExp(String(m.cut), m.flags) } } catch (err) {
            say({ t: 'result', id: m.id, error: `the pattern did not compile in the matcher (${err instanceof Error ? err.message : String(err)})`, cpu: ownCpu() })
            continue
          }
          if (patterns.size >= PATTERNS_KEPT) patterns.delete(patterns.keys().next().value!)
        }
        patterns.set(key, p)
        // `after`: the first line is one a wait resumed inside of, and a match there counts only
        // when it ends past its first `after` characters.
        const after = typeof m.after === 'number' && m.after > 0 ? m.after : 0
        const began = Date.now()
        const cpuAt = process.cpuUsage()
        let i = 0
        let hit: number | null = null
        let text: string | undefined
        let slow = false
        let nextCut = 0
        for (; i < texts.length; i += 1) {
          const line = stripAnsi(texts[i]!)
          let cut = false
          while (nextCut < cuts.length && cuts[nextCut]! < i) nextCut += 1
          if (cuts[nextCut] === i) cut = true
          const t = Date.now()
          const ok = after && i === 0
            ? endsPast(cut ? (p.gcut ??= new RegExp(p.cut.source, `${p.cut.flags}g`)) : (p.g ??= new RegExp(p.re.source, `${p.re.flags}g`)), line, after)
            : (cut ? p.cut : p.re).test(line)
          if (Date.now() - t > LINE_LIMIT_MS) {
            const u = process.cpuUsage(cpuAt)
            if ((u.user + u.system) / 1000 > LINE_LIMIT_MS) { slow = true; break }
          }
          if (ok) { hit = i; text = line.slice(0, SHOW_MAX); i += 1; break }
          if (Date.now() - began >= BATCH_MS) { i += 1; break }
        }
        say(slow ? { t: 'result', id: m.id, slow: true, cpu: ownCpu() } : { t: 'result', id: m.id, tested: i, hit, ...(text !== undefined ? { text } : {}), cpu: ownCpu() })
        // Let the answer out before the next batch.
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    } finally {
      busy = false
    }
  }
  return new Promise((resolve) => {
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
      // A test of a large batch comes in many chunks: only the new one is searched for its end.
      const from = rest.length
      rest += chunk
      for (let nl = rest.indexOf('\n', from); nl !== -1; nl = rest.indexOf('\n')) {
        queue.push(rest.slice(0, nl))
        rest = rest.slice(nl + 1)
      }
      void work()
    })
    process.stdin.on('end', () => resolve())
    process.stdin.on('error', () => resolve())
    // v 2: it reads the joined form of a test (the daemon sends the pairs to a matcher that does not
    // say so); v 3: it reads `after`.
    void watching.then(() => say({ t: 'ready', v: 3, cpu: ownCpu() }))
  })
}

/**
 * The matcher's environment: the daemon's PATH, HOME and TMPDIR, and the two that place the
 * compiled walnut file's unpacked runtime (OPEN_WALNUT_HOME, WALNUT_RUNTIME_DIR): a daemon that runs
 * as that file starts the matcher as it, and without them the matcher would unpack and prune
 * under ~/.open-walnut instead of where the daemon's own tree is (src/binary/runtime-tree.ts).
 */
export function matcherEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = { PATH: env.PATH ?? '/usr/bin:/bin', HOME: env.HOME ?? os.homedir() }
  for (const k of ['TMPDIR', 'OPEN_WALNUT_HOME', 'WALNUT_RUNTIME_DIR']) { const v = env[k]; if (v) out[k] = v }
  return out
}

/**
 * A process's CPU time so far (ms), from the OS: /proc on Linux, ps elsewhere (2 s at most); null
 * when it cannot say. /proc is read at once, not through the thread pool: a few hundred bytes the
 * kernel writes on the spot, while the pool may be held by file looks on a mount that stopped
 * answering (2026-11-04 review: with the pool held, this never answered, the matcher's timer
 * never fired again, and every output wait answered untested until the daemon restarted).
 */
export async function cpuOfPid(pid: number, platform: string = process.platform): Promise<number | null> {
  if (platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      // utime and stime, fields 14 and 15, in clock ticks of 10 ms.
      const ticks = Number(f[11]) + Number(f[12])
      return Number.isFinite(ticks) ? ticks * 10 : null
    } catch {
      return null
    }
  }
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'cputime=', '-p', String(pid)], { timeout: 2_000 }, (err, out) => resolve(err ? null : psTime(String(out))))
  })
}

/** `ps -o cputime` as ms: [[dd-]hh:]mm:ss[.cc]. */
export function psTime(text: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim())
  if (!m) return null
  return ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 3600 + Number(m[3]) * 60 + Number(m[4])) * 1000
}

/**
 * A batch's lines as a test carries them: joined with \n (no line holds one: the splitter ends a
 * line there) and the indexes of the cut ones, one string that encodes and parses at native speed
 * (2026-11-04 review: a pair per line held the scan near 2.5 MB/s); as pairs for a matcher that
 * did not say it reads that (an older executable after a rollback).
 */
export function linesOut(lines: MatchLine[], joined: boolean): { text: string; cuts: number[]; n: number } | { lines: Array<[string, number]> } {
  if (!joined) return { lines: lines.map((l) => [l.text, l.cut ? 1 : 0]) }
  const texts: string[] = new Array(lines.length)
  const cuts: number[] = []
  for (let i = 0; i < lines.length; i += 1) { texts[i] = lines[i]!.text; if (lines[i]!.cut) cuts.push(i) }
  return { text: texts.join('\n'), cuts, n: lines.length }
}

/** One ask of the matcher: its answer, and its withdrawal (the answer is then WITHDRAWN at once). */
export interface MatchAsk { result: Promise<MatchResult>; withdraw(): void }

export interface Matcher {
  /** Test lines, in turn with every other wait: answers after the first match, or about BATCH_MS of them. */
  ask(pattern: LinePattern, lines: MatchLine[], resume?: MatchResume): MatchAsk
  /** ask(...).result, for a caller that never withdraws. */
  test(pattern: LinePattern, lines: MatchLine[]): Promise<MatchResult>
  /** The process, while one runs (tests). */
  readonly pid: number | null
  /** A process runs and has said it is ready (false: the next ask waits for one to start). */
  readonly warm?: boolean
  close(): void
}

/** `resume`: the first line is one a wait resumed inside of (resumedAsk in host-exec-wait.ts). */
interface Asked { pattern: LinePattern; lines: MatchLine[]; resume?: MatchResume; resolve: (r: MatchResult) => void }
/** A resumed line's test: `after` for a matcher that reads it, the `fallback` pattern for one that does not. */
export interface MatchResume { after: number; fallback: LinePattern }
/** `cpuAt`: the CPU the process said with its last message; `cpuSeen`: the most its watch thread reported since. */
interface Running { proc: ChildProcess; ready: boolean; cpuAt: number; cpuSeen: number; heardAt: number; joined: boolean; resumes: boolean }

/**
 * The daemon's side: one matcher process, started on first use and ended when idle. A batch the
 * process does not answer within the line limit is judged by the process's CPU time (a slow line
 * burns it; a starved machine does not), so a loaded host does not turn an ordinary pattern into
 * a "too slow" answer; with no CPU reading at all, it is never called slow.
 */
export function createMatcher(start: MatcherStart | (() => MatcherStart), spawn: Spawn, opts: { lineLimitMs?: number; silentMaxMs?: number; cpuOf?: (pid: number) => Promise<number | null> } = {}): Matcher {
  const limit = opts.lineLimitMs ?? LINE_LIMIT_MS
  const silentMax = opts.silentMaxMs ?? SILENT_MAX_MS
  const cpuOf = opts.cpuOf ?? cpuOfPid
  const queue: Asked[] = []
  let current: Running | null = null
  let inFlight: { asked: Asked; id: number } | null = null
  let seq = 0
  let idle: ReturnType<typeof setTimeout> | null = null
  let watch: ReturnType<typeof setTimeout> | null = null
  let startTimer: ReturnType<typeof setTimeout> | null = null

  const finish = (r: MatchResult) => {
    if (watch) { clearTimeout(watch); watch = null }
    const asked = inFlight?.asked
    inFlight = null
    asked?.resolve(r)
  }

  /** End the process; what it was testing answers `why`, and what it had not started stays queued. */
  const stop = (proc: ChildProcess, why: MatchResult | null) => {
    if (current?.proc !== proc) return
    current = null
    if (startTimer) { clearTimeout(startTimer); startTimer = null }
    try { proc.kill('SIGKILL') } catch { /* gone */ }
    if (inFlight && why) finish(why)
  }

  function launch(): Running | string {
    let proc: ChildProcess
    try {
      // Asked each time: an update may have replaced the executable the daemon started from.
      const how = typeof start === 'function' ? start() : start
      proc = spawn(how.command, how.args, { stdio: ['pipe', 'pipe', 'pipe'], env: matcherEnv(process.env) })
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
    const run: Running = { proc, ready: false, cpuAt: 0, cpuSeen: 0, heardAt: Date.now(), joined: false, resumes: false }
    let buf = ''
    let err = ''
    // The watch thread's CPU reports; anything else there (a crash's trace) is not JSON and is skipped.
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      if (current !== run) return
      err += chunk
      for (let nl = err.indexOf('\n'); nl !== -1; nl = err.indexOf('\n')) {
        const line = err.slice(0, nl)
        err = err.slice(nl + 1)
        if (!line.startsWith('{"cpu":')) continue
        try { const cpu = (JSON.parse(line) as { cpu?: unknown }).cpu; if (typeof cpu === 'number' && cpu > run.cpuSeen) run.cpuSeen = cpu } catch { /* not a report */ }
      }
      if (err.length > 4096) err = ''
    })
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      if (current !== run) return
      buf += chunk
      for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let m: { t?: string; v?: number; id?: number; cpu?: number; tested?: number; hit?: number | null; text?: string; slow?: boolean; error?: string }
        try { m = JSON.parse(line) } catch { continue }
        run.heardAt = Date.now()
        if (typeof m.cpu === 'number') { run.cpuAt = m.cpu; if (m.cpu > run.cpuSeen) run.cpuSeen = m.cpu }
        if (m.t === 'ready') {
          run.ready = true
          run.joined = typeof m.v === 'number' && m.v >= 2
          run.resumes = typeof m.v === 'number' && m.v >= 3
          if (startTimer) { clearTimeout(startTimer); startTimer = null }
        } else if (m.t === 'result' && inFlight && m.id === inFlight.id) {
          finish(m.slow ? { slow: true } : typeof m.error === 'string' ? { error: m.error }
            : { tested: Math.max(0, Number(m.tested) || 0), hit: typeof m.hit === 'number' && m.hit >= 0 ? m.hit : null, ...(typeof m.text === 'string' ? { text: m.text } : {}) })
        }
      }
      pump()
    })
    const gone = (why: string) => {
      if (current !== run) return
      current = null
      if (startTimer) { clearTimeout(startTimer); startTimer = null }
      if (inFlight) finish({ error: `the pattern matcher stopped (${why})` })
      else if (!run.ready) for (const a of queue.splice(0)) a.resolve({ error: `the pattern matcher did not start (${why})` })
      pump()
    }
    proc.on('error', (err) => gone(err.message))
    proc.on('exit', (code, signal) => gone(signal ? `signal ${signal}` : `exit ${code}`))
    proc.stdin?.on('error', () => { /* it died: exit says so */ })
    proc.unref()
    ;(proc.stdout as unknown as { unref?: () => void } | null)?.unref?.()
    ;(proc.stderr as unknown as { unref?: () => void } | null)?.unref?.()
    ;(proc.stdin as unknown as { unref?: () => void } | null)?.unref?.()
    startTimer = setTimeout(() => {
      if (current !== run || run.ready) return
      const waiting = queue.splice(0)
      stop(proc, null)
      for (const a of waiting) a.resolve({ error: `the pattern matcher did not start within ${START_MAX_MS / 1000} s` })
    }, START_MAX_MS)
    startTimer.unref?.()
    return run
  }

  /**
   * No answer within the limit: a line that burned the CPU is stopped as slow. The CPU is what the
   * process's watch thread reported, else the OS's count; both only ever undercount (a report
   * that is late, a tick of 10 ms), so neither calls an ordinary line slow. With neither, nothing
   * is called slow: the batch is timed again until the process has been silent SILENT_MAX_MS.
   */
  const arm = (run: Running, id: number) => {
    watch = setTimeout(() => {
      watch = null
      // What already came in is read first (the poll phase runs before this).
      setImmediate(() => {
        void (async () => {
          if (current !== run || inFlight?.id !== id) return
          // Most of the limit is enough: CPU counts in ticks, and the process may have waited for a core.
          const over = (cpu: number | null) => cpu !== null && cpu - run.cpuAt >= limit * 0.8
          if (over(run.cpuSeen)) { stop(run.proc, { slow: true }); pump(); return }
          const pid = run.proc.pid
          const cpu = typeof pid === 'number' ? await cpuOf(pid) : null
          if (current !== run || inFlight?.id !== id) return
          if (over(cpu) || over(run.cpuSeen)) { stop(run.proc, { slow: true }); pump(); return }
          const silent = Date.now() - run.heardAt
          if (silent >= silentMax) {
            stop(run.proc, { error: `the pattern matcher did not answer for ${Math.round(silent / 1000)} s and showed no line over the limit (an overloaded host?), so the output could not be checked` })
            pump()
            return
          }
          arm(run, id)
        })()
      })
    }, limit)
    watch.unref?.()
  }

  function pump(): void {
    if (inFlight || !queue.length) {
      if (!inFlight && !queue.length && current && !idle) {
        idle = setTimeout(() => { idle = null; if (!inFlight && !queue.length && current) { const p = current.proc; current = null; try { p.stdin?.end() } catch { /* gone */ } setTimeout(() => { try { p.kill('SIGKILL') } catch { /* gone */ } }, 1_000).unref?.() } }, IDLE_MS)
        idle.unref?.()
      }
      return
    }
    if (idle) { clearTimeout(idle); idle = null }
    if (!current) {
      const run = launch()
      if (typeof run === 'string') {
        for (const a of queue.splice(0)) a.resolve({ error: `the pattern matcher did not start (${run})` })
        return
      }
      current = run
    }
    const run = current
    if (!run.ready) return
    const asked = queue.shift()!
    // A resumed line: `after` where the process reads it, else the pattern that says it in a lookahead.
    const resumes = asked.resume !== undefined && run.resumes
    const p = asked.resume && !resumes ? asked.resume.fallback : asked.pattern
    const id = ++seq
    inFlight = { asked, id }
    try {
      run.proc.stdin?.write(`${JSON.stringify({ t: 'test', id, source: p.source, flags: p.flags, cut: p.cut, ...linesOut(asked.lines, run.joined), ...(resumes ? { after: asked.resume!.after } : {}) })}\n`)
    } catch (err) {
      stop(run.proc, { error: `the pattern matcher stopped (${err instanceof Error ? err.message : String(err)})` })
      pump()
      return
    }
    run.heardAt = Date.now()
    arm(run, id)
  }

  const ask = (pattern: LinePattern, lines: MatchLine[], resume?: MatchResume): MatchAsk => {
    if (!lines.length) return { result: Promise.resolve({ tested: 0, hit: null }), withdraw: () => {} }
    let settled = false
    let answer: (r: MatchResult) => void = () => {}
    const result = new Promise<MatchResult>((resolve) => { answer = resolve })
    const asked: Asked = { pattern, lines, ...(resume ? { resume } : {}), resolve: (r) => { if (!settled) { settled = true; answer(r) } } }
    queue.push(asked)
    pump()
    return {
      result,
      // Not sent yet: never sent. In flight: answered now, and the process's answer, when it comes,
      // only frees the matcher for the next batch (judged as its own, never against another's).
      withdraw: () => {
        if (settled) return
        const at = queue.indexOf(asked)
        if (at !== -1) queue.splice(at, 1)
        asked.resolve({ error: WITHDRAWN })
        pump()
      },
    }
  }

  return {
    ask,
    test: (pattern, lines) => ask(pattern, lines).result,
    get pid() { return current?.proc.pid ?? null },
    get warm() { return current?.ready === true },
    close() {
      if (idle) { clearTimeout(idle); idle = null }
      for (const a of queue.splice(0)) a.resolve({ error: 'the pattern matcher was closed' })
      if (current) stop(current.proc, { error: 'the pattern matcher was closed' })
    },
  }
}
