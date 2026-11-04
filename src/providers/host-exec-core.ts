/**
 * The host side of `host_exec` (src/core/hosts/host-exec.ts): run one command
 * on THIS host for a task on another host, with the user's login environment,
 * and hand back its exit code and output (the user, 2026-10-31: "use the Mac's
 * login", so a task on a Linux box runs `gh` or `xcodebuild` here and no token
 * ever leaves this machine).
 *
 * The server decides WHETHER a command may run (the user's grant for the task
 * and host, the read-only gh rule, the concurrency caps); this file only runs
 * it, bounded: a foreground run is killed with its whole process group at its
 * deadline (10 min at most), a background one at 2 h; the output is kept in a
 * log file in the caller task's directory on this host and only its tail (256
 * KB at most) rides the reply; every run is one start and one end line in
 * `<state dir>/host-exec-audit.jsonl`.
 *
 * Which shell, the line from `command` or `argv`, its cwd, and the output read back as whole lines:
 * host-exec-line.ts (host-exec-v2: the login shell, then bash). The child gets WALNUT_TASK_DIR, the caller task's directory here
 * (src/lib/task-dir.ts), where its logs are kept too. Every reply names the shell, the login
 * shell and the task directory.
 *
 * On a Mac (host-exec-guards.ts, host-exec-watch.ts): a command that reads a place macOS guards is
 * refused unless the caller passes `allowPrompts` (the user agreed), and a run that
 * sits idle at a password or permission dialog is stopped and answers `blocked`.
 *
 * Bundled into the binary daemon and shipped as the host-exec-core.cjs sidecar
 * for the source twin; 'host-exec-v1' is advertised only where it loads, and
 * 'host-exec-v2' where it carries this shell and WALNUT_TASK_DIR (`version`), 'host-exec-wait-v1'
 * where exec.read waits for a pattern, a port or a file (host-exec-wait.ts, `version` 3); the
 * pattern runs in a matcher process the twin starts (`matcher`, host-exec-matcher.ts).
 * It never signals a process itself: the twin hands in `killGroup`. How a run ends, and what its
 * shell left running in its process group is stopped with it when the server asks (exec.run
 * `endGroup`, 'host-exec-group-v1', `version` 4): host-exec-group.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { ensureTaskDir } from './task-dir-core.js'
import { permissionMessage, permissionRisk } from './host-exec-guards.js'
import { cltInstalled, cltMessage, cltStubRun, loginPath, type CltFs } from './host-exec-clt.js'
import { IDLE_WINDOW_MS, createPromptWatcher, macPromptProbe, type PromptBlock, type PromptProbe } from './host-exec-watch.js'
import { bad, commandLine, findBash, openRunLog, readLogLines, resolveCwd, shellPlan, tailLines, type ExecError } from './host-exec-line.js'
import { waitBefore, waitOnJob, type HeldBefore, type WaitedFor } from './host-exec-wait.js'
import { createMatcher, type MatcherStart } from './host-exec-matcher.js'
import { stuckFileLooks } from './host-exec-probe.js'
import { watchShellEnd } from './host-exec-group.js'
import { jobView, type Job, type JobView, type RunReply } from './host-exec-job.js'

export type { JobView, RunReply } from './host-exec-job.js'

export { runWaitMatcher, type MatcherStart } from './host-exec-matcher.js'
export { BASH_CANDIDATES, LINE_ENV, commandLine, findBash, lineSpan, shellPlan, shellQuote, type ExecError } from './host-exec-line.js'

export const FOREGROUND_MAX_MS = 10 * 60_000
export const BACKGROUND_MAX_MS = 2 * 60 * 60_000
export const DEFAULT_TIMEOUT_MS = 2 * 60_000
export const OUTPUT_MAX_BYTES = 256 * 1024
const KILL_GRACE_MS = 3_000
const KEEP_FINISHED_MS = 60 * 60_000
const MAX_JOBS = 200
/** At most this many reads of one job wait on a wait_for at once. */
export const WAITS_PER_JOB = 4
/**
 * ... and on all of this host's jobs (up to MAX_JOBS kept an hour): each holds up to a few MB of
 * lines and all of them queue in the one matcher (2026-11-05 review: only the per-job cap held).
 */
