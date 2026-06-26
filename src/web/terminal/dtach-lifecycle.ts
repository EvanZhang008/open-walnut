/**
 * dtach lifecycle helpers — when to keep vs reap the persistent dtach sessions.
 *
 * Core rule: connection-break events (WS flap, idle, server restart) NEVER kill
 * the dtach session — that's the whole point. Only explicit intent (user
 * "End terminal"), loss of ownership (session deleted), or a clean orphan sweep may
 * destroy it. Task completion uses a conditional kill: a dtach session running
 * a real foreground process (build/test) is kept; an idle shell is reaped.
 *
 * A dtach "session" is a unix socket (see dtachSocketPath) plus the detached
 * `dtach -A` master process holding the pty. Killing it = remove the socket and
 * kill the master process group; the shell under it dies with it.
 */

import { execFile } from 'node:child_process'
import type { SessionRecord } from '../../core/types.js'
import { resolveSshTarget, dtachSocketPath, DTACH_SOCKET_DIR, sshControlMasterArgs } from './spawn.js'
import { listSessions } from '../../core/session-tracker.js'
import { getConfig } from '../../core/config-manager.js'
import { shellQuote } from '../../providers/session-io.js'
import { log } from '../../logging/index.js'

const CMD_TIMEOUT_MS = 8_000

/** Shell names that mean "no foreground task" when reported as the descendant command. */
const SHELL_COMMANDS = new Set([
  'bash', 'zsh', '-zsh', '-bash', 'sh', '-sh', 'fish', '-fish',
  'tcsh', '-tcsh', 'csh', '-csh', 'ksh', 'dash', '-dash',
  'dtach', 'login',
])

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: CMD_TIMEOUT_MS, encoding: 'utf-8' }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

/**
 * Run a shell snippet locally, or wrapped in ssh for a remote host. Reuses the
 * shared ControlMaster socket (warmed by the probe/spawn) so lifecycle calls
 * don't each pay a fresh proxied SSH connection.
 */
async function runShell(host: string | undefined, script: string): Promise<{ code: number; stdout: string; stderr: string }> {
  if (!host) return run('bash', ['-c', script])
  const target = await resolveSshTarget(host)
  const hostString = target.user ? `${target.user}@${target.hostname}` : target.hostname
  const sshArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', ...sshControlMasterArgs(host)]
  if (target.port) sshArgs.push('-p', String(target.port))
  sshArgs.push(hostString, script)
  return run('ssh', sshArgs)
}

/**
 * Does the dtach session have a real foreground process (not just a shell)?
 * dtach has no `display-message`; instead we inspect the process tree under the
 * `dtach -A <socket>` master. If the deepest descendant is a plain shell →
 * idle; anything else (node/vim/npm/...) → a real task is running.
 *
 * Returns false when the session is absent or only an idle shell.
 *
 * We fetch the master pid (pgrep -f matches the full command line, which
 * includes the socket path) plus the WHOLE process table, then walk the tree in
 * JS. WHY `ps -ax -o pid=,ppid=,comm=` (and NOT `ps --ppid`): `--ppid` is
 * GNU-only and errors with "ps: illegal option" on macOS BSD ps; the BSD `-g`
 * fallback means process-GROUP-id (not pid) and pulls in the ps/head pipeline
 * procs. `ps -ax -o pid=,ppid=,comm=` is portable across macOS BSD ps and Linux
 * GNU ps, so we get the same table on both and resolve the leaf ourselves.
 */
export async function hasForegroundProcess(record: Pick<SessionRecord, 'claudeSessionId' | 'host'>): Promise<boolean> {
  const sock = dtachSocketPath(record.claudeSessionId)
  // One round-trip: print the master pid line, then the full process table.
  const script =
    `echo "MASTERPID:$(pgrep -f ${shellQuote(sock)} | head -1)"; ` +
    `ps -ax -o pid=,ppid=,comm=`
  const res = await runShell(record.host, script)
  const lines = res.stdout.split('\n')

  const masterLine = lines.find((l) => l.startsWith('MASTERPID:'))
  const masterPid = masterLine?.slice('MASTERPID:'.length).trim() ?? ''
  if (!masterPid) return false // no dtach master → no session

  // Build ppid → children[] adjacency from the ps table (skip the MASTERPID line).
  const children = new Map<string, { pid: string; comm: string }[]>()
  for (const line of lines) {
    if (line.startsWith('MASTERPID:')) continue
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    const [, pid, ppid, commRaw] = m
    // comm may be a full path (Linux GNU ps); take the basename for matching.
    const comm = commRaw.trim().split('/').pop() ?? ''
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid)!.push({ pid, comm })
  }

  // Walk down from the master to the deepest descendant (the foreground cmd).
  let leaf = ''
  let cur = masterPid
  const seen = new Set<string>()
  while (!seen.has(cur)) {
    seen.add(cur)
    const kids = children.get(cur)
    if (!kids || kids.length === 0) break
    // Follow the first child; on a single interactive terminal the tree is linear.
    const next = kids[0]
    leaf = next.comm
    cur = next.pid
  }
  if (!leaf) return false
  return !SHELL_COMMANDS.has(leaf)
}

