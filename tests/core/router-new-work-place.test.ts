/**
 * Where a router's new work is born (ensureRouterNewWork): in the project of the one open VP its
 * router works closely with, so that VP's team sees it; with no link, several projects, a closed
 * VP or a paused router, in the Inbox. Round-two review: new work for a new subject sat in the
 * Inbox, where no VP saw it, which is the very thing the user first asked about.
 *
 * Real task store and area file in a temp home.
 */
import fsp from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('router-new-work-place'))

import { WALNUT_HOME, TASKS_DIR } from '../../src/constants.js'
import { closeDb } from '../../src/core/task-db.js'
import { _resetForTesting, addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { ensureRouterNewWork, routerNewWorkId, routerNewWorkProject } from '../../src/core/router/service.js'
import { updateRouterAreas } from '../../src/core/router/areas.js'

let n = 0

beforeEach(async () => {
  closeDb(); _resetForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(TASKS_DIR, { recursive: true })
})
afterEach(async () => {
  closeDb(); _resetForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

async function setup(opts: { links: (vps: string[]) => string[]; paused?: boolean; closeFirst?: boolean }) {
  // Each call its own item and key: one id per item, so a second call never reuses the first task.
  const account = `desk${++n}@example.invalid`
  const item = { kind: 'mail' as const, account, message: `m-${n}` }
  const key = `key-${n}`
  const vps: string[] = []
  for (const project of ['Pier', 'Quay']) {
    const { task } = await addTask({ title: `${project} lead`, project, source: 'local' })
    await updateTaskRaw(task.id, { org_role: 'lead' } as never)
    vps.push(task.id)
  }
  if (opts.closeFirst) await updateTaskRaw(vps[0]!, { phase: 'COMPLETE', status: 'done' } as never)
  const { task: router } = await addTask({ title: 'Desk router', project: '', source: 'local' })
  await updateTaskRaw(router.id, { org_role: 'router', router_area_id: `desk-${n}`, router_links: opts.links(vps) } as never)
  // Each call its own area, added beside the earlier ones (an area's items are never taken away).
  const area = `desk-${n}`
  await updateRouterAreas(WALNUT_HOME, (file) => ({
    version: 1,
    areas: [...(file.areas ?? []), { id: area, name: `Desk ${n}`, host: '__local__', taskIds: [router.id], sources: [{ kind: 'mail', account }] }],
    routers: [...(file.routers ?? []), { taskId: router.id, areaId: area, paused: opts.paused ?? false }],
    items: [...(file.items ?? []), { areaId: area, source: item }],
  }))
  const taskId = await routerNewWorkId(area, key)
  await ensureRouterNewWork({ areaId: area, source: item, key, taskId, title: 'Dock repair', brief: 'Fix the dock.' }, WALNUT_HOME)
  return getTask(taskId)
}

describe('new router work', () => {
  it('is born in the project of the one VP the router works closely with, still in its area', async () => {
    const t = await setup({ links: (v) => [v[0]!] })
    expect(t.project).toBe('Pier')
    expect(t.router_area_id).toBe(`desk-${n}`)
    expect(t.source).toBe('local')
  })

  it('goes to the Inbox with no link, two projects, only a closed VP, or no reading router', async () => {
    expect((await setup({ links: () => [] })).project ?? '').toBe('')
    expect((await setup({ links: (v) => v })).project ?? '').toBe('')
    expect((await setup({ links: (v) => [v[0]!], closeFirst: true })).project ?? '').toBe('')
    expect((await setup({ links: (v) => [v[1]!], paused: true })).project ?? '').toBe('')
  })

  it('reads the links of the area\'s reading router only', () => {
    const lead = (id: string, project: string, phase = 'IN_PROGRESS') => ({ id, org_role: 'lead', phase, project }) as never
    expect(routerNewWorkProject(['a'], [lead('a', 'Pier')])).toBe('Pier')
    expect(routerNewWorkProject(['a', 'b'], [lead('a', 'Pier'), lead('b', 'Pier')])).toBe('Pier')
    expect(routerNewWorkProject(['a'], [lead('a', '  ')])).toBe('')
    expect(routerNewWorkProject(['a'], [{ id: 'a', org_role: undefined, phase: 'IN_PROGRESS', project: 'Pier' } as never])).toBe('')
    expect(routerNewWorkProject([], [lead('a', 'Pier')])).toBe('')
  })
})
