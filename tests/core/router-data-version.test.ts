// Real SQLite files under a temp home: the stamp worker, the task store and the areas file together.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('router-data-version'))

import Database from '../../src/lib/sqlite.js'
import { WALNUT_HOME, TASKS_DIR } from '../../src/constants.js'
import { closeDb, getDb, MAX_SUPPORTED_SCHEMA_VERSION, SCHEMA_VERSION, TASK_DB_PATH } from '../../src/core/task-db.js'
import { _resetForTesting, addTask, getTask } from '../../src/core/task-manager.js'
import { TASK_DB_ROUTER_VERSION, TASK_DB_SCHEMA_VERSION } from '../../src/core/task-db-version.js'
import { ensureRouterDataVersion, routerTaskDbPath } from '../../src/core/router/data-version.js'
import { ensureRouterNewWork, routerNewWorkId } from '../../src/core/router/service.js'
import { PluginDatabaseClient } from '../../src/core/plugins/plugin-storage.js'
import { RouterAreaError, readRouterAreas, routerAreasPath, updateRouterAreas, type RouterAreasFile } from '../../src/core/router/areas.js'
import { seedTaskStore, taskStoreVersion } from '../helpers/router-task-store.js'

const ACCOUNT = 'desk@example.invalid'

function oneArea(taskId = 'task-desk'): RouterAreasFile {
  return {
    version: 1,
    areas: [{ id: 'desk', name: 'Desk', host: '__local__', taskIds: [taskId], sources: [{ kind: 'mail', account: ACCOUNT }] }],
    routers: [{ taskId, areaId: 'desk', paused: true }],
    items: [],
  }
}

const EMPTY: RouterAreasFile = { version: 1, areas: [], routers: [], items: [] }

async function refusal(run: () => Promise<unknown>): Promise<{ code?: string; status?: number; message: string }> {
  try { await run() } catch (error) { return error as never }
  throw new Error('expected a refusal')
}

