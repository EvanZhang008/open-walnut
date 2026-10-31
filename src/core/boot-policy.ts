/**
 * Which background jobs a server starts, by role, placement and capability
 * (docs/plan/walnut-replica-servers-impl.md, section 2; stage 5 of
 * docs/plan/walnut-companion-unified-replica.md).
 *
 * One row per job `startServer` (and the modules that gate themselves) can
 * start, with two columns: `leader` (the Mac) and `replica` (every replica: the
 * server on a host the user picked, `walnut web --replica`, and the companion).
 * Nearly everything is off in the replica column: a replica must never touch the
 * Mac's daemon, the user's data or another Walnut's files. What only the
 * companion does is not a column but a row's `capability` (core/capabilities.ts:
 * public-door, bridge-door, cloud-exec, backup-leader), on for a replica that has
 * it. A companion that sets nothing has all four, so every row still equals the
 * `CLOUD_MODE` truth it had (tests/core/boot-policy.test.ts recomputes it per row).
 *
 * `companionUntil` marks a job the companion still runs on its own pipeline with
 * no capability for it yet: the named stage of the companion plan moves it onto
 * the replica core, makes it a capability row or turns it off.
 *
 * A gate reads `bootPolicy(job)` instead of a raw `CLOUD_MODE`; conditions that
 * are not about the role (ephemeral, env opt-outs, cloud.exec.enabled) stay at the gate.
 */

import { placement, type Placement } from './server-role.js'
import { capabilitiesAt, type Capability } from './capabilities.js'

/** The stage of docs/plan/walnut-companion-unified-replica.md that decides a `companionUntil` row. */
export type CompanionStage = '2c' | '5b'

export interface BootRow {
  job: string
  /** The Mac. */
  leader: boolean
  /** Every replica, the host replica and the companion alike. */
  replica: boolean
  /** On a replica also when the box has this capability. */
  capability?: Capability
  /** On the companion also, until this stage (see the header). Never together with a capability. */
  companionUntil?: CompanionStage
  /** Why a replica without the row's capability does not run it (one line). */
  why: string
}

const OFF_HOST_DATA = 'the Mac owns this; a host replica only reads copies'
const OFF_HOST_DAEMON = 'a host replica never runs or reaches a session daemon of its own'

