/**
 * A host_exec job on a Mac found waiting at a dialog (host-exec-core.ts stops it and says
 * `blocked`). 2026-11-03, on a user's Mac: `security show-keychain-info` sat at a SecurityAgent
 * password dialog, and `du -sk ~/Library/Caches` sat for 7 minutes at 0.01 s of CPU while tccd
 * showed a permission dialog (AUTHREQ_PROMPTING kTCCServiceMediaLibrary) on her screen.
 * host-exec-guards.ts refuses what it can see in the line; this catches the rest at run time.
 *
 * ONE watcher per daemon looks at every watched job each IDLE_WINDOW_MS, with one `ps` for all
 * of them and at most one log read. A job is stopped only on evidence tied to it:
 *   - idle (its processes used under IDLE_CPU_MS since the last look, the same processes), and
 *   - a SecurityAgent that started after the job while a program that can ask for a keychain
 *     item or a password runs in its group (`security`, `codesign`, `sudo`, ...), or
 *   - a tccd prompt whose AUTHREQ_ATTRIBUTION names one of its processes as the accessor.
 * 2026-11-03 review: any SecurityAgent stopped any idle job (the owner unlocking a System Settings
 * pane stopped `python3 -m http.server` and `ssh -N`), and every job read `ps -A` and the log on
 * its own. Never a keychain read. The probes are injected (tests use fakes); the defaults are
 * bounded, asynchronous `ps` and `/usr/bin/log show` calls.
 */
import path from 'node:path'
import { execFile } from 'node:child_process'

/** A job's window of this long with less CPU than IDLE_CPU_MS is idle. */
export const IDLE_WINDOW_MS = 20_000
export const IDLE_CPU_MS = 100
const PROBE_TIMEOUT_MS = 8_000
/** A log read reaches back this far before the previous one, so nothing between two reads is missed. */
const LOG_OVERLAP_MS = 2_000
/** A job seen idle for the first time reads the log this many windows back (its dialog came up as it stopped). */
const LOG_LOOKBACK_WINDOWS = 3
/** A job idle look after look reads the log again every this many looks, from where its last read ended. */
const IDLE_REREAD_LOOKS = 3

/** Programs that can put up a SecurityAgent dialog: a keychain item, a signing key, an admin password. */
export const KEYCHAIN_PROGRAMS = new Set([
  'security', 'osascript', 'sudo', 'su', 'login', 'codesign', 'productsign', 'productbuild', 'pkgbuild',
  'notarytool', 'altool', 'git-credential-osxkeychain', 'ssh-add', 'security_authtrampoline', 'authopen',
  'installer', 'sysadminctl', 'fdesetup', 'profiles', 'kinit',
])

export interface ProcessRow { pid: number; pgid: number; cpuMs: number; comm: string }

/** One look at the processes (null when ps could not be read), and when SecurityAgent started (null: not running). */
export interface ProcessTable { processes: ProcessRow[] | null; securityAgentStartedAt: number | null }

export interface PromptProbe {
  /** The processes of these process groups, read with one `ps` for all of them. */
  snapshot: (pgids: number[]) => Promise<ProcessTable>
  /** tccd's AUTHREQ_PROMPTING and AUTHREQ_ATTRIBUTION lines since `sinceMs`; null when the log could not be read. */
  tccPrompts: (sinceMs: number) => Promise<string[] | null>
}

export interface PromptBlock { reason: 'password_prompt' | 'permission_prompt'; service: string }

/** `pid=<n>` as a whole number in `text` (pid=412 is not pid=4123). */
function hasPid(text: string, pid: number): boolean {
  return new RegExp(`\\bpid=${pid}(?!\\d)`).test(text)
}

/** The TCC service a tccd prompt shows for one of `pids` (its attribution, same msgID, names it as the accessor), or null. */
export function tccServiceFor(lines: string[], pids: number[]): string | null {
  const accessors = new Map<string, string>()
  for (const line of lines) {
    if (!line.includes('AUTHREQ_ATTRIBUTION')) continue
    const id = /msgID=([\w.:-]+)/.exec(line)?.[1]
    const accessing = /accessing=\{([^}]*)/.exec(line)?.[1]
    if (id && accessing) accessors.set(id, `${accessors.get(id) ?? ''} ${accessing}`)
  }
  for (const line of lines) {
    if (!line.includes('AUTHREQ_PROMPTING')) continue
    const id = /msgID=([\w.:-]+)/.exec(line)?.[1]
    const accessing = id ? accessors.get(id) : undefined
    if (accessing && pids.some((pid) => hasPid(accessing, pid))) return /service=(kTCCService\w+)/.exec(line)?.[1] ?? 'kTCCService'
  }
  return null
}

interface Watched {
  pgid: number
  startedAt: number
  watchedAt: number
  onBlocked: (block: PromptBlock) => void
  last: { pids: string; cpu: Map<number, number> } | null
  idleLooks: number
  loggedUntil: number
}

