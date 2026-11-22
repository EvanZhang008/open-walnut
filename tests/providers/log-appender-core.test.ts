/**
 * The daemon log's writer (src/providers/log-appender-core.ts): lines appended off the thread,
 * one write at a time, in order; an error line and the exit paths written synchronously.
 * S7-M4 (2026-11-22 review): the exit flush skipped the batch already handed to appendFile, so
 * the last lines before a crash could be lost or land after the FATAL line.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLogAppender, type LogAppenderDeps } from '../../src/providers/log-appender-core.js'
import { armFilePoolDeadline } from '../../src/providers/file-pool-deadline.js'

const appender = (deps: Omit<LogAppenderDeps, 'armDeadline'>) => createLogAppender({ ...deps, armDeadline: armFilePoolDeadline })

let dir: string
let file: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'log-appender-'))
  file = path.join(dir, 'daemon.log')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const lines = (): string[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').split('\n').filter(Boolean)

/** fs whose promises.appendFile waits for `gate` (a write in flight for as long as the test wants); `wedged`: every pool call does, the deadline's probe too. */
function slowFs(gate: Promise<void>, wedged = false) {
  const promises = new Proxy(fs.promises, {
    get(target, prop, receiver) {
      if (prop === 'appendFile') return async (...args: Parameters<typeof fs.promises.appendFile>) => { await gate; return target.appendFile(...args) }
      if (prop === 'stat' && wedged) return async (p: string) => { await gate; return target.stat(p) }
      return Reflect.get(target, prop, receiver)
    },
  })
  return new Proxy(fs, { get(t, p, r) { return p === 'promises' ? promises : Reflect.get(t, p, r) } }) as typeof fs
}

describe('log appender', () => {
  it('writes every line once, in order, across turns', async () => {
    const log = appender({ fs, file })
    for (let i = 0; i < 200; i++) {
      log.append(`line ${i}\n`)
      if (i % 37 === 0) await new Promise((r) => setImmediate(r))
    }
    await log.drained()
    expect(lines()).toEqual(Array.from({ length: 200 }, (_, i) => `line ${i}`))
  })

  it('caps the queue in bytes and writes the count of the lines it dropped', async () => {
    // Each line is 5 characters but 9 bytes (four two-byte letters): a cap by characters keeps every one.
    const log = appender({ fs, file, maxQueuedBytes: 25 })
    for (let i = 0; i < 5; i++) log.append('\u00e9\u00e9\u00e9\u00e9\n')
    await log.drained()
    const out = lines()
    expect(out.filter((l) => l.startsWith('\u00e9'))).toHaveLength(2)
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ msg: 'log lines dropped: the log could not keep up', dropped: 3 })
  })

  it('the exit flush writes the batch in flight, then the queue, synchronously and in order', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const log = appender({ fs: slowFs(gate), file })
    log.append('before 1\n')
    log.append('before 2\n')
    await new Promise((r) => setImmediate(r))
    // Those two are in flight now; these are queued behind them.
    log.append('queued\n')
    log.append('FATAL\n')
    log.flushSync()
    // "Exit" here: the write in flight never lands.
    expect(lines()).toEqual(['before 1', 'before 2', 'queued', 'FATAL'])
    release()
  })

  it('an error line is never written ahead of the lines in flight before it', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const log = appender({ fs: slowFs(gate), file })
    log.append('first\n')
    await new Promise((r) => setImmediate(r))
    log.append('error\n', true)
    expect(lines()).toEqual([])
    release()
    await log.drained()
    expect(lines()).toEqual(['first', 'error'])
    // With nothing in flight, an error line is on disk at once.
    log.append('second error\n', true)
    expect(lines()).toEqual(['first', 'error', 'second error'])
  })

  // S7-R2-M2 (2026-11-22 review): an error line waited behind the append in flight, so a wedged
  // pool silenced the whole log (errors, heartbeats, the registry's own warning) until exit.
  it('a wedged pool: past the deadline the batch in flight, the queue and every later line are written synchronously, in order', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const log = appender({ fs: slowFs(gate, true), file, deadlineMs: 30 })
    log.append('first\n')
    await new Promise((r) => setImmediate(r))
    log.append('error\n', true)
    expect(lines()).toEqual([])
    const started = Date.now()
    while (lines().length === 0 && Date.now() - started < 2000) await new Promise((r) => setTimeout(r, 5))
    expect(lines().slice(0, 2)).toEqual(['first', 'error'])
    expect(JSON.parse(lines()[2])).toMatchObject({ level: 'warn', msg: 'log: the file pool did not answer; writing synchronously' })
    // Still stuck: a plain line goes out within the turn, an error line at once.
    log.append('later\n')
    await log.drained()
    log.append('later error\n', true)
    expect(lines().slice(3)).toEqual(['later', 'later error'])
    // The pool answers again: the stuck batch lands a second time (accepted), and writes go async again.
    release()
    await new Promise((r) => setTimeout(r, 20))
    log.append('after\n')
    await log.drained()
    expect(lines().at(-1)).toBe('after')
    expect(lines().filter((l) => l === 'error')).toHaveLength(1)
  })

  it('a slow disk, the pool alive: nothing is written synchronously; the lines land once, in order', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const log = appender({ fs: slowFs(gate), file, deadlineMs: 20 })
    log.append('first\n')
    await new Promise((r) => setImmediate(r))
    log.append('second\n')
    await new Promise((r) => setTimeout(r, 150))
    expect(lines()).toEqual([])
    release()
    await log.drained()
    expect(lines()).toEqual(['first', 'second'])
  })
})
