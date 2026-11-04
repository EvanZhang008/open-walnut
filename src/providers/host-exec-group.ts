/**
 * How a host_exec job's process ends (host-exec-core.ts): its shell's exit ends the job.
 *
 * With `endGroup` (the server asks for it on each run: exec.run `endGroup`, 'host-exec-group-v1'),
 * what the shell left running in the job's process group is stopped with it, whatever that does
 * with its output (2026-11-04 usability review: `python3 -m http.server ... > srv.log 2>&1 &` kept
 * serving after its job exited 0, in the job's own group, where host_exec_list and host_exec_stop
 * never reach it). At the shell's exit, what is left in its group gets EXIT_DRAIN_MS to end by
 * itself (a last line of output, a file written), then SIGTERM, and SIGKILL after KILL_GRACE_MS;
 * the answer names it (`leftCommands`, from ps). The job's pipes stay open while its group has
 * members, so what they print as they stop is kept; once the group is empty, a process still
 * holding them left the group (a tool that daemonizes, one started in a new session): the job stops
 * reading them, and the answer says so (`outputCut`), and that it runs on (2026-11-04 review: an
 * ordinary `cmd &` that kept the job's output was told as a process outside the group).
 *
 * Without `endGroup` (a server older than host-exec-group-v1, whose help promises only this), as
 * before: a run whose output is still held EXIT_DRAIN_MS after its shell exited has its group sent
 * SIGTERM and its pipes closed; a child that sent its output elsewhere keeps running.
 *
 * A group's number is free again once its last member ended (its leader, the shell, has exited), and
 * a new program may then lead a group of that number. So a group signal goes out only while ps
 * shows a member and no process leading the group (a leader there is another program's), and the
 * SIGKILL only while a process the SIGTERM went to (by pid and start time) is still in it
 * (2026-11-04 review: the 0.1 to 3 s between a look and a signal).
 *
 * Once the shell exited, the job's deadline and a stop no longer judge the run (it ended by itself,
 * `onExit`): a stop in that window only stops what it left at once (2026-11-04 review: a deadline
 * there answered "stopped at its deadline (exit 0)" and the `&` child it stopped was never named).
 *
 * Bundled into host-exec-core (the binary daemon and the host-exec-core.cjs sidecar), so both twins
 * stop a job's group the same way. It signals only through the twin's own `killGroup`.
 */
import type { ChildProcess, SpawnOptions } from 'node:child_process'

/** How long the pipes may stay open, and the group keep members, after the shell exited. */
export const EXIT_DRAIN_MS = 2_000
const KILL_GRACE_MS = 3_000
const GROUP_POLL_MS = 100
/** How long ps may take to name what is stopped. */
const PS_MS = 1_000
/** With endGroup: the pipes stay open at most this long after the shell's exit while its group still has members. */
const DRAIN_MAX_MS = EXIT_DRAIN_MS + PS_MS + KILL_GRACE_MS + 1_000
const NAMES_MAX = 3
const NAME_MAX = 160

export interface ShellEnd {
  code: number | null
  signal: string | null
  error?: string
  /** Something it left running in its group at the shell's exit was stopped. */
  leftBehind: boolean
  /** What was stopped in its group, as ps named it (absent when ps could not say). */
  leftCommands?: string[]
  /**
   * A process outside the group (a tool that daemonizes, one in a new session) still held the
   * job's output once the group was empty: the job stopped reading it, and that process still runs.
   */
  outputCut: boolean
}

export interface ShellEndWatch {
  /** The job's process group (its shell's pid), null when it has none. */
  pgid: number | null
  /** The line the shell ran: a subshell of it (`( ... ) &`) shows that line, and is not named on its own. */
  line: string
  /** Stop what the shell left in its group (the server asked, exec.run `endGroup`); else as before host-exec-group-v1. */
  endGroup?: boolean
  killGroup: (pid: number, signal: NodeJS.Signals | 0) => void
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess
  /** The shell exited (once, before onEnd): from here its deadline and a stop no longer judge it. */
  onExit?: () => void
  onEnd: (end: ShellEnd) => void
}

/** What a watch lets its job do once the shell exited: stop what it left now, not after EXIT_DRAIN_MS. */
export interface ShellEndHandle { stopLeft(): void }

/** A process in the job's group, as ps lists it. */
export interface GroupMember { pid: number; pgid: number; start: string; command: string }

