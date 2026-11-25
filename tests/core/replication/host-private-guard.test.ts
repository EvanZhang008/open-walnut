/**
 * Class rule: nothing of a task kept local reaches a host's copies (core/replication/host-private.ts).
 *
 * Read from the source, never from a list kept here:
 *   - every leader copy kind (kinds/index.ts copyKinds, and the task copy's tasks and registry)
 *     names whose its rows are (`owners`), or why they are no one's (`taskFree`);
 *   - a kind of owned rows proves, row by row, that the real filter (hostManifest) leaves out a
 *     row naming a kept task through each of its task fields: a new owned kind fails here until
 *     its rows are added below; a new kind declared task-free fails until it is reviewed below;
 *   - every kind a follower serves on /bridge/replica has its leader kind here (no copy goes
 *     around the filter), and every module that reads the follower list (replicaTargets) calls
 *     host-private.ts's filter, or is a reviewed sender of no one's rows;
 *   - every copy a host's daemon takes (providers/daemon-twin-state.ts, whose own ratchet lists
 *     every `.configure` / `.sync` command and `host.slice`) names the module that builds it
 *     through that filter, which calls it, and every part it ships: each filtered part has a test
 *     with a kept-task fixture that shows its rows or files leave (titled
 *     "kept fixture: <command> <part>"), each other part says why it holds no task's data; or the
 *     copy says why it holds none at all, reviewed here.
 */
import { describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-private-guard', { CLOUD_MODE: false }))

import { copyKinds } from '../../../src/core/replication/kinds/index.js'
import { REGISTRY_KIND, TASKS_KIND } from '../../../src/core/replication/task-replica.js'
import { hostManifest, hostPrivacyOf, isTaskFree, type OwnedKind } from '../../../src/core/replication/host-private.js'
import { buildKindManifest, type LeaderKind } from '../../../src/core/replication/kind-leader.js'
import { followerKindNames } from '../../../src/core/replication/kind-follower.js'
import { sha12 } from '../../../src/core/replication/kind.js'
import { DAEMON_TWIN_STATE } from '../../../src/providers/daemon-twin-state.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')
type Kind = LeaderKind<any> & OwnedKind<any>

/** Every leader kind, from the source. */
const KINDS: Kind[] = [TASKS_KIND, REGISTRY_KIND, ...copyKinds()]

/** Reviewed: kinds whose rows are no task's (each kind's own `taskFree` says why). */
const REVIEWED_TASK_FREE = ['registry', 'prefs', 'config', 'personas', 'model-catalogs', 'stt-vocab', 'local-tasks']

const KEPT = 'kept-task'
const KEPT_SID = 'kept-session'
const hold = { target: 'acme', state: 'chosen', at: '2026-11-21T00:00:00.000Z' }

/**
 * For each kind of owned rows: rows that each belong to the kept task through one of the kind's
 * task fields (every one must be left out), and one that does not (it must stay). `derived`:
 * the parent rows left out, for a kind derived from another.
 */
