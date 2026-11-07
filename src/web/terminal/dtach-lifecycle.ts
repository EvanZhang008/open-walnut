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
 * `dtach -A` master process holding the pty, whose pid and start time sit in
 * the `.dpid` record beside the socket. Killing it = SIGTERM that one master
 * once its identity is proved (dtach-master.ts: never a name or a pattern),
 * then remove the socket and the record; the shell under it gets SIGHUP when
 * the master's pty closes.
 *
 * A PLAIN terminal (dtach unavailable, see dtach-check.ts) has no socket and no
 * master: the socket helpers below simply find nothing, and conditionalReap
 * ends such a shell through the TerminalManager, which holds its only process.
 */

import { execFile } from 'node:child_process'
import type { SessionRecord } from '../../core/types.js'
import { resolveSshTarget, dtachSocketPath, dtachPidPath, dtachOwnerMarkerPath, DTACH_SOCKET_DIR, REMOTE_DTACH_SOCKET_DIR, sshControlMasterArgs } from './spawn.js'
import { chooseDtachMaster, dtachProbeScript, parseDtachProbe, stopDtachMaster, type StopOutcome } from './dtach-master.js'
import { WALNUT_HOME } from '../../constants.js'
import { listSessions } from '../../core/session-tracker.js'
import { getConfig } from '../../core/config-manager.js'
import { shellQuote } from '../../providers/session-io.js'
import { log } from '../../logging/index.js'

const CMD_TIMEOUT_MS = 8_000

/**
 * Shell names that mean "no foreground task" when reported as the descendant command.
 *
 * CROSS-FILE COUPLING (do NOT prune the dash-prefixed / `login` entries):
 * spawn.ts launches the shell as a LOGIN shell (`-l`). A login shell reports in
 * `ps comm` with a LEADING DASH (`-zsh`, `-bash`, …) or, on some systems, as
 * `login`. These are NOT duplicates of `zsh`/`bash` — they are the exact strings
 * hasForegroundProcess() will see for an idle login shell. If they're removed,
 * an idle login shell is misclassified as a running task → conditionalReap
 * returns 'kept' → the terminal is NEVER reaped (permanent, silent leak).
 */
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
 * Run a dtach-master.ts script on the terminal's host under /bin/sh. Over ssh a
 * script runs in the login shell, and zsh (a common one) does not split an
 * unquoted `$owners` into words, so a pid list would read as one bad word.
 */
function runPosix(host: string | undefined, script: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return runShell(host, host ? `/bin/sh -c ${shellQuote(script)}` : script)
}

/**
 * Does the dtach session have a real foreground process (not just a shell)?
 * dtach has no `display-message`; instead we inspect the process tree under the
 * session's master. If the deepest descendant is a plain shell → idle;
 * anything else (node/vim/npm/...) → a real task is running.
 *
 * Returns false when the session is absent or only an idle shell.
 *
 * The master is the verified one (dtach-master.ts: its pid record, else the
 * socket's owner, each proved by start time and argv), never a command-line
 * match, which also picked up any process that only named the socket. The
 * probe carries the WHOLE process table in the same round trip, and the tree is
 * walked in JS. WHY `ps -ax -o pid= -o ppid= -o comm=` (and NOT `ps --ppid`):
 * `--ppid` is GNU-only and errors with "ps: illegal option" on macOS BSD ps;
 * the BSD `-g` fallback means process-GROUP-id (not pid). `ps -ax -o pid= -o
 * ppid= -o comm=` is portable across macOS BSD ps and Linux GNU ps (one -o per
 * column: procps 3.3.10 takes everything after a column's `=` as its header,
 * commas included), so we get the same table on both and resolve the leaf
 * ourselves.
 */