/** Watch a job's shell to its end: `onEnd` once, after its group was settled and its pipes closed. */
export function watchShellEnd(child: ChildProcess, o: ShellEndWatch): ShellEndHandle {
  let done = false
  let exit: { code: number | null; signal: string | null } | null = null
  let closed = false
  let cut = false
  // Without endGroup: the group was sent SIGTERM because it still held the output (as before).
  let heldStopped = false
  let group: Promise<string[] | null> | null = null
  const hurry = { now: false, wake: () => {} }
  const finish = (left: string[] | null, error?: string) => {
    if (done) return
    done = true
    o.onEnd({
      code: exit?.code ?? null, signal: exit?.signal ?? null, ...(error ? { error } : {}),
      leftBehind: left !== null, ...(left && left.length ? { leftCommands: left } : {}), outputCut: cut,
    })
  }
  const settle = () => { if (closed && group) void group.then((left) => finish(left ?? (heldStopped ? [] : null))) }
  const exited = () => { if (!group) { group = o.endGroup ? settleGroup(o, hurry) : Promise.resolve(null); o.onExit?.() } }
  const closePipes = () => {
    if (done || closed) return
    child.stdout?.destroy()
    child.stderr?.destroy()
    closed = true
    settle()
  }
  // As before host-exec-group-v1: a group that still holds the output gets SIGTERM, and no SIGKILL.
  const stopHeld = async () => {
    if (heldStopped || !groupHas(o)) return
    heldStopped = true
    if ((await stopGroup(o, false)) === 'gone') heldStopped = false
  }
  child.on('error', (err) => finish(null, err.message))
  child.on('exit', (code, signal) => {
    exit = { code, signal }
    exited()
    settle()
    const exitAt = Date.now()
    // The group seen empty once: the pipes get one more turn, as a member that just ended (and was
    // reaped) may have left an end of file not read yet (2026-11-04 review: a busy loop runs this
    // timer before it reads the pipes, and an ordinary `cmd &` was told as outside the group).
    let emptySeen = false
    const drain = async () => {
      if (done || closed) return
      const members = groupHas(o)
      if (!members && !emptySeen) { emptySeen = true; arm(GROUP_POLL_MS); return }
      if (!o.endGroup) {
        await stopHeld()
        cut = !heldStopped
        closePipes()
        return
      }
      // A member of the group still holds them while it is stopped (settleGroup): they close as it ends.
      if (members && Date.now() - exitAt < DRAIN_MAX_MS) { arm(GROUP_POLL_MS); return }
      // Its group is empty: what still holds them left it, and runs on.
      cut = !members
      closePipes()
    }
    const arm = (ms: number) => { const t = setTimeout(() => { void drain() }, ms); t.unref?.() }
    arm(EXIT_DRAIN_MS)
  })
  child.on('close', (code, signal) => {
    // A close comes once the shell exited, whichever event a runtime emits first.
    exit ??= { code, signal }
    closed = true
    exited()
    settle()
  })
  return {
    stopLeft: () => {
      if (!group) return
      if (!o.endGroup) { void stopHeld(); return }
      if (!hurry.now) { hurry.now = true; hurry.wake() }
    },
  }
}

