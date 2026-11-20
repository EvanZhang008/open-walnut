/**
 * The experiment threads_sqlite (threads-backend.ts, threads-sync.ts, threads-db.ts) on real SQLite in a
 * temp home: the one-time move of the JSON files into the database, the check that undoes it, the
 * JSON files kept current for an older build, and a file changed outside read back in (the file wins).
 *
 *   1. Three nodes of real shapes (open, closed, merged, split, moved in and out, answers, Unicode,
 *      a summary from before replyAt, a field of a newer build, a closed thread past its week): every
 *      node reads back exactly as its JSON file reads, and org/threads/ is copied byte for byte first.
 *   2. A forced difference in the check: the database stays unused, nothing of the import is kept, the
 *      JSON files are untouched; the next start moves them.
 *   3. Written back: a change reaches its file at most once a minute and at the flush, in the old
 *      format; the experiment off reads the change from the file.
 *   4. Read back in: a file an older build wrote, and one written while the experiment was off, win.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-threads-sqlite-migration'))

const tamper = vi.hoisted(() => ({ node: '' }))
vi.mock('../../../src/core/org/threads-db.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/core/org/threads-db.js')>()
  return {
    ...real,
    // The import's read-back, made to differ for one node when a test asks.
    readNodeForCheck: (node: string) => {
      const file = real.readNodeForCheck(node)
      return node === tamper.node ? { ...file, threads: file.threads.slice(1) } : file
    },
  }
})

import { WALNUT_HOME } from '../../../src/constants.js'
import { closeThreadsDb, getMeta, loadNode, readNodeForCheck } from '../../../src/core/org/threads-db.js'
import { _resetThreadsBackendForTesting, useThreadsDb, writeThreadsLeftovers } from '../../../src/core/org/threads-backend.js'
import { _setThreadsExportEveryForTesting, flushThreadsExports, parseThreadsText } from '../../../src/core/org/threads-sync.js'
import { listThreadNodes, patchThread, readThreads } from '../../../src/core/org/threads-store.js'
import * as backend from '../../../src/core/org/threads-backend.js'
import {
  emptyThreads, fileMessage, mergeThreads, moveThreadIn, moveThreadOut, setAnswers, splitThreadMessage, updateThread, type ThreadsFile,
} from '../../../src/core/org/threads-model.js'

const NODES = ['node-orchard', 'node-greenhouse', 'node-shed'] as const
const dir = () => path.join(WALNUT_HOME, 'org', 'threads')
const fileOf = (node: string) => path.join(dir(), `${node}.json`)
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const text = (node: string) => fs.readFileSync(fileOf(node), 'utf8')

/** The three nodes as files an older build wrote (writeJsonFile's format). */
function fixtures(): Record<string, unknown> {
  // Orchard: a thread with his message and the node's answer (Unicode), a second ask merged into it,
  // one he closed two days ago, a summary from before replyAt (raw), a message with no `via`.
  let a = fileMessage(emptyThreads(NODES[0]), { text: 'Order the \u79cd\u5b50 trays, caf\u00e9 size \u{1F331}', via: 'chat', at: ago(300), sid: 'sess-orchard' })
  const first = a.thread
  a = { ...a, file: setAnswers(a.file, new Map([[a.message.id, { text: 'Ordered **72-cell** trays \u2713', at: ago(290), sid: 'sess-orchard' }]])).file }
  const b = fileMessage(a.file, { text: 'And the potting soil?', via: 'chat', at: ago(200) })
  let orchard = mergeThreads(b.file, b.thread.id, first.id, 'human', ago(199)).file
  const c = fileMessage(orchard, { text: 'Fix the gate latch', via: 'letter', letter: 'letter-1', about: 'Gate', at: ago(3000) })
  orchard = updateThread(c.file, c.thread.id, { close: 'acked' }, 'human', ago(2880)).file
  const raw = JSON.parse(JSON.stringify(orchard)) as { threads: Array<Record<string, unknown>> }
  raw.threads.push({
    id: 'th-0123456789ab', title: 'Legacy summary', state: 'answered', reply: 'Done: watered the beds', by: 'agent',
    createdAt: ago(500), updatedAt: ago(480),
    messages: [{ id: 'tm-0123456789ab', at: ago(500), text: 'Water the beds' }],
  })

  // Greenhouse: a message split out of its thread, a thread that came in from the shed.
  let g = fileMessage(emptyThreads(NODES[1]), { text: 'Heat the greenhouse at night', via: 'chat', at: ago(120) })
  g = fileMessage(g.file, { text: 'Also vent it at noon', via: 'chat', at: ago(119), threadId: g.thread.id })
  const split = splitThreadMessage(g.file, g.thread.id, g.message.id, 'human', ago(118))
  const shedAsk = fileMessage(emptyThreads(NODES[2]), { text: 'Move the seed trays to the greenhouse', via: 'chat', at: ago(100) })
  const greenhouse = moveThreadIn(split.file, shedAsk.thread, { task: NODES[2], title: 'Shed' }, 'agent', ago(90), 'its work moved', 'work').file

  // Shed: the moved thread closed here pointing on, one closed ten days ago (past its week), and a
  // field a newer build wrote, kept as it is.
  let shed = moveThreadOut(shedAsk.file, shedAsk.thread.id, { task: NODES[1], title: 'Greenhouse' }, 'agent', ago(90), 'its work moved', 'work').file
  const old = fileMessage(shed, { text: 'Sharpen the shears', via: 'chat', at: ago(15_000) })
  shed = updateThread(old.file, old.thread.id, { close: 'dropped' }, 'human', ago(14_400)).file
  const shedRaw = JSON.parse(JSON.stringify(shed)) as { threads: Array<Record<string, unknown>> }
  shedRaw.threads[0].futureField = { kept: true, note: '\u00fcber' }
  return { [NODES[0]]: raw, [NODES[1]]: greenhouse, [NODES[2]]: shedRaw }
}

