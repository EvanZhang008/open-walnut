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
 * `endGroup`, 'host-exec-group-v1', `version` 4): host-exec-group.ts. A run the caller marks
 * `resumable` (it only waits or reads) never holds a daemon update (`holding`, `version` 6).
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
import { jobView, untilEndedByDaemon, type Job, type JobView, type RunReply, type RunRequest } from './host-exec-job.js'
import { createRecall, jobFromAudit, type Orphan } from './host-exec-recall.js'
import { registryFile } from './detached-registry.js'
import type { ScriptResult } from './host-script-core.js'
import { createScriptRunner } from './host-exec-script.js'
import { createDetachedScripts } from './host-script-detached.js'
import { detachedChild, exitFileOf, removeExitFile, wrapperArgv } from './detached-run.js'
import { ROLLBACK_NOTE, installStopScript, processStart as psStart, registerRun, unregisterRun } from './detached-registry.js'

export type { JobView, RunReply, RunRequest } from './host-exec-job.js'

export { runWaitMatcher, type MatcherStart } from './host-exec-matcher.js'
export { BASH_CANDIDATES, LINE_ENV, commandLine, findBash, lineSpan, shellPlan, shellQuote, type ExecError } from './host-exec-line.js'

export const FOREGROUND_MAX_MS = 10 * 60_000
export const BACKGROUND_MAX_MS = 2 * 60 * 60_000
export const DEFAULT_TIMEOUT_MS = 2 * 60_000
export const OUTPUT_MAX_BYTES = 256 * 1024
const KILL_GRACE_MS = 3_000
const KEEP_FINISHED_MS = 60 * 60_000
/** How long a read or stop of a detached run waits for its adoption (ps answers in 5 s at most) before it answers what the audit says. */
const ADOPT_WAIT_MS = 15_000
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
  /** Whether a pid runs (default: signal 0); asked of the daemon that wrote a run's start line (host-exec-recall.ts). */
  pidAlive?: (pid: number) => boolean
  /**
   * Where this host's daemon lists the work it ran detached, for a rollback's stop
   * (detached-registry.ts); default `<stateDir>/detached`. The twins give the one their other kinds use.
   */
  registryDir?: string
  /** What ps names as a pid's start (default detached-registry.ts processStart): a run is adopted only while its wrapper holds its pid. */
  processStart?: (pid: number) => Promise<string | null>
}

/**
 * Bumped when exec.* changes what a server may rely on: 2 = bash after the login shell,
 * WALNUT_TASK_DIR; 3 = exec.read `until` (host-exec-wait.ts, 'host-exec-wait-v1'); 4 = exec.run
 * `endGroup` (host-exec-group.ts, 'host-exec-group-v1'); 5 = exec.script (host-script-core.ts,
 * 'host-script-v1'); 6 = exec.run `resumable` (`holding`: such a run never holds a daemon update); 7 = exec.run `detach`
 * (detached-run.ts, 'host-exec-detach-v1': the run outlives this daemon and the next one follows it).
 */
