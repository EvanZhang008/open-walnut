/**
 * `proc.sample`: what each session costs this host, shared by both daemon twins.
 *
 * ONE `ps` per sample lists every process (pid, ppid, pgid, rss, cumulative cpu
 * time, elapsed time, command); the sampler then attributes processes to the
 * sessions the daemon runs. A session owns its CLI (the root pid), everything
 * below it by parent chain, anything left in its process group, and anything it
 * was seen owning before. The last one matters: Claude Code's Bash tool runs
 * each command DETACHED (its own process group), so a background server whose
 * shell exited is re-parented to launchd/init in a group no root leads, and only
 * an earlier sample's claim still ties it to the session. Such a claim outlives
 * the CLI: a stopped session whose processes kept running answers a row with
 * `alive: false`. (A command that detaches and exits between two samples is
 * never seen in the tree, so it stays unattributed.)
 *
 * A process is a pid plus its start time (now minus elapsed, whole seconds), so a
 * reused pid is a new process. CPU is a delta of cumulative cpu time over a
 * window of at least `minCpuWindowMs`, never ps's own `%cpu` (a lifetime average
 * on Linux, a decayed one on macOS, both ~0 for a process that just started a
 * 100% loop). procps prints cpu time in whole seconds, so Linux windows are
 * longer; a sample inside the window repeats the last reading instead of
 * dividing a rounding error by a short interval. A process born inside the
 * window counts from zero, so a short tsc or test worker is not lost.
 *
 * Why this lives in the daemon: the raw table is ~150 KB on a busy Mac and the
 * server must never spawn `ps` on its one event loop; the per-session totals
 * that cross the tunnel are a few hundred bytes.
 *
 * How each twin gets it: daemon-standalone.ts imports createProcSampler;
 * daemon-source.ts inlines `createProcSampler.toString()` through
 * `__CREATE_PROC_SAMPLER__`. So the factory body references NOTHING at module
 * scope: every helper lives inside it and every capability comes from `deps`.
 */

export interface ProcSampleExecFile {
  (
    file: string,
    args: string[],
    options: { encoding: 'utf-8'; timeout: number; maxBuffer: number; env: Record<string, string | undefined> },
    callback: (error: Error | null, stdout: string) => void,
  ): unknown
}

export interface ProcSamplerDeps {
  execFile?: ProcSampleExecFile
  platform?: string
  env?: Record<string, string | undefined>
  now?: () => number
  totalmem?: () => number
  loadavg?: () => number[]
  cpuCount?: () => number
  /** ps budget (default 5s). A host that cannot answer in time answers `error`. */
  timeoutMs?: number
  /** Processes listed per session, largest first (default 6). */
  topN?: number
  /** Shortest cpu window (default 3s, 9s on Linux, whose ps rounds to seconds). */
  minCpuWindowMs?: number
}

/** One row of the ps table. */
export interface ProcRow {
  pid: number
  ppid: number
  pgid: number
  rssBytes: number
  /** Cumulative user+system cpu seconds. */
  cpuSeconds: number
  /** Seconds since the process started. */
  elapsedSeconds: number
  /** Command basename (`claude`, `node`, `vitest`), never the whole argv. */
  comm: string
}

/** A session the daemon runs, by its root process. */
export interface ProcSampleRoot {
  sid: string
  pid: number
  kind: 'cli' | 'acp'
}

export interface ProcUsageEntry {
  pid: number
  comm: string
  rssBytes: number
  /** Null until a full cpu window has seen this process. */
  cpuPct: number | null
}

export interface SessionProcUsage {
  sid: string
  kind: 'cli' | 'acp'
  rootPid: number
  /**
   * The root pid is running. False: the CLI is gone and these are processes it
   * left behind (still attributed to the session from an earlier sample).
   */
  alive: boolean
  procCount: number
  rssBytes: number
  /** Sum over the processes with a cpu reading; null when none has one yet. */
  cpuPct: number | null
  top: ProcUsageEntry[]
}

export interface ProcSample {
  at: number
  /** How long the ps call plus attribution took. */
  sampleMs: number
  host: { platform: string; totalMemBytes: number; loadavg1: number; cpuCount: number }
  /** Every process on the host, attributed or not. */
  processCount: number
  sessions: SessionProcUsage[]
  /** ps did not answer: `sessions` is empty and `processCount` 0. */
  error?: string
}