export const BOOT_POLICY = [
  { job: 'foreign-db-guard', leader: true, replica: false, why: 'copies have one writer, the apply connection; the instance lock still holds' },
  { job: 'cloud-exec', leader: false, replica: false, capability: 'cloud-exec', why: 'cloud.exec is a companion setting' },
  { job: 'local-daemon', leader: true, replica: false, capability: 'cloud-exec', why: OFF_HOST_DAEMON },
  { job: 'cloud-box-probe', leader: true, replica: false, why: 'the Mac probes its cloud box' },
  { job: 'local-claude-probe', leader: true, replica: false, why: 'sessions on the host start through the Mac until WP12' },
  { job: 'trust-proxy', leader: false, replica: true, why: 'the tunnel in front is a loopback reverse proxy, as on the companion' },
  { job: 'companion-ingest-routes', leader: false, replica: false, capability: 'bridge-door', why: '/git/data and /bridge/* live only on the leader door' },
  { job: 'backup-routes', leader: true, replica: false, why: OFF_HOST_DATA },
  { job: 'plugin-apps', leader: true, replica: false, why: 'plugins never load on a host replica' },
  { job: 'plugin-jobs', leader: true, replica: false, why: 'only the Mac says which plugin jobs run on which machine' },
  { job: 'v1-forward', leader: false, replica: false, companionUntil: '5b', why: 'the host replica front (WP2) forwards instead' },
  { job: 'backup-leader', leader: false, replica: false, capability: 'backup-leader', why: 'only the companion may stand in' },
  { job: 'leader-heartbeat', leader: true, replica: false, why: 'the leader heartbeat is the Mac' },
  { job: 'replica-pushes', leader: true, replica: false, why: 'only the leader pushes copies' },
  { job: 'self-api-credential', leader: false, replica: true, why: 'no loopback trust on a host replica, own calls carry a credential' },
  { job: 'setup-token-banner', leader: false, replica: false, capability: 'public-door', why: 'devices come from the device copy, nothing is claimed here' },
  { job: 'terminal-sweep', leader: true, replica: false, why: 'the terminal stays with the Mac' },
  { job: 'letter-push', leader: true, replica: false, why: 'no relay credential is copied' },
  { job: 'audio', leader: true, replica: false, why: 'no capture or transcriber on a host' },
  { job: 'git-pull', leader: true, replica: false, why: 'a replica reads copies; git sync is the Mac\'s backup and writes no replica\'s data dir (4d)' },
  { job: 'git-auto-commit', leader: true, replica: false, why: 'copies are not committed; what a box writes for the Mac goes through its journal (4d)' },
  { job: 'git-maintenance', leader: true, replica: false, capability: 'bridge-door', why: 'the bare hub the Mac backs up to lives behind /git/data, on the bridge door' },
  { job: 'git-compaction', leader: true, replica: false, why: 'the Mac is the sole compactor' },
  { job: 'session-auto-recover', leader: true, replica: false, why: OFF_HOST_DAEMON },
  { job: 'session-reconcile', leader: true, replica: false, why: OFF_HOST_DAEMON },
  { job: 'completed-task-session-migration', leader: true, replica: false, companionUntil: '2c', why: 'the session copy is written by the apply connection only' },
  { job: 'one-session-per-task', leader: true, replica: false, why: 'the session copy is written by the apply connection only' },
  { job: 'stream-file-cleanup', leader: true, replica: false, capability: 'cloud-exec', why: 'a host replica keeps no session streams' },
  { job: 'session-integrity-check', leader: true, replica: false, why: OFF_HOST_DATA },
  // Stage 4d: the companion reads its copy of the Mac's notes too, so it watches and indexes no vault of its own.
  { job: 'notes-watcher', leader: true, replica: false, why: 'notes live in the copy (WP6; the companion\'s since 4d)' },
  { job: 'notes-semantic', leader: true, replica: false, why: 'the search copy is used instead' },
  { job: 'search-wiring', leader: true, replica: false, why: 'the search copy is used instead' },
  { job: 'thread-ai', leader: true, replica: false, why: 'side threads are named on the Mac' },
  { job: 'revoke-queue', leader: true, replica: false, capability: 'public-door', why: 'a revoke reaches the host replica as a device round' },
  { job: 'send-path-canary', leader: true, replica: false, capability: 'cloud-exec', why: OFF_HOST_DAEMON },
  { job: 'primary-store-jobs', leader: true, replica: false, why: 'projections, backups, auto-continue are the Mac' },
  { job: 'companion-queues', leader: false, replica: false, companionUntil: '5b', why: 'writes away go to the host journal (WP10)' },
  // The companion on the same path (WP13): its forward rides a stream through the Mac's own daemon.
  { job: 'companion-stream-door', leader: true, replica: false, why: 'only the leader takes the companion\'s forward streams' },
  { job: 'companion-stream-forward', leader: false, replica: false, companionUntil: '5b', why: 'the host replica front (WP2) forwards on its own link' },
  { job: 'hook-task-domains', leader: true, replica: false, why: 'task and cron hook actions fire on the Mac' },
  { job: 'session-request-sweep', leader: true, replica: false, why: OFF_HOST_DATA },
  { job: 'lane-orphan-passes', leader: true, replica: false, why: OFF_HOST_DATA },
  { job: 'lane-ask-sync', leader: true, replica: false, why: OFF_HOST_DATA },
  { job: 'pin-retirement', leader: true, replica: false, why: OFF_HOST_DATA },
  { job: 'usage-collect', leader: true, replica: false, why: 'the leader reads every host\'s usage through its daemon for Usage & Costs' },
  { job: 'budget-letters', leader: true, replica: false, why: 'the leader tells the user about budget pauses; the hosts keep each pause until it does' },
  { job: 'session-health-monitor', leader: true, replica: false, why: OFF_HOST_DAEMON },
  // Stage 4d: off on the companion too. Its project skill writes went to the box's disk, a
  // copy of the Mac's skills that git sync no longer brings round.
  { job: 'overview-maintainer', leader: true, replica: false, why: 'project skills are written on the Mac; a replica holds a copy' },
  { job: 'project-summary', leader: true, replica: false, capability: 'backup-leader', why: OFF_HOST_DATA },
  { job: 'host-learning', leader: true, replica: false, why: 'host profiles have one writer, the Mac' },
  { job: 'routine-wake', leader: true, replica: false, capability: 'backup-leader', why: 'routines never run on a host replica' },
  // replicaCloud false: startWorkspaceWatch returned at once on the companion (its own env read at 8b0fb0e08).
  { job: 'workspace-watch', leader: true, replica: false, why: OFF_HOST_DATA },
  { job: 'host-wiring', leader: true, replica: false, why: 'no ssh and no daemons of its own' },
  { job: 'expose-runtime', leader: true, replica: false, capability: 'public-door', why: 'the host tunnel follows the Mac settings through the daemon (WP2)' },
  { job: 'update-check', leader: true, replica: false, companionUntil: '5b', why: 'the Mac installs the host replica' },
  { job: 'plugins', leader: true, replica: false, companionUntil: '5b', why: 'plugin credentials are never copied' },
  { job: 'companion-plugin-cards', leader: false, replica: false, companionUntil: '5b', why: 'plugins never load on a host replica' },
  { job: 'plugin-sync-polling', leader: true, replica: false, why: 'plugins never load on a host replica' },
  { job: 'cron', leader: true, replica: false, capability: 'backup-leader', why: 'routines never run on a host replica' },
  { job: 'triage-bootstrap', leader: true, replica: false, why: 'the Mac owns cron-jobs.json' },
  { job: 'board-store-watch', leader: true, replica: false, why: 'boards are copies on a host replica (WP4)' },
  { job: 'board-kanban-watch', leader: true, replica: false, why: 'board facts are written on the Mac' },
  { job: 'board-reminders', leader: true, replica: false, why: 'the reminders clock runs on the Mac' },
  { job: 'wait-until', leader: true, replica: false, why: 'the wait_until clock runs on the Mac' },
  { job: 'user-status', leader: true, replica: false, why: 'task statuses are written on the Mac' },
  { job: 'title-reconciler', leader: true, replica: false, why: 'titles are written on the Mac' },
  { job: 'link-tags', leader: true, replica: false, why: 'link tags are written on the Mac' },
  { job: 'notes-indexer', leader: true, replica: false, why: 'notes live in the copy (WP6; the companion searches its copy since 4d)' },
  { job: 'stt-auto-setup', leader: true, replica: false, capability: 'public-door', why: 'voice is answered by the Mac or the companion' },
] as const satisfies readonly BootRow[]