const ROWS: Record<string, { kept: unknown[]; open: unknown; derived?: string[] }> = {
  // A subtask with no hold of its own is kept with its kept parent.
  tasks: { kept: [{ id: KEPT }, { id: 'kept-child', parent_task_id: KEPT }], open: { id: 'open-task' } },
  sessions: {
    kept: [{ claudeSessionId: KEPT_SID, taskId: KEPT }, { claudeSessionId: 's-2', taskId: 'open-task', legacyTaskId: KEPT }],
    open: { claudeSessionId: 's-3', taskId: 'open-task' },
  },
  requests: {
    kept: [
      { id: 'rq-1', fromSessionId: 's-open', toTaskId: KEPT }, { id: 'rq-2', fromSessionId: KEPT_SID },
      { id: 'rq-3', fromSessionId: 's-open', toSessionId: KEPT_SID }, { id: 'rq-4', fromSessionId: 's-open', carriedBy: [{ id: 'rq-0', taskId: KEPT }] },
    ],
    open: { id: 'rq-5', fromSessionId: 's-open', toTaskId: 'open-task' },
  },
  boards: { kept: [{ task_id: KEPT }], open: { task_id: 'open-task' } },
  inbox: {
    kept: [
      { id: 'lt-1-aaaa', sender: { sessionId: 'external', taskId: KEPT } }, { id: 'lt-2-aaaa', sender: { sessionId: KEPT_SID } },
      { id: 'lt-3-aaaa', sender: { sessionId: 'external' }, awayThread: { taskId: KEPT, since: null } },
      { id: 'lt-4-aaaa', sender: { sessionId: 'external' }, taskRefs: ['open-task', KEPT] },
    ],
    open: { id: 'lt-5-aaaa', sender: { sessionId: 'external', taskId: 'open-task' }, taskRefs: ['open-task'] },
  },
  'inbox-bodies': { kept: [{ name: 'lt-1-aaaa.html' }, { name: 'lt-1-aaaa.r2.md' }], open: { name: 'lt-5-aaaa.html' }, derived: ['lt-1-aaaa'] },
  routines: {
    kept: [
      { id: 'r1', job: { id: 'r1', executor: { type: 'task', config: { target: KEPT } } }, status: {} },
      { id: 'r2', job: { id: 'r2', ownerTaskId: KEPT }, status: {} }, { id: 'r3', job: { id: 'r3', checkActsFor: KEPT }, status: {} },
    ],
    open: { id: 'r4', job: { id: 'r4', ownerTaskId: 'open-task', executor: { type: 'task', config: { target: 'open-task' } } }, status: {} },
  },
  conversations: {
    kept: [{ agent: 'general', meta: { id: 'conv-1', askTaskId: KEPT } }],
    open: { agent: 'general', meta: { id: 'conv-2', askTaskId: 'open-task' } },
  },
  'conversation-bodies': { kept: [{ agent: 'general', id: 'conv-1' }], open: { agent: 'general', id: 'conv-2' }, derived: ['general/conv-1'] },
  // A letter's card goes with its letter (withheld for any of the letter's own owners).
  notifications: {
    kept: [{ id: 'n1', taskId: KEPT }, { id: 'n2', sessionId: KEPT_SID }, { id: 'n4', kind: 'letter', letterId: 'lt-1-aaaa' }],
    open: { id: 'n3', taskId: 'open-task', sessionId: 's-open', letterId: 'lt-5-aaaa' }, derived: ['lt-1-aaaa'],
  },
}

