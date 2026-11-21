/**
 * The pins of several databases are one moment: a commit to a database already pinned, made
 * before the last one is pinned, makes the worker pin again. A WAL restart (a writer starting
 * again from frame 1 after a full checkpoint) keeps the -wal's size, so the -wal's header is
 * compared too. The worker's test hook stops it between the first pin and the second.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { openPinWorker, type PinWorker } from '../../../src/core/standby/sqlite-pin.js'
import { makeDb, sandbox, type Sandbox } from './helpers.js'

let sb: Sandbox
let worker: PinWorker | null = null
const dbs: Array<{ close: () => unknown }> = []
afterEach(async () => {
  await worker?.close()
  worker = null
  for (const db of dbs.splice(0)) db.close()
  await sb?.cleanup()
})

async function until(file: string): Promise<void> {
  for (let i = 0; i < 400 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 5))
  expect(fs.existsSync(file), file).toBe(true)
}

describe('pinning several databases', () => {
  it('a WAL restart on the first database between its pin and the next one pins again', async () => {
    sb = await sandbox('pin-restart')
    const a = makeDb(sb.home, 'a.sqlite', 0)
    const b = makeDb(sb.home, 'b.sqlite', 5)
    dbs.push(a, b)
    a.pragma('wal_autocheckpoint = 0')
    const ins = a.prepare('INSERT INTO t (body) VALUES (?)')
    for (let i = 0; i < 30; i++) ins.run(`first ${i}`)
    // Every frame checkpointed, nobody reading: the pin's reader takes read mark 0, so the next
    // write restarts the WAL from frame 1.
    a.pragma('wal_checkpoint(PASSIVE)')
    const walFile = path.join(sb.home, 'a.sqlite-wal')
    const sizeBefore = fs.statSync(walFile).size
    worker = await openPinWorker([path.join(sb.home, 'a.sqlite'), path.join(sb.home, 'b.sqlite')])
    const pauseDir = path.join(sb.root, 'pause')
    fs.mkdirSync(pauseDir)
    const pinned = worker.pin({ pauseDir })
    await until(path.join(pauseDir, 'paused'))
    ins.run('after the first pin')
    expect(fs.statSync(walFile).size).toBe(sizeBefore)
    fs.writeFileSync(path.join(pauseDir, 'resume'), '')
    expect((await pinned).attempts).toBeGreaterThan(1)
  })

  it('with no commit between the pins, one attempt is enough', async () => {
    sb = await sandbox('pin-steady')
    dbs.push(makeDb(sb.home, 'a.sqlite', 5), makeDb(sb.home, 'b.sqlite', 5))
    worker = await openPinWorker([path.join(sb.home, 'a.sqlite'), path.join(sb.home, 'b.sqlite')])
    const pauseDir = path.join(sb.root, 'pause')
    fs.mkdirSync(pauseDir)
    const pinned = worker.pin({ pauseDir })
    await until(path.join(pauseDir, 'paused'))
    fs.writeFileSync(path.join(pauseDir, 'resume'), '')
    expect((await pinned).attempts).toBe(1)
  })
})