async function writeFixtures(): Promise<void> {
  await fsp.mkdir(dir(), { recursive: true })
  for (const [node, file] of Object.entries(fixtures())) await fsp.writeFile(fileOf(node), JSON.stringify(file, null, 2) + '\n')
}

/** Each node as the JSON mode reads it. */
async function jsonReads(): Promise<Record<string, ThreadsFile>> {
  _resetThreadsBackendForTesting(false)
  const out: Record<string, ThreadsFile> = {}
  for (const node of NODES) out[node] = await readThreads(node)
  return out
}

beforeEach(async () => {
  closeThreadsDb()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  tamper.node = ''
  _setThreadsExportEveryForTesting(undefined)
  _resetThreadsBackendForTesting(false)
})

afterAll(async () => {
  _resetThreadsBackendForTesting(undefined)
  closeThreadsDb()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the move into the database', () => {
  it('every node reads back exactly as its JSON file reads, after a byte-for-byte backup', async () => {
    await writeFixtures()
    const before = Object.fromEntries(NODES.map((n) => [n, text(n)]))
    const want = await jsonReads()
    expect(want[NODES[0]].threads.length).toBe(3)

    _resetThreadsBackendForTesting(true)
    expect(await useThreadsDb()).toBe(true)
    expect(getMeta('imported_at')).toBeTruthy()

    // The backup: the whole directory, every file the same bytes.
    const backup = getMeta('backup_dir')!
    expect(backup.startsWith(path.join(WALNUT_HOME, 'org', 'threads-backup'))).toBe(true)
    expect(fs.readdirSync(backup).sort()).toEqual(fs.readdirSync(dir()).sort())
    for (const node of NODES) expect(fs.readFileSync(path.join(backup, `${node}.json`), 'utf8')).toBe(before[node])

    for (const node of NODES) {
      // Everything it holds, the closed thread past its week too, exactly (key order included).
      expect(JSON.stringify(readNodeForCheck(node))).toBe(JSON.stringify(want[node]))
      const read = await readThreads(node)
      const live = want[node].threads.filter((t) => !t.closed || Date.now() - Date.parse(t.closed.at) <= 7 * 24 * 3600_000)
      // A read leaves out only the closed thread past its week (the sweep deletes it).
      expect(JSON.stringify(read)).toBe(JSON.stringify({ ...want[node], threads: live }))
    }
    const orchard = (await readThreads(NODES[0])).threads
    expect(orchard[0].messages.map((m) => m.text)).toEqual(['Order the \u79cd\u5b50 trays, caf\u00e9 size \u{1F331}', 'And the potting soil?'])
    expect(orchard[0].messages[0].answer?.text).toBe('Ordered **72-cell** trays \u2713')
    expect(orchard[2].messages[0].via).toBe('chat')
    expect((await readThreads(NODES[2])).threads[0]).toMatchObject({ futureField: { kept: true, note: '\u00fcber' }, movedTo: { task: NODES[1] } })
    expect((await readThreads(NODES[2])).threads).toHaveLength(1)
    expect((await readThreads(NODES[1])).threads.some((t) => t.movedFrom?.task === NODES[2])).toBe(true)
    // Nothing changed, so nothing was written back: the files are as the older build left them.
    await flushThreadsExports()
    for (const node of NODES) expect(text(node)).toBe(before[node])
    expect((await listThreadNodes()).sort()).toEqual([...NODES].sort())
  })

  it('a difference in the check undoes the import and keeps the JSON files; the next start moves them', async () => {
    await writeFixtures()
    const before = Object.fromEntries(NODES.map((n) => [n, text(n)]))
    const warn = vi.spyOn((await import('../../../src/logging/index.js')).log.task, 'warn')
    tamper.node = NODES[1]
    _resetThreadsBackendForTesting(true)
    expect(await useThreadsDb()).toBe(false)
    expect(warn.mock.calls.some(([msg, data]) => /undone/.test(String(msg)) && (data as { node?: string })?.node === NODES[1])).toBe(true)
    warn.mockRestore()
    expect(getMeta('imported_at')).toBeUndefined()
    // The copy made for the try goes with it, so a try at each start never piles them up.
    expect(fs.existsSync(path.join(WALNUT_HOME, 'org', 'threads-backup')) ? fs.readdirSync(path.join(WALNUT_HOME, 'org', 'threads-backup')) : []).toEqual([])
    for (const node of NODES) expect(loadNode(node, { all: true }).file.threads).toEqual([])
    // Still on JSON for this run: the store reads and writes the files.
    const id = (await readThreads(NODES[1])).threads[0].id
    await patchThread(NODES[1], id, { title: 'Greenhouse heat' }, 'human')
    expect(parseThreadsText(text(NODES[1]), NODES[1]).threads[0].title).toBe('Greenhouse heat')
    for (const node of [NODES[0], NODES[2]]) expect(text(node)).toBe(before[node])

    // The next start (no difference now): moved, with the change made meanwhile.
    tamper.node = ''
    _resetThreadsBackendForTesting(true)
    expect(await useThreadsDb()).toBe(true)
    expect((await readThreads(NODES[1])).threads[0].title).toBe('Greenhouse heat')
  })
})

