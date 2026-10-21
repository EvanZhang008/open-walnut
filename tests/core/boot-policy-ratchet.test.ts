/**
 * Every raw `CLOUD_MODE` read in src/ is either replaced by role(),
 * placement() or bootPolicy() (src/core/server-role.ts, src/core/boot-policy.ts)
 * or listed here with what a host replica does at it
 * (docs/plan/walnut-replica-servers-impl.md, section 2 and C9).
 *
 * A host replica (`walnut web --replica`) is not CLOUD_MODE, so every raw read
 * takes the leader's branch there. Each row says why that branch is right, or
 * why it never runs. The count of a row may only fall: a new read fails this
 * test until it is a bootPolicy row or listed with its decision; a read that
 * goes makes the row lower (or go), so the table stays exact.
 *
 * Counted: code tokens (tests/helpers/cloud-mode-scan.ts), the constant and the
 * env key alike (`process.env.WALNUT_CLOUD_MODE`, `env['WALNUT_CLOUD_MODE']`),
 * never a comment, other string text or an import. At the plan's tree
 * (8b0fb0e08) that was 408 reads in 147 files (401 of the constant, 7 of the
 * env key).
 */
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { countCloudModeReads, scanCloudModeReads } from '../helpers/cloud-mode-scan.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const START_TOTAL = 408

/** The definition and the two modules that answer the question for everyone. */
const READERS = new Set(['src/constants.ts', 'src/core/server-role.ts', 'src/core/boot-policy.ts'])

const ROUTE = 'route: the WP2 front forwards it to the Mac while the Mac answers; away, the route table runs it on copies or answers needs_leader'
const COMPANION = 'companion-only: a host replica is not CLOUD_MODE and skips it, which is right'
const off = (job: string) => `off: runs only under boot job ${job}, which is off on a host replica`
const leader = (why: string) => `leader branch is right: ${why}`

const ROUTES: Array<[string, number]> = [
  ['src/web/routes/actions-v1.ts', 1], ['src/web/routes/api-v1.ts', 28], ['src/web/routes/asks-v1.ts', 1], ['src/web/routes/board-v1.ts', 1],
  ['src/web/routes/browser-pair.ts', 1], ['src/web/routes/chat-turn-relay.ts', 1], ['src/web/routes/config.ts', 4], ['src/web/routes/console-extras-v1.ts', 2],
  ['src/web/routes/console-v1.ts', 3], ['src/web/routes/device-twins.ts', 4], ['src/web/routes/devices-adopt.ts', 2], ['src/web/routes/devices-tailscale.ts', 1],
  ['src/web/routes/devices.ts', 16], ['src/web/routes/diagnostics.ts', 2], ['src/web/routes/events-v1.ts', 6], ['src/web/routes/expose.ts', 1],
  ['src/web/routes/file-content.ts', 1], ['src/web/routes/file-history.ts', 1], ['src/web/routes/file-ops.ts', 1], ['src/web/routes/file-raw.ts', 1],
  ['src/web/routes/files-v1.ts', 5], ['src/web/routes/files.ts', 1], ['src/web/routes/health-v1.ts', 1], ['src/web/routes/health.ts', 1],
  ['src/web/routes/host-servers.ts', 1], ['src/web/routes/hosts.ts', 3], ['src/web/routes/human-inbox-body.ts', 2], ['src/web/routes/human-inbox-v1.ts', 10],
  ['src/web/routes/instance-routes-v1.ts', 1], ['src/web/routes/leader.ts', 1], ['src/web/routes/library-v1.ts', 1], ['src/web/routes/media-v1.ts', 5],
  ['src/web/routes/messages-v1.ts', 1], ['src/web/routes/notes-v2.ts', 1], ['src/web/routes/notifications.ts', 1], ['src/web/routes/personal-ai-v1.ts', 1],
  ['src/web/routes/places-v1.ts', 1], ['src/web/routes/places.ts', 2], ['src/web/routes/plugin-runtime.ts', 1], ['src/web/routes/plugin-updates.ts', 1],
  ['src/web/routes/projects-v1.ts', 5], ['src/web/routes/push.ts', 5], ['src/web/routes/routines-v1.ts', 13], ['src/web/routes/search-memory-v1.ts', 3],
  ['src/web/routes/session-control-v1.ts', 3], ['src/web/routes/session-extras-v1.ts', 16], ['src/web/routes/session-launch-v1.ts', 4], ['src/web/routes/session-lifecycle-v1.ts', 10],
  ['src/web/routes/session-send-v1.ts', 3], ['src/web/routes/session-stop-v1.ts', 1], ['src/web/routes/session-stream-v1.ts', 3], ['src/web/routes/sessions.ts', 1],
  ['src/web/routes/stt-v1.ts', 1], ['src/web/routes/system.ts', 3], ['src/web/routes/task-extras-v1.ts', 4], ['src/web/routes/task-v1.ts', 2],
  ['src/web/routes/time-report.ts', 2], ['src/web/routes/time-task.ts', 1], ['src/web/routes/time-timeline.ts', 3], ['src/web/routes/time-v1.ts', 1],
  ['src/web/routes/time.ts', 10],
]

