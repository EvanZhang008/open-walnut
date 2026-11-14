/**
 * The one-time move to the simple mail flow (src/core/router/simplify-migration.ts): non-router
 * tasks leave their areas (membership and `router_area_id` marks), restricted items become open
 * items of the same area, rule bindings go, receiver ('work') session profiles are dropped, all
 * backed up first and put back by restore.
 *
 * The real areas file (updateRouterAreas / readRouterAreas) under a temp home; the task store and
 * session registry are injected fakes that record their calls. All names are invented.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Each areas write records whether the backup was already on disk: the backup must land first.
const seen = vi.hoisted(() => ({ backupAtWrite: [] as boolean[], file: '' }))
vi.mock('../../src/core/router/areas.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/router/areas.js')>()
  const { existsSync } = await import('node:fs')
  return {
    ...real,
    // Recorded once the change is made, just before the registry is written.
    updateRouterAreas: (async (home, change) => real.updateRouterAreas(home, async (file) => {
      const out = await change(file)
      seen.backupAtWrite.push(!!seen.file && existsSync(seen.file))
      return out
    })) as typeof real.updateRouterAreas,
  }
})

import { readRouterAreas, updateRouterAreas, type RouterAreasFile } from '../../src/core/router/areas.js'
import {
  planRouterSimplify, restoreRouterSimplify, routerHandoffAsksPath, routerSimplifyBackupsPath, runRouterSimplify, type RouterSimplifyDeps,
} from '../../src/core/router/simplify-migration.js'
import type { SessionProfile, Task } from '../../src/core/types.js'
import { seedTaskStore } from '../helpers/router-task-store.js'

const DESK = 'desk@marina.example.invalid'
const RESTRICTED = { kind: 'mail' as const, account: DESK, message: 'INBOX:1:1', version: 'v1' }
const ALREADY_OPEN = { kind: 'mail' as const, account: DESK, message: 'INBOX:1:2', version: 'v2' }
const RULE = { ruleId: 'rule-dock', revision: 'a'.repeat(64), areaId: 'personal', confirmedAt: 5 }
const WORK_PROFILE: SessionProfile = { areaId: 'personal', areaRole: 'work', areaPolicyVersion: 1 }
const ROUTER_PROFILE: SessionProfile = { areaId: 'personal', areaRole: 'router', areaPolicyVersion: 1 }

let home: string

function legacyFile(): RouterAreasFile {
  return {
    version: 1,
    areas: [
      { id: 'personal', name: 'Personal', host: '__local__', taskIds: ['router-p', 'work-a', 'work-b'], sources: [{ kind: 'mail', account: DESK }] },
      { id: 'side', name: 'Side', host: '__local__', taskIds: ['router-s'], sources: [] },
    ],
    routers: [{ taskId: 'router-p', areaId: 'personal', paused: false }, { taskId: 'router-s', areaId: 'side', paused: true }],
    items: [{ source: RESTRICTED, areaId: 'personal', canonicalKey: 'rfc-1' }],
    openItems: [{ source: ALREADY_OPEN, areaId: 'personal' }],
    ruleBindings: [RULE],
  }
}

interface World {
  tasks: Map<string, Pick<Task, 'id' | 'org_role' | 'router_area_id'>>
  profiles: Map<string, SessionProfile | undefined>
  calls: string[]
  deps: RouterSimplifyDeps
}

function world(): World {
  const tasks = new Map<string, Pick<Task, 'id' | 'org_role' | 'router_area_id'>>([
    ['router-p', { id: 'router-p', org_role: 'router', router_area_id: 'personal' }],
    ['router-s', { id: 'router-s', org_role: 'router', router_area_id: 'side' }],
    ['work-a', { id: 'work-a', router_area_id: 'personal' }],
    ['work-b', { id: 'work-b', router_area_id: 'personal' }],
    // A task an older build marked but no longer lists.
    ['stray', { id: 'stray', router_area_id: 'side' }],
    ['plain', { id: 'plain' }],
  ])
  const profiles = new Map<string, SessionProfile | undefined>([
    ['sid-router', ROUTER_PROFILE], ['sid-work-a', WORK_PROFILE], ['sid-work-b', { ...WORK_PROFILE }], ['sid-plain', undefined],
  ])
  const calls: string[] = []
  const w: World = {
    tasks, profiles, calls,
    deps: {
      home: '',
      now: () => new Date('2026-11-14T10:00:00Z'),
      listTasks: async () => [...tasks.values()].map((one) => ({ ...one })),
      clearMark: async (taskId, areaId) => {
        calls.push(`clear:${taskId}:${areaId}`)
        const task = tasks.get(taskId)!
        if (task.router_area_id === areaId) tasks.set(taskId, { ...task, router_area_id: undefined })
      },
      setMark: async (taskId, areaId) => {
        calls.push(`set:${taskId}:${areaId}`)
        const task = tasks.get(taskId)!
        if (!task.router_area_id) tasks.set(taskId, { ...task, router_area_id: areaId })
      },
      listProfiles: async () => [...profiles].map(([sessionId, profile]) => ({ sessionId, ...(profile ? { profile } : {}) })),
      setProfile: async (sessionId, profile) => {
        calls.push(`profile:${sessionId}:${profile?.areaRole ?? 'none'}`)
        profiles.set(sessionId, profile)
      },
    },
  }
  return w
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'router-simplify-'))
  seedTaskStore(home)
  seen.backupAtWrite = []
  seen.file = routerSimplifyBackupsPath(home)
  await updateRouterAreas(home, () => legacyFile())
  seen.backupAtWrite = []
})

afterEach(() => {
  if (home && path.basename(home).startsWith('router-simplify-')) fs.rmSync(home, { recursive: true, force: true })
})

describe('planRouterSimplify', () => {
  it('lists the members, items, rule bindings, marks and work profiles to move, and changes nothing', async () => {
    const w = world()
    w.deps.home = home
    const before = await readRouterAreas(home)
    const plan = await planRouterSimplify(w.deps)
    expect(plan.members).toEqual([{ areaId: 'personal', taskIds: ['work-a', 'work-b'] }])
    expect(plan.items).toEqual([{ source: RESTRICTED, areaId: 'personal', canonicalKey: 'rfc-1' }])
    expect(plan.ruleBindings).toEqual([RULE])
    expect(plan.marks).toEqual([
      { taskId: 'work-a', areaId: 'personal' }, { taskId: 'work-b', areaId: 'personal' }, { taskId: 'stray', areaId: 'side' },
    ])
    expect(plan.profiles.map((one) => one.sessionId)).toEqual(['sid-work-a', 'sid-work-b'])
    expect(await readRouterAreas(home)).toEqual(before)
    expect(w.calls).toEqual([])
    expect(fs.existsSync(routerSimplifyBackupsPath(home))).toBe(false)
  })
})

describe('runRouterSimplify', () => {
  it('backs up first, then moves everything: only routers stay in areas, items open, rules gone, marks and work profiles cleared', async () => {
    const w = world()
    w.deps.home = home
    const run = await runRouterSimplify(w.deps)
    expect(run).not.toBeNull()
    expect(run!.at).toBe('2026-11-14T10:00:00.000Z')
    // The one areas write happened with the backup already on disk.
    expect(seen.backupAtWrite).toEqual([true])
    const backups = JSON.parse(fs.readFileSync(routerSimplifyBackupsPath(home), 'utf-8'))
    expect(backups).toEqual([run])

    const after = await readRouterAreas(home)
    expect(after.areas.map((one) => [one.id, one.taskIds])).toEqual([['personal', ['router-p']], ['side', ['router-s']]])
    expect(after.routers).toEqual(legacyFile().routers)
    expect(after.items).toEqual([])
    expect(after.openItems).toEqual([
      { source: ALREADY_OPEN, areaId: 'personal' },
      { source: RESTRICTED, areaId: 'personal', canonicalKey: 'rfc-1' },
    ])
    expect(after.ruleBindings).toBeUndefined()

    expect(w.tasks.get('work-a')!.router_area_id).toBeUndefined()
    expect(w.tasks.get('work-b')!.router_area_id).toBeUndefined()
    expect(w.tasks.get('stray')!.router_area_id).toBeUndefined()
    // Routers keep their marks and profiles.
    expect(w.tasks.get('router-p')!.router_area_id).toBe('personal')
    expect(w.profiles.get('sid-router')).toEqual(ROUTER_PROFILE)
    expect(w.profiles.get('sid-work-a')).toBeUndefined()
    expect(w.profiles.get('sid-work-b')).toBeUndefined()
    expect(w.calls.filter((one) => one.startsWith('profile:'))).toEqual(['profile:sid-work-a:none', 'profile:sid-work-b:none'])
  })

  it('is idempotent: a second run finds nothing, writes nothing and adds no backup', async () => {
    const w = world()
    w.deps.home = home
    expect(await runRouterSimplify(w.deps)).not.toBeNull()
    const file = await readRouterAreas(home)
    const calls = w.calls.length
    seen.backupAtWrite = []
    expect(await runRouterSimplify(w.deps)).toBeNull()
    expect(await readRouterAreas(home)).toEqual(file)
    expect(seen.backupAtWrite).toEqual([])
    expect(w.calls).toHaveLength(calls)
    expect(JSON.parse(fs.readFileSync(routerSimplifyBackupsPath(home), 'utf-8'))).toHaveLength(1)
  })

  it('a store that is already simple writes no backup at all', async () => {
    const w = world()
    w.deps.home = home
    await updateRouterAreas(home, (file) => ({
      ...file,
      areas: file.areas.map((one) => ({ ...one, taskIds: one.taskIds.filter((id) => id.startsWith('router-')) })),
      items: [], openItems: [...(file.openItems ?? []), ...file.items], ruleBindings: [],
    }))
    w.tasks.clear()
    w.profiles.clear()
    expect(await runRouterSimplify(w.deps)).toBeNull()
    expect(fs.existsSync(routerSimplifyBackupsPath(home))).toBe(false)
  })
})

describe('restoreRouterSimplify', () => {
  it('puts back members, restricted items, rule bindings, marks and work profiles', async () => {
    const w = world()
    w.deps.home = home
    const before = await readRouterAreas(home)
    await runRouterSimplify(w.deps)
    expect(await restoreRouterSimplify(w.deps)).toBe(1)
    const restored = await readRouterAreas(home)
    expect(restored.areas).toEqual(before.areas)
    expect(restored.items).toEqual(before.items)
    expect(restored.openItems).toEqual(before.openItems)
    expect(restored.ruleBindings).toEqual(before.ruleBindings)
    expect(w.tasks.get('work-a')!.router_area_id).toBe('personal')
    expect(w.tasks.get('work-b')!.router_area_id).toBe('personal')
    expect(w.tasks.get('stray')!.router_area_id).toBe('side')
    expect(w.profiles.get('sid-work-a')).toEqual(WORK_PROFILE)
    expect(w.profiles.get('sid-work-b')).toEqual(WORK_PROFILE)
  })

  it('leaves a value changed since the run as it is now', async () => {
    const w = world()
    w.deps.home = home
    await runRouterSimplify(w.deps)
    // After the move the person gave one session a new profile and re-marked one task.
    const fresh: SessionProfile = { areaId: 'side', areaRole: 'router', areaPolicyVersion: 1 }
    w.profiles.set('sid-work-a', fresh)
    w.tasks.set('work-b', { id: 'work-b', router_area_id: 'side' })
    await restoreRouterSimplify(w.deps)
    expect(w.profiles.get('sid-work-a')).toEqual(fresh)
    expect(w.tasks.get('work-b')!.router_area_id).toBe('side')
    expect(w.profiles.get('sid-work-b')).toEqual(WORK_PROFILE)
  })

  it('restores each run once: a second restore changes nothing and adds no duplicate', async () => {
    const w = world()
    w.deps.home = home
    const before = await readRouterAreas(home)
    await runRouterSimplify(w.deps)
    expect(await restoreRouterSimplify(w.deps)).toBe(1)
    expect(await restoreRouterSimplify(w.deps)).toBe(0)
    const restored = await readRouterAreas(home)
    expect(restored.items).toEqual(before.items)
    expect(restored.ruleBindings).toEqual(before.ruleBindings)
  })

  it('backs up and moves the same set: a router by org_role alone stays listed and is not backed up', async () => {
    const w = world()
    w.deps.home = home
    // A router task (org_role) the registry lists as a member but not as a router assignment.
    await updateRouterAreas(home, (file) => {
      file.areas[0]!.taskIds.push('router-x')
      return file
    })
    w.tasks.set('router-x', { id: 'router-x', org_role: 'router' })
    const run = await runRouterSimplify(w.deps)
    expect(run!.members.flatMap((one) => one.taskIds)).not.toContain('router-x')
    expect((await readRouterAreas(home)).areas[0]!.taskIds).toContain('router-x')
  })

  it('cancels each handoff ask an older build left pending, once', async () => {
    const w = world()
    w.deps.home = home
    const canceled: string[] = []
    w.deps.cancelApproval = async (id) => { canceled.push(id) }
    const file = routerHandoffAsksPath(home)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [
      { approvalId: 'ap-1', state: 'pending' }, { approvalId: 'ap-2', state: 'approved' },
    ] }))
    await runRouterSimplify(w.deps)
    await runRouterSimplify(w.deps)
    expect(canceled).toEqual(['ap-1'])
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).entries.map((one: { state: string }) => one.state)).toEqual(['canceled', 'approved'])
  })

  it('a handoff ask whose cancel failed stays pending and is asked again at the next boot', async () => {
    const w = world()
    w.deps.home = home
    let fail = true
    const canceled: string[] = []
    w.deps.cancelApproval = async (id) => { if (fail) throw new Error('approvals store busy'); canceled.push(id) }
    const file = routerHandoffAsksPath(home)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [{ approvalId: 'ap-1', state: 'pending' }] }))
    await runRouterSimplify(w.deps)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).entries[0].state).toBe('pending')
    fail = false
    await runRouterSimplify(w.deps)
    expect(canceled).toEqual(['ap-1'])
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).entries[0].state).toBe('canceled')
  })

  it('with no backup restores nothing', async () => {
    const w = world()
    w.deps.home = home
    const before = await readRouterAreas(home)
    expect(await restoreRouterSimplify(w.deps)).toBe(0)
    expect(await readRouterAreas(home)).toEqual(before)
    expect(w.calls).toEqual([])
  })
})
