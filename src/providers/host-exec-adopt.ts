/**
 * Detached host_exec runs an earlier daemon here started, followed from here once it is gone: their
 * deadline, a stop, a wait_for and their end line work as if this daemon had started them
 * (host-exec-core.ts, detached-run.ts).
 *
 * What a run is adopted from is its registry entry (detached-registry.ts, `<dir>/host-exec-<id>.run`):
 * written at the spawn with the run's start line, its wrapper's pid, then its start time once ps named
 * it, the daemon that follows it and why a stop of it began. The audit only records; its tail
 * (host-exec-recall.ts) still covers the few ms between the spawn and the entry's first write, so a
 * run is adopted from whichever names it. A run whose start line left the audit's tail (a busy host,
 * a run of hours) is still adopted from its entry (2026-11-21, the lead's ask: the registry decides).
 *
 * The wrapper is signalled only while the process at its pid started when the listed one did; ps with
 * no answer is unknown (asked again from the timer, never on a caller's path); a run with no start ever
 * recorded is followed, never signalled, and let go past its deadline.
 */
import type { ChildProcess } from 'node:child_process'
import { detachedChild } from './detached-run.js'
import { ROLLBACK_NOTE, installStopScript, readRegistry, registerRun, unregisterRun, type RegistryEntry } from './detached-registry.js'
import type { Job } from './host-exec-job.js'
import { jobFromAudit, type Orphan, type createRecall } from './host-exec-recall.js'

type StopWhy = 'timeout' | 'asked' | 'blocked' | 'daemon'
type Line = Record<string, unknown>

export interface AdoptDeps {
  recall: ReturnType<typeof createRecall>
  jobs: Map<string, Job>
  /** Runs still starting (or being adopted): reads and stops of them wait. */
  starting: Map<string, Promise<void>>
  audit: (line: Line) => void
  follow: (job: Job, child: ChildProcess, who: { task: string | null; host: string | null }, endGroup: boolean, line: string, fd: number | null, allowPrompts: boolean) => Promise<void>
  stop: (j: Job, why: StopWhy) => void
  processStart: (pid: number) => Promise<string | null>
  pidAlive: (pid: number) => boolean
  now: () => number
  logSize: (file: string) => number
  registryDir: string
  auditFile: string
  stateDir: string
  taskDirRoot: string | null
  defaultTimeoutMs: number
  outputMaxBytes: number
  /** How long a read or stop of a run waits for its adoption before it answers what the audit says. */
  adoptWaitMs: number
  selfPid: number
}

