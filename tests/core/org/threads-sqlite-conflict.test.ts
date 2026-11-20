/**
 * The Threads database (experiment threads_sqlite) when its JSON file and it both moved:
 *
 *   1. A file changed outside while changes here still waited for it: merged by thread (each side's
 *      other threads kept, the copy changed last wins one both changed, no message lost), the
 *      database's copy saved to org/threads-backup/conflicts/ first.
 *   2. A start with the experiment off after a crash: a JSON write at boot waits for the crash's
 *      leftovers to reach the file, so nothing needs merging.
 *   3. A mutation that changes a loaded object in place is still written (judged by text, not identity).
 *   4. A backup copy cut short leaves no partial directory and no move.
 *   5. A config that cannot be read keeps the JSON files.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-threads-sqlite-conflict'))
const configFails = vi.hoisted(() => ({ on: false }))
vi.mock('../../../src/core/config-manager.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/core/config-manager.js')>()
  return { ...real, getConfig: (...args: Parameters<typeof real.getConfig>) => (configFails.on ? Promise.reject(new Error('config unreadable')) : real.getConfig(...args)) }
})

import { WALNUT_HOME } from '../../../src/constants.js'
import { closeThreadsDb, getMeta, readNodeForCheck } from '../../../src/core/org/threads-db.js'
import { _resetThreadsBackendForTesting, threadsSqliteOn, useThreadsDb, writeThreadsLeftovers } from '../../../src/core/org/threads-backend.js'
import { _forgetThreadsSyncForTesting, _setThreadsExportEveryForTesting, dbMutateThreads, parseThreadsText } from '../../../src/core/org/threads-sync.js'
import { fileThreadMessage, patchThread, readThreads } from '../../../src/core/org/threads-store.js'

const NODE = 'node-orchard'
const fileOf = () => path.join(WALNUT_HOME, 'org', 'threads', `${NODE}.json`)
const conflictsDir = () => path.join(WALNUT_HOME, 'org', 'threads-backup', 'conflicts')
const onDisk = () => parseThreadsText(fs.readFileSync(fileOf(), 'utf8'), NODE)
const titleOf = (f: { threads: Array<{ id: string; title: string }> }, id: string) => f.threads.find((t) => t.id === id)?.title

/** Two threads in the database, its file current; then one change here that waits its minute. */
async function twoThreadsAndAWaitingChange(): Promise<{ a: string; b: string }> {
  _resetThreadsBackendForTesting(true)
  _setThreadsExportEveryForTesting(60_000)
  expect(await useThreadsDb()).toBe(true)
  const a = (await fileThreadMessage(NODE, { text: 'Order the seed trays', via: 'chat', at: new Date(Date.now() - 60_000).toISOString() })).thread.id
  await vi.waitFor(() => expect(onDisk().threads).toHaveLength(1))
  const b = (await fileThreadMessage(NODE, { text: 'Prune the apple trees', via: 'chat', at: new Date().toISOString() })).thread.id
  expect(onDisk().threads).toHaveLength(1)
  return { a, b }
}

/** An older build's write of the file: `edit` changes the parsed file, written in the old format. */
async function editOutside(edit: (raw: { threads: Array<Record<string, any>> }) => void): Promise<void> {
  const raw = JSON.parse(fs.readFileSync(fileOf(), 'utf8'))
  edit(raw)
  await fsp.writeFile(fileOf(), JSON.stringify(raw, null, 2) + '\n')
}

beforeEach(async () => {
  closeThreadsDb()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  configFails.on = false
  vi.restoreAllMocks()
  _setThreadsExportEveryForTesting(undefined)
  _resetThreadsBackendForTesting(false)
})

afterAll(async () => {
  _resetThreadsBackendForTesting(undefined)
  closeThreadsDb()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a file changed outside while changes here waited for it', () => {
  it('keeps both: its edit of one thread, and the thread only the database had; the database copy is saved', async () => {
    const { a, b } = await twoThreadsAndAWaitingChange()
    await editOutside((raw) => { raw.threads[0].title = 'Seed trays (older build)' })
    const read = await readThreads(NODE)
    expect(titleOf(read, a)).toBe('Seed trays (older build)')
    expect(read.threads.map((t) => t.id)).toEqual([a, b])
    const saved = fs.readdirSync(conflictsDir())
    expect(saved).toHaveLength(1)
    expect(saved[0].startsWith(`${NODE}-`)).toBe(true)
    expect(parseThreadsText(fs.readFileSync(path.join(conflictsDir(), saved[0]), 'utf8'), NODE).threads.map((t) => t.id)).toEqual([a, b])
    // The merge is what the database holds and what goes out to the file.
    expect(readNodeForCheck(NODE).threads.map((t) => t.id)).toEqual([a, b])
  })

  it('one thread changed on both sides: the copy changed last wins, and no message of either is lost', async () => {
    const { a } = await twoThreadsAndAWaitingChange()
    await patchThread(NODE, a, { title: 'Changed here' }, 'human')
    const here = (await readThreads(NODE)).threads.find((t) => t.id === a)!
    // The file's copy is older than the change here: the database's copy wins; its message comes along.
    await editOutside((raw) => {
      raw.threads[0].title = 'Changed there, earlier'
      raw.threads[0].updatedAt = new Date(Date.parse(here.updatedAt) - 1000).toISOString()
      raw.threads[0].messages.push({ id: 'tm-0000aaaa0001', at: here.updatedAt, text: 'and the 128-cell ones', via: 'chat' })
    })
    let read = await readThreads(NODE)
    expect(titleOf(read, a)).toBe('Changed here')
    expect(read.threads.find((t) => t.id === a)!.messages.map((m) => m.text)).toEqual(['Order the seed trays', 'and the 128-cell ones'])

    // Now the file's copy is the later one: it wins.
    await patchThread(NODE, a, { title: 'Changed here again' }, 'human')
    await editOutside((raw) => {
      const t = raw.threads.find((x) => x.id === a)!
      t.title = 'Changed there, later'
      t.updatedAt = new Date(Date.now() + 60_000).toISOString()
    })
    read = await readThreads(NODE)
    expect(titleOf(read, a)).toBe('Changed there, later')
    expect(fs.readdirSync(conflictsDir()).length).toBeGreaterThanOrEqual(2)
  })

  it('with nothing waiting here, the file simply wins and nothing is set aside', async () => {
    _resetThreadsBackendForTesting(true)
    _setThreadsExportEveryForTesting(0)
    expect(await useThreadsDb()).toBe(true)
    const a = (await fileThreadMessage(NODE, { text: 'Water the beds', via: 'chat', at: new Date().toISOString() })).thread.id
    await editOutside((raw) => { raw.threads[0].title = 'Renamed there' })
    expect(titleOf(await readThreads(NODE), a)).toBe('Renamed there')
    expect(fs.existsSync(conflictsDir())).toBe(false)
  })
})