/** Explicitly destroy a session's dtach session (kill master + remove socket). */
export async function killDtachSession(record: Pick<SessionRecord, 'claudeSessionId' | 'host'>): Promise<void> {
  const sock = dtachSocketPath(record.claudeSessionId)
  // Kill the dtach master process(es) bound to this socket, then unlink it.
  const script = `pkill -f ${shellQuote(sock)} 2>/dev/null; rm -f ${shellQuote(sock)} 2>/dev/null; echo DONE`
  const res = await runShell(record.host, script)
  if (/DONE/.test(res.stdout)) {
    log.web.info('dtach session killed', { sessionId: record.claudeSessionId, host: record.host })
  } else {
    log.web.debug('dtach kill noop (likely already gone)', { sessionId: record.claudeSessionId, host: record.host })
  }
}

/**
 * Conditional reap on task completion / session stop. Keeps the dtach session
 * if a foreground process is still running; otherwise kills it.
 * Returns 'killed' | 'kept'.
 */
export async function conditionalReap(record: Pick<SessionRecord, 'claudeSessionId' | 'host'>): Promise<'killed' | 'kept'> {
  if (await hasForegroundProcess(record)) {
    log.web.info('dtach kept (foreground process running)', { sessionId: record.claudeSessionId })
    return 'kept'
  }
  await killDtachSession(record)
  return 'killed'
}

/** List walnut dtach socket session-ids present on a host (local or remote). */
async function listWalnutDtach(host: string | undefined): Promise<string[]> {
  const script = `ls -1 ${shellQuote(DTACH_SOCKET_DIR)}/walnut-*.dsock 2>/dev/null || true`
  const res = await runShell(host, script)
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.endsWith('.dsock'))
    .map((p) => {
      const base = p.split('/').pop() ?? ''
      return base.replace(/^walnut-/, '').replace(/\.dsock$/, '')
    })
    .filter(Boolean)
}

/**
 * Orphan reaper: sweep `walnut-*.dsock` dtach sockets on the local host (and
 * known remote hosts) and kill any whose backing session no longer exists in
 * the registry. Safety net for the "conditional keep" strategy. Best-effort.
 */
export async function reapOrphanDtach(): Promise<void> {
  let liveIds: Set<string>
  let sessions: Awaited<ReturnType<typeof listSessions>>
  try {
    sessions = await listSessions()
    liveIds = new Set(sessions.map((s) => s.claudeSessionId))
  } catch (err) {
    log.web.warn('reapOrphanDtach: failed to list sessions', { error: String(err) })
    return
  }

  // Determine hosts to sweep. Orphans are by definition on hosts that may no
  // longer have a live session (the last session was deleted), so sweeping only
  // live-session hosts would leak their sockets forever. Sweep local + EVERY
  // configured host, unioned with hosts of live sessions.
  const hosts = new Set<string | undefined>([undefined])
  for (const s of sessions) if (s.host) hosts.add(s.host)
  try {
    const config = await getConfig()
    for (const h of Object.keys(config.hosts ?? {})) hosts.add(h)
  } catch (err) {
    log.web.warn('reapOrphanDtach: failed to load config hosts', { error: String(err) })
  }

  for (const host of hosts) {
    let ids: string[]
    try {
      ids = await listWalnutDtach(host)
    } catch (err) {
      log.web.warn('reapOrphanDtach: list failed', { host, error: String(err) })
      continue
    }
    for (const sid of ids) {
      if (liveIds.has(sid)) continue // session still tracked → keep
      log.web.info('reaping orphan dtach session', { sid, host })
      try {
        await killDtachSession({ claudeSessionId: sid, host })
      } catch (err) {
        log.web.warn('reapOrphanDtach: kill failed', { sid, host, error: String(err) })
      }
    }
  }
}
