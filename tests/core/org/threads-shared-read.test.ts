/**
 * readThreads shares one parsed value per node and version (threads-sync.ts sharedView; the JSON
 * mode by the file's stamp, json-kept.ts readJsonFileShaped). 2026-11-25: every read parsed the
 * whole node again (about 8 MB of text across the nodes, the largest 0.9 MB), the live server's
 * top JSON.parse after a start, an estimated 0.6 to 1.8 GB of objects per boot.
 *
 * In both stores:
 *   1. A burst of reads of one node parses it once.
 *   2. A write's step gets a copy of its own: changing it in place (and throwing, or not) never
 *      changes what a reader holds; neither does a caller changing the thread a write hands back.
 *   3. A write here, and a write of the file by another writer, are seen by the next read.
 *   4. With WALNUT_THREADS_FREEZE_READS=1 (every test run's default) a shared read is frozen, so a
 *      reader that changes it throws in tests; the store's own read paths run on such reads.
 *
 * How the readers are kept from changing what they read (the audit of 2026-11-25): every caller of
 * readThreads only reads it, copies before it sorts (`[...threads].sort`), or builds new objects
 * (`{ ...t }`, map/filter); the writes' steps (threads-model.ts) get a copy of their own. One reader
 * took a new read's identity as news that something changed (user-status-sync.ts joinedAsks,
 * `rows ===`): its memo is now dropped with the node's rows. A memo keyed by a read's identity
 * must be dropped by the node's change, never by a fresh read.
 */
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-threads-shared-read'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { closeThreadsDb } from '../../../src/core/org/threads-db.js'
import { _resetThreadsBackendForTesting, useThreadsDb } from '../../../src/core/org/threads-backend.js'
import { _setThreadsExportEveryForTesting, _threadViewParsesForTesting, dbMutateThreads } from '../../../src/core/org/threads-sync.js'
import { fileThreadMessage, openNodeThread, patchThread, readThreads, withTaskAsks, writeThreadsFor } from '../../../src/core/org/threads-store.js'
import { _resetJsonKeptForTesting } from '../../../src/utils/json-kept.js'

const NODE = 'node-orchard'
const MARK = 'Order the seed trays for the orchard'
const fileOf = () => path.join(WALNUT_HOME, 'org', 'threads', `${NODE}.json`)
/** A decision of his that needs him: the kind every node write into needs names. */
const KIND = { user_kind: 'spending', user_kind_why: 'The order spends the user\'s money' }
const titleOf = (f: { threads: Array<{ id: string; title: string }> }, id: string) => f.threads.find((t) => t.id === id)?.title
/** Past json-kept's racy window: a file written this last 100 ms is read, never kept. */
const settle = () => new Promise((r) => setTimeout(r, 150))

/** JSON.parse calls whose text holds this node's threads. */
function countNodeParses(): { count: () => number } {
  const real = JSON.parse
  let n = 0
  vi.spyOn(JSON, 'parse').mockImplementation(((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    if (typeof text === 'string' && text.includes(MARK)) n++
    return real(text, reviver)
  }) as typeof JSON.parse)
  return { count: () => n }
}

/** An older build's write of the file, or a sync pull's. */
async function editOutside(edit: (raw: { threads: Array<Record<string, any>> }) => void): Promise<void> {
  const raw = JSON.parse(fs.readFileSync(fileOf(), 'utf8'))
  edit(raw)
  await fsp.writeFile(fileOf(), JSON.stringify(raw, null, 2) + '\n')
}

async function twoThreads(): Promise<{ a: string; b: string }> {
  const a = (await fileThreadMessage(NODE, { text: MARK, via: 'chat', at: new Date(Date.now() - 60_000).toISOString() })).thread.id
  const b = (await openNodeThread(NODE, { title: 'Prune the apple trees', text: 'Prune the apple trees before spring', from: 'node', state: 'answered' }, 'human')).id
  return { a, b }
}

beforeEach(async () => {
  closeThreadsDb()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  vi.restoreAllMocks()
  _resetJsonKeptForTesting()
  _setThreadsExportEveryForTesting(0)
})

// The run's own setting (on by default: tests/setup/threads-freeze-reads.ts), back after each test.
const FREEZE_SETTING = process.env.WALNUT_THREADS_FREEZE_READS
afterEach(() => {
  if (FREEZE_SETTING === undefined) delete process.env.WALNUT_THREADS_FREEZE_READS
  else process.env.WALNUT_THREADS_FREEZE_READS = FREEZE_SETTING
})

