/**
 * How a host is doing now and how it did lately ('host-vitals-v1', `host.vitals`),
 * shared by both daemon twins.
 *
 * Now: CPU use (two readings of os.cpus() apart in time), load, total and
 * available memory (Linux MemAvailable, macOS vm_stat free + inactive +
 * speculative pages, else os.freemem), uptime and boot time, the daemon's own
 * start, whether a Walnut server holds a link to it, and its running sessions.
 *
 * Lately: a ledger the daemon writes itself, one line a minute, kept 31 days in
 * one file per UTC day (about 60 KB a day). The host records that it was up, so
 * a Mac that slept or redeployed never reads as this host being down: a minute
 * with no line is a minute the host or its daemon was down, a line with c:0 is
 * a minute it was up with no Walnut server linked. `vitals` folds the ledger
 * into buckets and per-window shares, outages and boots; the raw lines never
 * leave the host.
 *
 * Line: {"m":<epoch minute>,"b":<boot minute>,"d":<daemon start minute>,
 *        "c":<0|1 linked>,"s":<running sessions>,"u":<cpu %|-1>,"a":<memory available %|-1>}
 * Two daemons on one host (one draining during an upgrade) may both write a
 * minute; the fold counts a minute once.
 *
 * How each twin gets it: daemon-standalone.ts imports createHostVitals;
 * daemon-source.ts inlines `createHostVitals.toString()` through
 * `__CREATE_HOST_VITALS__`. So the factory body references NOTHING at module
 * scope, every capability comes from `deps`, and it carries no backticks.
 */

import type fsType from 'node:fs'
import type osType from 'node:os'