/** The daemon's one watcher: `watch` a job until it ends (call what it returns) or is found blocked. */
export function createPromptWatcher(probe: PromptProbe, opts: { everyMs?: number; now?: () => number } = {}) {
  const now = opts.now ?? Date.now
  const every = opts.everyMs ?? IDLE_WINDOW_MS
  const jobs = new Set<Watched>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let looking = false

  const schedule = () => {
    if (timer || jobs.size === 0) return
    timer = setTimeout(() => { timer = null; void check().finally(schedule) }, every)
    timer.unref?.()
  }
  const stopIfIdle = () => { if (jobs.size === 0 && timer) { clearTimeout(timer); timer = null } }
  const fire = (job: Watched, block: PromptBlock) => {
    if (!jobs.delete(job)) return
    stopIfIdle()
    job.onBlocked(block)
  }

  /** One look at every job watched for a window or more. */
  async function check(): Promise<void> {
    if (looking) return
    const t = now()
    // A timer may fire a moment before the clock agrees a window passed.
    const due = [...jobs].filter((j) => t - j.watchedAt >= every * 0.9)
    if (due.length === 0) return
    looking = true
    try {
      const table = await probe.snapshot(due.map((j) => j.pgid)).catch((): ProcessTable => ({ processes: null, securityAgentStartedAt: null }))
      if (!table.processes) return
      const groups = new Map<number, ProcessRow[]>()
      for (const p of table.processes) groups.set(p.pgid, [...(groups.get(p.pgid) ?? []), p])
      const suspects: Array<{ job: Watched; pids: number[] }> = []
      for (const job of due) {
        if (!jobs.has(job)) continue
        const group = groups.get(job.pgid) ?? []
        if (group.length === 0) { job.last = null; job.idleLooks = 0; continue }
        const pids = group.map((p) => p.pid).sort((a, b) => a - b)
        const key = pids.join(',')
        const last = job.last
        const used = last === null
          ? group.reduce((n, p) => n + p.cpuMs, 0)
          // Processes that came or went did something; the same ones are judged by what each used since.
          : last.pids !== key ? Number.POSITIVE_INFINITY : group.reduce((n, p) => n + Math.max(0, p.cpuMs - (last.cpu.get(p.pid) ?? 0)), 0)
        job.last = { pids: key, cpu: new Map(group.map((p) => [p.pid, p.cpuMs])) }
        if (used >= IDLE_CPU_MS) { job.idleLooks = 0; continue }
        job.idleLooks++
        const agentAt = table.securityAgentStartedAt
        if (agentAt !== null && agentAt >= job.startedAt - 1_000 && group.some((p) => KEYCHAIN_PROGRAMS.has(path.posix.basename(p.comm)))) {
          fire(job, { reason: 'password_prompt', service: 'SecurityAgent' })
          continue
        }
        if (job.idleLooks === 1 || job.idleLooks % IDLE_REREAD_LOOKS === 0) suspects.push({ job, pids })
      }
      if (suspects.length === 0) return
      const floor = t - LOG_LOOKBACK_WINDOWS * every
      const since = Math.min(...suspects.map((s) => Math.max(s.job.loggedUntil, floor))) - LOG_OVERLAP_MS
      const lines = await probe.tccPrompts(since).catch(() => null)
      if (!lines) return
      for (const { job, pids } of suspects) {
        job.loggedUntil = t
        const service = tccServiceFor(lines, pids)
        if (service) fire(job, { reason: 'permission_prompt', service })
      }
    } finally {
      looking = false
    }
  }

  function watch(job: { pgid: number; startedAt: number }, onBlocked: (block: PromptBlock) => void): () => void {
    const entry: Watched = { ...job, watchedAt: now(), onBlocked, last: null, idleLooks: 0, loggedUntil: job.startedAt }
    jobs.add(entry)
    schedule()
    return () => { jobs.delete(entry); stopIfIdle() }
  }

  return { watch, check, watching: () => jobs.size }
}

/** `ps` TIME or ELAPSED (`[[dd-]hh:]mm:ss[.ss]`) in ms; null when it is not one. */
export function psDurationMs(text: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim())
  if (!m) return null
  const [, d, h, min, sec] = m
  return Math.round((((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(min)) * 60 + Number(sec)) * 1000)
}

/** One `ps -A -o pid= -o pgid= -o etime= -o time= -o comm=` table, for the groups in `pgids`. */
export function readSnapshot(psOut: string, pgids: number[], nowMs: number): ProcessTable {
  const wanted = new Set(pgids)
  const processes: ProcessRow[] = []
  let agentAt: number | null = null
  for (const row of psOut.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(row)
    if (!m) continue
    const comm = m[5].trim()
    const pgid = Number(m[2])
    if (wanted.has(pgid)) {
      const t = psDurationMs(m[4])
      if (t !== null) processes.push({ pid: Number(m[1]), pgid, cpuMs: t, comm })
    }
    if (path.posix.basename(comm) === 'SecurityAgent') {
      const age = psDurationMs(m[3])
      if (age !== null) agentAt = Math.max(agentAt ?? 0, nowMs - age)
    }
  }
  return { processes, securityAgentStartedAt: agentAt }
}

/** `log show --start` takes the host's local time. */
function localStamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 << 20 }, (err, stdout) => resolve(err ? null : String(stdout)))
  })
}

/** The probes on a Mac: one bounded `ps`, and the unified log read through /usr/bin/log (never zsh's `log`). */
export function macPromptProbe(now: () => number = Date.now): PromptProbe {
  return {
    snapshot: async (pgids) => {
      const out = await run('/bin/ps', ['-A', '-o', 'pid=', '-o', 'pgid=', '-o', 'etime=', '-o', 'time=', '-o', 'comm='])
      return out === null ? { processes: null, securityAgentStartedAt: null } : readSnapshot(out, pgids, now())
    },
    tccPrompts: async (sinceMs) => {
      const out = await run('/usr/bin/log', ['show', '--style', 'compact', '--start', localStamp(sinceMs),
        '--predicate', 'process == "tccd" AND (eventMessage CONTAINS "AUTHREQ_PROMPTING" OR eventMessage CONTAINS "AUTHREQ_ATTRIBUTION")'])
      return out === null ? null : out.split('\n').filter((l) => l.includes('AUTHREQ_'))
    },
  }
}