afterAll(async () => {
  _setThreadsExportEveryForTesting(undefined)
  _resetThreadsBackendForTesting(undefined)
  closeThreadsDb()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

for (const store of ['database', 'json'] as const) {
  describe(`the ${store} store`, () => {
    beforeEach(async () => {
      _resetThreadsBackendForTesting(store === 'database')
      expect(await useThreadsDb()).toBe(store === 'database')
    })

    it('a burst of reads of one node parses it once, and every read is the same value', async () => {
      await twoThreads()
      await settle()
      const parses = countNodeParses()
      const reads = await Promise.all(Array.from({ length: 20 }, () => readThreads(NODE)))
      for (let i = 0; i < 10; i++) reads.push(await readThreads(NODE))
      expect(reads[0].threads).toHaveLength(2)
      expect(parses.count()).toBeLessThanOrEqual(1)
      expect(new Set(reads).size).toBe(1)
    })

    it("a write's step that changes the node in place, then throws, leaves every reader's view as it was", async () => {
      const { a } = await twoThreads()
      const held = await readThreads(NODE)
      await expect(writeThreadsFor(NODE, (cur) => {
        ;(cur.threads.find((t) => t.id === a) as { title: string }).title = 'Broken'
        cur.threads[0].messages.length = 0
        cur.threads.reverse()
        throw new Error('the step gave up')
      })).rejects.toThrow('the step gave up')
      expect(titleOf(held, a)).not.toBe('Broken')
      expect(held.threads[0].id).toBe(a)
      expect(held.threads[0].messages.length).toBeGreaterThan(0)
      const again = await readThreads(NODE)
      expect(titleOf(again, a)).not.toBe('Broken')
      expect(again.threads.map((t) => t.id)).toEqual(held.threads.map((t) => t.id))
    })

    it("a write's step that changes the node in place is written; what a reader held before stays the old version", async () => {
      const { a } = await twoThreads()
      const held = await readThreads(NODE)
      const before = titleOf(held, a)
      if (store === 'database') {
        expect(await dbMutateThreads(NODE, (cur) => { (cur.threads[0] as { title: string }).title = 'Seed trays, mended'; return cur }, () => true)).toBe(true)
      } else {
        await writeThreadsFor(NODE, (cur) => { (cur.threads[0] as { title: string }).title = 'Seed trays, mended'; return { file: cur, out: null } })
      }
      expect(titleOf(held, a)).toBe(before)
      expect(titleOf(await readThreads(NODE), a)).toBe('Seed trays, mended')
    })

    it('a caller changing the thread a write handed back changes no later read', async () => {
      const { a } = await twoThreads()
      const back = await patchThread(NODE, a, { title: 'Seed trays, ordered' }, 'human')
      ;(back as { title: string }).title = 'Changed by the caller'
      back.messages.length = 0
      const read = (await readThreads(NODE)).threads.find((t) => t.id === a)!
      expect(read.title).toBe('Seed trays, ordered')
      expect(read.messages.length).toBeGreaterThan(0)
    })

    it('a write here is seen by the next read, and so is a write of the file by another writer', async () => {
      const { a, b } = await twoThreads()
      await settle()
      const first = await readThreads(NODE)
      expect(await readThreads(NODE)).toBe(first) // kept: the reads below are past the racy window
      await patchThread(NODE, b, { title: 'Prune the plum trees' }, 'human')
      await settle()
      const second = await readThreads(NODE)
      expect(second).not.toBe(first)
      expect(titleOf(second, b)).toBe('Prune the plum trees')
      expect(await readThreads(NODE)).toBe(second)
      // Another writer (an older build, a sync pull): seen by the stamp (the JSON store) or the
      // stat check (syncFromJson), no write here needed. Each read is past the racy window.
      await editOutside((raw) => { raw.threads.find((t) => t.id === a)!.title = 'Seed trays (another writer)' })
      await settle()
      const third = await readThreads(NODE)
      expect(third).not.toBe(second)
      expect(titleOf(third, a)).toBe('Seed trays (another writer)')
      expect(titleOf(third, b)).toBe('Prune the plum trees')
      expect(await readThreads(NODE)).toBe(third)
      // The same size, in place (one inode): only the file's times tell this edit apart.
      const sizeBefore = (await fsp.stat(fileOf())).size
      await editOutside((raw) => { raw.threads.find((t) => t.id === a)!.title = 'SEED TRAYS (ANOTHER WRITER)' })
      expect((await fsp.stat(fileOf())).size).toBe(sizeBefore)
      await settle()
      expect(titleOf(await readThreads(NODE), a)).toBe('SEED TRAYS (ANOTHER WRITER)')
    })

    if (store === 'database') {
      it("a write's export to the file keeps no readers' view: only a read makes one", async () => {
        const { b } = await twoThreads()
        const views = _threadViewParsesForTesting()
        // Exported at once (no wait between writes here), with nobody reading.
        await patchThread(NODE, b, { title: 'Prune the cherry trees' }, 'human')
        await vi.waitFor(() => expect(fs.readFileSync(fileOf(), 'utf8')).toContain('Prune the cherry trees'))
        expect(_threadViewParsesForTesting()).toBe(views)
        expect(titleOf(await readThreads(NODE), b)).toBe('Prune the cherry trees')
        expect(_threadViewParsesForTesting()).toBe(views + 1)
      })
    }

    if (store === 'json') {
      it('a write here drops the kept read itself, even where the file system would show the same stamp', async () => {
        const { b } = await twoThreads()
        await settle()
        expect(titleOf(await readThreads(NODE), b)).toBe('Prune the apple trees')
        const before = await fsp.stat(fileOf())
        await patchThread(NODE, b, { title: 'Prune the quince trees' }, 'human')
        await settle()
        // The file's stat as it was before the write: only the write's own drop (forgetKeptJson) shows the change.
        const realStat = fsp.stat
        vi.spyOn(fsp, 'stat').mockImplementation((async (p: Parameters<typeof fsp.stat>[0], o?: Parameters<typeof fsp.stat>[1]) =>
          (String(p) === fileOf() ? before : realStat(p, o as never))) as typeof fsp.stat)
        expect(titleOf(await readThreads(NODE), b)).toBe('Prune the quince trees')
      })
    }

    it('frozen in a test run that asks it: a reader that changes a shared read throws, and the store reads and writes on', async () => {
      process.env.WALNUT_THREADS_FREEZE_READS = '1'
      const { a, b } = await twoThreads()
      await settle()
      const read = await readThreads(NODE)
      expect(Object.isFrozen(read.threads)).toBe(true)
      expect(() => { (read.threads[0] as { title: string }).title = 'x' }).toThrow(TypeError)
      expect(() => [...read.threads].sort((x, y) => x.id.localeCompare(y.id))).not.toThrow()
      // The store's own paths over a frozen read: the view of what waits on him, a write, a filing.
      await withTaskAsks(NODE, read.threads, [])
      await patchThread(NODE, a, { title: 'Seed trays, frozen run' }, 'human')
      const count = read.threads.find((t) => t.id === b)!.messages.length
      await fileThreadMessage(NODE, { text: 'And the watering cans', via: 'chat', threadId: b, at: new Date().toISOString() })
      const after = await readThreads(NODE)
      expect(titleOf(after, a)).toBe('Seed trays, frozen run')
      expect(after.threads.find((t) => t.id === b)!.messages.length).toBe(count + 1)
      // A node's own writes that hand a thread to him run their dry run on the shared read first
      // (threads-store.ts openNodeThreadChecks: openThread; patchThread: updateThread).
      await settle()
      expect(Object.isFrozen((await readThreads(NODE)).threads)).toBe(true)
      const node = `task:${NODE}` as const
      const asked = await openNodeThread(NODE, { title: 'Which seed supplier', text: 'Two suppliers quote the trays.', ask: 'Which supplier gets the order?', from: 'node', state: 'needs', ...KIND }, node)
      expect(asked.state).toBe('needs')
      await settle()
      expect(Object.isFrozen((await readThreads(NODE)).threads)).toBe(true)
      const handed = await patchThread(NODE, b, { state: 'needs', ask: 'Prune the apple trees this week?', reply: 'The trees are ready to prune.', separate_reason: 'Pruning and the seed supplier are two decisions', ...KIND } as never, node)
      expect(handed.state).toBe('needs')
      expect((await readThreads(NODE)).threads.find((t) => t.id === b)?.state).toBe('needs')
    })
  })
}