const OTHERS: Array<[string, number, string]> = [
  ['src/core/attachment-text.ts', 1, off('notes-indexer')],
  ['src/core/calendar/sources/eventkit.ts', 2, off('plugins')],
  ['src/core/cloud-chat-outbox.ts', 3, COMPANION],
  ['src/core/cloud-owned-session.ts', 1, COMPANION],
  ['src/core/cloud-setup/job.ts', 1, ROUTE],
  ['src/core/config-broadcast.ts', 1, leader('the Mac mask over the replica config, itself an allowlisted copy (WP5)')],
  ['src/core/config-manager.ts', 1, leader('the cloud box row is only a host entry; host wiring is off')],
  ['src/core/control-queue.ts', 2, COMPANION],
  ['src/core/cron/jobs.ts', 1, off('cron')],
  ['src/core/device-adoption.ts', 2, ROUTE],
  ['src/core/device-auth.ts', 6, leader('auth.json is never read for auth on a host replica (replica/auth.ts); device changes are routes')],
  ['src/core/devices/relay.ts', 1, COMPANION],
  ['src/core/devices/revoke-queue.ts', 1, off('revoke-queue')],
  ['src/core/diagnostics/host-probes.ts', 4, ROUTE],
  ['src/core/diagnostics/local-probes.ts', 1, leader('a diagnostics line: a host replica searches its search copy, so "search on" is true there')],
  ['src/core/diagnostics/probes.ts', 1, ROUTE],
  ['src/core/health/db.ts', 1, leader('a health store only in its own data dir, none is copied')],
  ['src/core/health/index.ts', 1, leader('arms only when a health store exists, none is copied')],
  ['src/core/helper-build.ts', 1, leader('a darwin-only native helper')],
  ['src/core/host-replica-sync.ts', 1, off('replica-pushes')],
  ['src/core/host-server/index.ts', 1, off('host-wiring')],
  ['src/core/hosts/cloud-box-probe.ts', 2, off('cloud-box-probe')],
  ['src/core/hosts/host-connect-action.ts', 2, off('host-wiring')],
  ['src/core/human-inbox/replica-state.ts', 1, COMPANION],
  ['src/core/leader/backup-leader.ts', 2, off('backup-leader')],
  ['src/core/leader/primary-leader.ts', 5, off('leader-heartbeat')],
  ['src/core/mcp-servers/registry.ts', 1, ROUTE],
  ['src/core/notifications/origin.ts', 1, leader('its own notifications file in its own data dir')],
  ['src/core/observability/bug-report.ts', 1, ROUTE],
  ['src/core/peers/capability-router.ts', 2, ROUTE],
  ['src/core/permissions/darwin.ts', 2, leader('darwin TCC probes only')],
  ['src/core/places/db.ts', 2, leader('a places store only in its own data dir')],
  ['src/core/plugins/server-api.ts', 3, off('plugins')],
  ['src/core/projection-cache.ts', 1, off('primary-store-jobs')],
  ['src/core/protected-reader.ts', 2, leader('darwin native helpers only')],
  ['src/core/push-notification.ts', 1, leader('no push credential is copied, so nothing is sent (stated limit, section 2)')],
  ['src/core/push/device-revoke.ts', 2, off('revoke-queue')],
  ['src/core/push/relay.ts', 1, leader('no relay credential is copied')],
  ['src/core/replication/device-replica.ts', 1, off('replica-pushes')],
  ['src/core/self-repair/walnut-source.ts', 1, ROUTE],
  ['src/core/self-update/install-kind.ts', 1, off('update-check')],
  ['src/core/send-outcomes.ts', 6, ROUTE],
  ['src/core/send-path-announce.ts', 1, leader('it announces on a daemon host connect; a host replica has no daemon connection')],
  ['src/core/send-path-canary.ts', 1, off('send-path-canary')],
  ['src/core/send-queue-drain.ts', 2, COMPANION],
  ['src/core/send-queue.ts', 4, COMPANION],
  ['src/core/sessions/caller-placement.ts', 1, ROUTE],
  ['src/core/sessions/host-start-gate.ts', 1, ROUTE],
  ['src/core/sessions/lane-ask-link.ts', 6, off('lane-ask-sync')],
  ['src/core/sessions/open-items.ts', 2, ROUTE],
  ['src/core/stt/voice-archive-replication.ts', 2, COMPANION],
  ['src/core/stt/voice-archive-transcribe.ts', 1, ROUTE],
  ['src/core/stt/voice-archive.ts', 1, ROUTE],
  ['src/core/task-manager.ts', 1, ROUTE + '; the task copy is read only there'],
  ['src/core/task-outbox.ts', 4, COMPANION],
  ['src/core/task-pin-retirement.ts', 1, off('pin-retirement')],
  ['src/core/task-queue.ts', 2, COMPANION],
  ['src/core/time-tracking/calls-collector.ts', 1, leader('darwin only')],
  ['src/core/time-tracking/outside-collector.ts', 1, leader('darwin only')],
  ['src/core/triage/collect.ts', 1, off('triage-bootstrap')],
  ['src/integrations/cloud-bridge-config.ts', 4, leader('a host replica has no cloud bridge config (the config copy is an allowlist)')],
  ['src/integrations/git-maintenance.ts', 2, off('git-maintenance')],
  ['src/integrations/git-sync.ts', 2, off('git-auto-commit')],
  ['src/providers/cloud-tunnel-daemon.ts', 1, COMPANION + ' (it clears the env key for the tunnel daemon it spawns)'],
  ['src/providers/claude-code-session.ts', 1, leader('a local start reaches localDaemon.ensureRunning, which refuses on a host replica')],
  ['src/providers/daemon-version-check.ts', 1, leader('`web --replica` never runs the check (commands/web.ts)')],
  ['src/providers/session-host.ts', 2, ROUTE],
  ['src/web/middleware/auth.ts', 1, leader('a host replica branches to replica/auth.ts before it')],
  ['src/web/middleware/health-access.ts', 2, leader('no loopback trust on a host replica, so a token is asked')],
  ['src/web/server.ts', 7, leader('plugin parser and relay args (plugins off), the test host fixture, a log field, the warmup gate (host wiring off), the cloud.exec condition')],
  ['src/web/ws/daemon-tunnel.ts', 2, COMPANION],
  ['src/web/ws/handler.ts', 3, COMPANION + '; its /ws token check is the device copy (auth.ts)'],
]