export async function hasForegroundProcess(record: Pick<SessionRecord, 'claudeSessionId' | 'host'>): Promise<boolean> {
  const sock = dtachSocketPath(record.claudeSessionId, !!record.host)
  const res = await runPosix(record.host, dtachProbeScript(sock, true))
  const probe = parseDtachProbe(res.stdout)
  const masters = chooseDtachMaster(probe, sock).targets.map((t) => String(t.pid))
  if (masters.length === 0) return false // no verified dtach master → no session

  // Build ppid → children[] adjacency from the ps table.
  const children = new Map<string, { pid: string; comm: string }[]>()
  for (const line of probe.table) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    const [, pid, ppid, commRaw] = m
    // comm may be a full path (Linux GNU ps); take the basename for matching.
    const comm = commRaw.trim().split('/').pop() ?? ''
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid)!.push({ pid, comm })
  }

  // Walk down from the master to the deepest descendant (the foreground cmd).
  return masters.some((masterPid) => {
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
    return !!leaf && !SHELL_COMMANDS.has(leaf)
  })
}

/**
 * Explicitly destroy a session's dtach session (signal its verified master,
 * remove socket + record). 'left' when a process may hold the socket but could
 * not be proved its master: nothing was signalled and the socket is kept, and
 * `reason` says why (what "End terminal" reports instead of claiming it ended).
 */
export async function stopDtachSession(record: Pick<SessionRecord, 'claudeSessionId' | 'host'>): Promise<StopOutcome> {
  const sock = dtachSocketPath(record.claudeSessionId, !!record.host)
  const ctx = { sessionId: record.claudeSessionId, host: record.host }
  const res = await stopDtachMaster((script) => runPosix(record.host, script), sock, ctx)
  if (res.outcome === 'stopped') {
    log.web.info('dtach session killed', { ...ctx, source: res.source, pids: res.signalled })
  } else if (res.outcome === 'nothing') {
    log.web.debug('dtach kill noop (likely already gone)', { ...ctx, reason: res.reason })
  }
  return res
}

/**
 * A test server shutting down ends the terminals it opened on remote hosts (their
 * sockets live in its own root there, remote-isolation.ts, which goes next), each
 * master proved before it is signalled. Bounded per host by the caller.
 */
export async function endTestServerRemoteTerminals(hosts: string[]): Promise<void> {
  await Promise.all(hosts.map(async (host) => {
    try {
      const { owner, ids } = await listWalnutDtach(host)
      if (owner !== WALNUT_HOME) return
      for (const id of ids) await stopDtachSession({ claudeSessionId: id, host }).catch(() => {})
    } catch { /* the host is gone: nothing of ours can be ended there now */ }
  }))
}

/** stopDtachSession, outcome only. */
export async function killDtachSession(record: Pick<SessionRecord, 'claudeSessionId' | 'host'>): Promise<StopOutcome['outcome']> {
  return (await stopDtachSession(record)).outcome
}

/**
 * Conditional reap on task completion / session stop. Keeps the dtach session
 * if a client is actively viewing it OR a foreground process is still running;
 * otherwise kills it. Returns 'killed' | 'kept'.
 *
 * The viewing check exists because task completion is a data-model event that
 * says nothing about the user's screen: marking a task done while its terminal
 * tab is open used to vaporize the shell mid-look ("terminal randomly dies").
 * An idle viewed terminal is later collected by the periodic reaper / orphan
 * sweep once the session record itself is deleted.
 */
export async function conditionalReap(record: Pick<SessionRecord, 'claudeSessionId' | 'host'>): Promise<'killed' | 'kept'> {
  try {
    const { terminalManager } = await import('./terminal-manager.js')
    if (terminalManager.isViewing(record.claudeSessionId)) {
      log.web.info('dtach kept (client attached)', { sessionId: record.claudeSessionId })
      return 'kept'
    }
    // Plain shell: no dtach master to inspect, and its detached pty dies at
    // grace expiry anyway, so end it now like an idle shell.
    if (terminalManager.liveMode(record.claudeSessionId)?.persistent === false) {
      terminalManager.end(record.claudeSessionId)
      log.web.info('plain terminal ended (no dtach socket)', { sessionId: record.claudeSessionId })
      return 'killed'
    }
  } catch { /* terminal feature disabled → fall through to process check */ }
  if (await hasForegroundProcess(record)) {
    log.web.info('dtach kept (foreground process running)', { sessionId: record.claudeSessionId })
    return 'kept'
  }
  // A master that could not be proved is left running, so the terminal is kept.
  return (await killDtachSession(record)) === 'left' ? 'kept' : 'killed'
}

