/**
 * The boot policy table (src/core/boot-policy.ts): for the leader and the
 * companion every row equals today's CLOUD_MODE truth at its gate, recomputed
 * here from the expression the gate had before (docs/plan/walnut-replica-servers-impl.md,
 * section 2); the host replica column is the plan's OFF list. The companion's
 * truth comes from the one replica column plus its capabilities
 * (src/core/capabilities.ts), all four when it sets none; taking one away turns
 * off exactly the rows that name it (stage 5 of docs/plan/walnut-companion-unified-replica.md).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { BOOT_POLICY, bootPolicy, bootPolicyDecisions, jobsOfCapability, type BootJob, type BootRow } from '../../src/core/boot-policy.js'
import { CAPABILITIES, defaultCapabilities, type Capability } from '../../src/core/capabilities.js'
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
  'git-pull': leaderOnly, // 4d: the companion reads its copies; git sync no longer writes its data dir
  'git-auto-commit': leaderOnly, // 4d: what the box writes for the Mac goes through its journal
  'git-maintenance': always,
  'git-compaction': leaderOnly,
  'session-auto-recover': leaderOnly,
  'session-reconcile': leaderOnly,
  'completed-task-session-migration': always,
  'one-session-per-task': leaderOnly, // new 2026-10-21: the companion's session copy is the apply connection's
  'stream-file-cleanup': always,
  'session-integrity-check': leaderOnly,
  'notes-watcher': leaderOnly, // 4d: the companion reads its copy of the Mac's notes, no vault of its own
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
  'budget-letters': leaderOnly,
  'session-health-monitor': leaderOnly,
  'overview-maintainer': leaderOnly, // 4d: its project skill writes would land on the box's copy
  'project-summary': always,
  'host-learning': leaderOnly, // new: host profiles are written on the Mac
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
  'notes-indexer': leaderOnly, // 4d: the companion searches its copy of the Mac's notes
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
    expect(bootPolicy(job, 'mac')).toBe(OLD_TRUTH[job](false))
    expect(bootPolicy(job, 'cloud')).toBe(OLD_TRUTH[job](true))
    expect(bootPolicy(job, 'cloud', defaultCapabilities('cloud'))).toBe(OLD_TRUTH[job](true))
  })

  it.each(BOOT_POLICY.map((r) => [r.job, r] as const))('%s: the host replica column is the plan\'s', (job, row) => {
    expect(row.replica).toBe(HOST_ON.has(job))
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

/** The rows each capability turns on: the design's table, plus expose (a door to the public too). */
const CAPABILITY_JOBS: Record<Capability, BootJob[]> = {
  'public-door': ['setup-token-banner', 'revoke-queue', 'expose-runtime', 'stt-auto-setup'],
  'bridge-door': ['companion-ingest-routes', 'git-maintenance'],
  'cloud-exec': ['cloud-exec', 'local-daemon', 'stream-file-cleanup', 'send-path-canary'],
  'backup-leader': ['backup-leader', 'project-summary', 'routine-wake', 'cron'],
}

/** What the companion still runs on its own pipeline, and the stage that decides each. */
const COMPANION_UNTIL: Partial<Record<BootJob, string>> = {
  'v1-forward': '5b', 'companion-stream-forward': '5b', 'companion-queues': '5b',
  'plugins': '5b', 'companion-plugin-cards': '5b', 'update-check': '5b',
  'completed-task-session-migration': '2c',
}

const rows = BOOT_POLICY as readonly BootRow[]
const without = (cap: Capability): ReadonlySet<Capability> => new Set(CAPABILITIES.filter((c) => c !== cap))

describe('boot policy: one replica column plus capability rows', () => {
  it('each capability turns on the rows the plan names, and only those', () => {
    for (const cap of CAPABILITIES) expect(jobsOfCapability(cap), cap).toEqual(CAPABILITY_JOBS[cap])
    const named = rows.filter((r) => r.capability !== undefined).map((r) => r.job).sort()
    expect(named).toEqual(Object.values(CAPABILITY_JOBS).flat().sort())
  })

  it('the rows still kept for the companion name the stage that decides them', () => {
    const marked = Object.fromEntries(rows.filter((r) => r.companionUntil !== undefined).map((r) => [r.job, r.companionUntil]))
    expect(marked).toEqual(COMPANION_UNTIL)
    const doc = fs.readFileSync(path.join(ROOT, 'docs/plan/walnut-companion-unified-replica.md'), 'utf8')
    for (const stage of new Set(Object.values(COMPANION_UNTIL))) expect(doc, stage).toMatch(new RegExp(`(\\|\\s*${stage}\\s*\\||###\\s*${stage}:)`))
  })

  it('a row is a capability row, a companion row or neither, and both are off in the replica column', () => {
    for (const r of rows) {
      expect(r.capability !== undefined && r.companionUntil !== undefined, r.job).toBe(false)
      if (r.capability !== undefined || r.companionUntil !== undefined) expect(r.replica, r.job).toBe(false)
    }
  })

  it.each(CAPABILITIES.map((c) => [c] as const))('a companion without %s turns off exactly its rows', (cap) => {
    for (const r of rows) {
      const job = r.job as BootJob
      const want = r.capability === cap ? false : OLD_TRUTH[job](true)
      expect(bootPolicy(job, 'cloud', without(cap)), `${cap}: ${job}`).toBe(want)
    }
  })

  it('a companion with no capability keeps only the replica column and its own pipeline rows', () => {
    const { on } = bootPolicyDecisions('cloud', new Set())
    expect(on.sort()).toEqual([...HOST_ON, ...Object.keys(COMPANION_UNTIL)].sort())
  })

  it('capabilities never reach the Mac\'s column, and a host replica takes the table\'s rows only through its set', () => {
    const all = new Set(CAPABILITIES)
    for (const r of rows) expect(bootPolicy(r.job as BootJob, 'mac', all), r.job).toBe(r.leader)
    // The host's set is empty by construction (capabilities.ts ignores the env there).
    expect(defaultCapabilities('host').size).toBe(0)
    expect(bootPolicyDecisions('host').on.sort()).toEqual([...HOST_ON].sort())
    // The companion's own pipeline rows are the companion's alone, whatever a host's set says.
    for (const job of Object.keys(COMPANION_UNTIL) as BootJob[]) expect(bootPolicy(job, 'host', all), job).toBe(false)
  })
})
