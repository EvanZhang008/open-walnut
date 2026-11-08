/**
 * The Demo stopping its own daemons on remote hosts (providers/demo-remote-host.ts).
 *
 * Runs in the Demo's stop (demo-server.ts) after new work is fenced and before the
 * server tears its daemon links down. First no new connection is lifted, so nothing
 * dials a host and starts a Demo daemon after this. Then, for each connected host
 * whose daemon is the Demo's own, at the same time and within one deadline: every
 * live session there is stopped through that daemon (the same owner stop a reset
 * sends the local daemon), the daemon must list none alive and no command running,
 * and the daemon is retired: stopped in its isolated root, and the root removed
 * (DaemonConnection.stopDemoDaemon, remote-isolation.ts). A host that is not
 * connected, or does not answer before the deadline, is skipped and logged: its
 * root is named by this generation's data dir, so it never mixes with a later
 * Demo, no other Walnut uses it, and a later test server's sweep removes it once
 * nothing serves it. A host that answers and refuses a stop
 * keeps the Demo running (the reset keeps its data), as a refused local stop does.
 */
import { log } from '../logging/index.js'
import type { SessionRecord } from '../core/types.js'
import type { OwnerConnection, OwnerStopOutcome } from '../core/sessions/owner-stop.js'
import { execRunsProven } from '../providers/exec-runs-hold.js'

export const DEMO_REMOTE_STOP_DEADLINE_MS = 30_000

/** The slice of a DaemonConnection the stop uses. */
export interface DemoRemoteConn extends OwnerConnection {
  readonly host: string
  stopDemoDaemon(timeoutMs: number): Promise<void>
}

type Row = Pick<SessionRecord, 'claudeSessionId' | 'host' | 'acpRuntimeId'>

export interface DemoRemoteStopDeps {
  /** No connection made from now on gets a daemon of its own (closeDemoRemoteHosts). */
  close(): void
  /** The pooled, connected connections that run the Demo's own daemon. */
  connections(): DemoRemoteConn[]
  /** The Demo's session records (for the ACP workers a host runs). */
  records(): Promise<Row[]>
  stopSession(row: { claudeSessionId: string; host: string }, conn: DemoRemoteConn): Promise<OwnerStopOutcome>
  stopAcp(row: Row, conn: DemoRemoteConn): Promise<OwnerStopOutcome>
  now(): number
}

export interface DemoRemoteStopReport {
  stopped: string[]
  skipped: Array<{ host: string; reason: string }>
}

class Refused extends Error {}

async function stopOneHost(conn: DemoRemoteConn, rows: Row[], deps: DemoRemoteStopDeps, deadline: number): Promise<void> {
  const left = () => Math.max(1_000, deadline - deps.now())
  const host = conn.host
  for (const row of rows.filter((r) => r.host === host && r.acpRuntimeId)) {
    if (await deps.stopAcp(row, conn) !== 'stopped') throw new Refused(`Demo agent on ${host} did not confirm its stop; data was kept`)
  }
  const listed = await conn.send('list', {}, Math.min(10_000, left()))
  if (!Array.isArray(listed.sessions)) throw new Refused(`Demo daemon on ${host} did not list its sessions; data was kept`)
  const live = (listed.sessions as Array<{ sid?: unknown; alive?: unknown }>)
    .filter((row) => row && row.alive === true && typeof row.sid === 'string' && row.sid)
  const outcomes = await Promise.all(live.map((row) => deps.stopSession({ claudeSessionId: row.sid as string, host }, conn)))
  if (outcomes.some((o) => o !== 'stopped')) throw new Refused(`Demo session on ${host} did not confirm its stop; data was kept`)
  const remaining = await conn.send('list', {}, Math.min(10_000, left()))
  if (!Array.isArray(remaining.sessions) || (remaining.sessions as Array<{ alive?: unknown }>).some((row) => row?.alive === true)) {
    throw new Refused(`Demo still has live sessions on ${host}; data was kept`)
  }
  const running = await execRunsProven(conn, Math.min(10_000, left()))
  if (running === null) throw new Refused(`Demo daemon on ${host} did not list its commands; data was kept`)
  if (running > 0) throw new Refused(`Demo still has commands running on ${host}; wait for them to finish before reset`)
  await conn.stopDemoDaemon(left())
}

export async function stopDemoRemoteHosts(
  deps: DemoRemoteStopDeps, deadlineMs = DEMO_REMOTE_STOP_DEADLINE_MS,
): Promise<DemoRemoteStopReport> {
  deps.close()
  const conns = deps.connections()
  const report: DemoRemoteStopReport = { stopped: [], skipped: [] }
  if (!conns.length) return report
  const rows = await deps.records()
  const deadline = deps.now() + deadlineMs
  const refusals: string[] = []
  await Promise.all(conns.map(async (conn) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), deadlineMs) })
    try {
      const done = await Promise.race([stopOneHost(conn, rows, deps, deadline).then(() => 'done' as const), late])
      if (done === 'late') {
        report.skipped.push({ host: conn.host, reason: 'no answer before the deadline' })
        log.session.warn('demo stop: remote host did not finish its stop before the deadline, skipped', { host: conn.host, deadlineMs })
        return
      }
      report.stopped.push(conn.host)
      log.session.info('demo stop: remote host daemon stopped', { host: conn.host })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof Refused) {
        refusals.push(message)
        log.session.warn('demo stop: remote host refused a stop, the Demo keeps running', { host: conn.host, error: message })
        return
      }
      // The link or the host went (a closed socket, ssh failing): nothing more can be stopped there.
      report.skipped.push({ host: conn.host, reason: message.split('\n')[0].slice(0, 200) })
      log.session.warn('demo stop: remote host unreachable, skipped', { host: conn.host, error: message })
    } finally {
      clearTimeout(timer)
    }
  }))
  if (refusals.length) throw new Error(refusals[0])
  return report
}

/** The real dependencies: the daemon pool, the session tracker and the owner stops. */
export async function defaultDemoRemoteStopDeps(): Promise<DemoRemoteStopDeps> {
  const [dc, host, tracker, owners] = await Promise.all([
    import('../providers/daemon-connection.js'), import('../providers/demo-remote-host.js'),
    import('../core/session-tracker.js'), import('../core/sessions/owner-stop.js'),
  ])
  return {
    close: host.closeDemoRemoteHosts,
    connections: () => dc.demoLiftedConnections(),
    records: () => tracker.listSessions(),
    stopSession: (row, conn) => owners.stopThroughOwner(row, 'user', 'demo_reset', { connection: async () => conn }, 'human'),
    // The worker is the Demo's own daemon's child: the ephemeral refusal (a shared host's worker) does not apply.
    stopAcp: (row, conn) => owners.stopAcpThroughOwner(row, 'demo_reset', { connection: async () => conn }, { ephemeral: false }),
    now: Date.now,
  }
}