describe('nothing of a task kept local reaches a host: every copy kind', () => {
  it('names whose its rows are, or why they are no one\'s', () => {
    for (const k of KINDS) {
      expect(k.owners, `${k.kind}: owners (host-private.ts) or taskFree(why)`).toBeDefined()
      if (isTaskFree(k.owners)) expect(k.owners.taskFree.length, `${k.kind}: say why its rows are no task's`).toBeGreaterThan(20)
      else expect(typeof k.owners, k.kind).toBe('function')
    }
  })

  it('a kind declared task-free is one reviewed here', () => {
    expect(KINDS.filter((k) => isTaskFree(k.owners)).map((k) => k.kind).sort()).toEqual([...REVIEWED_TASK_FREE].sort())
  })

  it('a kind of owned rows leaves out, through the real filter, a row naming the kept task through each of its fields', async () => {
    const owned = KINDS.filter((k) => !isTaskFree(k.owners))
    expect(owned.map((k) => k.kind).sort(), 'every kind of owned rows has its rows here').toEqual(Object.keys(ROWS).sort())
    for (const k of owned) {
      const sample = ROWS[k.kind]!
      const rows = [...sample.kept, sample.open]
      // Keys the kind's own way; a plain hash (the kinds' own hash caches read store fields).
      const manifest = await buildKindManifest({ ...k, hash: (r: unknown) => sha12(JSON.stringify(r)) }, rows)
      expect(manifest.entries.length, `${k.kind}: sample keys are distinct`).toBe(rows.length)
      const p = hostPrivacyOf([{ id: KEPT, sync_hold: hold }, { id: 'kept-child', parent_task_id: KEPT }, { id: 'open-task' }], [{ claudeSessionId: KEPT_SID, taskId: KEPT }])
      if (k.derivedFrom) {
        expect(KINDS.some((x) => x.kind === k.derivedFrom && !isTaskFree(x.owners)), `${k.kind} derives from an owned kind`).toBe(true)
        p.derived.set(k.derivedFrom, new Set(sample.derived ?? []))
      }
      const host = await hostManifest(k, manifest, p, async () => undefined)
      expect(host.entries.map((e) => e.k), `${k.kind}: only the open row reaches a host`).toEqual([k.key(sample.open)])
    }
  })

  it('every kind a follower serves has its leader kind here: no copy goes around the filter', async () => {
    const { registerBuiltinReplicaKinds } = await import('../../../src/web/routes/bridge-replica.js')
    await registerBuiltinReplicaKinds()
    const names = followerKindNames()
    expect(names.length).toBeGreaterThan(10)
    // `search` is the search copy, filtered in search-replica.ts (searchKeyKeptFromHosts).
    for (const n of names) if (n !== 'search') expect(KINDS.map((k) => k.kind), `follower kind ${n}`).toContain(n)
  })

  it('every module that reads the follower list goes through host-private.ts, or sends no one\'s rows', () => {
    /** Reviewed senders of no task's rows. */
    const TASK_FREE_SENDERS: Record<string, string> = {
      'src/core/replication/device-replica.ts': 'the hashes of the signed-in devices\' tokens',
      'src/core/replication/replica-targets.ts': 'the list itself',
      'src/core/companion-host-replica.ts': 'the cloud companion\'s side of the file copy (it holds every task)',
    }
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name)) files.push(p)
      }
    }
    walk(path.join(ROOT, 'src'))
    // The leader's copy rounds (replicaTargets).
    const readers = files.map((f) => path.relative(ROOT, f)).filter((f) => /\breplicaTargets\b/.test(readFileSync(path.join(ROOT, f), 'utf8')))
    expect(readers).toEqual(expect.arrayContaining(['src/core/replication/task-replica.ts', 'src/core/replication/kinds/copy-kind.ts', 'src/core/replication/search-replica.ts']))
    for (const f of readers) {
      if (TASK_FREE_SENDERS[f]) continue
      expect(callsFilter(f), `${f} reads the follower list: build what a host takes through host-private.ts`).toBe(true)
    }
  })
})

describe('nothing of a task kept local reaches a host: the session rows a start carries', () => {
  it('every module that puts session rows on a start or resume for a host (`taskRows`) builds them through host-private.ts', () => {
    /** Reviewed: modules that name the field without sending rows, with why. */
    const READERS: Record<string, string> = {
      'src/core/session-channel/host-api.ts': 'the wire type',
      'src/core/session-channel/host-routes.ts': 'the host side: it takes the rows, sends none',
      'src/core/session-channel/switch-catch-up.ts': 'a seam of the reader; the rows are built by start-task-rows.ts withTaskRows',
    }
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name)) files.push(p)
      }
    }
    walk(path.join(ROOT, 'src'))
    const code = (f: string) => readFileSync(path.join(ROOT, f), 'utf8').replace(/^\s*(\/\/|\*).*$/gm, '')
    const senders = files.map((f) => path.relative(ROOT, f)).filter((f) => /\btaskRows\??\s*:/.test(code(f)))
    expect(senders).toEqual(expect.arrayContaining(['src/core/session-channel/start-task-rows.ts']))
    for (const f of senders) {
      if (READERS[f]) continue
      expect(callsFilter(f), `${f} puts session rows on a start for a host: build them through host-private.ts`).toBe(true)
    }
    // Its behaviour on a kept task: tests/core/session-channel/start-task-rows.test.ts ("kept fixture: start taskRows").
    expect(testTexts()).toContain('kept fixture: start taskRows')
  })
})

