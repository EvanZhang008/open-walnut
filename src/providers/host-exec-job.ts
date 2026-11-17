/**
 * A host_exec job as the daemon keeps it (host-exec-core.ts), the exec.run request that starts it
 * (RunRequest), and how an answer shows it (JobView).
 * Bundled into host-exec-core (the binary daemon and the host-exec-core.cjs sidecar).
 */
import type { PromptBlock } from './host-exec-watch.js'
import type { HeldBefore } from './host-exec-wait.js'

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
  /**
   * The run only waits or reads, and its caller runs it again if it ends: a daemon update does not
   * wait for it (`holding`) and ends it with a note in its log. An older daemon ignores the field
   * and its answer has no `resumable`, so there the run holds an update as every run does.
   */
  resumable?: unknown
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
  /** When its shell exited, processes it started in the background (`cmd &`) still ran, and they were stopped with it. */
  leftBehind: boolean
  /** What of those was stopped, as ps named it (host-exec-group.ts). */
  leftCommands?: string[]
  /** A process outside its group still held its output when its shell exited: Walnut stopped reading it, and it still runs. */
  outputCut?: true
  /**
   * While it runs: its shell has exited (the run is over: what it left in its group is being
   * stopped, within a few seconds), so `running` is only that settling (2026-11-04 review: a
   * background `server &` read as running and "keeps running" until the server was stopped).
   */
  shellExited?: true
  /** While its shell runs: how long to its deadline (0: it is being stopped there), in this host's time. */
  deadlineInMs?: number
  /**
   * The daemon that ran it stopped before it ended (an update or a crash), so no exit was kept: it
   * reads ended, as of its log's last write (host-exec-recall.ts).
   */
  daemonEnded?: true
  /**
   * The caller said the run only waits or reads (exec.run `resumable`): a daemon update never waits
   * for it, ends it with a note in its log, and the caller runs it again (exec-runs-hold.ts).
   */
  resumable?: true
}

export interface RunReply extends JobView {
  /** The last `maxOutputBytes` of the output (stdout and stderr in the order written). */
  output: string
  truncated: boolean
}

export interface Job {
  id: string
  pid: number | null
  startedAt: number
  endedAt: number | null
  /** When its shell exited (the job ends once what it left is settled), else null. */
  shellExitedAt: number | null
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
  leftBehind: boolean
  leftCommands?: string[]
  outputCut: boolean
  timeoutMs: number
  /** What a wait_for given with the run saw before it started: the ports already listening, the files already there. */
  before: HeldBefore
  unwatch: (() => void) | null
  /** Stops what the shell left in its group at once (host-exec-group.ts), once the shell exited. */
  stopLeft: (() => void) | null
  bytes: number
  tail: Buffer[]
  tailBytes: number
  tailMax: number
  waiters: Array<() => void>
  timer: ReturnType<typeof setTimeout> | null
  /** Reads of it waiting on a wait_for now (host-exec-core.ts caps them). */
  waits: number
  /** Read back from the audit with no end line (host-exec-recall.ts): it ended with the daemon that ran it. */
  daemonEnded?: true
  /** A daemon update does not wait for it (JobView `resumable`). */
  resumable?: true
  /** Its log and the audit say a daemon update or stop ended it (endForUpdate): written once. */
  noted?: true
  /** Stopped because this daemon is going (endForUpdate): it reads `daemonEnded`, never as a host_exec_stop. */
  endedByDaemon?: true
}

export function jobView(j: Job, now: number): JobView {
  const running = j.endedAt === null
  return {
    jobId: j.id, running, exitCode: j.exitCode, signal: j.signal, timedOut: j.timedOut, killed: j.killed,
    startedAt: j.startedAt, ms: (j.endedAt ?? now) - j.startedAt, cwd: j.cwd, logFile: j.logFile, outputBytes: j.bytes,
    shell: j.shell, loginShell: j.loginShell, taskDir: j.taskDir, taskId: j.taskId, command: j.command, blocked: j.blocked,
    leftBehind: j.leftBehind, ...(j.leftCommands ? { leftCommands: j.leftCommands } : {}), ...(j.outputCut ? { outputCut: true as const } : {}),
    ...(running && j.shellExitedAt !== null ? { shellExited: true as const } : {}),
    ...(running && j.shellExitedAt === null ? { deadlineInMs: Math.max(0, j.startedAt + j.timeoutMs - now) } : {}),
    ...(j.daemonEnded || (!running && j.endedByDaemon) ? { daemonEnded: true as const } : {}),
    ...(j.resumable ? { resumable: true as const } : {}),
  }
}

/**
 * Resolves once every job here that a going daemon stopped (endForUpdate) has ended, or after `ms`:
 * the reads waiting on them are answered before the daemon closes its sockets.
 */
export function untilEndedByDaemon(jobs: Iterable<Job>, ms: number): Promise<void> {
  const open = [...jobs].filter((j) => j.endedByDaemon && j.endedAt === null)
  if (!open.length) return Promise.resolve()
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
    let left = open.length
    for (const j of open) j.waiters.push(() => { if (--left === 0) { clearTimeout(t); resolve() } })
  })
}
