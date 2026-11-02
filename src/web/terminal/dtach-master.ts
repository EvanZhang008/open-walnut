/**
 * The dtach master of one terminal: found by the pid it recorded, never by a
 * pattern, and signalled only after its identity is proved.
 *
 * 2026-10-31: a pattern kill matched the command line of every agent session on
 * the Mac and ended them all. The terminal code used to find its master the
 * same way (`pgrep -f <socket>` / `pkill -f <socket>`), so any process whose
 * command line merely named the socket (an agent's `ls`, `grep` or `cat` of the
 * terminal dir, a `script` wrapper) was matched and signalled with it.
 *
 * Now every master records itself. spawn.ts starts the terminal's shell through
 * a tiny `/bin/sh -c` wrapper (dtachRecordScript): the wrapper runs as the
 * master's child, so its `$PPID` IS the master, and it writes that pid and its
 * start time to `<socket dir>/walnut-<sid>.dpid` before it execs the login
 * shell. A master an older Walnut started has no such file: its pid is read from
 * the socket's owner (`lsof -t` on the socket path; only the listening master
 * holds it, attached clients do not; on a Linux host without lsof, the
 * listening socket's inode from /proc/net/unix and the fds that point at it),
 * and with neither nothing is signalled and the skip is logged.
 *
 * A candidate pid is the master only when all of these hold:
 *   - it is alive and its start time is the recorded one (a pid reused by
 *     another process after a reboot has another start time); a socket-owner
 *     candidate has no record, so the start time read in the probe is the one
 *     the signal re-checks;
 *   - its argv is a dtach master's for THIS socket, compared by element:
 *     argv[0] is a dtach binary (`dtach` or `walnut-dtach`), argv[1] a create
 *     mode (`-A`, `-c`, `-n`, `-N`) and argv[2] exactly the socket path. A shell
 *     whose command merely mentions the path fails it.
 * The signal is SIGTERM to that one pid (never a group, never -1 or 0), and the
 * signalling script re-checks the start time right before it, so a pid that
 * changed hands between the probe and the signal is left alone.
 *
 * Every step runs as one bounded shell script through the caller's runner (a
 * local `bash -c`, or ssh for a remote host), never a sync call on the loop.
 */

import path from 'node:path'
import { execFile } from 'node:child_process'
import { log } from '../../logging/index.js'

export interface ShellResult { code: number; stdout: string; stderr: string }
export type ShellRunner = (script: string) => Promise<ShellResult>

const CMD_TIMEOUT_MS = 8_000