export interface HostVitalsDeps {
  fs: typeof fsType
  os: Pick<typeof osType, 'cpus' | 'totalmem' | 'freemem' | 'loadavg' | 'uptime'>
  /** child_process.execFile (vm_stat on macOS) */
  execFile: (file: string, args: string[], opts: Record<string, unknown>, cb: (err: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void) => unknown
  platform: string
  /** The ledger directory (created 0700 on the first write). */
  dir: string
  /** When this daemon started (ms). */
  startedAt: number
  /** A Walnut server holds a link to this daemon now. */
  linked: () => boolean
  /** Sessions this daemon runs now. */
  running: () => number
  now?: () => number
  retentionDays?: number
  /** Tick period (ms); a line is still written at most once a minute. */
  tickMs?: number
}

export interface HostStats {
  sampledAt: number
  cpus: number
  /** 0..1, null when it could not be measured. */
  cpuUtil: number | null
  load: [number, number, number] | null
  memTotalBytes: number
  memAvailBytes: number | null
  uptimeSec: number
  bootedAt: number
  daemonStartedAt: number
  linked: boolean
  running: number
}

export interface VitalsBucket {
  start: number
  /** Minutes the ledger covers in this bucket (before it started: 0). */
  minutes: number
  /** Minutes the host was up with its daemon running. */
  up: number
  /** Minutes a Walnut server was linked. */
  linked: number
  /** Average CPU use (0..1) and available memory share (0..1) over the up minutes, null when none. */
  cpu: number | null
  mem: number | null
  /** Most sessions running in one minute of it. */
  sessionsMax: number
}

export interface VitalsWindow {
  days: number
  minutes: number
  up: number
  linked: number
  /** up / minutes, null before any minute is covered. */
  online: number | null
  linkedShare: number | null
  /** Times the link to a Walnut server went away for 2 minutes or more. */
  drops: number
  /** Times the host or its daemon was down for 2 minutes or more. */
  downs: number
  /** Daemon starts and host boots that happened inside the window. */
  daemonStarts: number
  boots: number
}

export interface VitalsOutage { from: number; to: number; minutes: number; kind: 'down' | 'unlinked' }

export interface HostVitals {
  stats: HostStats
  history: {
    coverageFrom: number | null
    bucketMinutes: number
    buckets: VitalsBucket[]
    windows: VitalsWindow[]
    /** Newest first, at most 20, within the requested days. */
    outages: VitalsOutage[]
    /** Boot times seen in the requested days (ms), oldest first. */
    boots: number[]
    daemonStarts: number
  }
  ledger: { lastWriteAt: number | null; writeErrors: number; lastError: string | null }
}

/** Self-contained factory: see the file comment before adding any reference outside it. */
export function createHostVitals(deps: HostVitalsDeps) {
  var MIN = 60000
  var DAY_MIN = 1440
  var RETENTION = Math.max(2, Math.min(90, deps.retentionDays || 31))
  var TICK = deps.tickMs || 30000
  var now = deps.now || function () { return Date.now() }
  // Two baselines: the ledger's minute (moved only by its tick) and an asker's reading,
  // so a page polling every few seconds never shortens what a ledger minute measures.
  var cpuBase: Record<string, { at: number; idle: number; total: number } | null> = { tick: null, ask: null }
  var lastStats: HostStats | null = null
  var lastWrittenMinute = -1
  var lastPruneDay = ''
  var lastWriteAt: number | null = null
  var writeErrors = 0
  var lastError: string | null = null
  var dirReady = false
  var timer: { unref?: () => void } | null = null
  var ticking = false
  // Past days never change once over (a late duplicate line only repeats a minute): parsed once.
  var dayCache: Record<string, { size: number; rows: number[] }> = {}

  function cpuTimes(): { idle: number; total: number } | null {
    var list: Array<{ times: Record<string, number> }>
    try { list = deps.os.cpus() as never } catch (_e) { return null }
    if (!list || !list.length) return null
    var idle = 0, total = 0
    for (var i = 0; i < list.length; i++) {
      var t = list[i].times || {}
      for (var k in t) total += Number(t[k]) || 0
      idle += Number(t.idle) || 0
    }
    return total > 0 ? { idle: idle, total: total } : null
  }

  function utilBetween(a: { idle: number; total: number }, b: { idle: number; total: number }): number | null {
    var dt = b.total - a.total
    if (!(dt > 0)) return null
    var u = 1 - (b.idle - a.idle) / dt
    return u < 0 ? 0 : u > 1 ? 1 : Math.round(u * 1000) / 1000
  }

  function sleep(ms: number): Promise<void> {
    return new Promise(function (resolve) { setTimeout(resolve, ms) })
  }

  /** CPU use since the last reading (at least 1 s, at most 5 min ago), else over the next 250 ms. */
  async function cpuUtil(base: 'tick' | 'ask'): Promise<number | null> {
    var t = now()
    var cur = cpuTimes()
    if (!cur) return null
    var prev = cpuBase[base]
    if (prev && t - prev.at >= 1000 && t - prev.at <= 5 * MIN) {
      cpuBase[base] = { at: t, idle: cur.idle, total: cur.total }
      return utilBetween(prev, cur)
    }
    await sleep(250)
    var next = cpuTimes()
    if (!next) return null
    cpuBase[base] = { at: now(), idle: next.idle, total: next.total }
    return utilBetween(cur, next)
  }

  function execText(file: string, args: string[], ms: number): Promise<string | null> {
    return new Promise(function (resolve) {
      var done = false
      var timer2 = setTimeout(function () { if (!done) { done = true; resolve(null) } }, ms + 100)
      try {
        deps.execFile(file, args, { timeout: ms, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, encoding: 'utf8', windowsHide: true },
          function (err, stdout) {
            if (done) return
            done = true
            clearTimeout(timer2)
            resolve(err ? null : String(stdout || ''))
          })
      } catch (_e) { if (!done) { done = true; clearTimeout(timer2); resolve(null) } }
    })
  }

  /** Linux /proc/meminfo MemAvailable (kB), as bytes. */
  function parseMeminfo(text: string): number | null {
    var m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(String(text || ''))
    return m ? Number(m[1]) * 1024 : null
  }

  /** macOS vm_stat: free + inactive + speculative pages, as bytes. */
  function parseVmStat(text: string): number | null {
    var s = String(text || '')
    var ps = /page size of (\d+) bytes/.exec(s)
    var page = ps ? Number(ps[1]) : 4096
    var pick = function (name: string): number | null {
      var m = new RegExp('^Pages ' + name + ':\\s+(\\d+)', 'm').exec(s)
      return m ? Number(m[1]) : null
    }
    var free = pick('free')
    if (free === null) return null
    return (free + (pick('inactive') || 0) + (pick('speculative') || 0)) * page
  }

  async function memAvail(): Promise<number | null> {
    var v: number | null = null
    if (deps.platform === 'linux') {
      try { v = parseMeminfo(await deps.fs.promises.readFile('/proc/meminfo', 'utf8')) } catch (_e) { v = null }
    } else if (deps.platform === 'darwin') {
      var out = await execText('vm_stat', [], 2000)
      v = out === null ? null : parseVmStat(out)
    }
    if (v === null) { try { v = deps.os.freemem() } catch (_e) { v = null } }
    return typeof v === 'number' && isFinite(v) && v >= 0 ? v : null
  }

  async function measure(base: 'tick' | 'ask'): Promise<HostStats> {
    var util = await cpuUtil(base)
    var mem = await memAvail()
    var t = now()
    var cpus = 0
    try { cpus = deps.os.cpus().length } catch (_e) { cpus = 0 }
    var load: [number, number, number] | null = null
    try {
      var l = deps.os.loadavg()
      if (l && l.length >= 3 && deps.platform !== 'win32') load = [Math.round(l[0] * 100) / 100, Math.round(l[1] * 100) / 100, Math.round(l[2] * 100) / 100]
    } catch (_e) { load = null }
    var uptime = 0
    try { uptime = Math.round(deps.os.uptime()) } catch (_e) { uptime = 0 }
    var linked = false
    try { linked = !!deps.linked() } catch (_e) { linked = false }
    var running = 0
    try { running = Math.max(0, Number(deps.running()) || 0) } catch (_e) { running = 0 }
    var total = 0
    try { total = deps.os.totalmem() } catch (_e) { total = 0 }
    lastStats = {
      sampledAt: t, cpus: cpus, cpuUtil: util, load: load,
      memTotalBytes: total, memAvailBytes: mem === null ? null : Math.min(mem, total || mem),
      uptimeSec: uptime, bootedAt: t - uptime * 1000, daemonStartedAt: deps.startedAt,
      linked: linked, running: running,
    }
    return lastStats
  }

  /** The latest reading, measured again when it is older than 5 s; the link and sessions are read live. */
  async function stats(): Promise<HostStats> {
    if (lastStats && now() - lastStats.sampledAt < 5000) {
      var linked = lastStats.linked, running = lastStats.running
      try { linked = !!deps.linked() } catch (_e) { linked = false }
      try { running = Math.max(0, Number(deps.running()) || 0) } catch (_e) { /* keep */ }
      return Object.assign({}, lastStats, { linked: linked, running: running })
    }
    return measure('ask')
  }

  function dayName(minute: number): string {
    return new Date(minute * MIN).toISOString().slice(0, 10)
  }

  function pathOf(name: string): string {
    return deps.dir.replace(/\/+$/, '') + '/' + name
  }

  async function ensureDir(): Promise<void> {
    if (dirReady) return
    await deps.fs.promises.mkdir(deps.dir, { recursive: true, mode: 0o700 })
    dirReady = true
  }

  async function prune(today: string): Promise<void> {
    if (lastPruneDay === today) return
    lastPruneDay = today
    var cutoff = dayName(Math.floor(now() / MIN) - RETENTION * DAY_MIN)
    var names: string[] = []
    try { names = await deps.fs.promises.readdir(deps.dir) } catch (_e) { return }
    for (var i = 0; i < names.length; i++) {
      var n = names[i]
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) || n.slice(0, 10) >= cutoff) continue
      try { await deps.fs.promises.unlink(pathOf(n)) } catch (_e) { /* gone */ }
      delete dayCache[n]
    }
  }

  /** Write this minute's line once; the first tick of a UTC day prunes old days. */
  async function tick(): Promise<void> {
    if (ticking) return
    ticking = true
    try {
      var minute = Math.floor(now() / MIN)
      if (minute === lastWrittenMinute) return
      var s = await measure('tick')
      var line = JSON.stringify({
        m: minute,
        b: Math.floor(s.bootedAt / MIN),
        d: Math.floor(deps.startedAt / MIN),
        c: s.linked ? 1 : 0,
        s: s.running,
        u: s.cpuUtil === null ? -1 : Math.round(s.cpuUtil * 100),
        a: s.memAvailBytes === null || !s.memTotalBytes ? -1 : Math.round((s.memAvailBytes / s.memTotalBytes) * 100),
      }) + '\n'
      try {
        await ensureDir()
        var name = dayName(minute) + '.jsonl'
        await deps.fs.promises.appendFile(pathOf(name), line, { mode: 0o600 })
        lastWrittenMinute = minute
        lastWriteAt = now()
        await prune(dayName(minute))
      } catch (err) {
        dirReady = false
        writeErrors++
        lastError = String((err as Error) && (err as Error).message || err).slice(0, 200)
      }
    } finally {
      ticking = false
    }
  }

  function start(): void {
    if (timer) return
    void tick()
    timer = setInterval(function () { void tick() }, TICK) as unknown as { unref?: () => void }
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  function stop(): void {
    if (timer) clearInterval(timer as never)
    timer = null
  }

  function num(v: unknown): number | null {
    return typeof v === 'number' && isFinite(v) ? v : null
  }

  var ROW = 7 // m, boot, daemon start, linked, sessions, cpu%, mem%

  /** One flat array of rows (ROW numbers each); a bad line is skipped. */
  function parseDay(text: string): number[] {
    var out: number[] = []
    var lines = String(text || '').split('\n')
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i]
      if (!raw) continue
      var o: Record<string, unknown>
      try { o = JSON.parse(raw) } catch (_e) { continue }
      var m = num(o && o.m)
      if (m === null || m <= 0) continue
      var u = num(o.u), a = num(o.a)
      out.push(m, num(o.b) || 0, num(o.d) || 0, o.c === 1 ? 1 : 0, Math.max(0, num(o.s) || 0), u === null ? -1 : u, a === null ? -1 : a)
    }
    return out
  }

  async function readDay(name: string, today: string): Promise<number[]> {
    var file = pathOf(name)
    var size = -1
    try { size = (await deps.fs.promises.stat(file)).size } catch (_e) { return [] }
    var cached = dayCache[name]
    if (cached && cached.size === size) return cached.rows
    var text = ''
    try { text = await deps.fs.promises.readFile(file, 'utf8') } catch (_e) { return [] }
    var rows = parseDay(text)
    if (name < today + '.jsonl') dayCache[name] = { size: size, rows: rows }
    return rows
  }

  /** Runs of 2+ minutes over [from, to) (offsets) where bad(i) holds. */
  function runs(from: number, to: number, bad: (i: number) => boolean): Array<{ from: number; to: number }> {
    var out: Array<{ from: number; to: number }> = []
    var startBad = -1
    for (var i = from; i < to; i++) {
      if (bad(i)) { if (startBad < 0) startBad = i } else if (startBad >= 0) {
        if (i - startBad >= 2) out.push({ from: startBad, to: i })
        startBad = -1
      }
    }
    if (startBad >= 0 && to - startBad >= 2) out.push({ from: startBad, to: to })
    return out
  }

  async function vitals(cmd?: Record<string, unknown>): Promise<HostVitals> {
    var s = await stats()
    var days = Math.round(Number(cmd && cmd.days))
    if (!(days >= 1)) days = 30
    if (days > RETENTION) days = RETENTION
    var bucketMinutes = Math.round(Number(cmd && cmd.bucketMinutes))
    if (!(bucketMinutes >= 5)) bucketMinutes = days <= 1 ? 60 : DAY_MIN
    if (bucketMinutes > days * DAY_MIN) bucketMinutes = days * DAY_MIN
    // At most 2000 buckets: a finer ask gets wider buckets, never a megabyte reply.
    if (Math.ceil((days * DAY_MIN) / bucketMinutes) > 2000) bucketMinutes = Math.ceil((days * DAY_MIN) / 2000)
    var endMin = Math.floor(now() / MIN) // the current minute is still being written
    var widest = Math.max(days, 7)
    if (widest > RETENTION) widest = RETENTION
    var startMin = endMin - widest * DAY_MIN
    var N = endMin - startMin
    var today = dayName(endMin)
    // One slot per minute of the widest range: 0 none, 1 up, 2 up and linked. Typed
    // arrays keep a 31-day fold to a few milliseconds on the daemon's one thread.
    var state = new Uint8Array(N), sess = new Uint16Array(N), cpu = new Int8Array(N), mem = new Int8Array(N)
    var boot = new Float64Array(N), dstart = new Float64Array(N)
    cpu.fill(-1); mem.fill(-1)
    var firstSeen = -1
    for (var d = Math.floor(startMin / DAY_MIN); d <= Math.floor(endMin / DAY_MIN); d++) {
      var rows = await readDay(dayName(d * DAY_MIN) + '.jsonl', today)
      for (var r = 0; r + ROW <= rows.length; r += ROW) {
        var i = rows[r] - startMin
        if (i < 0 || i >= N) continue
        if (firstSeen < 0 || i < firstSeen) firstSeen = i
        // A minute two daemons both wrote is one minute, linked if either was.
        if (state[i] === 0) { boot[i] = rows[r + 1]; dstart[i] = rows[r + 2]; cpu[i] = Math.max(-1, Math.min(100, rows[r + 5])); mem[i] = Math.max(-1, Math.min(100, rows[r + 6])) }
        if (rows[r + 3] === 1 || state[i] === 0) state[i] = rows[r + 3] === 1 ? 2 : Math.max(state[i], 1)
        if (rows[r + 4] > sess[i]) sess[i] = Math.min(65535, rows[r + 4])
      }
    }
    // Coverage starts at the oldest line on disk, so a ledger begun yesterday reads 1 day, not 29 down.
    var coverage: number | null = firstSeen < 0 ? null : startMin + firstSeen
    var names: string[] = []
    try { names = (await deps.fs.promises.readdir(deps.dir)).filter(function (n) { return /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) }).sort() } catch (_e) { names = [] }
    if (names.length) {
      var first = await readDay(names[0], today)
      for (var fr = 0; fr + ROW <= first.length; fr += ROW) if (first[fr] <= endMin && (coverage === null || first[fr] < coverage)) coverage = first[fr]
    }
    var covFrom = coverage === null ? N : Math.max(0, coverage - startMin) // offset where coverage begins
    var unlinked = function (i: number): boolean { return state[i] === 1 }
    var down = function (i: number): boolean { return state[i] === 0 }

    // Boots (within 3 minutes is one boot: the minute jitters with rounding) and daemon
    // starts, each counted only when it happened inside the range asked.
    var bootList: number[] = []
    var startSet: Record<number, boolean> = {}
    for (var bi = 0; bi < N; bi++) {
      if (!state[bi]) continue
      if (boot[bi] > 0 && (!bootList.length || Math.abs(boot[bi] - bootList[bootList.length - 1]) > 3)) bootList.push(boot[bi])
      if (dstart[bi] > 0) startSet[dstart[bi]] = true
    }
    var startList = Object.keys(startSet).map(Number)
    var countFrom = function (list: number[], from: number): number { return list.filter(function (m) { return m >= from && m < endMin }).length }

    var windows: VitalsWindow[] = []
    var wins = [1, 7, 30]
    for (var wi = 0; wi < wins.length; wi++) {
      var wd = wins[wi]
      if (wd > widest && wd !== 1) continue
      var wFrom = Math.max(N - wd * DAY_MIN, covFrom)
      var mins = Math.max(0, N - wFrom), up = 0, lk = 0
      for (var wm = wFrom; wm < N; wm++) { if (state[wm]) { up++; if (state[wm] === 2) lk++ } }
      windows.push({
        days: wd, minutes: mins, up: up, linked: lk,
        online: mins > 0 ? Math.round((up / mins) * 10000) / 10000 : null,
        linkedShare: mins > 0 ? Math.round((lk / mins) * 10000) / 10000 : null,
        drops: runs(wFrom, N, unlinked).length,
        downs: runs(wFrom, N, down).length,
        daemonStarts: countFrom(startList, endMin - wd * DAY_MIN),
        boots: countFrom(bootList, endMin - wd * DAY_MIN),
      })
    }

    var reqFrom = N - days * DAY_MIN // offset
    var buckets: VitalsBucket[] = []
    for (var bs = N - Math.ceil((days * DAY_MIN) / bucketMinutes) * bucketMinutes; bs < N; bs += bucketMinutes) {
      var b: VitalsBucket = { start: (startMin + bs) * MIN, minutes: 0, up: 0, linked: 0, cpu: null, mem: null, sessionsMax: 0 }
      var cpuSum = 0, cpuN = 0, memSum = 0, memN = 0
      for (var bm = Math.max(bs, reqFrom, covFrom); bm < bs + bucketMinutes && bm < N; bm++) {
        b.minutes++
        if (!state[bm]) continue
        b.up++
        if (state[bm] === 2) b.linked++
        if (sess[bm] > b.sessionsMax) b.sessionsMax = sess[bm]
        if (cpu[bm] >= 0) { cpuSum += cpu[bm]; cpuN++ }
        if (mem[bm] >= 0) { memSum += mem[bm]; memN++ }
      }
      if (cpuN) b.cpu = Math.round(cpuSum / cpuN) / 100
      if (memN) b.mem = Math.round(memSum / memN) / 100
      buckets.push(b)
    }

    var outFrom = Math.max(reqFrom, covFrom)
    var outages: VitalsOutage[] = []
    runs(outFrom, N, down).forEach(function (x) {
      outages.push({ from: (startMin + x.from) * MIN, to: (startMin + x.to) * MIN, minutes: x.to - x.from, kind: 'down' })
    })
    runs(outFrom, N, unlinked).forEach(function (x) {
      outages.push({ from: (startMin + x.from) * MIN, to: (startMin + x.to) * MIN, minutes: x.to - x.from, kind: 'unlinked' })
    })
    outages.sort(function (x, y) { return y.from - x.from })

    return {
      stats: s,
      history: {
        coverageFrom: coverage === null ? null : coverage * MIN,
        bucketMinutes: bucketMinutes,
        buckets: buckets,
        windows: windows,
        outages: outages.slice(0, 20),
        boots: bootList.filter(function (m) { return m >= endMin - days * DAY_MIN && m < endMin }).map(function (m) { return m * MIN }),
        daemonStarts: countFrom(startList, endMin - days * DAY_MIN),
      },
      ledger: { lastWriteAt: lastWriteAt, writeErrors: writeErrors, lastError: lastError },
    }
  }

  return { start: start, stop: stop, tick: tick, stats: stats, vitals: vitals, parseMeminfo: parseMeminfo, parseVmStat: parseVmStat }
}
