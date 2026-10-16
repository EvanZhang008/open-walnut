/**
 * A drained away edit reaches the companion through the real projection import
 * (docs/plan/walnut-replica-servers-impl.md section 7, WP9 review round 4): the Mac's
 * drain moves updated_at to its own clock, so task-outbox.ts importProjectionOnCloud,
 * whose gate takes a projection row only when it is newer than the companion's, takes
 * the drained title. A record time older than the companion's copy of the row is the
 * case that needs it: a stamp at the record's time would be dropped by that gate.
 *
 * CLOUD_MODE is read at import, so the Mac and the companion are two module graphs
 * (vi.resetModules + doMock) over one temp home, wiped between the two sides.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

const constantsBase = createMockConstants('walnut-drain-companion-import')

vi.mock('../../../src/core/sessions/session-send-core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/sessions/session-send-core.js')>()),
  deliverToSession: vi.fn(async () => ({ delivery: 'queued' })),
}))

async function load(cloud: boolean) {
  vi.resetModules()
  vi.doMock('../../../src/constants.js', () => ({ ...constantsBase, CLOUD_MODE: cloud }))
  return {
    tm: await import('../../../src/core/task-manager.js'),
    taskDb: await import('../../../src/core/task-db.js'),
    projection: await import('../../../src/core/task-projection.js'),
    outbox: await import('../../../src/core/task-outbox.js'),
    handover: await import('../../../src/core/offline-handover.js'),
  }
}
type Side = Awaited<ReturnType<typeof load>>

let open: Side | undefined
async function wipe(): Promise<void> {
  if (open) { open.taskDb.closeDb(); open.tm._resetForTesting(); open = undefined }
  await fsp.rm(constantsBase.WALNUT_HOME as string, { recursive: true, force: true })
  await fsp.mkdir(constantsBase.TASKS_DIR as string, { recursive: true })
}
afterEach(async () => { open?.handover._setHandoverBackoffForTesting(null); await wipe(); vi.resetModules() })

async function drainOne(side: Side, record: Record<string, unknown>): Promise<void> {
  side.handover._resetOfflineHandoverForTesting()
  side.handover._setHandoverBackoffForTesting([])
  let handed = false
  await side.handover.runOfflineHandover({
    hostKey: 'marina', journalV2: true,
    send: async (cmd: string) => {
      if (cmd === 'offline.drain') { const r = handed ? [] : [record]; handed = true; return { ok: true, records: r, now: Date.now() } }
      return { ok: true }
    },
  } as never)
}

async function writeProjection(side: Side, p: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(side.projection.PROJECTION_FILE), { recursive: true })
  await fsp.writeFile(side.projection.PROJECTION_FILE, JSON.stringify(p))
}

describe('a drained edit through the companion\'s projection import', () => {
  it('a drained title with a record time older than the companion\'s row is imported there', async () => {
    await wipe()
    // The Mac: a task, the projection the companion last imported, then the drain.
    const mac = open = await load(false)
    const id = (await mac.tm.addTask({ title: 'Clock before', project: 'Acme' } as never)).task.id
    const before = await mac.projection.buildTaskProjection()
    await new Promise((r) => setTimeout(r, 20))
    await drainOne(mac, {
      v: 2, seq: 1, at: Date.now() - 60_000, kind: 'task-fields', opId: 'op-companion-0001', rev: 1,
      actor: { kind: 'trigger', id: 'trg-companion' }, op: 'task_update', taskId: id,
      fields: { title: { base: 'Clock before', value: 'Clock after' } },
    })
    expect((await mac.tm.getTask(id)).title).toBe('Clock after')
    const after = await mac.projection.buildTaskProjection()
    await wipe()

    // The companion: its row from the old projection, then the new one through the real gate.
    const cloud = open = await load(true)
    await writeProjection(cloud, before)
    await cloud.outbox.importProjectionOnCloud()
    expect((await cloud.tm.getTask(id)).title).toBe('Clock before')
    await new Promise((r) => setTimeout(r, 20))
    await writeProjection(cloud, after)
    expect(await cloud.outbox.importProjectionOnCloud()).toBeGreaterThanOrEqual(1)
    expect((await cloud.tm.getTask(id)).title).toBe('Clock after')
  }, 30_000)
})
