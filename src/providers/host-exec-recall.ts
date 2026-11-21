/**
 * A host_exec job this daemon does not hold, read back from the host's audit file
 * (`<state dir>/host-exec-audit.jsonl`, host-exec-core.ts writes one start and one end line per
 * run). 2026-11-16: a task's Playwright run on a dev box ended (exit 0, its done line printed),
 * then the daemon was updated; the new daemon held its jobs only in memory, so every read of
 * that finished run answered 404 `unknown_job` although its log and its end line were on disk,
 * and the task's wait loop asked again every 15 s for half an hour.
 *
 * A job read back here answers as it did before the swap: its exit, its log, a wait_for over
 * its output, for as long as a finished job is kept (KEEP_FINISHED_MS after it ended). One with
 * a start line and no end line was running when the daemon that ran it stopped (a forced update
 * or a crash), and so was one a forced update stopped: it reads `running: false` with
 * `daemonEnded`, its end at the last write to its log, unless the daemon that wrote its start line
 * (`daemonPid`) still runs, whose run it is to answer. It is never counted as running (`running()`,
 * exec-runs-hold.ts), so it never holds an update.
 *
 * A run started detached (detached-run.ts: a start line with `detach`) is not ended by its daemon's
 * going: it runs on, writing its own log and exit file. `orphans()` names such a run once the daemon
 * that follows it (`daemonPid`, or the last `adopted` line's) is gone, so the next daemon adopts it
 * (host-exec-core.ts) instead of reading it as ended. `stopping` lines say why it was signalled, an
 * `ended-by-update` line with `reason: 'rollback'` that a rollback stopped it.
 *
 * Bundled into host-exec-core (the binary daemon and the host-exec-core.cjs sidecar).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { PromptBlock } from './host-exec-watch.js'
import type { Job } from './host-exec-job.js'

/** Only the audit's last part is read: far more runs than a daemon keeps (MAX_JOBS) fit in it. */
export const RECALL_TAIL_BYTES = 1024 * 1024
const JOB_ID_RE = /^hx-[A-Za-z0-9_-]{4,64}$/
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export interface RecallDeps {
  /** The audit file (host-exec-core.ts `audit`). */
  auditFile: string
  /** The daemon's state dir: where a run with no task keeps its log. */
  stateDir: string
  /** Where task directories live on this host, for an audit line older than its `logFile` field. */
  taskDirRoot: string | null
  /** How long a finished job is kept. */
  keepMs: number
  /** The deadline of a run whose start line names none. */
  defaultTimeoutMs: number
  now: () => number
  /** This daemon's pid, and whether another pid still runs: a run whose daemon still lives is that daemon's to answer. */
  selfPid: number
  alive: (pid: number) => boolean
  /** A detached run that ended and is forgotten now: its exit file can go (the daemon that wrote it may be gone). */
  forgetEnded?: (job: Job) => void
}

type Line = Record<string, unknown>

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const time = (v: unknown): number | null => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : null
}

function mtime(file: string): number | null {
  try { return fs.statSync(file).mtimeMs } catch { return null }
}

/** Where the run kept its log: the start line says so since this file; an older line, as host-exec-core.ts named it. */
function logOf(start: Line, jobId: string, task: string | null, d: Pick<RecallDeps, 'stateDir' | 'taskDirRoot'>): { logFile: string; taskDir: string | null } {
  const named = str(start.logFile)
  const guess = d.taskDirRoot && task && TASK_ID_RE.test(task) ? path.join(d.taskDirRoot, task) : null
  const taskDir = 'taskDir' in start ? str(start.taskDir) : guess && fs.existsSync(guess) ? guess : null
  if (named) return { logFile: named, taskDir }
  const inTask = taskDir ? path.join(taskDir, 'host-exec', `${jobId}.log`) : null
  if (inTask && fs.existsSync(inTask)) return { logFile: inTask, taskDir }
  return { logFile: path.join(d.stateDir, 'host-exec', `${jobId}.log`), taskDir }
}

