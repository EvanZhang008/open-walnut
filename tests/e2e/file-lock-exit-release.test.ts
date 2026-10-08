/**
 * A process that exits while it holds a file lock gives the lock back.
 *
 * 2026-10-08, on the cloud companion: a stopping server was writing its
 * "SERVER EXIT" card when it exited. The notifications.json lock dir stayed
 * behind with an EMPTY pid file (the dir is made first, the pid written after),
 * which waiters can only age out after 30s while each gives up at 10s. The next
 * server's boot lost its 'web-assets' recovery write to it, twice in a row, and
 * the card it would have retired stayed up.
 *
 * Real child processes (tsx), each exiting with process.exit while inside fn.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { withFileLock } from '../../src/utils/file-lock.js'

const REPO = path.resolve(import.meta.dirname, '../..')
const TSX = path.join(REPO, 'node_modules/.bin/tsx')
const CHILD = path.join(import.meta.dirname, 'fixtures/file-lock-exit-child.ts')

let tmp: string

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-lock-exit-')) })
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

function runChild(file: string, mode: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [CHILD, file, mode], {
      cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OTHER_PID: String(process.pid) },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += String(d) })
    child.stderr.on('data', (d) => { err += String(d) })
    child.on('error', reject)
    child.on('close', (code) => {
      if (!out.includes('held')) reject(new Error(`child never held the lock: ${err}`))
      else resolve({ code, out })
    })
  })
}

const lockOf = (file: string) => `${file}.lock`

describe('withFileLock: a lock held at exit', () => {
  it('is removed when the process exits inside fn', async () => {
    const file = path.join(tmp, 'held.json')
    const { code } = await runChild(file, 'held')
    expect(code).toBe(0)
    expect(fs.existsSync(lockOf(file))).toBe(false)
  }, 60_000)

  it('is removed when it died before its pid was written, and the next writer gets it at once', async () => {
    const file = path.join(tmp, 'empty-pid.json')
    await runChild(file, 'empty-pid')
    expect(fs.existsSync(lockOf(file))).toBe(false)
    // Before the fix this waited out the 10s timeout and threw: an empty pid
    // file reads as a live holder until the lock is 30s old.
    const started = Date.now()
    await withFileLock(file, async () => { /* acquired */ })
    expect(Date.now() - started).toBeLessThan(2_000)
  }, 60_000)

  it('is left alone when its pid file names another process', async () => {
    const file = path.join(tmp, 'taken-over.json')
    await runChild(file, 'taken-over')
    expect(fs.existsSync(lockOf(file))).toBe(true)
    expect(fs.readFileSync(path.join(lockOf(file), 'pid'), 'utf-8')).toBe(String(process.pid))
    fs.rmSync(lockOf(file), { recursive: true, force: true })
  }, 60_000)

  it('a lock released before exit stays released', async () => {
    const file = path.join(tmp, 'released.json')
    const { code } = await runChild(file, 'released')
    expect(code).toBe(0)
    expect(fs.existsSync(lockOf(file))).toBe(false)
  }, 60_000)
})