export const WAITS_PER_HOST = 32
/** A job's id: the caller may choose it (`hx-<uuid>`), so a call whose answer was lost can still read the run. */
export const JOB_ID_RE = /^hx-[A-Za-z0-9_-]{4,64}$/
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export interface HostExecDeps {
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess
  /** Signal a whole process group (the twin's own, signal-checked helper); 0 only asks whether it has a member. */
  killGroup: (pid: number, signal: NodeJS.Signals | 0) => void
  /** The user's login shell (`$SHELL` when it runs), else bash, else sh. */
  shell: string
  /** The bash that runs the line; null for none (sh runs it). Found on this host when not given. */
  bash?: string | null
  home: string
  /** Where task directories live on this host (task-dir-core taskDirRoot), null when unknown. */
  taskDirRoot: string | null
  /** The daemon's own state dir: the audit file, and logs of a run with no task. */
  stateDir: string
  env: NodeJS.ProcessEnv
  now?: () => number
  /** This host's system (process.platform); the macOS guards apply on 'darwin'. */
  platform?: string
  /** Whether a Mac has the Command Line Tools (default: read from its filesystem, host-exec-clt.ts). */
  cltInstalled?: () => boolean
  /** The filesystem the Command Line Tools check reads (tests). */
  cltFs?: CltFs
  /** The PATH a run gets (default: the login shell asked, host-exec-clt.ts loginPath). */
  runPath?: () => string
  /** How a darwin run is checked for a dialog it waits on; null turns the check off (default: macPromptProbe). */
  promptProbe?: PromptProbe | null
  /** How often that check runs (IDLE_WINDOW_MS). */
  promptCheckMs?: number
  /** How to start the wait_for matcher process: this daemon run again as one; without it no output wait can run here. */
  matcher?: MatcherStart | (() => MatcherStart)
}

export interface RunRequest {
  jobId?: unknown
  taskId?: unknown
  command?: unknown
  argv?: unknown
  cwd?: unknown
  timeoutMs?: unknown
  background?: unknown
  maxOutputBytes?: unknown
  /** The asking Walnut's data home: the owner a new task directory's marker names (task-dir-core.ts). */
  home?: unknown
  /** The user agreed this command may show a dialog on this host's screen: no macOS guard, no idle check. */
  allowPrompts?: unknown
  /** Who asked, for the audit line only: the caller's task and host. */
  caller?: { task?: unknown; host?: unknown }
  /** The wait_for the server waits on next (exec.read `until`): one that could never hold here runs nothing. */
  until?: unknown
  /**
   * Stop what the shell leaves running in the job's process group when it exits (host-exec-group.ts,
   * 'host-exec-group-v1'). The server asks on each run, so a server older than that, whose help says
   * only that a child still holding the job's output is stopped, keeps exactly that.
   */
  endGroup?: unknown
}

/**
 * Bumped when exec.* changes what a server may rely on: 2 = bash after the login shell,
 * WALNUT_TASK_DIR; 3 = exec.read `until` (host-exec-wait.ts, 'host-exec-wait-v1'); 4 = exec.run
 * `endGroup` (host-exec-group.ts, 'host-exec-group-v1').
 */
export const HOST_EXEC_VERSION = 4