export type BootJob = (typeof BOOT_POLICY)[number]['job']

const byJob = new Map<string, BootRow>(BOOT_POLICY.map((r) => [r.job, r]))

function column(row: BootRow, where: Placement, caps: ReadonlySet<Capability>): boolean {
  if (where === 'mac') return row.leader
  if (row.replica) return true
  if (row.capability !== undefined && caps.has(row.capability)) return true
  return where === 'cloud' && row.companionUntil !== undefined
}

/**
 * Whether this server starts `job`. Throws on an unknown job: a typo must not read as off.
 * `where` and `caps` default to this server's (a test reads another placement with its defaults).
 */
export function bootPolicy(job: BootJob, where: Placement = placement(), caps: ReadonlySet<Capability> = capabilitiesAt(where)): boolean {
  const row = byJob.get(job)
  if (!row) throw new Error(`boot policy: no row for job "${job}"`)
  return column(row, where, caps)
}

/** Every row's decision for this server, for the `boot policy` log line. */
export function bootPolicyDecisions(where: Placement = placement(), caps: ReadonlySet<Capability> = capabilitiesAt(where)): { on: string[]; off: string[] } {
  const on: string[] = []
  const off: string[] = []
  for (const row of BOOT_POLICY) (column(row, where, caps) ? on : off).push(row.job)
  return { on, off }
}

/** The jobs a capability turns on (its rows), in table order. */
export function jobsOfCapability(cap: Capability): BootJob[] {
  return BOOT_POLICY.filter((r: BootRow) => r.capability === cap).map((r) => r.job)
}