/** The run a start line (and its end line, if any) tells, as a job; exported for a detached run's adoption (host-exec-core.ts). */
export function jobFromAudit(jobId: string, start: Line, end: Line | null, blocked: PromptBlock | null, byUpdate: boolean, d: Pick<RecallDeps, 'stateDir' | 'taskDirRoot' | 'defaultTimeoutMs'>, byRollback = false): Job | null {
  const startedAt = num(start.startedAt) ?? time(start.at)
  if (startedAt === null) return null
  // Its shell never started (spawn_failed: an end line with only the error): there is no run to read.
  if (end && !('ms' in end) && typeof end.error === 'string') return null
  // The task that may read it: the start line names it since this file; before, the caller's task, the same one.
  const taskId = 'taskId' in start ? str(start.taskId) : str(start.task)
  const { logFile, taskDir } = logOf(start, jobId, taskId, d)
  // No end line, or one written as a forced update stopped it (endForUpdate): its daemon went first.
  const daemonEnded = end === null || byUpdate
  // Its end as the daemon that ran it measured it (`ms`), else as the end line's time says.
  const endedAt = end ? (num(end.ms) !== null ? startedAt + (end.ms as number) : time(end.at)) : Math.max(startedAt, mtime(logFile) ?? startedAt)
  if (endedAt === null) return null
  const left = end?.leftBehind
  return {
    id: jobId, pid: null, startedAt, endedAt, shellExitedAt: endedAt,
    exitCode: end ? num(end.exitCode) : null, signal: end ? str(end.signal) : null,
    // A stop the update made is no host_exec_stop (host-exec-answers.ts words `killed` so).
    timedOut: end?.timedOut === true, killed: end?.killed === true && !byUpdate,
    cwd: str(start.cwd) ?? '', logFile, taskId,
    shell: str(start.shell) ?? '', loginShell: str(start.loginShell) ?? '', taskDir,
    command: (str(start.command) ?? '').slice(0, 200),
    blocked: end && typeof end.blocked === 'string' ? blocked : null,
    leftBehind: left !== undefined && left !== false,
    ...(Array.isArray(left) ? { leftCommands: left.filter((c): c is string => typeof c === 'string') } : {}),
    outputCut: end?.outputCut === true,
    timeoutMs: num(start.timeoutMs) ?? d.defaultTimeoutMs,
    before: { ports: [], files: [] }, unwatch: null, stopLeft: null,
    bytes: end ? (num(end.bytes) ?? 0) : (() => { try { return fs.statSync(logFile).size } catch { return 0 } })(),
    tail: [], tailBytes: 0, tailMax: 0, waiters: [], timer: null, waits: 0,
    ...(daemonEnded ? { daemonEnded: true as const } : {}),
    ...(start.resumable === true ? { resumable: true as const } : {}),
    ...(start.detach === true && typeof start.exitFile === 'string' ? { detached: { exitFile: start.exitFile } } : {}),
    ...(byRollback || end?.endedBy === 'rollback' ? { endedBy: 'rollback' as const } : end?.endedBy === 'let-go' ? { endedBy: 'let-go' as const } : {}),
  }
}

interface Run {
  start: Line
  end: Line | null
  blocked: PromptBlock | null
  byUpdate: boolean
  job?: Job | null
  /** A detached run's wrapper (its `spawned` line), and the daemon that follows it now (`adopted`). */
  pid?: number
  owner?: number
  /** What ps named as the wrapper's start (its `listed` line, UTC): adoption signals only that process. */
  lstart?: string
  /** Why it was last signalled (`stopping`): timeout, asked, blocked, daemon. */
  stopping?: string
  /** A rollback stopped it (`ended-by-update` with `reason: 'rollback'`). */
  byRollback?: boolean
}

/** A detached run no live daemon follows: what its adoption needs. */
export interface Orphan { jobId: string; start: Line; pid: number; lstart: string | null; stopping: string | null; blocked: PromptBlock | null }