export function createHostExec(deps: HostExecDeps) {
  const now = deps.now ?? Date.now
  const jobs = new Map<string, Job>()
  // Reads waiting on a wait_for now, over every job (WAITS_PER_HOST).
  let hostWaits = 0
  // Ids of runs past their id check and not in `jobs` yet (the look a wait_for takes before the run
  // sits between), each settled once its run is recorded or refused: a second run with the same id
  // at once is refused, never started beside it, and a read or stop of that id waits for it.
  const starting = new Map<string, Promise<void>>()
  let seq = 0
  let bash: string | null | undefined = deps.bash
  const bashPath = (): string | null => {
    if (bash === undefined) bash = findBash(deps.env.PATH)
    return bash
  }
  const mac = (deps.platform ?? process.platform) === 'darwin'
  // One watcher for every job here: one `ps` and at most one log read per look, whatever the number of jobs.
  const probe = deps.promptProbe === undefined ? (mac ? macPromptProbe(now) : null) : deps.promptProbe
  const watcher = probe ? createPromptWatcher(probe, { everyMs: deps.promptCheckMs ?? IDLE_WINDOW_MS, now }) : null
  // A Mac's login shell PATH, asked only when the Command Line Tools are missing (host-exec-clt.ts).
  let askedPath: (() => string) | null = null
  // One matcher process for every wait_for here, started on the first output wait (host-exec-matcher.ts).
  const matcher = deps.matcher ? createMatcher(deps.matcher, deps.spawn) : null
  const pathOfRun = (): string => (deps.runPath ?? (askedPath ??= loginPath({
    spawn: deps.spawn, killGroup: deps.killGroup, env: deps.env, home: deps.home, now,
    plan: (line) => { const login = deps.shell || '/bin/sh'; const p = shellPlan(login, bashPath(), line); return { cmd: login, args: p.args, env: p.env } },
  })))()

  function audit(line: Record<string, unknown>): void {
    try {
      fs.mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 })
      fs.appendFileSync(path.join(deps.stateDir, 'host-exec-audit.jsonl'), JSON.stringify({ at: new Date(now()).toISOString(), ...line }) + '\n', { mode: 0o600 })
    } catch { /* the audit never fails a run */ }
  }

  function prune(): void {
    const t = now()
    for (const [id, j] of jobs) if (j.endedAt !== null && t - j.endedAt > KEEP_FINISHED_MS) jobs.delete(id)
    if (jobs.size <= MAX_JOBS) return
    for (const [id, j] of jobs) {
      if (jobs.size <= MAX_JOBS) break
      if (j.endedAt !== null) jobs.delete(id)
    }
  }

  /** The caller task's directory here, made (with its marker) on first use; null without a root or a usable id. */
  function taskDirOf(taskId: unknown, home: unknown): string | null {
    if (!deps.taskDirRoot || typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) return null
    return ensureTaskDir(deps.taskDirRoot, taskId, home, new Date(now()))
  }

  const view = (j: Job): JobView => jobView(j, now())

  function stop(j: Job, why: 'timeout' | 'asked' | 'blocked'): void {
    if (j.endedAt !== null || j.pid === null) return
    // Its shell already exited by itself: the run ended, so this only stops what it left, at once.
    if (j.shellExitedAt !== null) { j.stopLeft?.(); return }
    if (why === 'timeout') j.timedOut = true
    else if (why === 'asked') j.killed = true
    const pid = j.pid
    try { deps.killGroup(pid, 'SIGTERM') } catch { /* already gone */ }
    const hard = setTimeout(() => { if (j.endedAt === null) { try { deps.killGroup(pid, 'SIGKILL') } catch { /* gone */ } } }, KILL_GRACE_MS)
    hard.unref?.()
  }

  /** Start a run; resolves when it ends (foreground) or at once (background). */
  async function run(req: RunRequest): Promise<RunReply | ExecError> {
    prune()
    const line = commandLine(req)
    if (typeof line !== 'string') return line
    const cwd = resolveCwd(req.cwd, deps.home)
    if (typeof cwd !== 'string') return cwd
    const allowPrompts = req.allowPrompts === true
    const taskDir = taskDirOf(req.taskId, req.home)
    // A place macOS guards shows a dialog on this Mac's screen, and the command waits on it.
    if (mac && !allowPrompts) {
      const risk = permissionRisk(line, cwd, deps.home, taskDir ? { WALNUT_TASK_DIR: taskDir } : {})
      if (risk) return bad(permissionMessage(risk, 'this Mac'), 'may_prompt')
      // A Mac without the Command Line Tools turns /usr/bin/git, cc, xcodebuild... into an install dialog.
      const stub = (deps.cltInstalled ?? cltInstalled)() ? null : cltStubRun(line, pathOfRun(), deps.cltFs, cwd)
      if (stub) return bad(cltMessage(stub, 'this Mac'), 'may_prompt')
    }
    const background = req.background === true
    const cap = background ? BACKGROUND_MAX_MS : FOREGROUND_MAX_MS
    const asked = typeof req.timeoutMs === 'number' && Number.isFinite(req.timeoutMs) && req.timeoutMs > 0 ? req.timeoutMs : (background ? cap : DEFAULT_TIMEOUT_MS)
    const timeoutMs = Math.min(asked, cap)
    const tailMax = typeof req.maxOutputBytes === 'number' && req.maxOutputBytes > 0 ? Math.min(req.maxOutputBytes, OUTPUT_MAX_BYTES) : OUTPUT_MAX_BYTES
    const id = typeof req.jobId === 'string' && JOB_ID_RE.test(req.jobId) ? req.jobId : `hx-${now().toString(36)}-${(++seq).toString(36)}`
    if (jobs.has(id) || starting.has(id)) return bad(`job ${id} already exists`, 'job_exists')
    // Held from here until the job is in `jobs` (or nothing ran): the id check and the record are
    // one step to any other run, whatever this one awaits in between.
    let settle = () => {}
    const held = new Promise<void>((resolve) => { settle = resolve })
    starting.set(id, held)
    const recorded = () => { if (starting.get(id) === held) starting.delete(id); settle() }
    try {
      return await start(req, { line, cwd, allowPrompts, taskDir, background, timeoutMs, tailMax, id, recorded })
    } finally {
      recorded()
    }
  }

  /** A run of this id still starting: settled once it is recorded (or nothing ran). */
  async function started(jobId: unknown): Promise<void> {
    const s = typeof jobId === 'string' ? starting.get(jobId) : undefined
    if (s) await s
  }

  /** The rest of run(), its id held: the checks that await, the spawn, and the job's record (`recorded`). */
  async function start(req: RunRequest, o: { line: string; cwd: string; allowPrompts: boolean; taskDir: string | null; background: boolean; timeoutMs: number; tailMax: number; id: string; recorded: () => void }): Promise<RunReply | ExecError> {
    const { line, cwd, allowPrompts, taskDir, background, timeoutMs, tailMax, id } = o
    // Unset, `$WALNUT_TASK_DIR/x` would be `/x`: refuse rather than run it there.
    if (!taskDir && /\bWALNUT_TASK_DIR\b/.test(line)) return bad('this host has no task directory for this task, so WALNUT_TASK_DIR is unset here; nothing ran', 'task_dir_unset')
    // A port or file the run will be waited on: is it there before the run could have made it?
    let before: HeldBefore = { ports: [], files: [] }
    if (req.until !== undefined) {
      const b = await waitBefore(req.until, { cwd, home: deps.home, taskDir })
      if (!b.ok) return bad(`${b.error}; nothing ran`, b.code)
      before = b.before
    }
    const dir = taskDir ? path.join(taskDir, 'host-exec') : path.join(deps.stateDir, 'host-exec')
    let fd: number
    let logFile: string
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      ;({ fd, logFile } = openRunLog(dir, id))
    } catch (err) {
      return bad(`could not open a log in ${dir}: ${(err as Error).message}`, 'spawn_failed')
    }

    const login = deps.shell || '/bin/sh'
    const plan = shellPlan(login, bashPath(), line)
    const job: Job = {
      id, pid: null, startedAt: now(), endedAt: null, shellExitedAt: null, exitCode: null, signal: null, timedOut: false, killed: false,
      cwd, logFile, taskId: typeof req.taskId === 'string' ? req.taskId : null, bytes: 0, tail: [], tailBytes: 0, tailMax, waiters: [], timer: null,
      shell: plan.shell, loginShell: plan.loginShell, taskDir, command: line.slice(0, 200), blocked: null, leftBehind: false, outputCut: false,
      before, unwatch: null, stopLeft: null, timeoutMs, waits: 0,
    }
    const caller = req.caller ?? {}
    const who = { task: typeof caller.task === 'string' ? caller.task.slice(0, 128) : null, host: typeof caller.host === 'string' ? caller.host.slice(0, 200) : null }
    audit({ event: 'start', jobId: id, ...who, cwd, command: line.slice(0, 2000), background, timeoutMs, shell: plan.shell })

    let child: ChildProcess
    try {
      // The env never carries the daemon's own WALNUT_* (the twins strip them); these two are the run's.
      child = deps.spawn(login, plan.args, {
        cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...deps.env, ...plan.env, WALNUT_HOST_EXEC_JOB: id, ...(taskDir ? { WALNUT_TASK_DIR: taskDir } : {}) },
      })
    } catch (err) {
      try { fs.closeSync(fd) } catch { /* closed */ }
      audit({ event: 'end', jobId: id, ...who, error: (err as Error).message })
      return bad(`could not start the shell: ${(err as Error).message}`, 'spawn_failed')
    }
    job.pid = typeof child.pid === 'number' ? child.pid : null
    jobs.set(id, job)
    o.recorded()

    const onData = (chunk: Buffer) => {
      job.bytes += chunk.length
      try { fs.writeSync(fd, chunk) } catch { /* a full disk loses the log, not the run */ }
      job.tail.push(chunk)
      job.tailBytes += chunk.length
      // Keep a little over the cap so the cut can fall on a whole character.
      while (job.tail.length > 1 && job.tailBytes - job.tail[0].length >= job.tailMax) job.tailBytes -= job.tail.shift()!.length
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)

    // The shell's exit ends the job, a moment later at most: what it left running in its group is
    // stopped (a terminal closing does the same), and the answer names it (host-exec-group.ts).
    const finished = new Promise<void>((resolve) => {
      const watch = watchShellEnd(child, {
        pgid: job.pid, line, endGroup: req.endGroup === true, killGroup: deps.killGroup, spawn: deps.spawn,
        // Its deadline is the shell's: one that exited by itself is never "stopped at its deadline".
        onExit: () => { job.shellExitedAt = now(); if (job.timer) { clearTimeout(job.timer); job.timer = null } },
        onEnd: ({ code, signal, error, leftBehind, leftCommands, outputCut }) => {
          if (job.timer) clearTimeout(job.timer)
          job.unwatch?.()
          job.endedAt = now()
          job.exitCode = code
          job.signal = signal
          job.leftBehind = leftBehind
          job.outputCut = outputCut
          if (leftCommands) job.leftCommands = leftCommands
          try { fs.closeSync(fd) } catch { /* closed */ }
          audit({ event: 'end', jobId: id, ...who, exitCode: code, signal, timedOut: job.timedOut, killed: job.killed, ...(job.blocked ? { blocked: job.blocked.reason } : {}), ms: job.endedAt - job.startedAt, bytes: job.bytes, ...(leftBehind ? { leftBehind: leftCommands ?? true } : {}), ...(outputCut ? { outputCut } : {}), ...(error ? { error } : {}) })
          for (const w of job.waiters.splice(0)) w()
          resolve()
        },
      })
      job.stopLeft = () => watch.stopLeft()
    })
    if (job.endedAt === null && job.shellExitedAt === null) {
      job.timer = setTimeout(() => stop(job, 'timeout'), timeoutMs)
      job.timer.unref?.()
    }
    // A run that sits at a dialog nobody here asked for is stopped, and says so.
    if (watcher && !allowPrompts && job.pid !== null && job.endedAt === null) {
      job.unwatch = watcher.watch({ pgid: job.pid, startedAt: job.startedAt }, (blocked) => {
        if (job.endedAt !== null) return
        job.blocked = blocked
        audit({ event: 'blocked', jobId: id, ...who, ...blocked })
        stop(job, 'blocked')
      })
    }

    if (!background) await finished
    return { ...view(job), ...tailLines(job.tail, job.tailMax, job.bytes, job.endedAt === null) }
  }

  function logSize(file: string): number {
    try { return fs.statSync(file).size } catch { return 0 }
  }

  /** The job, when it exists and the asking task (if named) is the one that started it. */
  function own(jobId: unknown, taskId: unknown): Job | undefined {
    const j = typeof jobId === 'string' ? jobs.get(jobId) : undefined
    if (!j) return undefined
    if (typeof taskId === 'string' && taskId && j.taskId !== taskId) return undefined
    return j
  }

  /**
   * Read a job's output from its log: `offset` onward (an offset past the log's end reads from its
   * end), at most `maxBytes`; with no offset, the last `maxBytes`. `wait` (ms, 60 s at most) holds
   * the answer until the job ends. With `until` (host-exec-wait.ts) it also answers as soon as that
   * holds, in `waitedFor`; the output is tested from `scanFrom` (a line start an earlier wait got
   * to), else `offset`, else the start; `by` (ms) is when the answer must go at the latest, every
   * look included (the server's read gives up soon after). A match on a line still being written
   * (`partial`) comes back with that line in `output`.
   */
  async function read(req: { jobId?: unknown; taskId?: unknown; offset?: unknown; maxBytes?: unknown; wait?: unknown; until?: unknown; scanFrom?: unknown; by?: unknown }): Promise<(JobView & { output: string; offset: number; nextOffset: number; waitedFor?: WaitedFor }) | ExecError> {
    // A run of this id still starting (a same-id call refused job_exists reads it next): it, once recorded.
    await started(req.jobId)
    const j = own(req.jobId, req.taskId)
    if (!j) return bad(`no job ${String(req.jobId)} on this host (finished jobs are kept for an hour; the log file stays)`, 'unknown_job')
    const wait = typeof req.wait === 'number' && req.wait > 0 ? Math.min(req.wait, 60_000) : 0
    // An offset past the log's end is its end (2026-11-04 usability review: offset 999999 on a 5-byte log said scanned 999999).
    const offset = typeof req.offset === 'number' && req.offset >= 0 ? Math.min(req.offset, logSize(j.logFile)) : null
    let waitedFor: WaitedFor | undefined
    if (req.until !== undefined) {
      // Each wait reads the log and asks the matcher on its own: a few at once per job is plenty.
      if (j.waits >= WAITS_PER_JOB) return bad(`${WAITS_PER_JOB} waits on job ${j.id} already run; let one end (or read it with no wait_for) before starting another`, 'busy')
      if (hostWaits >= WAITS_PER_HOST) return bad(`${WAITS_PER_HOST} waits already run on this host's jobs; let one end (or read with no wait_for) before starting another`, 'busy')
      const from = typeof req.scanFrom === 'number' && req.scanFrom >= 0 ? req.scanFrom : offset ?? 0
      const by = typeof req.by === 'number' && Number.isFinite(req.by) && req.by >= 0 ? req.by : undefined
      j.waits += 1
      hostWaits += 1
      let w: Awaited<ReturnType<typeof waitOnJob>>
      try {
        w = await waitOnJob(req.until, {
          logFile: j.logFile, cwd: j.cwd, home: deps.home, taskDir: j.taskDir, from, before: j.before, jobId: j.id,
          ended: () => j.endedAt !== null,
          onEnd: (wake) => { j.waiters.push(wake); return () => { const i = j.waiters.indexOf(wake); if (i !== -1) j.waiters.splice(i, 1) } },
        }, matcher, wait, by)
      } finally {
        j.waits -= 1
        hostWaits -= 1
      }
      if ('ok' in w) return bad(w.error, w.code)
      waitedFor = w
    } else if (wait && j.endedAt === null) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, wait)
        t.unref?.()
        j.waiters.push(() => { clearTimeout(t); resolve() })
      })
    }
    const max = typeof req.maxBytes === 'number' && req.maxBytes > 0 ? Math.min(req.maxBytes, OUTPUT_MAX_BYTES) : OUTPUT_MAX_BYTES
    // A match on the line still being written: the output shows it (2026-11-04 usability review: a
    // partial match on `Password: ` answered output "hi\n", as if the line had never been seen).
    const partialHit = waitedFor?.matched === 'output' && waitedFor.unfinished === true
    const lines = readLogLines(j.logFile, offset, max, j.endedAt === null && !partialHit)
    return { ...view(j), ...lines, ...(waitedFor ? { waitedFor } : {}) }
  }

  async function stopJob(req: { jobId?: unknown; taskId?: unknown }): Promise<JobView | ExecError> {
    await started(req.jobId)
    const j = own(req.jobId, req.taskId)
    if (!j) return bad(`no job ${String(req.jobId)} on this host`, 'unknown_job')
    stop(j, 'asked')
    return view(j)
  }

  /** Every job here, or one task's (`taskId`), newest first. */
  function list(req: { taskId?: unknown } = {}): JobView[] {
    prune()
    const task = typeof req.taskId === 'string' && req.taskId ? req.taskId : null
    return [...jobs.values()].filter((j) => task === null || j.taskId === task).sort((a, b) => b.startedAt - a.startedAt).map(view)
  }

  /**
   * A forced daemon update (daemon-update-behind.ts) is about to end the runs: each run's log
   * and the audit say so, and the run is stopped, so a later read of the log tells its task
   * why it ended instead of stopping mid-line. Returns how many it stopped.
   */
  function endForUpdate(note: string): number {
    let n = 0
    for (const j of jobs.values()) {
      // Ended, or already asked to stop (its line is written): one line per run.
      if (j.endedAt !== null || j.killed) continue
      try { fs.appendFileSync(j.logFile, `\n[walnut] ${note}\n`) } catch { /* the log is gone */ }
      audit({ event: 'ended-by-update', jobId: j.id, taskId: j.taskId })
      stop(j, 'asked')
      n++
    }
    return n
  }

  /** Running jobs (the server's per-host cap reads the host's own count after a restart). */
  function running(): number {
    let n = 0
    for (const j of jobs.values()) if (j.endedAt === null) n++
    return n
  }

  // The twins answer a thrown error with its `code` (replyTransfer), so a refusal
  // reaches the server as `exec.run failed: <why>` with `code: cwd_missing`.
  const thrown = async <T>(r: T | ExecError | Promise<T | ExecError>): Promise<T> => {
    const v = await r
    if (v && typeof v === 'object' && (v as ExecError).ok === false) {
      throw Object.assign(new Error((v as ExecError).error), { code: (v as ExecError).code })
    }
    return v as T
  }

  return {
    version: HOST_EXEC_VERSION,
    run: (req: RunRequest) => thrown<RunReply>(run(req)),
    read: (req: Parameters<typeof read>[0]) => thrown(read(req)),
    kill: (req: { jobId?: unknown; taskId?: unknown }) => thrown<JobView>(stopJob(req)),
    list: async (req: { taskId?: unknown } = {}) => ({ jobs: list(req) }),
    running,
    /** The running jobs' task and folder, read at once (task directory cleanup keeps what they work in). */
    active: (): Array<{ taskId: string | null; cwd: string }> =>
      [...jobs.values()].filter((j) => j.endedAt === null).map((j) => ({ taskId: j.taskId ?? null, cwd: j.cwd })),
    endForUpdate,
    /** File looks in flight `minAgeMs` or more (default STUCK_LOOK_MS; 0: any) in the thread pool: node's exit would wait on them (daemon-source.ts). */
    stuck: (minAgeMs?: number) => stuckFileLooks(Date.now(), minAgeMs) > 0,
    /** End the matcher process (the daemon's shutdown, tests). */
    close: () => matcher?.close(),
  }
}

export type HostExec = ReturnType<typeof createHostExec>
