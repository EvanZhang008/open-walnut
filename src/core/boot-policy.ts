/**
 * Which background jobs a server starts, by role and placement
 * (docs/plan/walnut-replica-servers-impl.md, section 2).
 *
 * One row per job `startServer` (and the modules that gate themselves) can
 * start. The `leader` and `replicaCloud` columns are today's `CLOUD_MODE`
 * truth, unchanged (tests/core/boot-policy.test.ts recomputes it per row); the
 * `replicaHost` column is the server on a host the user picked
 * (`walnut web --replica`), which must never touch the Mac's daemon, the
 * user's data or another Walnut's files: nearly everything there is off.
 *
 * A gate reads `bootPolicy(job)` instead of a raw `CLOUD_MODE`; conditions that
 * are not about the role (ephemeral, env opt-outs, cloud.exec) stay at the gate.
 */

import { placement, type Placement } from './server-role.js'

export interface BootRow {
  job: string
  leader: boolean
  replicaHost: boolean
  replicaCloud: boolean
  /** Why the host replica column is what it is (one line). */
  why: string
}

const OFF_HOST_DATA = 'the Mac owns this; a host replica only reads copies'
const OFF_HOST_DAEMON = 'a host replica never runs or reaches a session daemon of its own'

export const BOOT_POLICY = [
  { job: 'foreign-db-guard', leader: true, replicaHost: false, replicaCloud: false, why: 'copies have one writer, the apply connection; the instance lock still holds' },
  { job: 'cloud-exec', leader: false, replicaHost: false, replicaCloud: true, why: 'cloud.exec is a companion setting' },
  { job: 'local-daemon', leader: true, replicaHost: false, replicaCloud: true, why: OFF_HOST_DAEMON },
  { job: 'cloud-box-probe', leader: true, replicaHost: false, replicaCloud: false, why: 'the Mac probes its cloud box' },
  { job: 'local-claude-probe', leader: true, replicaHost: false, replicaCloud: false, why: 'sessions on the host start through the Mac until WP12' },
  { job: 'trust-proxy', leader: false, replicaHost: true, replicaCloud: true, why: 'the tunnel in front is a loopback reverse proxy, as on the companion' },
  { job: 'companion-ingest-routes', leader: false, replicaHost: false, replicaCloud: true, why: '/git/data and /bridge/* live only on the leader door' },
  { job: 'backup-routes', leader: true, replicaHost: false, replicaCloud: false, why: OFF_HOST_DATA },
  { job: 'plugin-apps', leader: true, replicaHost: false, replicaCloud: false, why: 'plugins never load on a host replica' },
  { job: 'v1-forward', leader: false, replicaHost: false, replicaCloud: true, why: 'the host replica front (WP2) forwards instead' },
  { job: 'backup-leader', leader: false, replicaHost: false, replicaCloud: true, why: 'only the companion may stand in' },
  { job: 'leader-heartbeat', leader: true, replicaHost: false, replicaCloud: false, why: 'the leader heartbeat is the Mac' },
  { job: 'replica-pushes', leader: true, replicaHost: false, replicaCloud: false, why: 'only the leader pushes copies' },
  { job: 'self-api-credential', leader: false, replicaHost: true, replicaCloud: true, why: 'no loopback trust on a host replica, own calls carry a credential' },
  { job: 'setup-token-banner', leader: false, replicaHost: false, replicaCloud: true, why: 'devices come from the device copy, nothing is claimed here' },
  { job: 'terminal-sweep', leader: true, replicaHost: false, replicaCloud: false, why: 'the terminal stays with the Mac' },
  { job: 'letter-push', leader: true, replicaHost: false, replicaCloud: false, why: 'no relay credential is copied' },
  { job: 'audio', leader: true, replicaHost: false, replicaCloud: false, why: 'no capture or transcriber on a host' },
  { job: 'git-pull', leader: true, replicaHost: false, replicaCloud: true, why: 'a host replica has no git data hub' },
  { job: 'git-auto-commit', leader: true, replicaHost: false, replicaCloud: true, why: 'copies are not committed' },
  { job: 'git-maintenance', leader: true, replicaHost: false, replicaCloud: true, why: 'no data repo on a host replica' },
  { job: 'git-compaction', leader: true, replicaHost: false, replicaCloud: false, why: 'the Mac is the sole compactor' },
  { job: 'session-auto-recover', leader: true, replicaHost: false, replicaCloud: false, why: OFF_HOST_DAEMON },
  { job: 'session-reconcile', leader: true, replicaHost: false, replicaCloud: false, why: OFF_HOST_DAEMON },
  { job: 'completed-task-session-migration', leader: true, replicaHost: false, replicaCloud: true, why: 'the session copy is written by the apply connection only' },
  { job: 'stream-file-cleanup', leader: true, replicaHost: false, replicaCloud: true, why: 'a host replica keeps no session streams' },
  { job: 'session-integrity-check', leader: true, replicaHost: false, replicaCloud: false, why: OFF_HOST_DATA },
  { job: 'notes-watcher', leader: true, replicaHost: false, replicaCloud: true, why: 'notes live in the daemon copy (WP6)' },
  { job: 'notes-semantic', leader: true, replicaHost: false, replicaCloud: false, why: 'the search copy is used instead' },
  { job: 'search-wiring', leader: true, replicaHost: false, replicaCloud: false, why: 'the search copy is used instead' },
  { job: 'thread-ai', leader: true, replicaHost: false, replicaCloud: false, why: 'side threads are named on the Mac' },
  { job: 'revoke-queue', leader: true, replicaHost: false, replicaCloud: true, why: 'a revoke reaches the host replica as a device round' },
  { job: 'send-path-canary', leader: true, replicaHost: false, replicaCloud: true, why: OFF_HOST_DAEMON },
  { job: 'primary-store-jobs', leader: true, replicaHost: false, replicaCloud: false, why: 'projections, backups, auto-continue are the Mac' },
  { job: 'companion-queues', leader: false, replicaHost: false, replicaCloud: true, why: 'writes away go to the host journal (WP10)' },
  // The companion on the same path (WP13): its forward rides a stream through the Mac's own daemon.
  { job: 'companion-stream-door', leader: true, replicaHost: false, replicaCloud: false, why: 'only the leader takes the companion\'s forward streams' },
  { job: 'companion-stream-forward', leader: false, replicaHost: false, replicaCloud: true, why: 'the host replica front (WP2) forwards on its own link' },
  { job: 'hook-task-domains', leader: true, replicaHost: false, replicaCloud: false, why: 'task and cron hook actions fire on the Mac' },
  { job: 'session-request-sweep', leader: true, replicaHost: false, replicaCloud: false, why: OFF_HOST_DATA },
  { job: 'lane-orphan-passes', leader: true, replicaHost: false, replicaCloud: false, why: OFF_HOST_DATA },
  { job: 'lane-ask-sync', leader: true, replicaHost: false, replicaCloud: false, why: OFF_HOST_DATA },
  { job: 'pin-retirement', leader: true, replicaHost: false, replicaCloud: false, why: OFF_HOST_DATA },
  { job: 'session-health-monitor', leader: true, replicaHost: false, replicaCloud: false, why: OFF_HOST_DAEMON },
  { job: 'overview-maintainer', leader: true, replicaHost: false, replicaCloud: true, why: OFF_HOST_DATA },
  { job: 'project-summary', leader: true, replicaHost: false, replicaCloud: true, why: OFF_HOST_DATA },
  { job: 'routine-wake', leader: true, replicaHost: false, replicaCloud: true, why: 'routines never run on a host replica' },
  // replicaCloud false: startWorkspaceWatch returned at once on the companion (its own env read at 8b0fb0e08).
  { job: 'workspace-watch', leader: true, replicaHost: false, replicaCloud: false, why: OFF_HOST_DATA },
  { job: 'host-wiring', leader: true, replicaHost: false, replicaCloud: false, why: 'no ssh and no daemons of its own' },
  { job: 'expose-runtime', leader: true, replicaHost: false, replicaCloud: true, why: 'the host tunnel follows the Mac settings through the daemon (WP2)' },
  { job: 'update-check', leader: true, replicaHost: false, replicaCloud: true, why: 'the Mac installs the host replica' },
  { job: 'plugins', leader: true, replicaHost: false, replicaCloud: true, why: 'plugin credentials are never copied' },
  { job: 'companion-plugin-cards', leader: false, replicaHost: false, replicaCloud: true, why: 'plugins never load on a host replica' },
  { job: 'plugin-sync-polling', leader: true, replicaHost: false, replicaCloud: false, why: 'plugins never load on a host replica' },
  { job: 'cron', leader: true, replicaHost: false, replicaCloud: true, why: 'routines never run on a host replica' },
  { job: 'heartbeat', leader: true, replicaHost: false, replicaCloud: false, why: 'the Mac owns heartbeat turns' },
  { job: 'triage-bootstrap', leader: true, replicaHost: false, replicaCloud: false, why: 'the Mac owns cron-jobs.json' },
  { job: 'board-store-watch', leader: true, replicaHost: false, replicaCloud: false, why: 'boards are copies on a host replica (WP4)' },
  { job: 'board-kanban-watch', leader: true, replicaHost: false, replicaCloud: false, why: 'board facts are written on the Mac' },
  { job: 'board-reminders', leader: true, replicaHost: false, replicaCloud: false, why: 'the reminders clock runs on the Mac' },
  { job: 'wait-until', leader: true, replicaHost: false, replicaCloud: false, why: 'the wait_until clock runs on the Mac' },
  { job: 'title-reconciler', leader: true, replicaHost: false, replicaCloud: false, why: 'titles are written on the Mac' },
  { job: 'link-tags', leader: true, replicaHost: false, replicaCloud: false, why: 'link tags are written on the Mac' },
  { job: 'notes-indexer', leader: true, replicaHost: false, replicaCloud: true, why: 'notes live in the daemon copy (WP6)' },
  { job: 'stt-auto-setup', leader: true, replicaHost: false, replicaCloud: true, why: 'voice is answered by the Mac or the companion' },
] as const satisfies readonly BootRow[]

export type BootJob = (typeof BOOT_POLICY)[number]['job']

const byJob = new Map<string, BootRow>(BOOT_POLICY.map((r) => [r.job, r]))

function column(row: BootRow, where: Placement): boolean {
  return where === 'mac' ? row.leader : where === 'host' ? row.replicaHost : row.replicaCloud
}

/** Whether this server starts `job`. Throws on an unknown job: a typo must not read as off. */
export function bootPolicy(job: BootJob, where: Placement = placement()): boolean {
  const row = byJob.get(job)
  if (!row) throw new Error(`boot policy: no row for job "${job}"`)
  return column(row, where)
}

/** Every row's decision for this server, for the `boot policy` log line. */
export function bootPolicyDecisions(where: Placement = placement()): { on: string[]; off: string[] } {
  const on: string[] = []
  const off: string[] = []
  for (const row of BOOT_POLICY) (column(row, where) ? on : off).push(row.job)
  return { on, off }
}