/** The calls of host-private.ts that build what a host takes. */
const FILTERS = /\b(hostPrivacyNow|hostPrivacyOf|hostManifest|keptOffHost|keptOffHostNow|ownedRowKept|searchKeyKeptFromHosts|keptVaultFolders|textKeptFromHosts)\(/

/** Whether module `f` calls the filter (outside its comments), not only imports it. */
function callsFilter(f: string): boolean {
  return FILTERS.test(readFileSync(path.join(ROOT, f), 'utf8').replace(/^\s*(\/\/|\*).*$/gm, ''))
}

/** Reviewed: daemon copies that hold no task's data (each entry's own `taskFree` says why). */
const REVIEWED_TASK_FREE_COPIES = [
  'bridge.configure', 'server.configure', 'jobs.configure', 'leader.configure', 'leader.spawnTemplate', 'workspace.configure',
  'turns.configure', 'net.configure', 'hooks.configure', 'skills.sync', 'secrets.sync', 'usage.budget.configure',
]

/** Every test file's text, for the fixture titles. */
function testTexts(): string {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.test\.ts$/.test(e.name)) out.push(readFileSync(p, 'utf8'))
    }
  }
  walk(path.join(ROOT, 'tests'))
  return out.join('\n')
}

describe('nothing of a task kept local reaches a host: every copy its daemon takes', () => {
  it('names the module that builds it through host-private.ts, which calls the filter, or why it holds no task\'s data', () => {
    const entries = Object.entries(DAEMON_TWIN_STATE)
    expect(entries.map(([cmd]) => cmd)).toEqual(expect.arrayContaining(['host.slice', 'triggers.configure', 'replica.sync']))
    for (const [cmd, e] of entries) {
      expect(e.hostPrivate, `${cmd}: say what it carries of a task kept local (daemon-twin-state.ts hostPrivate)`).toBeDefined()
      if ('filteredIn' in e.hostPrivate) expect(callsFilter(e.hostPrivate.filteredIn), `${cmd}: ${e.hostPrivate.filteredIn} builds it through host-private.ts`).toBe(true)
      else expect(e.hostPrivate.taskFree.length, `${cmd}: say why it holds no task's data`).toBeGreaterThan(20)
    }
  })

  it('a filtered copy names every part it ships, and each filtered part has its kept-task fixture test', () => {
    const tests = testTexts()
    const missing: string[] = []
    for (const [cmd, e] of Object.entries(DAEMON_TWIN_STATE)) {
      if (!('filteredIn' in e.hostPrivate)) continue
      const parts = Object.entries(e.hostPrivate.parts)
      expect(parts.length, `${cmd}: name the parts it ships`).toBeGreaterThan(0)
      expect(parts.some(([, v]) => v === 'filtered'), `${cmd}: a filtered copy filters some part`).toBe(true)
      for (const [part, v] of parts) {
        if (v === 'filtered') { if (!tests.includes(`kept fixture: ${cmd} ${part}`)) missing.push(`${cmd} ${part}`) }
        else expect(v.taskFree.length, `${cmd} ${part}: say why it holds no task's data`).toBeGreaterThan(20)
      }
    }
    expect(missing, 'each needs a test titled "kept fixture: <command> <part>" that shows a kept task\'s rows leave it').toEqual([])
  })

  it('a copy declared free of task data is one reviewed here', () => {
    const free = Object.entries(DAEMON_TWIN_STATE).filter(([, e]) => 'taskFree' in e.hostPrivate).map(([cmd]) => cmd)
    expect(free.sort()).toEqual([...REVIEWED_TASK_FREE_COPIES].sort())
  })
})
