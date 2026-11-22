/**
 * The session registry's writer (src/providers/registry-writer-core.ts): coalesced async writes off
 * the daemon's thread, the write-ahead a spawn awaits, the synchronous write of an exit, and the
 * exit hold. Real files in a temp dir; a slowed fs.promises makes the races happen on purpose.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRegistryWriter, type RegistrySessionLike } from '../../src/providers/registry-writer-core.js'
import { armFilePoolDeadline } from '../../src/providers/file-pool-deadline.js'

let dir: string
let file: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-writer-'))
  file = path.join(dir, 'sessions.json')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const live = (pid: number): RegistrySessionLike => ({ state: 'running', pid, startTime: String(pid), jsonlPath: `/streams/${pid}.jsonl`, args: ['claude'] })
const onDisk = (): string[] => Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).sessions).sort()

/** fs whose promises.rename (and optionally open) waits for `gate` before it runs. */
function slowFs(gate: { rename?: Promise<void>; failSync?: boolean }) {
  const promises = new Proxy(fs.promises, {
    get(target, prop, receiver) {
      if (prop === 'rename' && gate.rename) return async (a: string, b: string) => { await gate.rename; return target.rename(a, b) }
      if (prop === 'open' && gate.failSync) {
        return async (...args: Parameters<typeof fs.promises.open>) => {
          const fh = await target.open(...args)
          return new Proxy(fh, { get(t, p, r) { if (p === 'sync') return async () => { throw Object.assign(new Error('EIO: fsync'), { code: 'EIO' }) } ; const v = Reflect.get(t, p, r); return typeof v === 'function' ? v.bind(t) : v } })
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
  return new Proxy(fs, { get(target, prop, receiver) { return prop === 'promises' ? promises : Reflect.get(target, prop, receiver) } }) as typeof fs
}

function writer(sessions: Map<string, RegistrySessionLike>, opts: { fs?: typeof fs; strict?: boolean; pid?: number; deadlineMs?: number } = {}) {
  const writes: string[] = []
  const logs: string[] = []
  const w = createRegistryWriter({
    fs: opts.fs ?? fs, dirname: path.dirname, file, sessions, now: () => 0,
    strict: () => opts.strict === true,
    log: (_level, msg) => { logs.push(msg) },
    onWrite: (kind) => { writes.push(kind) },
    pid: opts.pid,
    asyncDeadlineMs: opts.deadlineMs,
    armDeadline: armFilePoolDeadline,
  })
  return { w, writes, logs }
}

describe('registry writer', () => {
  it('a burst of 100 changes is written in a few writes, the last one holding the final inventory', async () => {
    const sessions = new Map<string, RegistrySessionLike>()
    const { w, writes } = writer(sessions)
    for (let i = 0; i < 100; i++) {
      sessions.set(`s${i}`, live(1000 + i))
      w.request()
      // Some changes land in later turns too, as session exits do.
      if (i % 25 === 0) await new Promise((r) => setImmediate(r))
    }
    await w.durable()
    expect(writes.length).toBeLessThanOrEqual(6)
    expect(onDisk()).toHaveLength(100)
    for (let i = 0; i < 100; i += 2) { sessions.get(`s${i}`)!.state = 'dead'; w.request() }
    await w.durable()
    expect(onDisk()).toHaveLength(50)
    expect(w.stats().requests).toBe(150)
  })

  it('a spawn that awaited the write-ahead is in the file a crashed daemon leaves', async () => {
    const sessions = new Map<string, RegistrySessionLike>()
    let release!: () => void
    const gate = { rename: new Promise<void>((r) => { release = r }) }
    const { w } = writer(sessions, { fs: slowFs(gate) })
    // An earlier write is in flight (its rename held), then the spawn records its CLI.
    sessions.set('older', live(10)); w.request()
    await new Promise((r) => setImmediate(r))
    sessions.set('spawned', live(11))
    let answered = false
    const ahead = w.durable().then(() => { answered = true })
    await new Promise((r) => setTimeout(r, 30))
    // The spawn is not answered while the write that holds it has not landed.
    expect(answered).toBe(false)
    release()
    await ahead
    // "Crash" here: a new process reads the file as it is.
    expect(onDisk()).toEqual(['older', 'spawned'])
  })

  it('a synchronous write is never overwritten by an older async write already in flight', async () => {
    const sessions = new Map<string, RegistrySessionLike>([['a', live(1)]])
    let release!: () => void
    const gate = { rename: new Promise<void>((r) => { release = r }) }
    const { w } = writer(sessions, { fs: slowFs(gate) })
    w.request()
    const first = w.durable()
    await new Promise((r) => setTimeout(r, 20))
    // The async write took {a}; the exit's synchronous write holds {a, b}.
    sessions.set('b', live(2))
    w.writeSync()
    expect(onDisk()).toEqual(['a', 'b'])
    release()
    await first
    await new Promise((r) => setTimeout(r, 20))
    expect(onDisk()).toEqual(['a', 'b'])
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('the exit hold keeps the inventory through the reap, and a sync write before it lands writes the held one', async () => {
    const sessions = new Map<string, RegistrySessionLike>([['a', live(1)], ['b', live(2)]])
    const { w } = writer(sessions)
    await w.hold()
    expect(onDisk()).toEqual(['a', 'b'])
    sessions.get('a')!.state = 'dead'; w.request()
    sessions.get('b')!.state = 'dead'; await w.durable()
    w.writeSync()
    expect(onDisk()).toEqual(['a', 'b'])

    // A hold whose write has not landed yet: the bail's sync write writes what the hold took.
    fs.rmSync(file)
    const s2 = new Map<string, RegistrySessionLike>([['c', live(3)]])
    let release!: () => void
    const gate = { rename: new Promise<void>((r) => { release = r }) }
    const two = writer(s2, { fs: slowFs(gate) })
    const held = two.w.hold()
    s2.get('c')!.state = 'dead'
    await vi.waitFor(() => expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toHaveLength(1))
    two.w.writeSync()
    expect(onDisk()).toEqual(['c'])
    release()
    await held
    expect(onDisk()).toEqual(['c'])
  })

  it('strict: a write that cannot be made durable fails the write-ahead; not strict, it is a warning', async () => {
    const sessions = new Map<string, RegistrySessionLike>([['a', live(1)]])
    const strict = writer(sessions, { fs: slowFs({ failSync: true }), strict: true })
    await expect(strict.w.durable()).rejects.toThrow(/EIO/)
    const lenient = writer(sessions, { fs: slowFs({ failSync: true }) })
    await expect(lenient.w.durable()).resolves.toBeUndefined()
    expect(onDisk()).toEqual(['a'])
    // An explicit strict ask (the handover) fails even when the writer is not strict.
    await expect(lenient.w.durable(true)).rejects.toThrow(/EIO/)
  })

  it('unlessClean skips the exit write only when nothing changed since the last write', async () => {
    const sessions = new Map<string, RegistrySessionLike>([['a', live(1)]])
    const { w, writes } = writer(sessions)
    w.writeSync({ unlessClean: true })
    expect(writes).toEqual(['sync'])
    await w.durable()
    w.writeSync({ unlessClean: true })
    expect(writes).toEqual(['sync', 'async'])
    sessions.set('b', live(2)); w.request()
    w.writeSync({ unlessClean: true })
    expect(writes).toEqual(['sync', 'async', 'sync'])
    expect(onDisk()).toEqual(['a', 'b'])
  })

  // S7-H1 (2026-11-22 review): every async write needs a free fs pool thread. A pool wedged for
  // good (a FIFO open with no writer, a dead mount) hung the stop after its drain cap, the
  // update's strict write and every start's write-ahead.
  it('a file pool that never answers: the write-ahead, a strict write and the hold still finish, on disk', async () => {
    // Wedged means every pool call waits, the deadline's probe (a stat) included.
    const wedged = new Proxy(fs.promises, {
      get(target, prop, receiver) {
        if (prop === 'open' || prop === 'stat') return () => new Promise(() => {})
        return Reflect.get(target, prop, receiver)
      },
    })
    const wedgedFs = new Proxy(fs, { get(t, p, r) { return p === 'promises' ? wedged : Reflect.get(t, p, r) } }) as typeof fs
    const sessions = new Map<string, RegistrySessionLike>([['a', live(1)]])
    const { w, writes, logs } = writer(sessions, { fs: wedgedFs, strict: true, deadlineMs: 40 })
    const started = Date.now()
    sessions.set('spawned', live(2))
    await w.durable()
    expect(onDisk()).toEqual(['a', 'spawned'])
    expect(logs).toContain('registry write: the file pool did not answer; writing synchronously')
    // While the stuck write has not ended, every write is made here at once (no second wait).
    sessions.set('next', live(3))
    await w.durable(true)
    expect(onDisk()).toEqual(['a', 'next', 'spawned'])
    sessions.get('a')!.state = 'dead'
    await w.hold()
    expect(onDisk()).toEqual(['next', 'spawned'])
    expect(Date.now() - started).toBeLessThan(2000)
    expect(writes).toEqual(['async', 'sync', 'sync', 'hold', 'sync'])
  })

  it('the pool answers again: the late write never lands over the newer sync one, and writes go async again', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const slowOpen = new Proxy(fs.promises, {
      get(target, prop, receiver) {
        if (prop === 'open') return async (...args: Parameters<typeof fs.promises.open>) => { await gate; return target.open(...args) }
        if (prop === 'stat') return async (p: string) => { await gate; return target.stat(p) }
        return Reflect.get(target, prop, receiver)
      },
    })
    const slow = new Proxy(fs, { get(t, p, r) { return p === 'promises' ? slowOpen : Reflect.get(t, p, r) } }) as typeof fs
    const sessions = new Map<string, RegistrySessionLike>([['a', live(1)]])
    const { w, writes } = writer(sessions, { fs: slow, deadlineMs: 30 })
    await w.durable()
    expect(onDisk()).toEqual(['a'])
    sessions.set('b', live(2))
    await w.durable()
    expect(onDisk()).toEqual(['a', 'b'])
    release()
    await new Promise((r) => setTimeout(r, 30))
    expect(onDisk()).toEqual(['a', 'b'])
    sessions.set('c', live(3))
    await w.durable()
    expect(onDisk()).toEqual(['a', 'b', 'c'])
    expect(writes).toEqual(['async', 'sync', 'sync', 'async'])
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  // S7-R2-M1 (2026-11-22 review): the deadline could not tell a wedged pool from a slow disk, so a
  // slow fsync went synchronous, on the web server's thread in an in-process runtime, and every
  // write after it too. The pool still answers here (its probe does): the write is left to finish.
  it('a slow disk, the pool alive: no write is made synchronously, and the write-ahead waits for the async one', async () => {
    const slowSync = new Proxy(fs.promises, {
      get(target, prop, receiver) {
        if (prop === 'open') {
          return async (...args: Parameters<typeof fs.promises.open>) => {
            const fh = await target.open(...args)
            return new Proxy(fh, { get(t, p, r) { if (p === 'sync') return async () => { await new Promise((res) => setTimeout(res, 200)); return t.sync() } ; const v = Reflect.get(t, p, r); return typeof v === 'function' ? v.bind(t) : v } })
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    const slowFsNoWedge = new Proxy(fs, { get(t, p, r) { return p === 'promises' ? slowSync : Reflect.get(t, p, r) } }) as typeof fs
    const sessions = new Map<string, RegistrySessionLike>([['a', live(1)]])
    const { w, writes, logs } = writer(sessions, { fs: slowFsNoWedge, strict: true, deadlineMs: 30 })
    const started = Date.now()
    await w.durable(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(190)
    expect(onDisk()).toEqual(['a'])
    sessions.set('b', live(2))
    await w.durable()
    expect(onDisk()).toEqual(['a', 'b'])
    expect(writes).toEqual(['async', 'async'])
    expect(logs).toContain('registry write slow: the file pool answers, so the write is left to finish')
    expect(logs).not.toContain('registry write: the file pool did not answer; writing synchronously')
  })

  it('a writeSync that answered the write in flight while the pool is wedged: later requests still get written', async () => {
    const wedged = new Proxy(fs.promises, {
      get(target, prop, receiver) {
        if (prop === 'open' || prop === 'stat') return () => new Promise(() => {})
        return Reflect.get(target, prop, receiver)
      },
    })
    const wedgedFs = new Proxy(fs, { get(t, p, r) { return p === 'promises' ? wedged : Reflect.get(t, p, r) } }) as typeof fs
    const sessions = new Map<string, RegistrySessionLike>([['a', live(1)]])
    const { w, writes } = writer(sessions, { fs: wedgedFs, deadlineMs: 30 })
    w.request()
    await new Promise((r) => setImmediate(r))
    w.writeSync()
    expect(onDisk()).toEqual(['a'])
    // The flight it answered is still in the wedged pool: its deadline still turns into the sync path.
    sessions.set('b', live(2))
    await w.durable()
    expect(onDisk()).toEqual(['a', 'b'])
    expect(writes).toEqual(['async', 'sync', 'sync'])
  })

  // S7-M1: writeSync gave the async write up before its own write landed; a failed sync write
  // then resolved a strict waiter and set clean with nothing on disk.
  it('a sync write that fails gives nothing up: the async write in flight still lands it', async () => {
    const sessions = new Map<string, RegistrySessionLike>([['a', live(1)]])
    writer(sessions).w.writeSync()
    let release!: () => void
    const gate = { rename: new Promise<void>((r) => { release = r }) }
    const failing = { on: false }
    const base = slowFs(gate)
    const flaky = new Proxy(base, { get(t, p, r) {
      if (p === 'writeFileSync' && failing.on) return () => { throw Object.assign(new Error('ENOSPC: no space'), { code: 'ENOSPC' }) }
      return Reflect.get(t, p, r)
    } }) as typeof fs
    const { w } = writer(sessions, { fs: flaky })
    sessions.set('b', live(2))
    let resolved = false
    const ahead = w.durable(true).then(() => { resolved = true })
    await new Promise((r) => setTimeout(r, 20))
    failing.on = true
    w.writeSync({ strict: false })
    // Not told it is on disk, and the exit's unlessClean write is not skipped.
    expect(resolved).toBe(false)
    release()
    await ahead
    expect(onDisk()).toEqual(['a', 'b'])
  })

  it('a sync write whose rename fails after giving the async write up: the strict waiter rejects, and a later write lands it', async () => {
    const sessions = new Map<string, RegistrySessionLike>([['a', live(1)]])
    writer(sessions).w.writeSync()
    let release!: () => void
    const gate = { rename: new Promise<void>((r) => { release = r }) }
    const failing = { on: false }
    const base = slowFs(gate)
    const flaky = new Proxy(base, { get(t, p, r) {
      if (p === 'renameSync' && failing.on) return () => { throw Object.assign(new Error('EIO: rename'), { code: 'EIO' }) }
      return Reflect.get(t, p, r)
    } }) as typeof fs
    const { w } = writer(sessions, { fs: flaky })
    sessions.set('b', live(2))
    const ahead = w.durable(true)
    ahead.catch(() => {})
    await new Promise((r) => setTimeout(r, 20))
    failing.on = true
    w.writeSync({ strict: false })
    failing.on = false
    release()
    await expect(ahead).rejects.toThrow(/synchronous write that failed/)
    expect(onDisk()).toEqual(['a'])
    // The change is still asked for: the next write takes it.
    await w.durable()
    expect(onDisk()).toEqual(['a', 'b'])
    // A strict exit write that fails throws, and is not clean after it.
    failing.on = true
    sessions.set('c', live(3))
    expect(() => w.writeSync({ strict: true })).toThrow(/EIO/)
    failing.on = false
    w.writeSync({ unlessClean: true })
    expect(onDisk()).toEqual(['a', 'b', 'c'])
  })

  // S7-M2: one temp name for every process: a zombie daemon's exit write unlinked its
  // successor's temp in flight, or two async writers truncated one file between them.
  it('two processes on one registry never share a temp file', async () => {
    const sessions = new Map<string, RegistrySessionLike>([['a', live(1)]])
    let release!: () => void
    const gate = { rename: new Promise<void>((r) => { release = r }) }
    const successor = writer(sessions, { fs: slowFs(gate), pid: 2002 })
    const zombieSessions = new Map<string, RegistrySessionLike>([['old', live(9)]])
    const zombie = writer(zombieSessions, { pid: 1001 })
    sessions.set('b', live(2))
    const ahead = successor.w.durable(true)
    await vi.waitFor(() => expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual(['sessions.json.2002.tmp']))
    // The zombie's write leaves the successor's temp alone, so its write-ahead still lands.
    zombie.w.writeSync()
    expect(fs.existsSync(path.join(dir, 'sessions.json.2002.tmp'))).toBe(true)
    release()
    await ahead
    expect(onDisk()).toEqual(['a', 'b'])
  })
})