export function createRecall(d: RecallDeps) {
  // The runs the audit names, by id (a later start of the same id replaces an earlier one), kept
  // as the file grows: each look reads only what was appended since the last one (one stat when
  // nothing was), so a read loop never re-parses the file on the daemon's event loop.
  const runs = new Map<string, Run>()
  let taken = 0
  let ino = -1
  let carry = ''
  function apply(raw: string): void {
    if (!raw) return
    let line: Line
    try { line = JSON.parse(raw) as Line } catch { return }
    const id = str(line.jobId)
    if (!id || !JOB_ID_RE.test(id)) return
    if (line.event === 'start') { runs.set(id, { start: line, end: null, blocked: null, byUpdate: false }); return }
    const run = runs.get(id)
    if (!run || run.end) return
    if (line.event === 'end') { run.end = line; run.job = undefined }
    else if (line.event === 'ended-by-update') { run.byUpdate = true; if (line.reason === 'rollback') run.byRollback = true }
    else if (line.event === 'spawned') { const pid = num(line.pid); if (pid !== null && pid > 1) run.pid = pid }
    else if (line.event === 'adopted') { const pid = num(line.daemonPid); if (pid !== null) run.owner = pid }
    else if (line.event === 'listed') { const s = str(line.lstart); if (s) run.lstart = s }
    else if (line.event === 'stopping' && typeof line.why === 'string') run.stopping = line.why
    else if (line.event === 'blocked' && (line.reason === 'password_prompt' || line.reason === 'permission_prompt')) {
      run.blocked = { reason: line.reason, service: str(line.service) ?? '' }
    }
  }
  function take(): void {
    let st: fs.Stats
    try { st = fs.statSync(d.auditFile) } catch { runs.clear(); taken = 0; ino = -1; carry = ''; return }
    // A new or shorter file starts over.
    if (st.ino !== ino || st.size < taken) { runs.clear(); ino = st.ino; taken = 0; carry = '' }
    if (st.size === taken) return
    // Only the last RECALL_TAIL_BYTES are worth reading (first look, or a burst bigger than that).
    let cut = false
    if (st.size - taken > RECALL_TAIL_BYTES) { taken = st.size - RECALL_TAIL_BYTES; carry = ''; cut = true }
    const buf = Buffer.alloc(st.size - taken)
    try {
      const fd = fs.openSync(d.auditFile, 'r')
      try { fs.readSync(fd, buf, 0, buf.length, taken) } finally { fs.closeSync(fd) }
    } catch { return }
    taken = st.size
    const lines = (carry + buf.toString('utf8')).split('\n')
    carry = lines.pop() ?? ''
    if (cut) lines.shift()
    for (const raw of lines) apply(raw)
    // A run past its deadline and the hour after it is never answered again.
    const t = d.now()
    for (const [id, r] of runs) {
      const at = num(r.start.startedAt) ?? time(r.start.at) ?? 0
      if (t - at > (num(r.start.timeoutMs) ?? d.defaultTimeoutMs) + d.keepMs + 60_000) {
        runs.delete(id)
        if (r.end && r.start.detach === true && d.forgetEnded) {
          const j = jobFromAudit(id, r.start, r.end, r.blocked, r.byUpdate, d, r.byRollback)
          if (j) d.forgetEnded(j)
        }
      }
    }
  }
  /** The run as a job: one that ended is built once; one with no end line again, as its log grows. */
  function jobFor(id: string, r: Run): Job | null {
    if (r.job !== undefined) return r.job
    // Still running under another daemon here (two at once, or one not yet gone in a swap): not ours to call ended.
    const owner = r.owner ?? num(r.start.daemonPid)
    const ownerHere = owner !== null && owner !== d.selfPid && d.alive(owner)
    // A detached run whose wrapper is still there (followed by the other daemon, or not adopted yet):
    // it runs, never "the daemon stopped first", or its caller would run it again.
    if (!r.end && !r.byUpdate && r.start.detach === true && (ownerHere || (r.pid !== undefined && d.alive(r.pid)))) return runningOf(id, r)
    if (!r.end && ownerHere) return null
    const j = jobFromAudit(id, r.start, r.end, r.blocked, r.byUpdate, d, r.byRollback)
    if (r.end) r.job = j
    return j
  }
  /** A detached run still going that this daemon does not follow (yet): read from its log, no pid to signal. */
  function runningOf(id: string, r: Run): Job | null {
    const j = jobFromAudit(id, r.start, null, r.blocked, false, d)
    if (!j) return null
    const { daemonEnded: _gone, ...rest } = j
    return { ...rest, endedAt: null, shellExitedAt: null, exitCode: null, signal: null, notFollowed: true }
  }
  const kept = (j: Job | null): j is Job => j !== null && (j.endedAt === null ? j.notFollowed === true : d.now() - j.endedAt <= d.keepMs)
  return {
    /** The run `jobId` as the audit tells it, while a finished job is kept; else undefined. */
    get(jobId: string): Job | undefined {
      take()
      const r = runs.get(jobId)
      const j = r ? jobFor(jobId, r) : null
      return kept(j) ? j : undefined
    },
    /** Whether the audit's tail names the run `jobId` (its start line is there). */
    knows(jobId: string): boolean {
      take()
      return runs.has(jobId)
    },
    /**
     * Detached runs with no end line that no live daemon follows (its owner is gone, or is this
     * process: a daemon made again in it), but the ones `skip` names. A run a rollback or a forced
     * update stopped is not one: it is ending, or ended.
     */
    orphans(skip: (jobId: string) => boolean, ownerGone: (jobId: string) => boolean = () => false): Orphan[] {
      take()
      const out: Orphan[] = []
      for (const [id, r] of runs) {
        if (r.end || r.byUpdate || r.start.detach !== true || r.pid === undefined || skip(id)) continue
        const owner = r.owner ?? num(r.start.daemonPid)
        // `ownerGone`: the registry says another program holds that pid now (its start differs).
        if (owner !== null && owner !== d.selfPid && d.alive(owner) && !ownerGone(id)) continue
        out.push({ jobId: id, start: r.start, pid: r.pid, lstart: r.lstart ?? null, stopping: r.stopping ?? null, blocked: r.blocked })
      }
      return out
    },
    list(skip: (jobId: string) => boolean): Job[] {
      take()
      const out: Job[] = []
      for (const [id, r] of runs) {
        if (skip(id)) continue
        const j = jobFor(id, r)
        if (kept(j)) out.push(j)
      }
      return out
    },
  }
}