function integrity(file: string): string {
  const db = new Database(file)
  try { return (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check } finally { db.close() }
}

const areasRaw = () => fs.readFileSync(routerAreasPath(WALNUT_HOME), 'utf-8')

beforeEach(async () => {
  closeDb()
  _resetForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(TASKS_DIR, { recursive: true })
})

afterEach(async () => {
  closeDb()
  _resetForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('task store version for isolated areas', () => {
  it('shares one version constant with the task store and stamps above it', () => {
    expect(SCHEMA_VERSION).toBe(TASK_DB_SCHEMA_VERSION)
    expect(TASK_DB_SCHEMA_VERSION).toBe(13)
    expect(TASK_DB_ROUTER_VERSION).toBe(14)
    expect(MAX_SUPPORTED_SCHEMA_VERSION).toBe(14)
    expect(routerTaskDbPath(WALNUT_HOME)).toBe(TASK_DB_PATH)
  })

  it('an ordinary install stays 13, and an empty areas save stamps nothing', async () => {
    getDb()
    expect(taskStoreVersion(TASK_DB_PATH)).toBe(13)
    await updateRouterAreas(WALNUT_HOME, () => EMPTY)
    expect(taskStoreVersion(TASK_DB_PATH)).toBe(13)
  })

  it('the first non-empty area stamps 14 before the areas file is saved; an older build (max 13) refuses it', async () => {
    getDb()
    expect(fs.existsSync(routerAreasPath(WALNUT_HOME))).toBe(false)
    await updateRouterAreas(WALNUT_HOME, () => oneArea())
    expect(taskStoreVersion(TASK_DB_PATH)).toBe(14)
    expect((await readRouterAreas(WALNUT_HOME)).areas.map((a) => a.id)).toEqual(['desk'])
    // What a published build checks on open: anything above its own 13 is refused.
    expect(taskStoreVersion(TASK_DB_PATH) > TASK_DB_SCHEMA_VERSION).toBe(true)
  })

  it('a stamp that fails leaves the areas file as it was', async () => {
    getDb()
    await updateRouterAreas(WALNUT_HOME, () => EMPTY)
    const before = areasRaw()
    closeDb()
    fs.writeFileSync(TASK_DB_PATH, 'this is not a database file at all, only text that fills its header and more')
    const error = await refusal(() => updateRouterAreas(WALNUT_HOME, () => oneArea()))
    expect(error).toBeInstanceOf(RouterAreaError)
    expect(error.code).toBe('router_data_version')
    expect(error.status).toBe(503)
    expect(areasRaw()).toBe(before)
  })

  it('repeated saves keep 14 and never set it back to 13', async () => {
    getDb()
    await updateRouterAreas(WALNUT_HOME, () => oneArea())
    await updateRouterAreas(WALNUT_HOME, (file) => ({ ...file, items: [{ areaId: 'desk', source: { kind: 'mail', account: ACCOUNT, message: 'm-1' } }] }))
    expect(await ensureRouterDataVersion(WALNUT_HOME)).toBe(14)
    await updateRouterAreas(WALNUT_HOME, (file) => file)
    expect(taskStoreVersion(TASK_DB_PATH)).toBe(14)
  })

  it('this build opens a stamped store, migrates nothing and keeps 14', async () => {
    getDb()
    const { task } = await addTask({ title: 'Desk router', project: '', source: 'local', org_role: 'router', router_area_id: 'desk' } as never)
    await updateRouterAreas(WALNUT_HOME, () => oneArea(task.id))
    closeDb()
    _resetForTesting()
    expect(getDb()).not.toBeNull()
    expect(getDb()!.pragma('user_version', { simple: true })).toBe(14)
    // The area mark rides the task payload and survives the reopen.
    const back = await getTask(task.id)
    expect(back.router_area_id).toBe('desk')
    expect(back.org_role).toBe('router')
    closeDb()
    expect(taskStoreVersion(TASK_DB_PATH)).toBe(14)
    expect(integrity(TASK_DB_PATH)).toBe('ok')
  })

  it('a newer store (15) is refused by the stamp and by the task store, untouched', async () => {
    getDb()
    await updateRouterAreas(WALNUT_HOME, () => EMPTY)
    const before = areasRaw()
    closeDb()
    const raw = new Database(TASK_DB_PATH)
    raw.pragma('user_version = 15')
    raw.close()
    const error = await refusal(() => updateRouterAreas(WALNUT_HOME, () => oneArea()))
    expect(error.code).toBe('router_data_version')
    expect(error.message).toContain('newer')
    expect(taskStoreVersion(TASK_DB_PATH)).toBe(15)
    expect(integrity(TASK_DB_PATH)).toBe('ok')
    expect(areasRaw()).toBe(before)
    expect(() => getDb()).toThrow(/schema 15 is newer than supported schema 14/)
  })

  it('a missing store is refused and never created', async () => {
    await fsp.rm(TASKS_DIR, { recursive: true, force: true })
    const error = await refusal(() => updateRouterAreas(WALNUT_HOME, () => oneArea()))
    expect(error.code).toBe('router_data_version')
    expect(fs.existsSync(TASK_DB_PATH)).toBe(false)
    expect(fs.existsSync(routerAreasPath(WALNUT_HOME))).toBe(false)
  })

  it('an empty, damaged or newer store is refused as it is: content, mode and mtime unchanged, no sidecars', async () => {
    const file = routerTaskDbPath(WALNUT_HOME)
    const cases: Array<[string, () => void, RegExp]> = [
      ['empty', () => fs.writeFileSync(file, ''), /not yet upgraded/],
      ['short text', () => fs.writeFileSync(file, 'not a task store\n'), /could not be checked/],
      ['long text', () => fs.writeFileSync(file, 'x'.repeat(4096)), /could not be checked/],
      ['newer', () => seedTaskStore(WALNUT_HOME, 15), /newer/],
    ]
    for (const [name, make, message] of cases) {
      // A fresh file each time, so no earlier connection holds its inode.
      await fsp.rm(file, { force: true })
      make()
      await fsp.chmod(file, 0o644)
      const before = { bytes: fs.readFileSync(file), stat: fs.statSync(file) }
      const error = await refusal(() => ensureRouterDataVersion(WALNUT_HOME))
      expect(error.code, name).toBe('router_data_version')
      expect(error.message, name).toMatch(message)
      const after = fs.statSync(file)
      expect(fs.readFileSync(file).equals(before.bytes), name).toBe(true)
      expect({ mode: after.mode, mtimeMs: after.mtimeMs }, name).toEqual({ mode: before.stat.mode, mtimeMs: before.stat.mtimeMs })
      for (const suffix of ['-wal', '-shm', '-journal']) expect(fs.existsSync(file + suffix), name).toBe(false)
    }
  })

  it('the existing-file worker leaves a 13 store in its own journal mode and mode when it stamps', async () => {
    const file = seedTaskStore(WALNUT_HOME, 13)
    await fsp.chmod(file, 0o644)
    expect(await ensureRouterDataVersion(WALNUT_HOME)).toBe(14)
    expect(fs.statSync(file).mode & 0o777).toBe(0o644)
    expect(taskStoreVersion(file)).toBe(14)
    expect(integrity(file)).toBe('ok')
  })

  it('a store not yet upgraded to 13 is refused, never stamped', async () => {
    const file = seedTaskStore(WALNUT_HOME, 12)
    expect((await refusal(() => ensureRouterDataVersion(WALNUT_HOME))).message).toContain('not yet upgraded')
    expect(taskStoreVersion(file)).toBe(12)
  })

  it('two stamps at once both succeed and land 14 once', async () => {
    const file = seedTaskStore(WALNUT_HOME, 13)
    expect(await Promise.all([ensureRouterDataVersion(WALNUT_HOME), ensureRouterDataVersion(WALNUT_HOME)])).toEqual([14, 14])
    expect(taskStoreVersion(file)).toBe(14)
  })

  it('one worker request: a failure inside it is refused and the worker still closes', async () => {
    seedTaskStore(WALNUT_HOME, 13)
    const calls: string[] = []
    const failing = () => ({
      async ensureUserVersion(...args: number[]) { calls.push(`ensure:${args.join(',')}`); throw new Error('disk I/O error') },
      async dispose() { calls.push('dispose') },
    })
    const error = await refusal(() => ensureRouterDataVersion(WALNUT_HOME, failing as never))
    expect(error.message).toContain('disk I/O error')
    expect(calls).toEqual(['ensure:13,14,14', 'dispose'])
    expect(taskStoreVersion(routerTaskDbPath(WALNUT_HOME))).toBe(13)
    expect(await ensureRouterDataVersion(WALNUT_HOME)).toBe(14)
  })

  it('an outcome it does not know is refused, never read as stamped', async () => {
    seedTaskStore(WALNUT_HOME, 13)
    const odd = () => ({ async ensureUserVersion() { return { status: 'unreadable' } as never }, async dispose() {} })
    expect((await refusal(() => ensureRouterDataVersion(WALNUT_HOME, odd as never))).code).toBe('router_data_version')
  })

  it('waits on a held write lock in the worker, not on this thread, then stamps', async () => {
    const file = seedTaskStore(WALNUT_HOME, 13)
    const holder = new Database(file)
    holder.exec('BEGIN IMMEDIATE')
    // Only this thread can release the lock: a stamp that blocked it would never finish.
    setTimeout(() => holder.exec('COMMIT'), 300)
    try {
      expect(await ensureRouterDataVersion(WALNUT_HOME)).toBe(14)
    } finally {
      if (holder.inTransaction) holder.exec('ROLLBACK')
      holder.close()
    }
    expect(taskStoreVersion(file)).toBe(14)
  })

  it('a 15 committed by another writer while the stamp waits is refused and kept', async () => {
    const file = seedTaskStore(WALNUT_HOME, 13)
    const writer = new Database(file)
    writer.exec('BEGIN IMMEDIATE')
    writer.pragma('user_version = 15')
    setTimeout(() => writer.exec('COMMIT'), 300)
    try {
      expect((await refusal(() => ensureRouterDataVersion(WALNUT_HOME))).message).toContain('newer')
    } finally {
      if (writer.inTransaction) writer.exec('ROLLBACK')
      writer.close()
    }
    expect(taskStoreVersion(file)).toBe(15)
    expect(integrity(file)).toBe('ok')
  })

  it('the worker request never lowers a version and checks its arguments', async () => {
    const file = seedTaskStore(WALNUT_HOME, 13)
    const client = new PluginDatabaseClient(file)
    try {
      await expect(client.ensureUserVersion(14, 13, 14)).rejects.toThrow(RangeError)
      expect(await client.ensureUserVersion(13, 14, 14)).toEqual({ status: 'stamped', current: 14 })
      expect(await client.ensureUserVersion(13, 14, 14)).toEqual({ status: 'current', current: 14 })
      expect(await client.ensureUserVersion(10, 12, 13)).toEqual({ status: 'newer', current: 14 })
      expect(await client.ensureUserVersion(15, 15, 16)).toEqual({ status: 'older', current: 14 })
    } finally {
      await client.dispose()
    }
    expect(taskStoreVersion(file)).toBe(14)
  })

  it('an area registry left non-empty at 13 by an earlier build is stamped by the next area write', async () => {
    getDb()
    fs.mkdirSync(path.dirname(routerAreasPath(WALNUT_HOME)), { recursive: true })
    const item = { kind: 'mail' as const, account: ACCOUNT, message: 'm-1' }
    fs.writeFileSync(routerAreasPath(WALNUT_HOME), JSON.stringify({ ...oneArea(), items: [{ areaId: 'desk', source: item }] }))
    expect(taskStoreVersion(TASK_DB_PATH)).toBe(13)
    const taskId = await routerNewWorkId('desk', 'key-1')
    await ensureRouterNewWork({ areaId: 'desk', source: item, key: 'key-1', taskId, title: 'Desk follow-up', brief: 'Follow up on the desk mail.' }, WALNUT_HOME)
    expect(taskStoreVersion(TASK_DB_PATH)).toBe(14)
    expect((await getTask(taskId)).router_area_id).toBe('desk')
    expect((await readRouterAreas(WALNUT_HOME)).areas[0]!.taskIds).toContain(taskId)
  })

})
