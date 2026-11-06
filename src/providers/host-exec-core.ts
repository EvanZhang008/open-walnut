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
 * Which shell, and the line from `command` or `argv`: host-exec-line.ts (host-exec-v2: the login
 * shell, then bash). The child gets WALNUT_TASK_DIR, the caller task's directory here
 * (src/lib/task-dir.ts), where its logs are kept too. Every reply names the shell, the login
 * shell and the task directory.
 *
 * On a Mac (host-exec-guards.ts, host-exec-watch.ts): a command that reads a place macOS guards is
 * refused unless the caller passes `allowPrompts` (the user agreed), and a run that
 * sits idle at a password or permission dialog is stopped and answers `blocked`.
 *
 * Bundled into the binary daemon and shipped as the host-exec-core.cjs sidecar
 * for the source twin; 'host-exec-v1' is advertised only where it loads, and
 * 'host-exec-v2' where it carries this shell and WALNUT_TASK_DIR (`version`).
 * It never signals a process itself: the twin hands in `killGroup`.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { ensureTaskDir } from './task-dir-core.js'
import { permissionMessage, permissionRisk } from './host-exec-guards.js'
import { cltInstalled, cltMessage, cltStubRun, loginPath, type CltFs } from './host-exec-clt.js'
import { IDLE_WINDOW_MS, createPromptWatcher, macPromptProbe, type PromptBlock, type PromptProbe } from './host-exec-watch.js'
import { bad, commandLine, findBash, lineSpan, shellPlan, type ExecError } from './host-exec-line.js'

export { BASH_CANDIDATES, LINE_ENV, commandLine, findBash, lineSpan, shellPlan, shellQuote, type ExecError } from './host-exec-line.js'

export const FOREGROUND_MAX_MS = 10 * 60_000
export const BACKGROUND_MAX_MS = 2 * 60 * 60_000
export const DEFAULT_TIMEOUT_MS = 2 * 60_000
export const OUTPUT_MAX_BYTES = 256 * 1024
const KILL_GRACE_MS = 3_000
/** How long the pipes may stay open after the shell exited (a process that left its group holds them). */
const EXIT_DRAIN_MS = 2_000
const KEEP_FINISHED_MS = 60 * 60_000
const MAX_JOBS = 200
/** A job's id: the caller may choose it (`hx-<uuid>`), so a call whose answer was lost can still read the run. */
export const JOB_ID_RE = /^hx-[A-Za-z0-9_-]{4,64}$/
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export interface HostExecDeps {
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess
  /** Signal a whole process group (the twin's own, signal-checked helper). */
  killGroup: (pid: number, signal: NodeJS.Signals) => void
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
}

export interface JobView {
  jobId: string
  running: boolean
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  killed: boolean
  startedAt: number
  ms: number
  cwd: string
  logFile: string
  /** Bytes the command wrote in all. */
  outputBytes: number
  /** What ran the line ("bash", "sh"), after the login shell (`loginShell`, "zsh") set up the environment. */
  shell: string
  loginShell: string
  /** The caller task's directory on this host, the child's WALNUT_TASK_DIR; null when this host has none for it. */
  taskDir: string | null
  /** The task that started it, and the head of its line (a task lists its own jobs). */
  taskId: string | null
  command: string
  /** Stopped because it sat at a dialog on this host's screen (host-exec-watch.ts), else null. */
  blocked: PromptBlock | null
}

export interface RunReply extends JobView {
  /** The last `maxOutputBytes` of the output (stdout and stderr in the order written). */
  output: string
  truncated: boolean
}


interface Job {
  id: string
  pid: number | null
  startedAt: number
  endedAt: number | null
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  killed: boolean
  cwd: string
  logFile: string
  /** The task that started it: only that task reads or stops it. */
  taskId: string | null
  shell: string
  loginShell: string
  taskDir: string | null
  command: string
  blocked: PromptBlock | null
  unwatch: (() => void) | null
  bytes: number
  tail: Buffer[]
  tailBytes: number
  tailMax: number
  waiters: Array<() => void>
  timer: ReturnType<typeof setTimeout> | null
}

/** Bumped when exec.run changes what a server may rely on: 2 = bash after the login shell, WALNUT_TASK_DIR. */
export const HOST_EXEC_VERSION = 2