describe('a start with the experiment off after a crash with it on', () => {
  it('a JSON write at boot waits for the leftovers, so both changes are in the file with no merge', async () => {
    const { a, b } = await twoThreadsAndAWaitingChange()
    await patchThread(NODE, a, { title: 'Only in the database' }, 'human')
    // The crash: nothing flushed. The next start has the experiment off; a JSON write comes first,
    // the boot's own leftovers call at the same time.
    _setThreadsExportEveryForTesting(0)
    _resetThreadsBackendForTesting(false)
    _forgetThreadsSyncForTesting()
    await Promise.all([
      patchThread(NODE, b, { title: 'Written at boot' }, 'human'),
      writeThreadsLeftovers(),
    ])
    const file = onDisk()
    expect(titleOf(file, a)).toBe('Only in the database')
    expect(titleOf(file, b)).toBe('Written at boot')
    expect(fs.existsSync(conflictsDir())).toBe(false)
  })
})

describe('a write is judged by text, not by object identity', () => {
  it('a mutation that changes a loaded thread in place and hands it back is still written', async () => {
    _resetThreadsBackendForTesting(true)
    _setThreadsExportEveryForTesting(0)
    expect(await useThreadsDb()).toBe(true)
    const a = (await fileThreadMessage(NODE, { text: 'Mend the fence', via: 'chat', at: new Date().toISOString() })).thread.id
    await readThreads(NODE) // the node is cached now: the next write starts from the cache
    for (const round of [1, 2]) {
      const ok = await dbMutateThreads(NODE, (cur) => {
        const t = cur.threads[0] as { title: string; messages: Array<{ text: string }> }
        t.title = `Mended ${round}`
        t.messages[0].text = `Mend the fence, round ${round}`
        return cur
      }, () => true)
      expect(ok).toBe(true)
      expect(titleOf(readNodeForCheck(NODE), a)).toBe(`Mended ${round}`)
      expect(readNodeForCheck(NODE).threads[0].messages[0].text).toBe(`Mend the fence, round ${round}`)
      expect(titleOf(onDisk(), a)).toBe(`Mended ${round}`)
    }
  })
})

describe('the move in when something fails', () => {
  it('a backup copy cut short leaves no partial directory, no move, and the next start moves', async () => {
    await fsp.mkdir(path.dirname(fileOf()), { recursive: true })
    await fsp.writeFile(fileOf(), JSON.stringify({ version: 1, taskId: NODE, threads: [] }, null, 2) + '\n')
    const cp = fsp.cp
    const spy = vi.spyOn(fsp, 'cp').mockImplementation(async (_from, to) => {
      await fsp.mkdir(String(to), { recursive: true })
      await fsp.writeFile(path.join(String(to), 'half.json'), '{')
      throw new Error('disk full')
    })
    _resetThreadsBackendForTesting(true)
    expect(await useThreadsDb()).toBe(false)
    const backups = path.join(WALNUT_HOME, 'org', 'threads-backup')
    expect(fs.existsSync(backups) ? fs.readdirSync(backups) : []).toEqual([])
    expect(getMeta('imported_at')).toBeUndefined()
    spy.mockImplementation(cp)
    _resetThreadsBackendForTesting(true)
    expect(await useThreadsDb()).toBe(true)
    expect(fs.readdirSync(backups)).toHaveLength(1)
  })

  it('a config that cannot be read keeps the JSON files', async () => {
    configFails.on = true
    _resetThreadsBackendForTesting(undefined)
    // The real switch: a forced run of the suites (WALNUT_THREADS_SQLITE=1) would skip the config.
    const forcedEnv = process.env.WALNUT_THREADS_SQLITE
    delete process.env.WALNUT_THREADS_SQLITE
    try {
      const warn = vi.spyOn((await import('../../../src/logging/index.js')).log.task, 'warn')
      expect(await threadsSqliteOn()).toBe(false)
      expect(await useThreadsDb()).toBe(false)
      expect(warn.mock.calls.some(([msg]) => /config not read/.test(String(msg)))).toBe(true)
    } finally {
      if (forcedEnv !== undefined) process.env.WALNUT_THREADS_SQLITE = forcedEnv
    }
  })
})