export const HOST_EXEC_VERSION = 7

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
  const registryDir = deps.registryDir ?? path.join(deps.stateDir, 'detached')
  const processStart = deps.processStart ?? psStart
  const pidAlive = deps.pidAlive ?? ((pid: number) => { if (pid <= 1) return false; try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' } })
  // Plugin scripts (exec.script): no job, no log (host-exec-script.ts); a detached one keeps its files (host-script-detached.ts).
  const detachedScripts = createDetachedScripts({ spawn: deps.spawn, killGroup: deps.killGroup, root: path.join(deps.stateDir, 'host-script'), registryDir, processStart, pidAlive, now })
  void detachedScripts.adoptAll().then(() => detachedScripts.prune()).catch(() => {})
  const scripts = createScriptRunner({ spawn: deps.spawn, killGroup: deps.killGroup, shell: deps.shell, bash: bashPath, home: deps.home, env: deps.env, mac, detached: detachedScripts })
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

  const auditFile = path.join(deps.stateDir, 'host-exec-audit.jsonl')
  let stopScriptPut = false
  function audit(line: Record<string, unknown>): void {
    try {
      fs.mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 })
      fs.appendFileSync(auditFile, JSON.stringify({ at: new Date(now()).toISOString(), ...line }) + '\n', { mode: 0o600 })
    } catch { /* the audit never fails a run */ }
  }
  // The jobs an earlier daemon here ran, read back from the audit (host-exec-recall.ts): a daemon
  // update never turns a finished run into "no job".
  const recall = createRecall({
    auditFile, stateDir: deps.stateDir, taskDirRoot: deps.taskDirRoot, keepMs: KEEP_FINISHED_MS, defaultTimeoutMs: BACKGROUND_MAX_MS, now,
    selfPid: process.pid,
    alive: pidAlive,
    // An exit file a daemon that restarted within the hour after the end never removed (prune does it otherwise).
    forgetEnded: (j) => { if (j.detached && !jobs.has(j.id)) void removeExitFile(j.detached.exitFile) },
  })
  /** A job this daemon runs or ran, else one an earlier daemon here ran (a detached one it still runs is followed from here: adopt). */
  const jobOf = (id: string): Job | undefined => { adoptOrphans(); return jobs.get(id) ?? recall.get(id) }

  // Detached runs an earlier daemon here started, followed from here once it is gone: their
  // deadline, a stop, a wait_for and their end line work as if this daemon had started them.
  const adopting = new Map<string, Promise<void>>()
  const deferred = new Set<string>()
  /**
   * Starts the adoption of every orphan not yet followed. One whose adoption ps left for later
   * (`deferred`) is asked again only from the timer (`retry`), never on a caller's path: a slow ps
   * must not slow every read on the host (2026-11-21 review R2-1).
   */
  function adoptOrphans(retry = false): void {
    let found: Orphan[] = []
    try { found = recall.orphans((id) => jobs.has(id) || adopting.has(id) || starting.has(id) || (!retry && deferred.has(id))) } catch { /* the audit is unreadable: none */ }
    for (const o of found) {
      // In the map before it runs (an adoption that never awaits settles inside the call), and it
      // never rejects: the daemon holds every session on the host.
      const p: Promise<void> = Promise.resolve().then(() => adopt(o)).catch((err) => {
        audit({ event: 'adopt-failed', jobId: o.jobId, error: (err as Error)?.message ?? String(err) })
      }).finally(() => { if (adopting.get(o.jobId) === p) adopting.delete(o.jobId) })
      adopting.set(o.jobId, p)
    }
  }
  /** Adopts what is left, then waits for the adoption of `jobId` alone, at most until `by` (an epoch ms). */
  async function adoptedFirst(jobId: unknown, by?: number): Promise<void> {
    adoptOrphans()
    const p = typeof jobId === 'string' ? adopting.get(jobId) : undefined
    if (!p) return
    const left = by === undefined ? ADOPT_WAIT_MS : Math.min(ADOPT_WAIT_MS, by - now())
    if (left <= 0) return
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, left)
      t.unref?.()
      void p.then(() => { clearTimeout(t); resolve() })
    })
  }

  async function listedStart(jobId: string): Promise<string | null> {
    try {
      const text = await fs.promises.readFile(registryFile(registryDir, 'host-exec', jobId), 'utf8')
      const m = /^lstart=(.*)$/m.exec(text)
      return m && m[1] ? m[1] : null
    } catch { return null }
  }

  async function adopt(o: Orphan): Promise<void> {
    // Reads and stops of it wait for this (as for a run still starting), never answering it ended.
    let settle = () => {}
    const held = new Promise<void>((resolve) => { settle = resolve })
    starting.set(o.jobId, held)
    try {
      const base = jobFromAudit(o.jobId, o.start, null, o.blocked, false, { stateDir: deps.stateDir, taskDirRoot: deps.taskDirRoot, defaultTimeoutMs: BACKGROUND_MAX_MS })
      if (!base?.detached) return
      const exitFile = base.detached.exitFile
      // Its wrapper still holds its pid when the process there started when the listed one did (the
      // audit's `listed` line, else the registry). ps with no answer is unknown: left for the next
      // look, never taken as killed (the run reads running meanwhile, host-exec-recall.ts).
      const listed = o.lstart ?? await listedStart(o.jobId)
      let wrapperHere = pidAlive(o.pid)
      let verified = false
      if (wrapperHere && listed) {
        const nowStart = await processStart(o.pid)
        if (nowStart === null) {
          if (pidAlive(o.pid)) {
            // Said once in the audit (the reason it is not followed yet), then asked again every look.
            if (!deferred.has(o.jobId)) { deferred.add(o.jobId); audit({ event: 'adopt-deferred', jobId: o.jobId, pid: o.pid, why: 'ps gave no start' }) }
            return
          }
          wrapperHere = false
        } else {
          deferred.delete(o.jobId)
          verified = nowStart === listed
          wrapperHere = verified
        }
      }
      // No start was ever recorded (its daemon died right after the spawn): followed, never signalled,
      // since that pid may be another program's by now; past its deadline it is let go.
      const deadline = base.startedAt + base.timeoutMs + 60_000
      const job: Job = {
        ...base, pid: verified ? o.pid : null, endedAt: null, shellExitedAt: null, exitCode: null, signal: null,
        bytes: logSize(base.logFile), tailMax: OUTPUT_MAX_BYTES,
        timedOut: o.stopping === 'timeout', killed: o.stopping === 'asked', ...(o.stopping ? { signalled: true as const } : {}),
      }
      delete job.daemonEnded
      // Followed but never signalled: its reads say a stop cannot reach it.
      if (wrapperHere && !verified) job.unverified = true
      jobs.set(o.jobId, job)
      deferred.delete(o.jobId)
      audit({ event: 'adopted', jobId: o.jobId, daemonPid: process.pid, ...(job.unverified ? { unverified: true } : {}) })
      const str = (v: unknown) => (typeof v === 'string' ? v : null)
      const wrapperAlive = () => {
        if (!wrapperHere || !pidAlive(o.pid)) return false
        if (verified || now() < deadline) return true
        // Past its deadline an unverified run is let go: nothing signalled it, and it may still run.
        job.endedBy = 'let-go'
        return false
      }
      const child = detachedChild({ exitFile, wrapperAlive, killedBy: () => (job.endedBy === 'let-go' ? null : 'SIGKILL'), signalled: () => job.signalled === true })
      void follow(job, child, { task: str(o.start.task), host: str(o.start.host) }, true, String(o.start.command ?? ''), null, o.start.allowPrompts === true)
      // A stop the last daemon began goes on (its SIGKILL may never have gone out).
      if (verified && (o.stopping === 'timeout' || o.stopping === 'asked' || o.stopping === 'blocked')) stop(job, o.stopping)
    } finally {
      if (starting.get(o.jobId) === held) starting.delete(o.jobId)
      settle()
    }
  }
  adoptOrphans(true)
  // A handover overlaps two daemons for a moment: what the other still followed is taken once it is
  // gone; and what ps left for later is asked again here.
  const adoptTimer = setInterval(() => { adoptOrphans(true) }, 2_000)
  adoptTimer.unref?.()

  function prune(): void {
    const t = now()
    const drop = (id: string, j: Job) => { jobs.delete(id); if (j.detached) void removeExitFile(j.detached.exitFile) }
    for (const [id, j] of jobs) if (j.endedAt !== null && t - j.endedAt > KEEP_FINISHED_MS) drop(id, j)
    if (jobs.size <= MAX_JOBS) return
    for (const [id, j] of jobs) {
      if (jobs.size <= MAX_JOBS) break
      if (j.endedAt !== null) drop(id, j)
    }
  }

  /** The caller task's directory here, made (with its marker) on first use; null without a root or a usable id. */
  function taskDirOf(taskId: unknown, home: unknown): string | null {
    if (!deps.taskDirRoot || typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) return null
    return ensureTaskDir(deps.taskDirRoot, taskId, home, new Date(now()))
  }

  const view = (j: Job): JobView => jobView(j, now())

  /** `daemon`: this daemon is going (endForUpdate); `atOnce` sends SIGKILL at once (a run that only waits). */
  function stop(j: Job, why: 'timeout' | 'asked' | 'blocked' | 'daemon', atOnce = false): void {
    if (j.endedAt !== null || j.pid === null) return
    // Its shell already exited by itself: the run ended, so this only stops what it left, at once.
    if (j.shellExitedAt !== null) { j.stopLeft?.(); return }
    if (why === 'timeout') j.timedOut = true
    else if (why === 'asked') j.killed = true
    else if (why === 'daemon') j.endedByDaemon = true
    j.signalled = true
    // A daemon that follows the run after this one knows why it was signalled (host-exec-recall.ts).
    if (j.detached) audit({ event: 'stopping', jobId: j.id, why })
    const pid = j.pid
    // The fallback below dies with a daemon that exits first: one that must end now gets SIGKILL.
    if (atOnce) { try { deps.killGroup(pid, 'SIGKILL') } catch { /* gone */ } return }
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
    // One an earlier daemon here ran counts too: a call resent after an update never runs it twice.
    if (jobs.has(id) || starting.has(id) || recall.get(id)) return bad(`job ${id} already exists`, 'job_exists')
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
    // Detached (detached-run.ts): the run's output goes straight to its log, which outlives this daemon.
    const detach = req.detach === true && req.endGroup === true
    let fd: number
    let logFile: string
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      ;({ fd, logFile } = openRunLog(dir, id))
      // Appended to, so a note this daemon (or the next) writes at its end is never written over.
      if (detach) { fs.closeSync(fd); fd = fs.openSync(logFile, 'a', 0o600) }
    } catch (err) {
      return bad(`could not open a log in ${dir}: ${(err as Error).message}`, 'spawn_failed')
    }

    const login = deps.shell || '/bin/sh'
    const plan = shellPlan(login, bashPath(), line)
    const job: Job = {
      id, pid: null, startedAt: now(), endedAt: null, shellExitedAt: null, exitCode: null, signal: null, timedOut: false, killed: false,
      cwd, logFile, taskId: typeof req.taskId === 'string' ? req.taskId : null, bytes: 0, tail: [], tailBytes: 0, tailMax, waiters: [], timer: null,
      shell: plan.shell, loginShell: plan.loginShell, taskDir, command: line.slice(0, 200), blocked: null, leftBehind: false, outputCut: false,
      before, unwatch: null, stopLeft: null, timeoutMs, waits: 0, ...(req.resumable === true ? { resumable: true as const } : {}),
      ...(detach ? { detached: { exitFile: exitFileOf(logFile) } } : {}),
    }
    const caller = req.caller ?? {}
    const who = { task: typeof caller.task === 'string' ? caller.task.slice(0, 128) : null, host: typeof caller.host === 'string' ? caller.host.slice(0, 200) : null }
    // What a later daemon needs to answer for this run (host-exec-recall.ts): whose it is and where its log is.
    audit({
      event: 'start', jobId: id, ...who, taskId: job.taskId, startedAt: job.startedAt, daemonPid: process.pid, cwd, command: line.slice(0, 2000), background, timeoutMs,
      shell: plan.shell, loginShell: plan.loginShell, taskDir, logFile, ...(job.resumable ? { resumable: true } : {}),
      ...(job.detached ? { detach: true, exitFile: job.detached.exitFile, ...(allowPrompts ? { allowPrompts: true } : {}) } : {}),
    })

    let child: ChildProcess
    try {
      // The env never carries the daemon's own WALNUT_* (the twins strip them); these two are the run's.
      const env = { ...deps.env, ...plan.env, WALNUT_HOST_EXEC_JOB: id, ...(taskDir ? { WALNUT_TASK_DIR: taskDir } : {}) }
      if (job.detached) {
        const w = wrapperArgv(login, plan.args, job.detached.exitFile)
        child = deps.spawn(w.cmd, w.args, { cwd, detached: true, stdio: ['ignore', fd, fd], env })
      } else {
        child = deps.spawn(login, plan.args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env })
      }
    } catch (err) {
      try { fs.closeSync(fd) } catch { /* closed */ }
      audit({ event: 'end', jobId: id, ...who, error: (err as Error).message })
      return bad(`could not start the shell: ${(err as Error).message}`, 'spawn_failed')
    }
    job.pid = typeof child.pid === 'number' ? child.pid : null
    jobs.set(id, job)
    o.recorded()

    let finished: Promise<void>
    if (job.detached) {
      // The wrapper holds the log once it started (Bun hands the fd over then); this daemon only reads it.
      const closeLog = () => { try { fs.closeSync(fd) } catch { /* closed */ } }
      child.once('spawn', closeLog)
      child.once('error', closeLog)
      if (job.pid !== null) {
        audit({ event: 'spawned', jobId: id, pid: job.pid, daemonPid: process.pid })
        void listDetached(job)
      }
      finished = follow(job, detachedChild({ exitFile: job.detached.exitFile, wrapper: child, signalled: () => job.signalled === true }), who, true, line, null, allowPrompts)
    } else {
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
      finished = follow(job, child, who, req.endGroup === true, line, fd, allowPrompts)
    }

    if (!background) await finished
    return { ...view(job), ...(await replyTail(job)) }
  }

  /** The output a run's answer carries: the last bytes kept in memory, or (a detached run) read from its log. */
  async function replyTail(job: Job): Promise<{ output: string; truncated: boolean }> {
    if (!job.detached) return tailLines(job.tail, job.tailMax, job.bytes, job.endedAt === null)
    // A detached run's output is only in its log: its tail, read off the event loop.
    let size = 0
    let buf = Buffer.alloc(0)
    try {
      const fh = await fs.promises.open(job.logFile, 'r')
      try {
        size = (await fh.stat()).size
        const len = Math.min(size, job.tailMax + 4)
        buf = Buffer.alloc(len)
        await fh.read(buf, 0, len, size - len)
      } finally { await fh.close() }
    } catch { return { output: '', truncated: size > 0 } }
    return tailLines([buf], job.tailMax, size, job.endedAt === null)
  }

  /**
   * Follow a run to its end, whichever daemon started it: its shell's exit (the ChildProcess, or a
   * detached run's stand-in), its deadline, a dialog it sits at; the end line in the audit. `fd` is
   * the log this daemon writes for it (a run with pipes), null when the run writes it itself.
   */
  function follow(job: Job, child: ChildProcess, who: { task: string | null; host: string | null }, endGroup: boolean, line: string, fd: number | null, allowPrompts: boolean): Promise<void> {
    const id = job.id
    // The shell's exit ends the job, a moment later at most: what it left running in its group is
    // stopped (a terminal closing does the same), and the answer names it (host-exec-group.ts).
    const finished = new Promise<void>((resolve) => {
      const watch = watchShellEnd(child, {
        pgid: job.pid, line, endGroup, killGroup: deps.killGroup, spawn: deps.spawn,
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
          if (fd !== null) { try { fs.closeSync(fd) } catch { /* closed */ } }
          if (job.detached) job.bytes = logSize(job.logFile)
          audit({ event: 'end', jobId: id, ...who, exitCode: code, signal, timedOut: job.timedOut, killed: job.killed, ...(job.blocked ? { blocked: job.blocked.reason } : {}), ms: job.endedAt - job.startedAt, bytes: job.bytes, ...(leftBehind ? { leftBehind: leftCommands ?? true } : {}), ...(outputCut ? { outputCut } : {}), ...(error ? { error } : {}), ...(job.endedBy ? { endedBy: job.endedBy } : {}) })
          // Its end is in the audit now: its registry entry has done its work. The exit file stays while the
          // job is kept (another daemon following it too reads the same status, never "killed"); prune removes it.
          if (job.detached) void unregisterRun(registryDir, 'host-exec', id)
          for (const w of job.waiters.splice(0)) w()
          resolve()
        },
      })
      job.stopLeft = () => watch.stopLeft()
    })
    if (job.endedAt === null && job.shellExitedAt === null) {
      // A run adopted after a restart keeps the deadline it started with.
      job.timer = setTimeout(() => stop(job, 'timeout'), Math.max(0, job.startedAt + job.timeoutMs - now()))
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
    return finished
  }

  /** Lists a detached run for a launcher's rollback stop (detached-registry.ts), once ps named its start. */
  async function listDetached(job: Job): Promise<void> {
    if (job.pid === null) return
    if (!stopScriptPut) { stopScriptPut = true; void installStopScript(registryDir) }
    const lstart = await processStart(job.pid)
    if (!lstart || job.endedAt !== null) return
    // The start a later daemon checks before it adopts or signals this pid (host-exec-recall.ts `listed`).
    audit({ event: 'listed', jobId: job.id, pid: job.pid, lstart })
    await registerRun(registryDir, {
      kind: 'host-exec', id: job.id, pid: job.pid, pgid: job.pid, lstart,
      noteFile: job.logFile, note: `[walnut] ${ROLLBACK_NOTE}`,
      lineFile: auditFile, line: JSON.stringify({ at: new Date(now()).toISOString(), event: 'ended-by-update', jobId: job.id, taskId: job.taskId, reason: 'rollback' }),
    })
    // It may have ended while the entry was written: the end removes it, but only once.
    if (job.endedAt !== null) await unregisterRun(registryDir, 'host-exec', job.id)
  }

  function logSize(file: string): number {
    try { return fs.statSync(file).size } catch { return 0 }
  }

  /** The job, when it exists and the asking task (if named) is the one that started it. */
  function own(jobId: unknown, taskId: unknown): Job | undefined {
    const j = typeof jobId === 'string' ? jobOf(jobId) : undefined
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
    // A detached run an earlier daemon left is adopted first, so it never reads as ended meanwhile.
    await adoptedFirst(req.jobId, typeof req.by === 'number' && Number.isFinite(req.by) ? req.by : undefined)
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
    await adoptedFirst(req.jobId)
    await started(req.jobId)
    const j = own(req.jobId, req.taskId)
    if (!j) return bad(`no job ${String(req.jobId)} on this host`, 'unknown_job')
    stop(j, 'asked')
    return view(j)
  }

  /** Every job here, or one task's (`taskId`), newest first. */
  function list(req: { taskId?: unknown } = {}): JobView[] {
    prune()
    adoptOrphans()
    const task = typeof req.taskId === 'string' && req.taskId ? req.taskId : null
    const earlier = recall.list((id) => jobs.has(id))
    return [...jobs.values(), ...earlier].filter((j) => task === null || j.taskId === task).sort((a, b) => b.startedAt - a.startedAt).map(view)
  }

  /**
   * A forced daemon update (daemon-update-behind.ts) is about to end the runs: each run's log
   * and the audit say so, and the run is stopped, so a later read of the log tells its task
   * why it ended instead of stopping mid-line. With `only: 'resumable'` (a plain update, which
   * waited for every other run) it ends only the resumable runs, at once (SIGKILL: they only wait), and
   * no script. A run it ends reads `daemonEnded`, never as a host_exec_stop. Returns how many it stopped.
   */
  function endForUpdate(note: string, only?: 'resumable'): number {
    let n = 0
    for (const j of jobs.values()) {
      // Ended, asked to stop, or noted already (a forced update, then the stop): one line per run.
      // A detached run outlives this daemon and the next one follows it (endForRollback ends it).
      if (j.endedAt !== null || j.killed || j.noted || j.detached || (only === 'resumable' && !j.resumable)) continue
      j.noted = true
      try { fs.appendFileSync(j.logFile, `\n[walnut] ${note}\n`) } catch { /* the log is gone */ }
      audit({ event: 'ended-by-update', jobId: j.id, taskId: j.taskId })
      stop(j, 'daemon', only === 'resumable')
      n++
    }
    // A plugin's script keeps no log: it is only stopped (its answer says timedOut).
    if (only !== 'resumable') n += scripts.stopAll()
    return n
  }

  /**
   * The next daemon here is a version that cannot follow detached runs (a rollback: the update
   * asking for this daemon's place did not say it adopts them): each one's log and the audit say so,
   * and it is stopped. Returns how many it stopped (detached plugin scripts too).
   */
  function endForRollback(): number {
    let n = 0
    for (const j of jobs.values()) {
      if (j.endedAt !== null || !j.detached || j.endedBy === 'rollback') continue
      j.endedBy = 'rollback'
      try { fs.appendFileSync(j.logFile, `\n[walnut] ${ROLLBACK_NOTE}\n`) } catch { /* the log is gone */ }
      audit({ event: 'ended-by-update', jobId: j.id, taskId: j.taskId, reason: 'rollback' })
      stop(j, 'daemon')
      n++
    }
    return n + (scripts.endForRollback?.() ?? 0)
  }

  /** Running jobs (the server's per-host cap reads the host's own count after a restart). */
  function running(): number {
    let n = 0
    for (const j of jobs.values()) if (j.endedAt === null) n++
    return n
  }

  /** Running jobs a daemon update waits for: all but the resumable and the detached ones (plugin scripts are `scripts`). */
  function holding(): number {
    let n = 0
    for (const j of jobs.values()) if (j.endedAt === null && !j.resumable && !j.detached) n++
    return n
  }

  /** Running detached jobs: a handover to a daemon that cannot adopt them ends them (endForRollback). */
  function detachedRunning(): number {
    let n = 0
    for (const j of jobs.values()) if (j.endedAt === null && j.detached) n++
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
    script: (req: Record<string, unknown>) => thrown<ScriptResult>(scripts.script(req)),
    /** Plugin scripts running now (exec.script): a handover waits for them as for jobs. */
    scripts: scripts.count,
    /** Detached plugin scripts running now (they hold no handover). */
    detachedScripts: scripts.detachedCount,
    read: (req: Parameters<typeof read>[0]) => thrown(read(req)),
    kill: (req: { jobId?: unknown; taskId?: unknown }) => thrown<JobView>(stopJob(req)),
    list: async (req: { taskId?: unknown } = {}) => ({ jobs: list(req) }),
    running,
    holding,
    /** A run marked resumable that this daemon runs: a read of it holds no handover (the twins' dispatch). */
    resumableJob: (jobId: unknown): boolean => typeof jobId === 'string' && jobs.get(jobId)?.resumable === true,
    /** The running jobs' task and folder, read at once (task directory cleanup keeps what they work in). */
    active: (): Array<{ taskId: string | null; cwd: string }> =>
      [...jobs.values()].filter((j) => j.endedAt === null).map((j) => ({ taskId: j.taskId ?? null, cwd: j.cwd })),
    endForUpdate,
    endForRollback,
    detachedRunning,
    /** Where detached runs are listed for a rollback's stop (detached-registry.ts). */
    registryDir,
    /** The runs endForUpdate stopped have ended (their reads answered), or `ms` passed: the twins' stopDaemon drains it. */
    untilEnded: (ms: number) => untilEndedByDaemon(jobs.values(), ms),
    /** File looks in flight `minAgeMs` or more (default STUCK_LOOK_MS; 0: any) in the thread pool: node's exit would wait on them (daemon-source.ts). */
    stuck: (minAgeMs?: number) => stuckFileLooks(Date.now(), minAgeMs) > 0,
    /** End the matcher process (the daemon's shutdown, tests). */
    close: () => { clearInterval(adoptTimer); scripts.stopAll(); matcher?.close() },
  }
}

export type HostExec = ReturnType<typeof createHostExec>
