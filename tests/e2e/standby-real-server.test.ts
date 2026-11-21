/**
 * The standby copy against a real server under writes: notes and tasks are created through
 * the API, each task naming the note made just before it, while batches run in the server's
 * own process (so its write gate holds the server's gated writes). Every completed batch must
 * be of one moment: any task in it has its note in it too. The flag off: the server starts no
 * standby, opens no gate and writes nothing for it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('standby-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { snapshotTo, verifyStandby } from '../../src/core/standby/index.js'
import { removeTree } from '../../src/core/standby/target-files.js'
import { setWriteGateEnabled, writeGateEnabled } from '../../src/utils/write-gate.js'
import { openCopiedDb, walk } from '../core/standby/helpers.js'

let port = 0
let target = ''
const call = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(`http://localhost:${port}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

beforeAll(async () => {
  fs.mkdirSync(WALNUT_HOME, { recursive: true })
  target = fs.mkdtempSync(path.join(os.tmpdir(), 'standby-e2e-target-'))
  const server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 60_000)

afterAll(async () => {
  setWriteGateEnabled(false)
  await stopServer().catch(() => {})
  await removeTree(target).catch(() => {})
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true })
})

describe('a real server', () => {
  it('with the flag off runs no standby: no gate, no staging, nothing written', async () => {
    expect(writeGateEnabled()).toBe(false)
    await new Promise((r) => setTimeout(r, 500))
    expect(fs.existsSync(path.join(WALNUT_HOME, 'tmp/standby-staging'))).toBe(false)
    expect(walk(target)).toEqual([])
  })

  it('every completed batch taken under writes is of one moment', async () => {
    setWriteGateEnabled(true)
    let writing = true
    let made = 0
    const writer = (async () => {
      while (writing) {
        const i = made
        const note = await call('PUT', `/api/notes-v2/content/standby-e2e/n-${i}.md`, { content: `# note ${i}\n` })
        expect(note.status, JSON.stringify(note.json)).toBeLessThan(300)
        const task = await call('POST', '/api/tasks', { title: `standby e2e task ${i}`, project: 'Standby e2e', description: `see standby-e2e/n-${i}.md` })
        expect(task.status, JSON.stringify(task.json)).toBeLessThan(300)
        made++
      }
    })()

    const holds: number[] = []
    let done = 0
    let voids = 0
    const reasons: string[] = []
    let checkedTasks = 0
    const deadline = Date.now() + 25_000
    while ((done < 8 || made < 20) && Date.now() < deadline) {
      const out = await snapshotTo(WALNUT_HOME, target)
      holds.push(out.stats.holdMs)
      if (!out.ok) { voids++; reasons.push(out.reason.slice(0, 160)); continue }
      done++
      // The batch just made current: every task in it has its note in it.
      const copy = path.join(target, 'copy')
      const notes = new Set(walk(copy).filter((p) => /standby-e2e\/n-\d+\.md$/.test(p)).map((p) => Number(/n-(\d+)\.md$/.exec(p)![1])))
      const dbFile = path.join(copy, 'tasks/tasks.sqlite')
      if (!fs.existsSync(dbFile)) continue
      const { db, done: close } = openCopiedDb(dbFile)
      try {
        expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
        const rows = db.prepare("SELECT title FROM tasks WHERE title LIKE 'standby e2e task %'").all() as Array<{ title: string }>
        for (const r of rows) {
          const i = Number(/(\d+)$/.exec(r.title)![1])
          expect(notes.has(i), `batch ${out.commit.batch}: task ${i} without its note`).toBe(true)
          checkedTasks++
        }
      } finally { close() }
    }
    writing = false
    await writer
    setWriteGateEnabled(false)
    holds.sort((a, b) => a - b)
    const q = (p: number) => Math.round(holds[Math.min(holds.length - 1, Math.floor(p * holds.length))])
    console.log(`[standby e2e] ${done} batches, ${voids} void, ${made} note+task pairs written, ${checkedTasks} task rows checked; hold p50 ${q(0.5)} ms, p95 ${q(0.95)} ms, max ${Math.round(holds[holds.length - 1])} ms`)
    if (reasons.length) console.log(`[standby e2e] void reasons: ${JSON.stringify(reasons)}`)
    expect(done).toBeGreaterThanOrEqual(5)
    expect(checkedTasks).toBeGreaterThan(0)
    expect((await verifyStandby(target, { deep: true })).drift).toEqual([])
  }, 60_000)
})