describe('the JSON files kept current', () => {
  it('a change goes out at once, the next within the minute waits for the flush; the file reads as the database', async () => {
    await writeFixtures()
    _resetThreadsBackendForTesting(true)
    _setThreadsExportEveryForTesting(60_000)
    expect(await useThreadsDb()).toBe(true)
    const id = (await readThreads(NODES[0])).threads[0].id
    await patchThread(NODES[0], id, { title: 'Seed trays' }, 'human')
    await vi.waitFor(() => expect(parseThreadsText(text(NODES[0]), NODES[0]).threads[0].title).toBe('Seed trays'))
    await patchThread(NODES[0], id, { title: 'Seed trays and soil' }, 'human')
    // The next export waits on its one-minute timer, so the file still holds the first change now.
    expect(parseThreadsText(text(NODES[0]), NODES[0]).threads[0].title).toBe('Seed trays')
    await flushThreadsExports()
    const exported = text(NODES[0])
    expect(exported.endsWith('\n')).toBe(true)
    expect(parseThreadsText(exported, NODES[0])).toEqual(await readThreads(NODES[0]))
    expect(JSON.stringify(parseThreadsText(exported, NODES[0]))).toBe(JSON.stringify(await readThreads(NODES[0])))
    expect(JSON.parse(exported)).toMatchObject({ version: 1, taskId: NODES[0] })
  })

  it('turned off, the JSON mode reads the change at once (a waiting write goes out first)', async () => {
    await writeFixtures()
    _resetThreadsBackendForTesting(true)
    _setThreadsExportEveryForTesting(60_000)
    expect(await useThreadsDb()).toBe(true)
    const id = (await readThreads(NODES[1])).threads[0].id
    await patchThread(NODES[1], id, { title: 'First' }, 'human')
    await patchThread(NODES[1], id, { title: 'Second' }, 'human')
    const inDb = await readThreads(NODES[1])
    _resetThreadsBackendForTesting(false)
    expect(await readThreads(NODES[1])).toEqual(inDb)
  })

  it('a file that is gone is written again from the database', async () => {
    await writeFixtures()
    _resetThreadsBackendForTesting(true)
    _setThreadsExportEveryForTesting(0)
    expect(await useThreadsDb()).toBe(true)
    const want = await readThreads(NODES[2])
    await fsp.rm(fileOf(NODES[2]))
    expect(await readThreads(NODES[2])).toEqual(want)
    await flushThreadsExports()
    await vi.waitFor(() => expect(parseThreadsText(text(NODES[2]), NODES[2])).toEqual(want))
  })
})

