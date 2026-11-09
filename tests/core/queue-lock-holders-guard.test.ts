/**
 * The session message queue never loses a write, never writes for nothing, and nobody holds
 * its file lock across other work.
 *
 * 2026-11-09, the user: "everything shows queued, why every session freeze without any warning",
 * then "the newer message is delivered but the older one still queued". A Codex session's
 * delivery loop wrote the queue file 20 to 50 times a second for 40 minutes, almost all writes
 * that changed nothing; every other session's queue write timed out on the file lock after one
 * 10 s round; a timed-out write went to the in-memory cache only, and the next write read the
 * file without it and replaced the cache, so an older message vanished while a newer one was
 * delivered. The snapshot hand-back guard also held the same lock across a task hand-back,
 * whose hooks queue messages: a write waiting on a lock its own caller held.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

const writes = { fail: 0, failAfter: 0, count: 0 }
vi.mock('../../src/utils/fs.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/utils/fs.js')>()
  return {
    ...orig,
    writeJsonFile: async (...args: Parameters<typeof orig.writeJsonFile>) => {
      if (String(args[0]).endsWith('session-message-queue.json')) {
        writes.count++
        if (writes.fail > 0) { writes.fail--; throw new Error('EIO: simulated disk failure') }
        await orig.writeJsonFile(...args)
        if (writes.failAfter > 0) { writes.failAfter--; throw new Error('EIO: simulated failure after the rename') }
        return
      }
      return orig.writeJsonFile(...args)
    },
  }
})

import { WALNUT_HOME, SESSION_QUEUE_FILE } from '../../src/constants.js'
import {
  editMessage, enqueueMessage, getQueue, markNextProcessing, markProcessing, requeueUnanswered, resetCache, withUndeliveredMessageGuard,
} from '../../src/core/session-message-queue.js'
import { mutateStore, pendingReplayCount } from '../../src/core/session-queue-store.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const onDisk = () => (JSON.parse(fs.readFileSync(SESSION_QUEUE_FILE, 'utf-8')) as { queues: Record<string, { id: string; message: string }[]> }).queues

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  writes.fail = 0
  writes.failAfter = 0
  writes.count = 0
})

afterEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the queue file is written only for a change, and every change reaches it', () => {
  it('a mutation that changes nothing writes nothing', async () => {
    await enqueueMessage('s1', 'first')
    const before = writes.count
    // Another row already processing: the pick changes nothing (the 11-09 loop's write).
    expect((await markNextProcessing('s1')).length).toBe(1)
    const afterPick = writes.count
    for (let i = 0; i < 20; i++) expect(await markNextProcessing('s1')).toEqual([])
    expect(afterPick - before).toBe(1)
    expect(writes.count).toBe(afterPick)
  })

  it('an older message whose write failed is never overtaken by a newer one: both land, in order', async () => {
    writes.fail = 1
    const older = await enqueueMessage('s1', 'so do u agree that we put it inside the plugin')
    // The cache holds it; the disk does not yet.
    expect((await getQueue('s1')).map((m) => m.id)).toEqual([older.id])
    expect(pendingReplayCount()).toBe(1)
    const newer = await enqueueMessage('s1', 'So do u know why they duplicate in the first place?')
    expect(pendingReplayCount()).toBe(0)
    expect(onDisk().s1.map((m) => m.id)).toEqual([older.id, newer.id])
    // A fresh process reads both, and the older goes first.
    resetCache()
    expect((await markNextProcessing('s1')).map((m) => m.id)).toEqual([older.id])
  })

  it('a failed write with no later one reaches the disk by itself', async () => {
    writes.fail = 1
    const row = await enqueueMessage('s1', 'nothing comes after me')
    await vi.waitFor(() => expect(onDisk().s1?.map((m) => m.id)).toEqual([row.id]), { timeout: 8_000 })
  })

  it('a lock held past one wait round is waited for, and the write lands', async () => {
    // Another holder, alive (this pid, another token), for 12 s: one round of the lock is 10 s.
    const lock = `${SESSION_QUEUE_FILE}.lock`
    fs.mkdirSync(path.join(lock, 'owner', `${process.pid}-0123456789ab`), { recursive: true })
    const released = new Promise<void>((resolve) => setTimeout(() => { fs.rmSync(lock, { recursive: true, force: true }); resolve() }, 12_000))
    const row = await enqueueMessage('s1', 'held')
    await released
    expect(onDisk().s1.map((m) => m.id)).toEqual([row.id])
    expect(pendingReplayCount()).toBe(0)
  }, 40_000)
})

// Review of 2026-11-09 (probes of the first version, which replayed the mutation itself).
describe('a change held for the disk is the change that was made, never the mutation run again', () => {
  const flush = () => mutateStore(() => undefined)
  const writeDisk = (queues: Record<string, unknown[]>) => fs.writeFileSync(SESSION_QUEUE_FILE, JSON.stringify({ version: 1, queues }))

  it('a strict take that failed leaves the row pending, in memory and on disk', async () => {
    writes.fail = 1
    const queued = await enqueueMessage('s1', 'never written to the CLI')
    writes.fail = 1
    await expect(markProcessing('s1', null)).rejects.toThrow(/EIO/)
    expect(queued.status).toBe('pending')
    await flush()
    expect((onDisk().s1 as Array<{ status: string }>)[0].status).toBe('pending')
    expect((await markProcessing('s1', null)).map((m) => m.message)).toEqual(['never written to the CLI'])
  })

  it('a take that answered nothing never marks a row processing later', async () => {
    await getQueue('s1')
    writeDisk({ s1: [{ id: 'qm-other-writer', sessionId: 's1', message: 'from the CLI process', status: 'pending', enqueuedAt: new Date().toISOString() }] })
    writes.fail = 1
    expect(await markNextProcessing('s1')).toEqual([])
    await flush()
    expect((onDisk().s1 as Array<{ status: string }>)[0].status).toBe('pending')
    expect((await markNextProcessing('s1')).map((m) => m.id)).toEqual(['qm-other-writer'])
  })

  it('a held take of row A never becomes a take of row B', async () => {
    const a = await enqueueMessage('s1', 'first')
    const b = await enqueueMessage('s1', 'second')
    writes.fail = 1
    expect((await markNextProcessing('s1'))[0].id).toBe(a.id)
    // Another writer settled A meanwhile.
    writeDisk({ s1: (onDisk().s1 as Array<{ id: string }>).filter((m) => m.id !== a.id) })
    await flush()
    expect(onDisk().s1).toMatchObject([{ id: b.id, status: 'pending' }])
    expect((await markNextProcessing('s1'))[0].id).toBe(b.id)
  })

  it('an older held enqueue goes in before a newer one another process wrote', async () => {
    writes.fail = 1
    const older = await enqueueMessage('s1', 'older')
    writeDisk({ s1: [{ ...older, id: 'qm-external-newer', message: 'newer', enqueuedAt: new Date(Date.parse(older.enqueuedAt) + 1000).toISOString() }] })
    await flush()
    expect(onDisk().s1.map((m) => m.message)).toEqual(['older', 'newer'])
  })

  it('a held resend keeps the uuid its caller was handed', async () => {
    await enqueueMessage('s1', 'unanswered')
    const rows = await markProcessing('s1')
    writes.fail = 1
    const { resent } = await requeueUnanswered(rows, rows[0].lineUuid)
    await flush()
    expect((onDisk().s1 as Array<{ lineUuid?: string }>)[0].lineUuid).toBe(resent[0].lineUuid)
  })

  it('a held edit changes only the text: another writer parking or fencing the row meanwhile stays', async () => {
    const row = await enqueueMessage('s1', 'typo')
    writes.fail = 1
    await editMessage('s1', row.id, 'fixed text')
    const parkedElsewhere = { ...onDisk().s1[0], status: 'parked', parkedReason: 'folder gone', stopFence: 7 }
    writeDisk({ s1: [parkedElsewhere] })
    await flush()
    expect(onDisk().s1[0]).toMatchObject({ id: row.id, message: 'fixed text', status: 'parked', parkedReason: 'folder gone', stopFence: 7 })
  })

  it('an enqueue whose write landed and then threw leaves what another writer did to the row since', async () => {
    writes.failAfter = 1
    const row = await enqueueMessage('s1', 'landed')
    writeDisk({ s1: [{ ...onDisk().s1[0], status: 'parked', parkedReason: 'folder gone' }] })
    await flush()
    expect(onDisk().s1).toMatchObject([{ id: row.id, status: 'parked', parkedReason: 'folder gone' }])
  })

  it('a write that landed and then threw is not applied twice', async () => {
    writes.failAfter = 1
    const row = await enqueueMessage('s1', 'one user message')
    await flush()
    expect(onDisk().s1.filter((m) => m.id === row.id)).toHaveLength(1)
  })
})

describe('nobody holds the queue lock across other work', () => {
  it('a hand-back guard whose work queues a message finishes at once', async () => {
    const t0 = Date.now()
    await withUndeliveredMessageGuard(async (hasUndelivered) => {
      expect(hasUndelivered('s1')).toBe(false)
      await enqueueMessage('s1', 'queued by a hand-back hook')
      // Read live: the guard sees what its own work queued.
      expect(hasUndelivered('s1')).toBe(true)
    })
    expect(Date.now() - t0).toBeLessThan(3_000)
    expect(onDisk().s1).toHaveLength(1)
  })

  it('ratchet: a test that fails the queue write does it where the store writes (writeJsonFile)', () => {
    // 2026-11-09: two tests failed the queue write through updateJsonFile, which the store no
    // longer calls; one kept passing with its fault never injected.
    const dead: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name)
        if (e.isDirectory()) walk(rel)
        else if (/\.test\.tsx?$/.test(e.name)) {
          const text = fs.readFileSync(path.join(ROOT, rel), 'utf-8')
          if (/session-message-queue/.test(text) && /utils\/fs\.js/.test(text) && /^\s+updateJsonFile:/m.test(text)) dead.push(rel)
        }
      }
    }
    walk('tests')
    expect(dead).toEqual([])
    expect(fs.readFileSync(path.join(ROOT, 'src/core/session-queue-store.ts'), 'utf-8')).not.toMatch(/updateJsonFile/)
  })

  it('ratchet: only the queue store locks the queue file, and it runs nothing async but its own read and write', () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name)
        if (e.isDirectory()) walk(rel)
        else if (/\.tsx?$/.test(e.name)) {
          const text = fs.readFileSync(path.join(ROOT, rel), 'utf-8')
          if (/(withFileLock|updateJsonFile)\(\s*SESSION_QUEUE_FILE/.test(text)) hits.push(rel)
        }
      }
    }
    walk('src')
    expect(hits).toEqual(['src/core/session-queue-store.ts'])
    const store = fs.readFileSync(path.join(ROOT, 'src/core/session-queue-store.ts'), 'utf-8')
    const body = store.slice(store.indexOf('async function persist'), store.indexOf('\n}\n', store.indexOf('async function persist')))
    const locked = body.slice(body.indexOf('withFileLock(SESSION_QUEUE_FILE'))
    // Inside the lock: one read, one write, nothing else awaited.
    expect(locked.match(/await /g)?.length).toBe(2) // the read and the write
  })
})