const LISTED = new Map<string, { reads: number; decision: string }>([
  ...ROUTES.map(([f, n]) => [f, { reads: n, decision: ROUTE }] as const),
  ...OTHERS.map(([f, n, d]) => [f, { reads: n, decision: d }] as const),
])

describe('boot policy ratchet (raw CLOUD_MODE reads in src/)', () => {
  const found = scanCloudModeReads(ROOT)
  for (const r of READERS) found.delete(r)

  it('every file with a raw read is listed with its host replica decision', () => {
    const missing = [...found.keys()].filter((f) => !LISTED.has(f))
    expect(missing, 'a new CLOUD_MODE read: use bootPolicy()/role()/placement(), or list it here with what a host replica does there').toEqual([])
    for (const [, row] of LISTED) expect(row.decision.length).toBeGreaterThan(10)
  })

  it('a row never grows, and a row that fell is lowered (the table stays exact)', () => {
    const grew: string[] = []
    const fell: string[] = []
    for (const [file, row] of LISTED) {
      const n = found.get(file) ?? 0
      if (n > row.reads) grew.push(`${file}: ${row.reads} -> ${n}`)
      if (n < row.reads) fell.push(`${file}: ${row.reads} -> ${n} (lower the row${n === 0 ? ', or remove it' : ''})`)
    }
    expect(grew, 'the count may only fall').toEqual([])
    expect(fell).toEqual([])
  })

  it('the total fell from the tree the plan started at', () => {
    const total = [...found.values()].reduce((a, b) => a + b, 0)
    expect(total).toBeLessThan(START_TOTAL)
    expect(total).toBe([...LISTED.values()].reduce((a, r) => a + r.reads, 0))
  })
})

describe('the scanner', () => {
  it('counts code reads, not comments, strings, imports or template text', () => {
    const src = [
      "import { CLOUD_MODE, WALNUT_HOME } from '../constants.js'",
      'import {',
      '  CLOUD_MODE as X,',
      "} from './c.js'",
      '// CLOUD_MODE in a comment',
      '/* CLOUD_MODE\n   CLOUD_MODE */',
      "const a = 'CLOUD_MODE'",
      'const b = "CLOUD_MODE"',
      'const c = `CLOUD_MODE ${CLOUD_MODE ? `x ${CLOUD_MODE}` : "y"} CLOUD_MODE`',
      'if (CLOUD_MODE) f({ cloudMode: CLOUD_MODE })',
      'const NOT_CLOUD_MODE = 1',
      "if (process.env.WALNUT_CLOUD_MODE === '1') f()",
      "const k = env['WALNUT_CLOUD_MODE'] ?? process.env[\"WALNUT_CLOUD_MODE\"]",
      'spawn(cmd, { env: { ...process.env, WALNUT_CLOUD_MODE: undefined } })',
      "// process.env.WALNUT_CLOUD_MODE in a comment, and 'WALNUT_CLOUD_MODE=1' in a message",
      "throw new Error('WALNUT_CLOUD_MODE=1 is placement cloud')",
    ].join('\n')
    expect(countCloudModeReads(src)).toBe(8)
  })
})