export function createAdopter(d: AdoptDeps) {
  const adopting = new Map<string, Promise<void>>()
  const deferred = new Set<string>()
  // The entry each detached run here has in the registry (written whole on every change).
  const regs = new Map<string, RegistryEntry>()
  // The registry's runs the audit's tail no longer names, as last read (scan).
  let fromRegistry: Orphan[] = []
  // Runs whose recorded owner's pid another program holds now (its start differs from the entry's).
  let ownerReused = new Set<string>()
  let stopScriptPut = false
  // This daemon's own start, written beside its pid as the owner of what it follows.
  let selfStart: string | undefined
  const selfStarted = d.processStart(d.selfPid).then((s) => { selfStart = s ?? undefined }, () => {})

  const put = (e: RegistryEntry): void => { if (regs.get(e.id) === e) void registerRun(d.registryDir, e) }
  const rollbackLine = (id: string, taskId: string | null): string =>
    JSON.stringify({ at: new Date(d.now()).toISOString(), event: 'ended-by-update', jobId: id, taskId, reason: 'rollback' })
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

  /** Reads the registry again: the runs it lists that the audit's tail does not, and no live daemon follows. */
  async function scan(): Promise<void> {
    const out: Orphan[] = []
    const reused = new Set<string>()
    for (const e of await readRegistry(d.registryDir, 'host-exec')) {
      if (!e.start) continue
      let start: Line
      try { start = JSON.parse(e.start) as Line } catch { continue }
      if (start.event !== 'start' || start.jobId !== e.id || start.detach !== true) continue
      const owner = e.owner ?? num(start.daemonPid)
      if (owner !== null && owner !== d.selfPid && d.pidAlive(owner)) {
        // A live owner is the run's unless its pid is another program's now (a restart long ago).
        if (!e.ownerStart) continue
        const now = await d.processStart(owner)
        if (now === null || now === e.ownerStart) continue
        reused.add(e.id)
      }
      if (d.recall.knows(e.id)) continue
      out.push({ jobId: e.id, start, pid: e.pid, lstart: e.lstart || null, stopping: e.stopping ?? null, blocked: null })
    }
    fromRegistry = out
    ownerReused = reused
  }

  /**
   * Starts the adoption of every orphan not yet followed. One whose adoption ps left for later
   * (`deferred`) is asked again only from the timer (`retry`), never on a caller's path: a slow ps
   * must not slow every read on the host (2026-11-21 review R2-1).
   */
  function adoptOrphans(retry = false): void {
    const skip = (id: string) => d.jobs.has(id) || adopting.has(id) || d.starting.has(id) || (!retry && deferred.has(id))
    let found: Orphan[] = []
    try { found = d.recall.orphans(skip, (id) => ownerReused.has(id)) } catch { /* the audit is unreadable: none */ }
    const named = new Set(found.map((o) => o.jobId))
    for (const o of fromRegistry) if (!named.has(o.jobId) && !skip(o.jobId) && !d.recall.knows(o.jobId)) found.push(o)
    for (const o of found) {
      // In the map before it runs (an adoption that never awaits settles inside the call), and it
      // never rejects: the daemon holds every session on the host.
      const p: Promise<void> = Promise.resolve().then(() => adopt(o)).catch((err) => {
        d.audit({ event: 'adopt-failed', jobId: o.jobId, error: (err as Error)?.message ?? String(err) })
      }).finally(() => { if (adopting.get(o.jobId) === p) adopting.delete(o.jobId) })
      adopting.set(o.jobId, p)
    }
  }

  /**
   * Adopts what is left, then waits for the adoption of `jobId` alone, at most until `by` (an epoch
   * ms). A run neither this daemon nor the audit's tail knows is looked for in the registry first.
   */
  async function adoptedFirst(jobId: unknown, by?: number): Promise<void> {
    const id = typeof jobId === 'string' ? jobId : null
    if (id !== null && !d.jobs.has(id) && !d.starting.has(id) && !adopting.has(id) && !d.recall.knows(id)) await scan().catch(() => {})
    adoptOrphans()
    const p = id !== null ? adopting.get(id) : undefined
    if (!p) return
    const left = by === undefined ? d.adoptWaitMs : Math.min(d.adoptWaitMs, by - d.now())
    if (left <= 0) return
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, left)
      t.unref?.()
      void p.then(() => { clearTimeout(t); resolve() })
    })
  }

  async function adopt(o: Orphan): Promise<void> {
    // Reads and stops of it wait for this (as for a run still starting), never answering it ended.
    let settle = () => {}
    const held = new Promise<void>((resolve) => { settle = resolve })
    d.starting.set(o.jobId, held)
    try {
      const base = jobFromAudit(o.jobId, o.start, null, o.blocked, false, { stateDir: d.stateDir, taskDirRoot: d.taskDirRoot, defaultTimeoutMs: d.defaultTimeoutMs })
      if (!base?.detached) return
      const exitFile = base.detached.exitFile
      // Its wrapper still holds its pid when the process there started when the listed one did (the
      // audit's `listed` line, else the registry). ps with no answer is unknown: left for the next
      // look, never taken as killed (the run reads running meanwhile, host-exec-recall.ts).
      const listed = o.lstart ?? (await readRegistry(d.registryDir, 'host-exec')).find((e) => e.id === o.jobId)?.lstart ?? null
      let wrapperHere = d.pidAlive(o.pid)
      let verified = false
      if (wrapperHere && listed) {
        const nowStart = await d.processStart(o.pid)
        if (nowStart === null) {
          if (d.pidAlive(o.pid)) {
            // Said once in the audit (the reason it is not followed yet), then asked again every look.
            if (!deferred.has(o.jobId)) { deferred.add(o.jobId); d.audit({ event: 'adopt-deferred', jobId: o.jobId, pid: o.pid, why: 'ps gave no start' }) }
            return
          }
          wrapperHere = false
        } else {
          verified = nowStart === listed
          wrapperHere = verified
        }
      }
      // No start was ever recorded (its daemon died right after the spawn): followed, never signalled,
      // since that pid may be another program's by now; past its deadline it is let go.
      const deadline = base.startedAt + base.timeoutMs + 60_000
      const job: Job = {
        ...base, pid: verified ? o.pid : null, endedAt: null, shellExitedAt: null, exitCode: null, signal: null,
        bytes: d.logSize(base.logFile), tailMax: d.outputMaxBytes,
        timedOut: o.stopping === 'timeout', killed: o.stopping === 'asked', ...(o.stopping ? { signalled: true as const } : {}),
      }
      delete job.daemonEnded
      // Followed but never signalled: its reads say a stop cannot reach it.
      if (wrapperHere && !verified) job.unverified = true
      d.jobs.set(o.jobId, job)
      deferred.delete(o.jobId)
      fromRegistry = fromRegistry.filter((x) => x.jobId !== o.jobId)
      d.audit({ event: 'adopted', jobId: o.jobId, daemonPid: d.selfPid, ...(job.unverified ? { unverified: true } : {}) })
      // Its entry names this daemon as the one that follows it now.
      const entry: RegistryEntry = {
        kind: 'host-exec', id: o.jobId, pid: o.pid, pgid: o.pid, lstart: verified ? listed! : '',
        noteFile: base.logFile, note: `[walnut] ${ROLLBACK_NOTE}`, lineFile: d.auditFile, line: rollbackLine(o.jobId, base.taskId),
        start: JSON.stringify(o.start), owner: d.selfPid, ...(selfStart ? { ownerStart: selfStart } : {}), ...(o.stopping ? { stopping: o.stopping } : {}),
      }
      regs.set(o.jobId, entry)
      put(entry)
      const str = (v: unknown) => (typeof v === 'string' ? v : null)
      const wrapperAlive = () => {
        if (!wrapperHere || !d.pidAlive(o.pid)) return false
        if (verified || d.now() < deadline) return true
        // Past its deadline an unverified run is let go: nothing signalled it, and it may still run.
        job.endedBy = 'let-go'
        return false
      }
      const child = detachedChild({ exitFile, wrapperAlive, killedBy: () => (job.endedBy === 'let-go' ? null : 'SIGKILL'), signalled: () => job.signalled === true })
      void d.follow(job, child, { task: str(o.start.task), host: str(o.start.host) }, true, String(o.start.command ?? ''), null, o.start.allowPrompts === true)
      // A stop the last daemon began goes on (its SIGKILL may never have gone out).
      if (verified && (o.stopping === 'timeout' || o.stopping === 'asked' || o.stopping === 'blocked')) d.stop(job, o.stopping)
    } finally {
      if (d.starting.get(o.jobId) === held) d.starting.delete(o.jobId)
      settle()
    }
  }

  /** A detached run just spawned here: its entry, written now (no start time yet), then again once ps named it. */
  function track(job: Job, start: Line): void {
    if (job.pid === null) return
    if (!stopScriptPut) { stopScriptPut = true; void installStopScript(d.registryDir) }
    const entry: RegistryEntry = {
      kind: 'host-exec', id: job.id, pid: job.pid, pgid: job.pid, lstart: '',
      noteFile: job.logFile, note: `[walnut] ${ROLLBACK_NOTE}`, lineFile: d.auditFile, line: rollbackLine(job.id, job.taskId),
      start: JSON.stringify(start), owner: d.selfPid, ...(selfStart ? { ownerStart: selfStart } : {}),
    }
    regs.set(job.id, entry)
    put(entry)
    void Promise.all([d.processStart(job.pid), selfStarted]).then(([lstart]) => {
      if (!lstart || job.endedAt !== null || regs.get(job.id) !== entry) return
      if (selfStart) entry.ownerStart = selfStart
      // The start a later daemon checks before it adopts or signals this pid (host-exec-recall.ts `listed`).
      d.audit({ event: 'listed', jobId: job.id, pid: job.pid, lstart })
      entry.lstart = lstart
      put(entry)
    })
  }

  /** A stop of a detached run began: its entry says why, for the daemon that may follow it next. */
  function stopping(id: string, why: StopWhy): void {
    const e = regs.get(id)
    if (!e) return
    e.stopping = why
    put(e)
  }

  /** The run ended (its end line is in the audit): its entry has done its work. */
  function ended(id: string): void {
    if (!regs.delete(id)) return
    void unregisterRun(d.registryDir, 'host-exec', id)
  }

  adoptOrphans(true)
  void scan().catch(() => {}).finally(() => adoptOrphans(true))
  // A handover overlaps two daemons for a moment: what the other still followed is taken once it is
  // gone; and what ps left for later is asked again here.
  const timer = setInterval(() => { void scan().catch(() => {}).finally(() => adoptOrphans(true)) }, 2_000)
  timer.unref?.()

  return { adoptOrphans, adoptedFirst, track, stopping, ended, close: () => clearInterval(timer) }
}