/** Self-contained factory: see the file comment before adding any reference outside it. */
export function createProcSampler(deps: ProcSamplerDeps) {
  var TIMEOUT_MS = deps.timeoutMs ?? 5000
  var TOP_N = deps.topN ?? 6
  var MIN_WINDOW_MS = deps.minCpuWindowMs ?? (deps.platform === 'linux' ? 9000 : 3000)
  var MAX_BUFFER = 16 * 1024 * 1024
  /** Start times read from two samples differ by up to a second each way. */
  var START_SLACK_S = 2
  var now = deps.now ?? (() => Date.now())
  /** The cpu baseline: every process's cumulative cpu at `baseAt`. Null before the first sample. */
  var base: Map<number, { cpuSeconds: number; start: number }> | null = null
  var baseAt = 0
  /** The readings of the last full window, repeated by a sample inside the next one. */
  var lastPct = new Map<number, { pct: number; start: number }>()
  /** pid -> the session that was seen owning it (survives re-parenting and the CLI's death). */
  var owners = new Map<number, { sid: string; kind: 'cli' | 'acp'; rootPid: number; start: number }>()
  /** A ps call in flight: a second ask rides it instead of spawning another. */
  var inFlight: Promise<ProcSample> | null = null

  /**
   * `[[D-]HH:]MM:SS[.cc]` -> seconds, for both `time` and `etime`. macOS prints
   * minutes unbounded (`5573:35.00`), procps prints `DD-HH:MM:SS` past a day.
   * Unparseable -> NaN.
   */
  function parseCpuTime(text: string): number {
    var s = String(text || '').trim()
    if (!s) return NaN
    var days = 0
    var dash = s.indexOf('-')
    if (dash > 0) {
      days = Number(s.slice(0, dash))
      s = s.slice(dash + 1)
      if (!Number.isFinite(days)) return NaN
    }
    var parts = s.split(':')
    if (parts.length < 2 || parts.length > 3) return NaN
    var total = 0
    for (var i = 0; i < parts.length; i++) {
      var n = Number(parts[i])
      if (!Number.isFinite(n) || n < 0) return NaN
      total = total * 60 + n
    }
    return days * 86400 + total
  }

  /** The ps argv: BSD and procps both take `-A -ww -o` with these keys. */
  function psArgs(): string[] {
    return ['-A', '-ww', '-o', 'pid=,ppid=,pgid=,rss=,time=,etime=,comm=']
  }

  /**
   * Parse the table. The first six columns are numbers/times; `comm` is the
   * REST of the line (macOS prints a path, and "/Library/Application Support/x"
   * has a space in it). A line that does not fit is skipped, never fatal.
   */
  function parsePsTable(stdout: string): ProcRow[] {
    var rows: ProcRow[] = []
    var lines = String(stdout || '').split('\n')
    for (var i = 0; i < lines.length; i++) {
      var m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*\S)\s*$/.exec(lines[i])
      if (!m) continue
      var cpu = parseCpuTime(m[5])
      var elapsed = parseCpuTime(m[6])
      if (!Number.isFinite(cpu) || !Number.isFinite(elapsed)) continue
      var full = m[7]
      var slash = full.lastIndexOf('/')
      var comm = slash >= 0 && slash < full.length - 1 ? full.slice(slash + 1) : full
      rows.push({
        pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]),
        rssBytes: Number(m[4]) * 1024, cpuSeconds: cpu, elapsedSeconds: elapsed, comm: comm,
      })
    }
    return rows
  }

  /**
   * Which processes belong to which root. In order: the NEAREST live root above
   * a process claims it (a registered session spawned inside another session's
   * tree keeps its own subtree); then `sticky` (pid -> root index, the earlier
   * claims) re-claims a process and its unclaimed descendants; then every
   * unclaimed process in a live root's group joins that root. Only the first
   * `liveCount` roots are walked from (default: all); the rest exist for the
   * sticky claims of a session whose CLI is gone, whose pid may be reused.
   * Returns pid -> root index.
   */
  function attribute(rows: ProcRow[], roots: ProcSampleRoot[], sticky?: Map<number, number>, liveCount?: number): Map<number, number> {
    var live = liveCount == null ? roots.length : liveCount
    var byPid = new Map<number, ProcRow>()
    var children = new Map<number, number[]>()
    for (var r of rows) {
      byPid.set(r.pid, r)
      var sib = children.get(r.ppid)
      if (sib) sib.push(r.pid)
      else children.set(r.ppid, [r.pid])
    }
    var rootIndexOfPid = new Map<number, number>()
    for (var i = 0; i < live; i++) rootIndexOfPid.set(roots[i].pid, i)
    var claimed = new Map<number, number>()
    // Depth-first; never into another live root (it claims its own tree) or a claimed pid.
    function walk(from: number, ri: number): void {
      var stack = [from]
      while (stack.length) {
        var pid = stack.pop() as number
        if (claimed.has(pid)) continue
        if (pid !== from && rootIndexOfPid.has(pid)) continue
        claimed.set(pid, ri)
        var kids = children.get(pid)
        if (kids) for (var k of kids) stack.push(k)
      }
    }
    for (var ri = 0; ri < live; ri++) if (byPid.has(roots[ri].pid)) walk(roots[ri].pid, ri)
    if (sticky) {
      for (var entry of Array.from(sticky.entries())) {
        if (!claimed.has(entry[0]) && byPid.has(entry[0]) && !rootIndexOfPid.has(entry[0])) walk(entry[0], entry[1])
      }
    }
    // The process group catches re-parented children of a non-detached spawn (ppid 1, pgid = the CLI).
    for (var r2 of rows) {
      if (claimed.has(r2.pid)) continue
      var gi = rootIndexOfPid.get(r2.pgid)
      if (gi != null && r2.pid !== roots[gi].pid) claimed.set(r2.pid, gi)
    }
    return claimed
  }

  function startOf(row: ProcRow, at: number): number {
    return Math.round(at / 1000 - row.elapsedSeconds)
  }

  function sameStart(a: number, b: number): boolean {
    return Math.abs(a - b) <= START_SLACK_S
  }

  function build(rows: ProcRow[], roots: ProcSampleRoot[], at: number): SessionProcUsage[] {
    var starts = new Map<number, number>()
    for (var r0 of rows) starts.set(r0.pid, startOf(r0, at))
    // Earlier claims, by the same process (pid AND start). A claim for a session
    // the daemon no longer runs gets a root of its own (`alive: false`).
    var all = roots.slice()
    var indexOfSid = new Map<string, number>()
    for (var i0 = 0; i0 < all.length; i0++) indexOfSid.set(all[i0].sid, i0)
    var sticky = new Map<number, number>()
    for (var o of Array.from(owners.entries())) {
      var st = starts.get(o[0])
      if (st == null || !sameStart(st, o[1].start)) continue
      var idx = indexOfSid.get(o[1].sid)
      if (idx == null) {
        idx = all.length
        all.push({ sid: o[1].sid, pid: o[1].rootPid, kind: o[1].kind })
        indexOfSid.set(o[1].sid, idx)
      }
      sticky.set(o[0], idx)
    }
    var claimed = attribute(rows, all, sticky, roots.length)

    // CPU: a full window moves the baseline; a sample inside it repeats the last readings.
    var full = base == null || at - baseAt >= MIN_WINDOW_MS
    var windowS = (at - baseAt) / 1000
    var pcts = new Map<number, number>()
    if (base && full) {
      for (var rc of rows) {
        if (!claimed.has(rc.pid)) continue
        var stc = starts.get(rc.pid) as number
        var b = base.get(rc.pid)
        var from: number | null = null
        if (b && sameStart(b.start, stc)) from = b.cpuSeconds
        // Born inside the window: everything it used, it used in this window.
        else if (stc * 1000 >= baseAt - START_SLACK_S * 1000) from = 0
        if (from == null) continue
        var dc = rc.cpuSeconds - from
        if (dc < 0) continue
        pcts.set(rc.pid, Math.round((dc / windowS) * 1000) / 10)
      }
    } else if (base) {
      for (var rl of rows) {
        var l = lastPct.get(rl.pid)
        if (l && claimed.has(rl.pid) && sameStart(l.start, starts.get(rl.pid) as number)) pcts.set(rl.pid, l.pct)
      }
    }
    if (full) {
      var nextBase = new Map<number, { cpuSeconds: number; start: number }>()
      for (var rb of rows) nextBase.set(rb.pid, { cpuSeconds: rb.cpuSeconds, start: starts.get(rb.pid) as number })
      base = nextBase
      baseAt = at
      var nextPct = new Map<number, { pct: number; start: number }>()
      for (var e0 of Array.from(pcts.entries())) nextPct.set(e0[0], { pct: e0[1], start: starts.get(e0[0]) as number })
      lastPct = nextPct
    }

    var groups: ProcUsageEntry[][] = all.map(() => [])
    var nextOwners = new Map<number, { sid: string; kind: 'cli' | 'acp'; rootPid: number; start: number }>()
    for (var row of rows) {
      var ri = claimed.get(row.pid)
      if (ri == null) continue
      var pct = pcts.get(row.pid)
      groups[ri].push({ pid: row.pid, comm: row.comm, rssBytes: row.rssBytes, cpuPct: pct == null ? null : pct })
      // Remember the claim under the session's CURRENT root, so a resumed CLI's new pid carries on.
      nextOwners.set(row.pid, { sid: all[ri].sid, kind: all[ri].kind, rootPid: all[ri].pid, start: starts.get(row.pid) as number })
    }
    owners = nextOwners
    var out: SessionProcUsage[] = []
    for (var i = 0; i < all.length; i++) {
      var entries = groups[i]
      // A session that is gone and left nothing is not a row.
      if (i >= roots.length && entries.length === 0) continue
      var rss = 0
      var cpu: number | null = null
      for (var e of entries) {
        rss += e.rssBytes
        if (e.cpuPct != null) cpu = (cpu ?? 0) + e.cpuPct
      }
      entries.sort((a, b2) => b2.rssBytes - a.rssBytes)
      out.push({
        sid: all[i].sid, kind: all[i].kind, rootPid: all[i].pid,
        alive: i < roots.length && claimed.get(all[i].pid) === i,
        procCount: entries.length, rssBytes: rss,
        cpuPct: cpu == null ? null : Math.round(cpu * 10) / 10,
        top: entries.slice(0, TOP_N),
      })
    }
    return out
  }

  function hostFacts(): ProcSample['host'] {
    var load = deps.loadavg ? deps.loadavg() : [0]
    return {
      platform: deps.platform ?? 'unknown',
      totalMemBytes: deps.totalmem ? deps.totalmem() : 0,
      loadavg1: Math.round(((load && load[0]) || 0) * 100) / 100,
      cpuCount: deps.cpuCount ? deps.cpuCount() : 0,
    }
  }

  function runPs(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!deps.execFile) return reject(new Error('proc.sample: no execFile'))
      deps.execFile('ps', psArgs(), {
        encoding: 'utf-8', timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER,
        env: Object.assign({}, deps.env || {}, { LANG: 'C', LC_ALL: 'C' }),
      }, (err, stdout) => {
        if (!err) return resolve(stdout || '')
        // ps exits 1 when a listed pid vanished mid-walk; the table it printed is
        // still whole. A kill (timeout) or an overflowing buffer cut it short: a
        // truncated table would drop sessions and reset every baseline, so it is
        // an error, not a reading.
        var e = err as Error & { code?: unknown; killed?: boolean; signal?: unknown }
        if (e.code === 1 && !e.killed && !e.signal && stdout && stdout.length > 0) return resolve(stdout)
        reject(err)
      })
    })
  }

  /** One sample for these roots. Concurrent callers share one ps. */
  function sample(roots: ProcSampleRoot[]): Promise<ProcSample> {
    if (inFlight) return inFlight
    var started = now()
    var wanted = roots.filter((r) => Number.isFinite(r.pid) && r.pid > 1)
    inFlight = runPs().then((stdout) => {
      var at = now()
      var rows = parsePsTable(stdout)
      var sessions = build(rows, wanted, at)
      return {
        at: at, sampleMs: at - started, host: hostFacts(), processCount: rows.length, sessions: sessions,
      } as ProcSample
    }, (err) => {
      var at = now()
      return {
        at: at, sampleMs: at - started, host: hostFacts(), processCount: 0, sessions: [],
        error: 'ps failed: ' + ((err && (err as Error).message) || String(err)),
      } as ProcSample
    }).then((r) => { inFlight = null; return r }, (err) => { inFlight = null; throw err })
    return inFlight
  }

  return { sample, parsePsTable, parseCpuTime, attribute, psArgs }
}

// Pure methods for the server and the tests, from a sampler with no deps.
var pure = createProcSampler({})
export const parsePsTable = pure.parsePsTable
export const parseCpuTime = pure.parseCpuTime
export const attributeProcesses = pure.attribute
export const PROC_SAMPLE_PS_ARGS = pure.psArgs()