/**
 * List walnut dtach socket session-ids present on a host (local or remote),
 * the ids that have a master pid record (`.dpid`), and the dir's ownership
 * marker (see dtachOwnerMarkerPath in spawn.ts). One round-trip: `OWNER:<data-dir>`
 * line first, then the socket paths, then the record paths (two `ls` calls, so a
 * zsh login shell's "no matches" for one never hides the other).
 */
async function listWalnutDtach(host: string | undefined): Promise<{ owner: string | null; ids: string[]; records: string[] }> {
  const dir = shellQuote(host ? REMOTE_DTACH_SOCKET_DIR : DTACH_SOCKET_DIR)
  const script =
    `echo "OWNER:$(cat ${shellQuote(dtachOwnerMarkerPath(!!host))} 2>/dev/null)"; ` +
    `ls -1 ${dir}/walnut-*.dsock 2>/dev/null || true; ` +
    `ls -1 ${dir}/walnut-*.dpid 2>/dev/null || true`
  const res = await runShell(host, script)
  const lines = res.stdout.split('\n')
  const ownerLine = lines.find((l) => l.startsWith('OWNER:'))
  const owner = ownerLine?.slice('OWNER:'.length).trim() || null
  const idsWith = (ext: string) => lines
    .map((l) => l.trim())
    .filter((l) => l.endsWith(ext))
    .map((p) => (p.split('/').pop() ?? '').replace(/^walnut-/, '').slice(0, -ext.length))
    .filter((id) => /^[A-Za-z0-9_-]+$/.test(id))
  return { owner, ids: idsWith('.dsock'), records: idsWith('.dpid') }
}

/**
 * May THIS instance sweep the socket dir it sees on `host`?
 *
 * The sweep's kill rule ("sid absent from MY registry → kill") is only sound
 * when the sockets were created against MY registry. The `.owner` marker
 * records which data dir (WALNUT_HOME) the sockets belong to; it is written
 * exclusively by the SPAWN paths — a sweeper never claims, so a misconfigured
 * instance (isolated registry, inherited production socket dir — the
 * 2026-08-18 recurrence) sees a foreign marker and refuses.
 *
 *   marker == my WALNUT_HOME → sweep.
 *   marker missing           → refuse (pre-upgrade sockets are unattributable;
 *                              the true owner claims on its next spawn, which
 *                              re-enables sweeping. An empty dir has nothing
 *                              to reap anyway).
 *   marker foreign           → refuse + loud log. LOCAL self-heal: if the
 *                              foreign data dir no longer exists (a torn-down
 *                              temp instance claimed first), drop the stale
 *                              marker so the true owner's next spawn reclaims.
 *                              (Remote markers hold LOCAL Mac paths, so an
 *                              existence check on the remote host would be
 *                              meaningless — remote foreign markers only log.)
 */
async function maySweepDtachDir(host: string | undefined, owner: string | null, socketCount: number): Promise<boolean> {
  if (owner === WALNUT_HOME) return true
  if (owner === null) {
    if (socketCount > 0) {
      log.web.info('reapOrphanDtach: socket dir unclaimed, skipping (owner claims on next spawn)', { host, socketCount })
    }
    return false
  }
  log.web.warn('reapOrphanDtach: socket dir owned by another instance, refusing to sweep', {
    host, owner, myHome: WALNUT_HOME, socketCount,
  })
  if (!host) {
    try {
      const { existsSync, rmSync } = await import('node:fs')
      if (!existsSync(owner)) {
        rmSync(dtachOwnerMarkerPath(), { force: true })
        log.web.warn('reapOrphanDtach: dropped stale owner marker (data dir gone)', { owner })
      }
    } catch { /* best-effort */ }
  }
  return false
}

/**
 * Orphan reaper: sweep `walnut-*.dsock` dtach sockets on the local host (and
 * known remote hosts) and kill any whose backing session no longer exists in
 * the registry. Safety net for the "conditional keep" strategy. Best-effort.
 *
 * `remoteHosts`: also ssh the remote hosts. Off under vitest by default, for the
 * host warmup's reason (hostWarmupGateReason): every test that boots a server
 * would otherwise ssh each host in its config, and the developer's real ones
 * when HOME is real.
 */