/** The local runner: `bash -c`, bounded. */
export function localShellRunner(script: string): Promise<ShellResult> {
  return new Promise((resolve) => {
    execFile('bash', ['-c', script], { timeout: CMD_TIMEOUT_MS, encoding: 'utf-8' }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

const q = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'"

/** Where a master's pid record lives: beside its socket, `walnut-<sid>.dpid`. */
export function dtachPidFileFor(socketPath: string): string {
  return socketPath.endsWith('.dsock') ? `${socketPath.slice(0, -'.dsock'.length)}.dpid` : `${socketPath}.dpid`
}

/**
 * A shell function printing a pid's start time, empty when the pid is gone:
 * `proc:<clock ticks since boot>` from /proc/<pid>/stat on Linux (exact, any
 * locale, BusyBox included), else `ps:<lstart>` in the C locale and UTC. The
 * record and every check run on the same host, so they always use one form.
 */
export const START_FN = 'walnut_st() { if [ -r "/proc/$1/stat" ]; then s=$(sed \'s/^.*) //\' "/proc/$1/stat" 2>/dev/null | cut -d" " -f20); '
  + '[ -n "$s" ] && printf "proc:%s\\n" "$s"; else s=$(LC_ALL=C LANG=C TZ=UTC ps -o lstart= -p "$1" 2>/dev/null | awk \'{ $1 = $1; print }\'); '
  + '[ -n "$s" ] && printf "ps:%s\\n" "$s"; fi; return 0; }'

/**
 * The script dtach runs in its pty as `/bin/sh -c <script> <shell>`: record the
 * master (`$PPID`) and its start time, atomically, then exec the login shell
 * (`$0 -l`). A failed record changes nothing for the user: the shell still starts.
 */
export function dtachRecordScript(pidFile: string): string {
  const tmp = `${pidFile}.tmp`
  return `${START_FN}; s=$(walnut_st "$PPID"); `
    + `[ -n "$s" ] && { printf "%s\\n%s\\n" "$PPID" "$s" > ${q(tmp)} && mv -f ${q(tmp)} ${q(pidFile)}; } 2>/dev/null; `
    + 'exec "$0" -l'
}

/** Is this argv a dtach master's (or a client's started the same way) for exactly `socketPath`? */
export function isDtachArgvFor(argv: readonly string[], socketPath: string): boolean {
  const bin = path.posix.basename(argv[0] ?? '')
  return /^(?:walnut-)?dtach$/.test(bin) && ['-A', '-c', '-n', '-N'].includes(argv[1] ?? '') && argv[2] === socketPath
}

export interface ProcInfo { pid: number; start: string; argv: string[] }
export interface DtachProbe {
  recorded: { pid: number; start: string } | null
  /** The host could look up the socket's owner (lsof, or /proc on Linux). */
  ownerLookup: boolean
  owners: number[]
  procs: Map<number, ProcInfo>
  socketExists: boolean
  /** The probe ran to its end (a timeout or a dropped ssh gives no answer, never "free"). */
  complete: boolean
  /** `pid ppid comm` rows of the whole process table, when asked for. */
  table: string[]
}

const validPid = (s: string | undefined): number | null => {
  const n = /^\d+$/.test(s ?? '') ? Number(s) : NaN
  return Number.isSafeInteger(n) && n > 1 ? n : null
}

/**
 * A shell function setting `owners` (the pids holding the socket `$1`) and
 * `lookup`: lsof, else (Linux without lsof) the inode of the LISTENING socket
 * bound to this exact path in /proc/net/unix (flags 00010000), then the
 * processes holding an fd to that inode. A lookup that could not run (no
 * -lname in this find, no listening entry for a socket that exists) is no
 * answer: `lookup` stays "no" and the socket is kept. Paths with a space never
 * match in /proc/net/unix: fail closed.
 */
const OWNERS_FN = 'walnut_owners() { owners=; lookup=no; '
  + 'if command -v lsof >/dev/null 2>&1; then lookup=lsof; [ -S "$1" ] && owners=$(lsof -t -- "$1" 2>/dev/null | tr "\\n" " "); '
  + 'elif [ -r /proc/net/unix ] && find /proc/self/fd -maxdepth 0 -lname x >/dev/null 2>&1; then '
  + 'if [ -S "$1" ]; then ino=$(awk -v p="$1" \'$NF == p && $4 == "00010000" { print $7; exit }\' /proc/net/unix 2>/dev/null); '
  + 'case "$ino" in ""|*[!0-9]*) ;; *) lookup=proc; owners=$(find /proc/[0-9]*/fd -lname "socket:\\[$ino\\]" 2>/dev/null | cut -d/ -f3 | sort -u | tr "\\n" " ") ;; esac; '
  + 'else lookup=proc; fi; fi; return 0; }'

/**
 * One round trip: the record, the socket's owners, each candidate's start time
 * and argv (exact from /proc/<pid>/cmdline on Linux; on macOS `ps` joins argv
 * with spaces, so a socket path with a space in it never matches, which fails
 * closed), and optionally the process table for the foreground check.
 */
export function dtachProbeScript(socketPath: string, withTable = false): string {
  const sock = q(socketPath)
  const rec = q(dtachPidFileFor(socketPath))
  return [
    START_FN,
    `SOCK=${sock}`,
    'walnut_proc() { echo "PROC:$1"; echo "START:$(walnut_st "$1")"; '
      + 'if [ -r "/proc/$1/cmdline" ]; then tr "\\000" "\\n" < "/proc/$1/cmdline" | sed "s/^/ARG:/"; '
      + 'else LC_ALL=C ps -ww -o command= -p "$1" 2>/dev/null | tr " " "\\n" | sed "/^$/d; s/^/ARG:/"; fi; echo "ENDPROC"; }',
    `rp=$(sed -n 1p ${rec} 2>/dev/null); rs=$(sed -n 2p ${rec} 2>/dev/null)`,
    'echo "REC:$rp"; echo "RECSTART:$rs"',
    OWNERS_FN,
    // A record that still names a live process with its start time needs no owner
    // lookup (lsof costs about 0.4 s); its argv is checked in chooseDtachMaster.
    'owners=; lookup=no',
    'if [ -n "$rp" ] && [ -n "$rs" ] && [ "$(walnut_st "$rp")" = "$rs" ]; then lookup=skipped; else walnut_owners "$SOCK"; fi',
    'echo "LOOKUP:$lookup"',
    'echo "OWNERS:$owners"',
    'for c in $rp $owners; do case "$c" in ""|*[!0-9]*) continue ;; esac; [ "$c" -gt 1 ] && walnut_proc "$c"; done',
    `if [ -S ${sock} ]; then echo "SOCKET:yes"; else echo "SOCKET:no"; fi`,
    'echo "PROBE:END"',
    ...(withTable ? ['echo "TABLE:"', 'ps -ax -o pid=,ppid=,comm='] : []),
  ].join('\n')
}

export function parseDtachProbe(stdout: string): DtachProbe {
  const lines = stdout.split('\n')
  const probe: DtachProbe = { recorded: null, ownerLookup: false, owners: [], procs: new Map(), socketExists: false, complete: false, table: [] }
  let recPid: number | null = null
  let recStart = ''
  let cur: ProcInfo | null = null
  let inTable = false
  for (const line of lines) {
    if (inTable) { probe.table.push(line); continue }
    if (cur) {
      if (line === 'ENDPROC') { probe.procs.set(cur.pid, cur); cur = null }
      else if (line.startsWith('START:')) cur.start = line.slice(6).trim()
      else if (line.startsWith('ARG:')) cur.argv.push(line.slice(4))
      continue
    }
    if (line.startsWith('REC:')) recPid = validPid(line.slice(4).trim())
    else if (line.startsWith('RECSTART:')) recStart = line.slice(9).trim()
    else if (line.startsWith('LOOKUP:')) probe.ownerLookup = ['lsof', 'proc'].includes(line.slice(7).trim())
    else if (line.startsWith('OWNERS:')) probe.owners = line.slice(7).trim().split(/\s+/).map(validPid).filter((p): p is number => p !== null)
    else if (line.startsWith('PROC:')) { const pid = validPid(line.slice(5).trim()); cur = pid ? { pid, start: '', argv: [] } : null }
    else if (line.startsWith('SOCKET:')) probe.socketExists = line.slice(7).trim() === 'yes'
    else if (line === 'PROBE:END') probe.complete = true
    else if (line === 'TABLE:') inTable = true
  }
  if (recPid !== null && recStart) probe.recorded = { pid: recPid, start: recStart }
  return probe
}

export interface MasterChoice {
  /** Verified masters, each with the start time the signal re-checks. */
  targets: Array<{ pid: number; start: string }>
  source: 'recorded' | 'socket-owner' | 'none'
  /** Why nothing was chosen, for the log. */
  reason?: string
}

/** Pick the verified master(s) from a probe. Pure: the guard every signal goes through. */
export function chooseDtachMaster(probe: DtachProbe, socketPath: string): MasterChoice {
  const rec = probe.recorded
  if (rec) {
    const p = probe.procs.get(rec.pid)
    if (p && p.start && p.start === rec.start && isDtachArgvFor(p.argv, socketPath)) {
      return { targets: [{ pid: rec.pid, start: rec.start }], source: 'recorded' }
    }
  }
  const owners = probe.owners
    .map((pid) => probe.procs.get(pid))
    .filter((p): p is ProcInfo => !!p && !!p.start && isDtachArgvFor(p.argv, socketPath))
  if (owners.length > 0) return { targets: owners.map((p) => ({ pid: p.pid, start: p.start })), source: 'socket-owner' }
  const why = rec ? 'the recorded pid is gone or is another process now' : 'no pid record'
  if (!probe.ownerLookup) return { targets: [], source: 'none', reason: `${why}, and no way on the host to read the socket's owner (no lsof, no /proc)` }
  if (probe.owners.length > 0) return { targets: [], source: 'none', reason: `${why}, and the socket's owner is not a dtach master for it` }
  return { targets: [], source: 'none', reason: `${why}, and nothing holds the socket` }
}

/**
 * SIGTERM each verified master, each only while its start time is still the
 * one verified, then remove the socket and the record. Pids are re-validated
 * here (an integer above 1), so no caller can widen it to a group or to -1.
 */
export function dtachStopScript(targets: Array<{ pid: number; start: string }>, socketPath: string, removeFiles: boolean): string {
  const lines = [START_FN]
  for (const t of targets) {
    if (!Number.isSafeInteger(t.pid) || t.pid <= 1 || !t.start) continue
    lines.push(`if [ "$(walnut_st ${t.pid})" = ${q(t.start)} ]; then kill -TERM ${t.pid} 2>/dev/null && echo "SIGNALLED:${t.pid}"; else echo "CHANGED:${t.pid}"; fi`)
  }
  if (removeFiles) lines.push(`rm -f ${q(socketPath)} ${q(dtachPidFileFor(socketPath))} 2>/dev/null`)
  lines.push('echo DONE')
  return lines.join('\n')
}

/**
 * Remove a socket and record nobody holds, deciding again in this same script:
 * a terminal reopened since the probe has a new master holding the socket,
 * which keeps both files. With the socket gone, only the record is removed (a
 * new master writes its record after it binds its socket).
 */
export function dtachRemoveStaleScript(socketPath: string): string {
  const sock = q(socketPath)
  const rec = q(dtachPidFileFor(socketPath))
  return [
    OWNERS_FN,
    `if [ -S ${sock} ]; then walnut_owners ${sock}; if [ "$lookup" != no ] && [ -z "$owners" ]; then rm -f ${sock} ${rec}; echo REMOVED; else echo KEPT; fi; else rm -f ${rec}; echo REMOVED; fi`,
  ].join('\n')
}

export interface StopOutcome {
  outcome: 'stopped' | 'nothing' | 'left'
  source: MasterChoice['source']
  signalled: number[]
  reason?: string
}

/**
 * End the dtach master holding `socketPath`. 'stopped': a verified master got
 * SIGTERM. 'nothing': no master runs (a stale socket or record), and the files
 * are removed. 'left': something may still hold the socket but could not be
 * proved to be its master, so nothing is signalled and the socket is kept (a
 * later open still reattaches it).
 */
export async function stopDtachMaster(run: ShellRunner, socketPath: string, ctx: Record<string, unknown> = {}): Promise<StopOutcome> {
  const probe = parseDtachProbe((await run(dtachProbeScript(socketPath))).stdout)
  if (!probe.complete) {
    log.web.warn('dtach master probe gave no answer, nothing signalled', { ...ctx, socketPath })
    return { outcome: 'left', source: 'none', signalled: [], reason: 'the probe did not finish' }
  }
  const choice = chooseDtachMaster(probe, socketPath)
  if (choice.targets.length === 0) {
    // Nobody could hold it: the socket is gone, or the owner lookup says no process has it open.
    const free = !probe.socketExists || (probe.ownerLookup && probe.owners.length === 0)
    if (free) {
      await run(dtachRemoveStaleScript(socketPath))
      return { outcome: 'nothing', source: 'none', signalled: [], reason: choice.reason }
    }
    log.web.warn('dtach master not verified, nothing signalled', { ...ctx, socketPath, reason: choice.reason })
    return { outcome: 'left', source: 'none', signalled: [], reason: choice.reason }
  }
  const res = await run(dtachStopScript(choice.targets, socketPath, true))
  const signalled = [...res.stdout.matchAll(/^SIGNALLED:(\d+)$/gm)].map((m) => Number(m[1]))
  const changed = [...res.stdout.matchAll(/^CHANGED:(\d+)$/gm)].map((m) => Number(m[1]))
  if (changed.length) log.web.warn('dtach master changed before the signal, left alone', { ...ctx, socketPath, changed })
  return { outcome: signalled.length ? 'stopped' : 'nothing', source: choice.source, signalled }
}
