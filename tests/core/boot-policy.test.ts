/**
 * The boot policy table (src/core/boot-policy.ts): for the leader and the
 * companion every row equals today's CLOUD_MODE truth at its gate, recomputed
 * here from the expression the gate had before (docs/plan/walnut-replica-servers-impl.md,
 * section 2); the host replica column is the plan's OFF list.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BOOT_POLICY, bootPolicy, bootPolicyDecisions, type BootJob } from '../../src/core/boot-policy.js'
import { listTsFiles } from '../helpers/cloud-mode-scan.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const always = () => true
const leaderOnly = (cloud: boolean) => !cloud
const cloudOnly = (cloud: boolean) => cloud

/**
 * The CLOUD_MODE expression each gate had at 8b0fb0e08 (cloud.exec, ephemeral and env opt-outs stay at the gate),
 * AND the gate the started module kept inside itself: a job is on only when both let it run.
 * SELF_GATED below names the modules that had one; each is checked against its source.
 */
const OLD_TRUTH: Record<BootJob, (cloud: boolean) => boolean> = {
  'foreign-db-guard': leaderOnly, // server.ts `if (!CLOUD_MODE) assertNoForeignDbHolders`
  'cloud-exec': cloudOnly, // `const cloudExec = CLOUD_MODE ? ... : null`
  'local-daemon': always, // `if (CLOUD_MODE && !cloudExec.enabled) skip`: the companion runs it with cloud.exec on
  'cloud-box-probe': leaderOnly,
  'local-claude-probe': leaderOnly,
  'trust-proxy': cloudOnly,
  'companion-ingest-routes': cloudOnly,
  'backup-routes': leaderOnly,
  'plugin-apps': leaderOnly,
  'v1-forward': cloudOnly,
  'backup-leader': cloudOnly,
  'leader-heartbeat': leaderOnly,
  'replica-pushes': leaderOnly,
  'self-api-credential': cloudOnly,
  'setup-token-banner': cloudOnly,
  'terminal-sweep': leaderOnly,
  'letter-push': leaderOnly,
  'audio': leaderOnly,
  'git-pull': always,
  'git-auto-commit': always,
  'git-maintenance': always,
  'git-compaction': leaderOnly,
  'session-auto-recover': leaderOnly,
  'session-reconcile': leaderOnly,
  'completed-task-session-migration': always,
  'stream-file-cleanup': always,
  'session-integrity-check': leaderOnly,
  'notes-watcher': always,
  'notes-semantic': leaderOnly,
  'search-wiring': leaderOnly,
  'thread-ai': leaderOnly,
  'revoke-queue': always,
  'send-path-canary': always,
  'primary-store-jobs': leaderOnly,
  'companion-queues': cloudOnly,
  'companion-stream-door': leaderOnly, // new in WP13: the Mac's door for the companion's forward streams
  'companion-stream-forward': cloudOnly, // new in WP13: the companion's forward on a stream (cap bridge-stream-v1)
  'hook-task-domains': leaderOnly,
  'session-request-sweep': leaderOnly,
  'lane-orphan-passes': leaderOnly,
  'lane-ask-sync': leaderOnly,
  'pin-retirement': leaderOnly,
  'session-health-monitor': leaderOnly,
  'overview-maintainer': always,
  'project-summary': always,
  'routine-wake': always,
  // The server.ts gate was `always`, but startWorkspaceWatch returned at once on its own
  // `process.env.WALNUT_CLOUD_MODE` read, so the job never ran on the companion.
  'workspace-watch': leaderOnly,
  'host-wiring': leaderOnly,
  'expose-runtime': always,
  'update-check': always,
  'plugins': always,
  'companion-plugin-cards': cloudOnly,
  'plugin-sync-polling': leaderOnly,
  'cron': always,
  'heartbeat': leaderOnly,
  'triage-bootstrap': leaderOnly,
  'board-store-watch': leaderOnly,
  'board-kanban-watch': leaderOnly,
  'board-reminders': leaderOnly,
  'wait-until': leaderOnly,
  'title-reconciler': leaderOnly,
  'link-tags': leaderOnly, // new: link tags are written on the Mac
  'notes-indexer': always,
  'stt-auto-setup': always, // new: installs the voice model on the Mac and on the companion
}