describe('a file changed outside wins', () => {
  it('a file an older build wrote while the database holds the node is read back in', async () => {
    await writeFixtures()
    _resetThreadsBackendForTesting(true)
    expect(await useThreadsDb()).toBe(true)
    const raw = JSON.parse(text(NODES[0])) as { threads: Array<{ title: string }> }
    raw.threads[0].title = 'Renamed by an older build'
    await fsp.writeFile(fileOf(NODES[0]), JSON.stringify(raw, null, 2) + '\n')
    expect((await readThreads(NODES[0])).threads[0].title).toBe('Renamed by an older build')
    expect(readNodeForCheck(NODES[0]).threads[0].title).toBe('Renamed by an older build')
  })

  it('what the JSON mode wrote while the experiment was off is in the database when it is on again, a new node too', async () => {
    await writeFixtures()
    _resetThreadsBackendForTesting(true)
    expect(await useThreadsDb()).toBe(true)
    _resetThreadsBackendForTesting(false)
    const id = (await readThreads(NODES[2])).threads[0].id
    await patchThread(NODES[2], id, { title: 'Edited while off' }, 'human')
    const fresh = fileMessage(emptyThreads('node-barn'), { text: 'Paint the barn door', via: 'chat', at: ago(5) })
    await fsp.writeFile(fileOf('node-barn'), JSON.stringify(fresh.file, null, 2) + '\n')
    const want = { shed: await readThreads(NODES[2]), barn: await readThreads('node-barn') }

    _resetThreadsBackendForTesting(true)
    expect(await useThreadsDb()).toBe(true)
    expect(readNodeForCheck(NODES[2]).threads.find((t) => t.id === id)?.title).toBe('Edited while off')
    expect(await readThreads('node-barn')).toEqual(want.barn)
    expect(await readThreads(NODES[2])).toEqual({ ...want.shed, threads: want.shed.threads.filter((t) => !t.closed || Date.now() - Date.parse(t.closed.at) <= 7 * 24 * 3600_000) })
    expect((await listThreadNodes()).sort()).toEqual([...NODES, 'node-barn'].sort())
  })
})