export async function reapOrphanDtach(opts: { remoteHosts?: boolean } = {}): Promise<void> {
  const remoteHosts = opts.remoteHosts ?? !process.env.VITEST
  let liveIds: Set<string>
  let sessions: Awaited<ReturnType<typeof listSessions>>
  try {
    sessions = await listSessions()
    liveIds = new Set(sessions.map((s) => s.claudeSessionId))
  } catch (err) {
    log.web.warn('reapOrphanDtach: failed to list sessions', { error: String(err) })
    return
  }

  // Same guard as conditionalReap: never vaporize a terminal a client is
  // looking at, even if its session record is already gone.
  let isViewing: (sid: string) => boolean = () => false
  try {
    const { terminalManager } = await import('./terminal-manager.js')
    isViewing = (sid) => terminalManager.isViewing(sid)
  } catch { /* terminal feature disabled */ }

  // Determine hosts to sweep. Orphans are by definition on hosts that may no
  // longer have a live session (the last session was deleted), so sweeping only
  // live-session hosts would leak their sockets forever. Sweep local + EVERY
  // configured host, unioned with hosts of live sessions.
  const hosts = new Set<string | undefined>([undefined])
  if (remoteHosts) {
    for (const s of sessions) if (s.host) hosts.add(s.host)
    try {
      const config = await getConfig()
      for (const h of Object.keys(config.hosts ?? {})) hosts.add(h)
      // A host that cannot open a terminal (the cloud box: no SSH) has no dtach
      // sockets to sweep, and listing them would only fail on every start.
      const { hostOffersTerminal } = await import('../../core/hosts/host-status.js')
      // A found host waiting for the person's yes is never dialled (core/hosts/found-hosts.ts);
      // a live session there would have made it a yes.
      const { foundHostWaits } = await import('../../core/hosts/found-hosts.js')
      const live = new Set(sessions.map((s) => s.host).filter(Boolean))
      for (const [h, def] of Object.entries(config.hosts ?? {})) {
        if (def && !hostOffersTerminal(def)) hosts.delete(h)
        else if (def && foundHostWaits(def) && !live.has(h)) hosts.delete(h)
      }
    } catch (err) {
      log.web.warn('reapOrphanDtach: failed to load config hosts', { error: String(err) })
    }
  }

  for (const host of hosts) {
    let ids: string[]
    try {
      const listed = await listWalnutDtach(host)
      // Ownership gate: only the instance whose registry the sockets belong to
      // may apply the "absent from my registry → kill" rule. See maySweepDtachDir.
      if (!(await maySweepDtachDir(host, listed.owner, listed.ids.length))) continue
      ids = listed.ids
      await dropStaleRecords(host, listed.records.filter((sid) => !ids.includes(sid)))
    } catch (err) {
      log.web.warn('reapOrphanDtach: list failed', { host, error: String(err) })
      continue
    }
    for (const sid of ids) {
      if (liveIds.has(sid)) continue // session still tracked → keep
      if (isViewing(sid)) continue   // client actively viewing → keep
      log.web.info('reaping orphan dtach session', { sid, host })
      try {
        await killDtachSession({ claudeSessionId: sid, host })
      } catch (err) {
        log.web.warn('reapOrphanDtach: kill failed', { sid, host, error: String(err) })
      }
    }
  }
}

/**
 * A master that ended on its own (its shell exited) removes its socket but not
 * its pid record. Remove each record whose socket is still absent when the
 * removal runs (a new master for that id writes its record after its socket).
 * Files only: nothing is signalled.
 */
async function dropStaleRecords(host: string | undefined, sids: string[]): Promise<void> {
  if (sids.length === 0) return
  const lines = sids.map((sid) => {
    const sock = dtachSocketPath(sid, !!host)
    return `[ -S ${shellQuote(sock)} ] || rm -f ${shellQuote(dtachPidPath(sid, !!host))}`
  })
  await runShell(host, `${lines.join('; ')}; echo DONE`)
}