export function createHostExec(deps: HostExecDeps) {
  const now = deps.now ?? Date.now
  const jobs = new Map<string, Job>()
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

  function resolveCwd(raw: unknown): string | ExecError {
    let cwd = typeof raw === 'string' && raw.trim() ? raw.trim() : deps.home
    if (cwd === '~') cwd = deps.home
    else if (cwd.startsWith('~/')) cwd = path.join(deps.home, cwd.slice(2))
    if (!path.isAbsolute(cwd)) return bad(`cwd must be an absolute path or start with ~/ (got "${cwd}")`)
    try {
      const real = fs.realpathSync(cwd)
      if (!fs.statSync(real).isDirectory()) return bad(`${cwd} is not a directory on this host`, 'cwd_missing')
      return real
    } catch {
      return bad(`${cwd} does not exist on this host`, 'cwd_missing')
    }
  }

  /** The caller task's directory here, made (with its marker) on first use; null without a root or a usable id. */
  function taskDirOf(taskId: unknown, home: unknown): string | null {
    if (!deps.taskDirRoot || typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) return null
    return ensureTaskDir(deps.taskDirRoot, taskId, home, new Date(now()))
  }

  function view(j: Job): JobView {
    return {
      jobId: j.id, running: j.endedAt === null, exitCode: j.exitCode, signal: j.signal, timedOut: j.timedOut, killed: j.killed,
      startedAt: j.startedAt, ms: (j.endedAt ?? now()) - j.startedAt, cwd: j.cwd, logFile: j.logFile, outputBytes: j.bytes,
      shell: j.shell, loginShell: j.loginShell, taskDir: j.taskDir, taskId: j.taskId, command: j.command, blocked: j.blocked,
    }
  }

  function tailText(j: Job): { output: string; truncated: boolean } {
    const buf = Buffer.concat(j.tail)
    const cut = buf.length > j.tailMax ? buf.subarray(buf.length - j.tailMax) : buf
    const { start, end } = lineSpan(cut, cut.length < j.bytes, j.endedAt === null)
    return { output: cut.subarray(start, end).toString('utf8'), truncated: j.bytes > end - start }
  }

  function stop(j: Job, why: 'timeout' | 'asked' | 'blocked'): void {
    if (j.endedAt !== null || j.pid === null) return
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
    const cwd = resolveCwd(req.cwd)
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
    if (jobs.has(id)) return bad(`job ${id} already exists`, 'job_exists')

    // Unset, `$WALNUT_TASK_DIR/x` would be `/x`: refuse rather than run it there.
    if (!taskDir && /\bWALNUT_TASK_DIR\b/.test(line)) return bad('this host has no task directory for this task, so WALNUT_TASK_DIR is unset here; nothing ran', 'task_dir_unset')
    const dir = taskDir ? path.join(taskDir, 'host-exec') : path.join(deps.stateDir, 'host-exec')
    const logFile = path.join(dir, `${id}.log`)
    let fd: number
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      fd = fs.openSync(logFile, 'a', 0o600)
    } catch (err) {
      return bad(`could not open the log ${logFile}: ${(err as Error).message}`, 'spawn_failed')
    }

    const login = deps.shell || '/bin/sh'
    const plan = shellPlan(login, bashPath(), line)
    const job: Job = {
      id, pid: null, startedAt: now(), endedAt: null, exitCode: null, signal: null, timedOut: false, killed: false,
      cwd, logFile, taskId: typeof req.taskId === 'string' ? req.taskId : null, bytes: 0, tail: [], tailBytes: 0, tailMax, waiters: [], timer: null,
      shell: plan.shell, loginShell: plan.loginShell, taskDir, command: line.slice(0, 200), blocked: null, unwatch: null,
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

    const finished = new Promise<void>((resolve) => {
      let done = false
      const end = (code: number | null, signal: string | null, error?: string) => {
        if (done) return
        done = true
        if (job.timer) clearTimeout(job.timer)
        job.unwatch?.()
        job.endedAt = now()
        job.exitCode = code
        job.signal = signal
        try { fs.closeSync(fd) } catch { /* closed */ }
        audit({ event: 'end', jobId: id, ...who, exitCode: code, signal, timedOut: job.timedOut, killed: job.killed, ...(job.blocked ? { blocked: job.blocked.reason } : {}), ms: job.endedAt - job.startedAt, bytes: job.bytes, ...(error ? { error } : {}) })
        for (const w of job.waiters.splice(0)) w()
        resolve()
      }
      child.on('error', (err) => end(null, null, err.message))
      child.on('close', (code, signal) => end(code, signal))
      // Something the shell left behind can hold the pipes open long after it exited: a
      // process in its group (`cmd &`), or one that left the group (setsid, a daemonizing
      // tool) that no group signal reaches. The shell's exit ends the job, a moment later at
      // most: what is still in its group gets SIGTERM (a terminal closing does the same),
      // and the pipes are closed so a process outside it holds nothing of ours.
      child.on('exit', (code, signal) => {
        const t = setTimeout(() => {
          if (done) return
          if (job.pid !== null) { try { deps.killGroup(job.pid, 'SIGTERM') } catch { /* the group is gone */ } }
          child.stdout?.destroy()
          child.stderr?.destroy()
          end(code, signal)
        }, EXIT_DRAIN_MS)
        t.unref?.()
      })
    })
    job.timer = setTimeout(() => stop(job, 'timeout'), timeoutMs)
    job.timer.unref?.()
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
    return { ...view(job), ...tailText(job) }
  }

  /**
   * Read a job's output from its log: `offset` onward, at most `maxBytes`; with no
   * offset, the last `maxBytes`. `wait` (ms, 60 s at most) holds the answer until the
   * job ends or the time is up, so a reader polls rarely.
   */
  /** The job, when it exists and the asking task (if named) is the one that started it. */
  function own(jobId: unknown, taskId: unknown): Job | undefined {
    const j = typeof jobId === 'string' ? jobs.get(jobId) : undefined
    if (!j) return undefined
    if (typeof taskId === 'string' && taskId && j.taskId !== taskId) return undefined
    return j
  }

  async function read(req: { jobId?: unknown; taskId?: unknown; offset?: unknown; maxBytes?: unknown; wait?: unknown }): Promise<(JobView & { output: string; offset: number; nextOffset: number }) | ExecError> {
    const j = own(req.jobId, req.taskId)
    if (!j) return bad(`no job ${String(req.jobId)} on this host (finished jobs are kept for an hour; the log file stays)`, 'unknown_job')
    const wait = typeof req.wait === 'number' && req.wait > 0 ? Math.min(req.wait, 60_000) : 0
    if (wait && j.endedAt === null) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, wait)
        t.unref?.()
        j.waiters.push(() => { clearTimeout(t); resolve() })
      })
    }
    const max = typeof req.maxBytes === 'number' && req.maxBytes > 0 ? Math.min(req.maxBytes, OUTPUT_MAX_BYTES) : OUTPUT_MAX_BYTES
    let size = 0
    try { size = fs.statSync(j.logFile).size } catch { /* gone */ }
    const explicit = typeof req.offset === 'number' && req.offset >= 0
    let from = explicit ? Math.min(req.offset as number, size) : Math.max(0, size - max)
    const len = Math.min(max, size - from)
    let output = ''
    let next = from + len
    if (len > 0) {
      const buf = Buffer.alloc(len)
      let fd: number | null = null
      try {
        fd = fs.openSync(j.logFile, 'r')
        fs.readSync(fd, buf, 0, len, from)
        // Whole lines only: a tail read starts at a line, and a window that stops before the
        // end, or while the job still writes, stops at one, so nextOffset is a line start
        // (an offset is the reader's own: it is never moved forward, which could skip output).
        const span = lineSpan(buf, !explicit && from > 0, from + len < size || j.endedAt === null)
        output = buf.subarray(span.start, span.end).toString('utf8')
        next = from + span.end
        from += span.start
      } catch { /* gone */ } finally { if (fd !== null) try { fs.closeSync(fd) } catch { /* closed */ } }
    }
    return { ...view(j), output, offset: from, nextOffset: next }
  }

  function stopJob(req: { jobId?: unknown; taskId?: unknown }): JobView | ExecError {
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
      if (j.endedAt !== null) continue
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
  }
}

export type HostExec = ReturnType<typeof createHostExec>
