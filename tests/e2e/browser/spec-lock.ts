/**
 * One spec at a time holds one shared thing of a fixture server (spec-lock).
 *
 * Playwright runs other files against the same fixture server at once (`fullyParallel`), and
 * serial within a file never covers that. A spec that drives something the whole server shares
 * (the panel count, the list of waiting approvals) holds that thing's lock:
 *
 *  - a serial file holds it for the whole file (its tests build on each other);
 *  - any other file holds it per test, so its tests spread over workers never wait on each other.
 *
 * A mkdir lock keyed by the fixture port, as layout-record-restart.spec.ts does: the holder's pid
 * is written inside, a dead holder's lock is broken, and the same worker taking it again (a file
 * whose release never ran) is no wait. Time spent waiting is added to the hook's or test's own
 * timeout, and kept there across a later test.setTimeout of the test (wait-budget.ts), so a queue
 * never eats a test's budget.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from '@playwright/test'
import { waitOutsideBudget } from './wait-budget'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const MAX_WAIT_MS = 25 * 60_000
const STALE_MS = 40 * 60_000

export interface SpecLock {
  acquire(): Promise<void>
  release(): void
  /** Hold the lock for this file (serial) or for each test (any other file). */
  hold(scope: 'file' | 'test'): void
}

/** The lock named `name` on this fixture port. */
export function specLock(name: string): SpecLock {
  const lock = path.join(os.tmpdir(), `walnut-${name}-spec-${TEST_PORT}.lock`)
  const holder = (): number | null => {
    try { return Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8')) || null } catch { return null }
  }
  const acquire = async (): Promise<void> => {
    const t0 = Date.now()
    // The wait is kept out of the test's time limit, a later test.setTimeout of its own included.
    await waitOutsideBudget(test.info(), MAX_WAIT_MS, async () => {
      for (;;) {
        try {
          fs.mkdirSync(lock)
          fs.writeFileSync(path.join(lock, 'pid'), String(process.pid))
          return
        } catch { /* held */ }
        const pid = holder()
        if (pid === process.pid) return
        try {
          let alive = pid !== null && pid > 1
          // Signal 0 only asks whether the holder still runs; it sends nothing.
          if (alive) { try { process.kill(pid!, 0) } catch { alive = false } }
          if (!alive || Date.now() - fs.statSync(lock).mtimeMs > STALE_MS) fs.rmSync(lock, { recursive: true, force: true })
        } catch { /* racing the holder's release */ }
        if (Date.now() - t0 > MAX_WAIT_MS) throw new Error(`${name} lock still held by pid ${pid}: ${lock}`)
        await new Promise((r) => setTimeout(r, 500))
      }
    })
  }
  const release = (): void => {
    if (holder() === process.pid) fs.rmSync(lock, { recursive: true, force: true })
  }
  process.once('exit', release)
  return {
    acquire,
    release,
    hold(scope) {
      if (scope === 'file') {
        test.beforeAll(acquire)
        test.afterAll(release)
      } else {
        test.beforeEach(acquire)
        test.afterEach(release)
      }
    },
  }
}

export type RwMode = 'shared' | 'exclusive'

export interface SpecRwLock {
  /** Take it shared (beside other shared holders) or exclusive (alone). */
  acquire(mode: RwMode): Promise<void>
  /** Let go of whatever this worker holds (shared or exclusive). */
  release(): void
  /** What this worker holds now. */
  held(): RwMode | null
  /** Hold it in `mode` for this file (serial) or for each test (any other file). */
  hold(mode: RwMode, scope: 'file' | 'test'): void
}

/**
 * A readers/writer lock named `name` on this fixture port: any number of workers hold it shared
 * at once, one worker holds it exclusive with nobody else. Two kinds of entry under one directory:
 *
 *  - `writer/` (a mkdir, as specLock's, the holder's pid inside): the exclusive claim;
 *  - `readers/<pid>`: one file per worker holding it shared.
 *
 * Both sides write first and look second, so of a reader and a writer that arrive together at
 * least one sees the other: a reader that finds a writer's claim takes its file back and waits,
 * and a writer, once its claim is made, waits for the readers already in to leave. A claim made
 * holds new readers off, so a writer is never starved by readers that keep coming. A dead
 * holder's entry is broken (its pid no longer runs; a writer's claim also when older than
 * STALE_MS, as specLock's). The same worker asking again is no wait: exclusive covers shared, and
 * asking for exclusive while holding shared first gives the shared hold back (an upgrade in place
 * could deadlock two upgrading workers).
 */
export function specRwLock(name: string): SpecRwLock {
  const dir = path.join(os.tmpdir(), `walnut-${name}-spec-${TEST_PORT}.rwlock`)
  const writer = path.join(dir, 'writer')
  const readers = path.join(dir, 'readers')
  const mine = path.join(readers, String(process.pid))
  const alive = (pid: number | null): boolean => {
    if (pid === null || pid <= 1) return false
    // Signal 0 only asks whether the holder still runs; it sends nothing.
    try { process.kill(pid, 0); return true } catch { return false }
  }
  const stale = (p: string): boolean => {
    try { return Date.now() - fs.statSync(p).mtimeMs > STALE_MS } catch { return false }
  }
  const writerPid = (): number | null => {
    try { return Number(fs.readFileSync(path.join(writer, 'pid'), 'utf8')) || null } catch { return null }
  }
  /** The live writer's pid other than this worker, else null (a dead or stale claim is broken). */
  const otherWriter = (): number | null => {
    if (!fs.existsSync(writer)) return null
    const pid = writerPid()
    if (pid === process.pid) return null
    // A claim with no pid yet is a writer between its mkdir and its write: count it as live.
    if (pid === null) {
      if (!stale(writer)) return -1
      try { fs.rmSync(writer, { recursive: true, force: true }) } catch { /* racing its release */ }
      return null
    }
    if (!alive(pid) || stale(writer)) { try { fs.rmSync(writer, { recursive: true, force: true }) } catch { /* racing its release */ } return null }
    return pid
  }
  /** Live shared holders other than this worker (dead or stale ones are removed). */
  const otherReaders = (): number[] => {
    let names: string[] = []
    try { names = fs.readdirSync(readers) } catch { return [] }
    const live: number[] = []
    for (const n of names) {
      const pid = Number(n)
      if (pid === process.pid) continue
      const p = path.join(readers, n)
      // Only a holder that no longer runs: a live one may hold a whole long file, never stale by age.
      if (!alive(pid)) { try { fs.rmSync(p, { force: true }) } catch { /* gone */ } continue }
      live.push(pid)
    }
    return live
  }
  const held = (): RwMode | null => {
    if (writerPid() === process.pid) return 'exclusive'
    return fs.existsSync(mine) ? 'shared' : null
  }
  const sleep = () => new Promise((r) => setTimeout(r, 500))
  const acquire = async (mode: RwMode): Promise<void> => {
    const now = held()
    if (now === 'exclusive' || (now === 'shared' && mode === 'shared')) return
    fs.mkdirSync(readers, { recursive: true })
    const t0 = Date.now()
    const tooLong = (who: string) => { if (Date.now() - t0 > MAX_WAIT_MS) throw new Error(`${name} lock (${mode}) still held by ${who}: ${dir}`) }
    await waitOutsideBudget(test.info(), MAX_WAIT_MS, async () => {
      if (mode === 'shared') {
        for (;;) {
          const w = otherWriter()
          if (w === null) {
            fs.writeFileSync(mine, String(Date.now()))
            if (otherWriter() === null) return
            fs.rmSync(mine, { force: true })
          }
          tooLong(`writer pid ${w}`)
          await sleep()
        }
      }
      // Exclusive: give a shared hold back first, then claim, then wait for the readers to leave.
      fs.rmSync(mine, { force: true })
      for (;;) {
        try {
          fs.mkdirSync(writer)
          fs.writeFileSync(path.join(writer, 'pid'), String(process.pid))
          break
        } catch { /* claimed */ }
        if (writerPid() === process.pid) break
        otherWriter()
        tooLong(`writer pid ${writerPid()}`)
        await sleep()
      }
      for (;;) {
        const r = otherReaders()
        if (r.length === 0) return
        // Keep the claim fresh while it waits, so a long wait never reads as a stale claim.
        try { const t = new Date(); fs.utimesSync(writer, t, t) } catch { /* ours, still there */ }
        // Given up: the claim goes too, so the readers waiting behind it are not held off for nothing.
        try { tooLong(`readers ${r.join(', ')}`) } catch (err) { release(); throw err }
        await sleep()
      }
    })
  }
  const release = (): void => {
    fs.rmSync(mine, { force: true })
    if (writerPid() === process.pid) fs.rmSync(writer, { recursive: true, force: true })
  }
  process.once('exit', release)
  return {
    acquire,
    release,
    held,
    hold(mode, scope) {
      if (scope === 'file') {
        test.beforeAll(() => acquire(mode))
        test.afterAll(release)
      } else {
        test.beforeEach(() => acquire(mode))
        test.afterEach(release)
      }
    },
  }
}
