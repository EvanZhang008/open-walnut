import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
vi.mock('../../src/constants.js', () => createMockConstants('router-data-version-boot'))
import { WALNUT_HOME, TASKS_DIR } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { closeDb, getDb } from '../../src/core/task-db.js'
import { _resetForTesting, addTask, getTask } from '../../src/core/task-manager.js'
import { routerAreasPath, type RouterAreasFile } from '../../src/core/router/areas.js'
import { routerTaskDbPath } from '../../src/core/router/data-version.js'
import { localDaemon } from '../../src/providers/local-daemon.js'
import { seedTaskStore, taskStoreVersion } from '../helpers/router-task-store.js'

// Fixture account only: no mailbox is read.
const ACCOUNT = 'desk@example.invalid'
const BOOT_MS = 60_000

const storeFile = () => routerTaskDbPath(WALNUT_HOME)
const areasRaw = () => fs.readFileSync(routerAreasPath(WALNUT_HOME), 'utf-8')

function oneArea(taskId: string): RouterAreasFile {
  return {
    version: 1,
    areas: [{ id: 'desk', name: 'Desk', host: '__local__', taskIds: [taskId], sources: [{ kind: 'mail', account: ACCOUNT }] }],
    routers: [{ taskId, areaId: 'desk', paused: true }],
    items: [],
  }
}

async function writeAreas(file: RouterAreasFile): Promise<void> {
  await fsp.mkdir(path.dirname(routerAreasPath(WALNUT_HOME)), { recursive: true })
  await fsp.writeFile(routerAreasPath(WALNUT_HOME), JSON.stringify(file, null, 2))
}

// A store an earlier build left at 13, with one router task and its area on disk; nothing holds it open at boot.
async function seedHistoricalInstall(): Promise<string> {
  getDb()
  const { task } = await addTask({ title: 'Desk router', project: '', source: 'local', org_role: 'router', router_area_id: 'desk' } as never)
  await writeAreas(oneArea(task.id))
  closeDb()
  _resetForTesting()
  return task.id
}

async function boot() {
  const server = await startServer({ port: 0, dev: true })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

// The store's version each time the boot reaches the local daemon: the stamp must already be there.
let daemonSawVersion: number[] = []
let daemonStarts: MockInstance

beforeEach(async () => {
  closeDb()
  _resetForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(TASKS_DIR, { recursive: true })
  daemonSawVersion = []
  const real = localDaemon.ensureRunning.bind(localDaemon)
  daemonStarts = vi.spyOn(localDaemon, 'ensureRunning').mockImplementation(async () => {
    daemonSawVersion.push(taskStoreVersion(storeFile()))
    return real()
  })
})

afterEach(async () => {
  try {
    await stopServer()
  } finally {
    daemonStarts.mockRestore()
    closeDb()
    _resetForTesting()
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  }
})

describe('boot confirms the task store version for isolated areas', () => {
  it('stamps a historical 13 store with a non-empty registry before the daemon starts or the port listens', async () => {
    const routerId = await seedHistoricalInstall()
    expect(taskStoreVersion(storeFile())).toBe(13)

    const base = await boot()

    expect(taskStoreVersion(storeFile())).toBe(14)
    expect(daemonSawVersion.length).toBeGreaterThan(0)
    expect(daemonSawVersion.every((version) => version === 14)).toBe(true)
    expect((await fetch(`${base}/api/config`)).status).toBe(200)
    expect(await getTask(routerId)).toMatchObject({ org_role: 'router', router_area_id: 'desk' })
  }, BOOT_MS)

  it('leaves a 13 store at 13 when the registry is empty or absent', async () => {
    getDb()
    closeDb()
    _resetForTesting()
    await writeAreas({ version: 1, areas: [], routers: [], items: [] })

    const base = await boot()

    expect(taskStoreVersion(storeFile())).toBe(13)
    expect((await fetch(`${base}/api/config`)).status).toBe(200)
    await stopServer()
    await fsp.rm(routerAreasPath(WALNUT_HOME), { force: true })
    closeDb()
    _resetForTesting()

    await boot()
    expect(taskStoreVersion(storeFile())).toBe(13)
  }, BOOT_MS * 2)

  it('refuses to boot on a store from a newer build, before the daemon or the port, and changes nothing', async () => {
    await seedHistoricalInstall()
    // A fresh 15 file, not the seeded one rewritten: a seeding connection still open here checkpoints into its own inode only.
    for (const suffix of ['-wal', '-shm', '']) await fsp.rm(storeFile() + suffix, { force: true })
    seedTaskStore(WALNUT_HOME, 15)
    const areasBefore = areasRaw()

    await expect(boot()).rejects.toMatchObject({ code: 'router_data_version' })
    // No server was kept: a second boot meets the same refusal, never "already running".
    await expect(boot()).rejects.toMatchObject({ code: 'router_data_version' })

    expect(daemonStarts).not.toHaveBeenCalled()
    expect(taskStoreVersion(storeFile())).toBe(15)
    expect(areasRaw()).toBe(areasBefore)
  }, BOOT_MS)

  it('refuses to boot on a damaged store, before the daemon or the port, and changes nothing', async () => {
    await seedHistoricalInstall()
    // A new file, not the seeded one rewritten: a seeding connection still open in this process checkpoints into its own inode only.
    for (const suffix of ['-wal', '-shm', '']) await fsp.rm(storeFile() + suffix, { force: true })
    await fsp.writeFile(storeFile(), 'not a task store\n')
    // A mode the stamp worker would tighten to 0600 if it ever opened the file.
    await fsp.chmod(storeFile(), 0o644)
    const areasBefore = areasRaw()
    const before = await fsp.stat(storeFile())

    await expect(boot()).rejects.toMatchObject({ code: 'router_data_version' })
    await expect(boot()).rejects.toMatchObject({ code: 'router_data_version' })

    expect(daemonStarts).not.toHaveBeenCalled()
    expect(await fsp.readFile(storeFile(), 'utf-8')).toBe('not a task store\n')
    const after = await fsp.stat(storeFile())
    expect({ ino: after.ino, mode: after.mode, mtimeMs: after.mtimeMs }).toEqual({ ino: before.ino, mode: before.mode, mtimeMs: before.mtimeMs })
    for (const suffix of ['-wal', '-shm', '-journal']) expect(fs.existsSync(storeFile() + suffix)).toBe(false)
    expect(areasRaw()).toBe(areasBefore)
  }, BOOT_MS)
})