describe('what the database never gives up to a bad file, and what survives a switch', () => {
  it('an empty file (a write cut short) never empties the node, and is written again', async () => {
    await writeFixtures()
    _resetThreadsBackendForTesting(true)
    _setThreadsExportEveryForTesting(0)
    expect(await useThreadsDb()).toBe(true)
    const want = await readThreads(NODES[0])
    await fsp.writeFile(fileOf(NODES[0]), '')
    expect(await readThreads(NODES[0])).toEqual(want)
    await flushThreadsExports()
    await vi.waitFor(() => expect(parseThreadsText(text(NODES[0]), NODES[0])).toEqual(want))
  })

  it('a file that names a thread twice is read in with the first, and every other node still moves', async () => {
    await writeFixtures()
    _resetThreadsBackendForTesting(true)
    expect(await useThreadsDb()).toBe(true)
    const raw = JSON.parse(text(NODES[1])) as { threads: Array<{ id: string; title: string }> }
    raw.threads.push({ ...raw.threads[0], title: 'A second copy' })
    raw.threads[0].title = 'The first copy'
    await fsp.writeFile(fileOf(NODES[1]), JSON.stringify(raw, null, 2) + '\n')
    const read = await readThreads(NODES[1])
    expect(read.threads.filter((t) => t.id === raw.threads[0].id).map((t) => t.title)).toEqual(['The first copy'])
    expect((await readThreads(NODES[0])).threads.length).toBe(3)
  })

  it('a write that began before the experiment went off lands in the file, never lost to the switch', async () => {
    await writeFixtures()
    _resetThreadsBackendForTesting(true)
    _setThreadsExportEveryForTesting(60_000)
    expect(await useThreadsDb()).toBe(true)
    const id = (await readThreads(NODES[0])).threads[0].id
    // The switch lands while the write waits on its file check (before its database write).
    const stat = fsp.stat
    let switched = false
    const spy = vi.spyOn(fsp, 'stat').mockImplementation(async (...args: Parameters<typeof fsp.stat>) => {
      if (!switched) { switched = true; _resetThreadsBackendForTesting(false) }
      return stat(...args)
    })
    try {
      await patchThread(NODES[0], id, { title: 'Written while it went off' }, 'human')
    } finally { spy.mockRestore() }
    expect(switched).toBe(true)
    expect(parseThreadsText(text(NODES[0]), NODES[0]).threads[0].title).toBe('Written while it went off')
    expect(readNodeForCheck(NODES[0]).threads[0].title).not.toBe('Written while it went off')
    // On again: the file wins, so the change is in the database too.
    _resetThreadsBackendForTesting(true)
    expect((await readThreads(NODES[0])).threads[0].title).toBe('Written while it went off')
  })

  it('a start with the experiment off writes out what a crash left only in the database', async () => {
    await writeFixtures()
    _resetThreadsBackendForTesting(true)
    _setThreadsExportEveryForTesting(60_000)
    expect(await useThreadsDb()).toBe(true)
    const id = (await readThreads(NODES[2])).threads[0].id
    await patchThread(NODES[2], id, { title: 'First' }, 'human')
    await vi.waitFor(() => expect(parseThreadsText(text(NODES[2]), NODES[2]).threads[0].title).toBe('First'))
    await patchThread(NODES[2], id, { title: 'Only in the database' }, 'human')
    expect(parseThreadsText(text(NODES[2]), NODES[2]).threads[0].title).toBe('First')
    // The crash: nothing flushed; the next start has the experiment off.
    _setThreadsExportEveryForTesting(0)
    _resetThreadsBackendForTesting(false)
    expect(backend.threadsDbOnNow()).toBe(false)
    await writeThreadsLeftovers()
    expect(parseThreadsText(text(NODES[2]), NODES[2]).threads[0].title).toBe('Only in the database')
    expect((await readThreads(NODES[2])).threads[0].title).toBe('Only in the database')
  })
})