/**
 * Modules that returned at once on the companion inside their own start (an
 * `if (CLOUD_MODE) return` or a raw env read at 8b0fb0e08), whatever the
 * server.ts gate said. Their old truth is off on the companion, and each now
 * reads its row itself, so the row decides there too.
 */
const SELF_GATED: Array<[BootJob, string]> = [
  ['board-reminders', 'src/core/boards/board-reminders.ts'],
  ['board-kanban-watch', 'src/core/boards/board-kanban-watch.ts'],
  ['board-store-watch', 'src/core/boards/board-store.ts'],
  ['wait-until', 'src/core/task-wait-until.ts'],
  ['title-reconciler', 'src/core/session-title-reconciler.ts'],
  ['notes-semantic', 'src/core/notes-indexer.ts'],
  ['workspace-watch', 'src/core/workspaces/watch.ts'],
]

/** What a host replica starts: the tunnel's proxy trust and its own credentialed calls. Everything else is off. */
const HOST_ON = new Set<BootJob>(['trust-proxy', 'self-api-credential'])

describe('boot policy', () => {
  it('every row has an old truth and every old truth a row', () => {
    expect(BOOT_POLICY.map((r) => r.job).sort()).toEqual(Object.keys(OLD_TRUTH).sort())
    expect(new Set(BOOT_POLICY.map((r) => r.job)).size).toBe(BOOT_POLICY.length)
  })

  it.each(BOOT_POLICY.map((r) => [r.job, r] as const))('%s: leader and companion equal the old CLOUD_MODE truth', (job, row) => {
    expect(row.leader).toBe(OLD_TRUTH[job](false))
    expect(row.replicaCloud).toBe(OLD_TRUTH[job](true))
    expect(bootPolicy(job, 'mac')).toBe(OLD_TRUTH[job](false))
    expect(bootPolicy(job, 'cloud')).toBe(OLD_TRUTH[job](true))
  })

  it.each(BOOT_POLICY.map((r) => [r.job, r] as const))('%s: the host replica column is the plan\'s', (job, row) => {
    expect(row.replicaHost).toBe(HOST_ON.has(job))
    expect(bootPolicy(job, 'host')).toBe(HOST_ON.has(job))
    expect(row.why.length).toBeGreaterThan(10)
  })

  it('the self-gated starts the plan names are off on a host replica', () => {
    for (const job of ['board-reminders', 'wait-until', 'title-reconciler', 'notes-indexer', 'local-daemon', 'plugins', 'cron', 'heartbeat', 'replica-pushes', 'leader-heartbeat'] as const) {
      expect(bootPolicy(job, 'host'), job).toBe(false)
    }
  })

  it.each(SELF_GATED)('%s gated itself on the companion: its old truth is off there, and the module reads its row', (job, file) => {
    expect(OLD_TRUTH[job](true)).toBe(false)
    expect(OLD_TRUTH[job](false)).toBe(true)
    expect(fs.readFileSync(path.join(ROOT, file), 'utf8')).toContain(`bootPolicy('${job}')`)
  })

  it('an unknown job throws instead of reading as off', () => {
    expect(() => bootPolicy('no-such-job' as BootJob, 'mac')).toThrow(/no row/)
  })

  it('the decisions split every row once, per placement', () => {
    for (const where of ['mac', 'host', 'cloud'] as const) {
      const { on, off } = bootPolicyDecisions(where)
      expect([...on, ...off].sort()).toEqual(BOOT_POLICY.map((r) => r.job).sort())
      expect(on.every((j) => bootPolicy(j as BootJob, where))).toBe(true)
    }
    expect(bootPolicyDecisions('host').on.sort()).toEqual([...HOST_ON].sort())
  })

  it('every row is read by a gate in src/ (no dead rows)', () => {
    const text = listTsFiles(ROOT, 'src').map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n')
    const unread = BOOT_POLICY.map((r) => r.job).filter((job) => !text.includes(`bootPolicy('${job}')`))
    expect(unread).toEqual([])
  })
})