/** Whether the job's group has a member now (EPERM: one this user may not signal is still one). */
function groupHas(o: ShellEndWatch): boolean {
  const pgid = o.pgid
  if (pgid === null || pgid <= 1) return false
  try { o.killGroup(pgid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

/**
 * SIGTERM to the job's group, unless its number is another program's by now: ps shows a process
 * leading the group (the job's leader, its shell, has exited) or no member at all ('gone', nothing
 * sent). `hard`: SIGKILL after KILL_GRACE_MS while one of those it went to is still in the group.
 * The members it went to; null when ps could not say (the signal goes out as before).
 */
async function stopGroup(o: ShellEndWatch, hard: boolean): Promise<GroupMember[] | null | 'gone'> {
  const pgid = o.pgid!
  const seen = await groupMembers(pgid, o)
  if (seen && (seen.length === 0 || seen.some((m) => m.pid === pgid))) return 'gone'
  try { o.killGroup(pgid, 'SIGTERM') } catch { return 'gone' } // it ended in between
  if (hard) {
    const t = setTimeout(() => { void killStill(o, pgid, seen) }, KILL_GRACE_MS)
    t.unref?.()
  }
  return seen
}

/** The SIGKILL after a SIGTERM: only while a process it went to is still in the group (ps unread: while it has a member). */
async function killStill(o: ShellEndWatch, pgid: number, seen: GroupMember[] | null): Promise<void> {
  if (!groupHas(o)) return
  if (seen) {
    const now = await groupMembers(pgid, o)
    if (now && !now.some((m) => seen.some((s) => s.pid === m.pid && s.start === m.start))) return
  }
  try { o.killGroup(pgid, 'SIGKILL') } catch { /* gone */ }
}

/**
 * What the shell left in its group: null when the group is empty (at once, or within
 * EXIT_DRAIN_MS); else it is stopped, and the commands ps names for it come back ([]: ps could not
 * say). `hurry.now` (a stop or the deadline in that window) stops it at once.
 */
async function settleGroup(o: ShellEndWatch, hurry: { now: boolean; wake: () => void }): Promise<string[] | null> {
  const pgid = o.pgid
  if (pgid === null || pgid <= 1) return null
  const until = Date.now() + EXIT_DRAIN_MS
  while (groupHas(o)) {
    if (hurry.now || Date.now() >= until) {
      const stopped = await stopGroup(o, true)
      return stopped === 'gone' ? null : stopped ? memberNames(stopped, o.line) : []
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, GROUP_POLL_MS)
      t.unref?.()
      hurry.wake = () => { clearTimeout(t); resolve() }
    })
  }
  return null
}

/**
 * The members of group `pgid` as ps lists them; null when ps does not answer in PS_MS, or answers
 * rows it does not read. Rows are read as they come and only this group's are kept, with each
 * row's head (ROW_HEAD_MAX): the listing has no cap, so a host with many long command lines (a
 * Java classpath, 1 MB of ps in all) never loses the job's members, which ps lists last.
 */
function groupMembers(pgid: number, o: ShellEndWatch): Promise<GroupMember[] | null> {
  return new Promise((resolve) => {
    const rows = psRowReader(pgid)
    let settled = false
    let ps: ChildProcess | undefined
    const done = (r: GroupMember[] | null) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r) } }
    // A ps that does not answer in time is ended, not left behind at every job's end (2026-11-05 review).
    const timer = setTimeout(() => { try { ps?.kill('SIGKILL') } catch { /* gone */ } done(null) }, PS_MS)
    timer.unref?.()
    try {
      // -ww: macOS ps cuts a row to the terminal's width (79 columns into a pipe) without it.
      ps = o.spawn('ps', ['-A', '-ww', '-o', 'pid=', '-o', 'pgid=', '-o', 'lstart=', '-o', 'command='], { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/bin:/usr/bin', LC_ALL: 'C' } })
    } catch {
      done(null)
      return
    }
    ps.stdout?.setEncoding('utf8')
    ps.stdout?.on('data', (chunk: string) => rows.push(chunk))
    ps.on('error', () => done(null))
    ps.on('close', () => done(rows.end()))
  })
}

/** At most this much of a row is kept: its pid, group, start and the head of its command. */
const ROW_HEAD_MAX = 4096
// `ps -o pid= -o pgid= -o lstart= -o command=` with LC_ALL=C: `  812   812 Wed Nov  4 10:00:00 2026 sleep 30`.
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})(?:\s+([^]*\S))?\s*$/

/** Reads ps output as it comes: the rows of group `pgid`; null when it listed nothing or a row is not one. */
export function psRowReader(pgid: number): { push(chunk: string): void; end(): GroupMember[] | null } {
  const kept: GroupMember[] = []
  let line = ''
  let any = false
  let bad = false
  const take = (row: string) => {
    if (bad || !row.trim()) return
    const m = PS_ROW.exec(row)
    if (!m) { bad = true; return }
    any = true
    if (Number(m[2]) === pgid) kept.push({ pid: Number(m[1]), pgid, start: m[3]!.replace(/\s+/g, ' '), command: m[4] ?? '' })
  }
  return {
    push(chunk) {
      let at = 0
      for (let nl = chunk.indexOf('\n'); nl !== -1; nl = chunk.indexOf('\n', at)) {
        if (line.length < ROW_HEAD_MAX) line += chunk.slice(at, Math.min(nl, at + ROW_HEAD_MAX - line.length))
        take(line)
        line = ''
        at = nl + 1
      }
      if (line.length < ROW_HEAD_MAX) line += chunk.slice(at, at + ROW_HEAD_MAX - line.length)
    },
    end() {
      take(line)
      line = ''
      return bad || !any ? null : kept
    },
  }
}

/** The commands of the members, without copies of the job's own shell (a subshell shows its line), at most NAMES_MAX. */
export function memberNames(members: GroupMember[], line: string): string[] {
  const own = line.split('\n')[0]!.trim().slice(0, 60)
  const names: string[] = []
  for (const m of members) {
    if (!m.command || (own.length >= 8 && m.command.includes(own))) continue
    const name = m.command.slice(0, NAME_MAX)
    if (!names.includes(name)) names.push(name)
    if (names.length >= NAMES_MAX) break
  }
  return names
}
