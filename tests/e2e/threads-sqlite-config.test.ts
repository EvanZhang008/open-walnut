/**
 * The experiment threads_sqlite on a real server, switched the way Settings does (PUT /api/config:
 * written, then announced), with the real minute between two writes of a file:
 *
 *   1. On: the JSON files move into the database (backup made, every thread read back the same).
 *   2. Off: a change still waiting its minute goes out to its file at the switch, and the next write
 *      goes to the file only.
 *   3. stopServer: a change waiting its minute and a write made in the middle of the shutdown (after
 *      the first flush, while HTTP still serves) are both in the file when it returns.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-threads-sqlite-config'))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())
const midShutdown = vi.hoisted(() => ({ write: null as null | (() => Promise<unknown>), done: null as Promise<unknown> | null }))
vi.mock('../../src/core/org/threads-sync.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/org/threads-sync.js')>()
  return {
    ...real,
    // A write lands right after the first flush of stopServer, while the rest of the shutdown runs.
    stopThreadsExports: async () => {
      await real.stopThreadsExports()
      if (midShutdown.write) { midShutdown.done = midShutdown.write(); midShutdown.write = null }
    },
  }
})

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { getMeta, readNodeForCheck } from '../../src/core/org/threads-db.js'
import { threadsSqliteOn, useThreadsDb } from '../../src/core/org/threads-backend.js'
import { parseThreadsText } from '../../src/core/org/threads-sync.js'
import { emptyThreads, fileMessage } from '../../src/core/org/threads-model.js'
import { patchThread, readThreads } from '../../src/core/org/threads-store.js'

// The real switch and the real minute: a forced run of the suites must not reach this file.
delete process.env.WALNUT_THREADS_SQLITE
delete process.env.WALNUT_THREADS_EXPORT_MS

const NODE = 'node-greenhouse'
const fileOf = () => path.join(WALNUT_HOME, 'org', 'threads', `${NODE}.json`)
const onDisk = () => parseThreadsText(fs.readFileSync(fileOf(), 'utf8'), NODE)
let base = ''
let a = ''
let b = ''

async function flag(on: boolean): Promise<void> {
  const put = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ experimental: { threads_sqlite: on } }) })
  expect(put.status).toBe(200)
  await vi.waitFor(async () => expect(await threadsSqliteOn()).toBe(on), { timeout: 5000 })
}

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  // Two threads an older build wrote.
  const first = fileMessage(emptyThreads(NODE), { text: 'Heat the greenhouse at night', via: 'chat', at: new Date(Date.now() - 120_000).toISOString() })
  const second = fileMessage(first.file, { text: 'Vent it at noon', via: 'chat', at: new Date(Date.now() - 60_000).toISOString() })
  a = first.thread.id
  b = second.thread.id
  await fsp.mkdir(path.dirname(fileOf()), { recursive: true })
  await fsp.writeFile(fileOf(), JSON.stringify(second.file, null, 2) + '\n')
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await stopServer().catch(() => {})
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('threads_sqlite switched through the config', () => {
  it('on: the files move into the database, every thread read back the same', async () => {
    const before = await readThreads(NODE)
    expect(await useThreadsDb()).toBe(false)
    await flag(true)
    expect(await useThreadsDb()).toBe(true)
    expect(getMeta('imported_at')).toBeTruthy()
    expect(fs.existsSync(path.join(getMeta('backup_dir')!, `${NODE}.json`))).toBe(true)
    expect(await readThreads(NODE)).toEqual(before)
  })

  it('off: the change still waiting its minute is in the file at the switch; the next write goes to the file only', async () => {
    await patchThread(NODE, a, { title: 'Night heat' }, 'human')
    await vi.waitFor(() => expect(onDisk().threads.find((t) => t.id === a)?.title).toBe('Night heat'))
    await patchThread(NODE, b, { title: 'Noon vent (waits its minute)' }, 'human')
    expect(onDisk().threads.find((t) => t.id === b)?.title).not.toBe('Noon vent (waits its minute)')
    await flag(false)
    await vi.waitFor(() => expect(onDisk().threads.find((t) => t.id === b)?.title).toBe('Noon vent (waits its minute)'))
    await patchThread(NODE, a, { title: 'Written with it off' }, 'human')
    expect(onDisk().threads.find((t) => t.id === a)?.title).toBe('Written with it off')
    expect(readNodeForCheck(NODE).threads.find((t) => t.id === a)?.title).toBe('Night heat')
  })

  it('stopServer: a change waiting its minute and a write in the middle of the shutdown are both in the file', async () => {
    await flag(true)
    expect(await useThreadsDb()).toBe(true)
    // On again: the file wins over the database's older copy.
    expect((await readThreads(NODE)).threads.find((t) => t.id === a)?.title).toBe('Written with it off')
    await patchThread(NODE, a, { title: 'Before the stop' }, 'human')
    await patchThread(NODE, b, { title: 'Waiting its minute at the stop' }, 'human')
    // Once stopping, the write is in its file when its own call returns (no minute's wait).
    midShutdown.write = async () => {
      await patchThread(NODE, a, { title: 'Written during the shutdown' }, 'human')
      return onDisk().threads.find((t) => t.id === a)?.title
    }
    await stopServer()
    expect(midShutdown.done).not.toBeNull()
    expect(await midShutdown.done).toBe('Written during the shutdown')
    const file = onDisk()
    expect(file.threads.find((t) => t.id === b)?.title).toBe('Waiting its minute at the stop')
    expect(file.threads.find((t) => t.id === a)?.title).toBe('Written during the shutdown')
  })
})
