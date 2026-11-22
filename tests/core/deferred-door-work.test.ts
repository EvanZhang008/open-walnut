/**
 * Outward work a closed door held is on disk (src/core/deferred-door-work.ts): a restart while
 * the doors are closed keeps it, and it runs once after the doors open, never twice. A restart is
 * simulated by loading every module again (vi.resetModules): what a module held in memory is gone,
 * the files under the (mocked) home stay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('deferred-door-work'))

import { WALNUT_HOME } from '../../src/constants.js'

type Doors = typeof import('../../src/core/leader/switch/doors.js')
type Work = typeof import('../../src/core/deferred-door-work.js')

const FILE = path.join(WALNUT_HOME, 'cache', 'leader-deferred-work.json')
const refusal = () => Object.assign(new Error('this machine does not hold the write permission'), { name: 'PermitNotHeld' })

/** A process start: every module fresh. */
async function boot(): Promise<{ doors: Doors; work: Work }> {
  vi.resetModules()
  return {
    doors: await import('../../src/core/leader/switch/doors.js'),
    work: await import('../../src/core/deferred-door-work.js'),
  }
}

/** A permit guards the process (as runtime.ts registers it), doors as `open` says, armed at boot. */
function guard(p: { doors: Doors; work: Work }, open: { now: boolean }): void {
  p.doors.setOutwardDoorChecker(() => { if (!open.now) throw refusal() }, () => open.now)
  p.work.armDeferredDoorWork(WALNUT_HOME)
}

const held = () => (fs.existsSync(FILE) ? (JSON.parse(fs.readFileSync(FILE, 'utf8')) as { entries: Array<{ key: string; payload: unknown; claim?: { pid: number; token: string } }> }).entries : null)
/** Held and not claimed by any process (a kept entry gave its claim back). */
const unclaimed = () => (held() ?? []).filter((e) => !e.claim).map((e) => e.key).sort()
/** Lets a replayer take a moment, so concurrent replays overlap. */
const settle = () => new Promise((r) => setTimeout(r, 30))

let last: { doors: Doors } | null = null

beforeEach(() => {
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true })
  fs.mkdirSync(WALNUT_HOME, { recursive: true })
})

afterEach(() => {
  last?.doors.setOutwardDoorChecker(null)
  last = null
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true })
})

describe('with no permit guarding the process (experiment off, or on with no witnesses)', () => {
  it('holds nothing, reads nothing and runs nothing, even with a file a past leader left', async () => {
    const p = await boot(); last = p
    const run = vi.fn(async () => {})
    p.work.registerDeferredReplay('task-sync:delete', run)
    await p.work.holdDurablyUntilDoorsOpen('task-sync:delete', 'task-sync:delete:x:1', { n: 1 })
    expect(fs.existsSync(FILE)).toBe(false)

    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    const left = JSON.stringify({ version: 1, entries: [{ kind: 'task-sync:delete', key: 'k', payload: { n: 2 }, at: '2026-11-01T00:00:00Z' }] })
    fs.writeFileSync(FILE, left)
    p.doors.notifyOutwardDoorsOpened()
    expect(await p.work.replayDeferredDoorWork()).toBe(0)
    p.work.registerDeferredReplay('task-sync:delete', run)
    expect(await p.work.replayDeferredDoorWork()).toBe(0)
    expect(run).not.toHaveBeenCalled()
    expect(fs.readFileSync(FILE, 'utf8')).toBe(left)
  })
})

describe('held at a closed door', () => {
  it('survives a restart and runs once after the doors open, never again', async () => {
    const first = await boot(); last = first
    guard(first, { now: false })
    await first.work.holdDurablyUntilDoorsOpen('task-sync:delete', 'task-sync:delete:ms-todo:t1', { task: { id: 't1' } })
    expect(held()).toEqual([expect.objectContaining({ key: 'task-sync:delete:ms-todo:t1', payload: { task: { id: 't1' } } })])
    first.doors.setOutwardDoorChecker(null)

    // The restart: the doors come up closed, the owner registers its replayer at load.
    const second = await boot(); last = second
    const open = { now: false }
    const run = vi.fn(async () => {})
    second.work.registerDeferredReplay('task-sync:delete', run)
    guard(second, open)
    second.doors.notifyOutwardDoorsOpened() // a rising edge while closed (no lease yet) runs nothing
    expect(await second.work.replayDeferredDoorWork()).toBe(0)
    expect(run).not.toHaveBeenCalled()

    open.now = true
    second.doors.notifyOutwardDoorsOpened()
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    expect(run).toHaveBeenCalledWith({ task: { id: 't1' } })
    await vi.waitFor(() => expect(held()).toEqual([]))
    second.doors.notifyOutwardDoorsOpened()
    expect(await second.work.replayDeferredDoorWork()).toBe(0)
    expect(run).toHaveBeenCalledTimes(1)
    second.doors.setOutwardDoorChecker(null)

    // And a later restart finds nothing left.
    const third = await boot(); last = third
    const again = vi.fn(async () => {})
    third.work.registerDeferredReplay('task-sync:delete', again)
    guard(third, { now: true })
    third.doors.notifyOutwardDoorsOpened()
    expect(await third.work.replayDeferredDoorWork()).toBe(0)
    expect(again).not.toHaveBeenCalled()
  })

  it('negative control: the same work held in memory (onceOutwardDoorsOpened) is gone after a restart', async () => {
    const first = await boot(); last = first
    guard(first, { now: false })
    const run = vi.fn()
    first.doors.onceOutwardDoorsOpened('task-sync:delete:ms-todo:t1', run)
    first.doors.setOutwardDoorChecker(null)

    const second = await boot(); last = second
    guard(second, { now: true })
    second.doors.notifyOutwardDoorsOpened()
    // The listeners run synchronously in notify: nothing to wait for.
    expect(run).not.toHaveBeenCalled()
    expect(held()).toBeNull()
  })

  it('a second hold of the same key replaces the first: one run, with the newest payload', async () => {
    const p = await boot(); last = p
    const open = { now: false }
    const run = vi.fn(async () => {})
    p.work.registerDeferredReplay('task-sync:rename', run)
    guard(p, open)
    await p.work.holdDurablyUntilDoorsOpen('task-sync:rename', 'task-sync:rename:ms-todo:Old', { canonical: 'B' })
    await p.work.holdDurablyUntilDoorsOpen('task-sync:rename', 'task-sync:rename:ms-todo:Old', { canonical: 'C' })
    expect(held()).toHaveLength(1)
    open.now = true
    p.doors.notifyOutwardDoorsOpened()
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    expect(run).toHaveBeenCalledWith({ canonical: 'C' })
  })

  it('a replay refused again is held again for the next opening, and runs then once', async () => {
    const p = await boot(); last = p
    const open = { now: false }
    let refuseNext = true
    const run = vi.fn(async () => { if (refuseNext) { refuseNext = false; throw refusal() } })
    p.work.registerDeferredReplay('task-sync:mark-moved', run)
    guard(p, open)
    await p.work.holdDurablyUntilDoorsOpen('task-sync:mark-moved', 'task-sync:mark-moved:ms-todo:t2', { steps: ['complete'] })
    open.now = true
    p.doors.notifyOutwardDoorsOpened()
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(unclaimed()).toEqual(['task-sync:mark-moved:ms-todo:t2']))
    p.doors.notifyOutwardDoorsOpened()
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(held()).toEqual([]))
    expect(await p.work.replayDeferredDoorWork()).toBe(0)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('a replayer that cannot run yet keeps its entry; one with no replayer is left for the owner that registers later', async () => {
    const p = await boot(); last = p
    const open = { now: false }
    guard(p, open)
    await p.work.holdDurablyUntilDoorsOpen('task-sync:delete', 'task-sync:delete:gone:t3', { task: { id: 't3' } })
    await p.work.holdDurablyUntilDoorsOpen('mail-unsubscribe', 'mail-unsubscribe:lt-1', { letterId: 'lt-1', actionId: 'unsubscribe' })
    const keep = vi.fn(async () => 'keep' as const)
    p.work.registerDeferredReplay('task-sync:delete', keep)
    open.now = true
    p.doors.notifyOutwardDoorsOpened()
    await vi.waitFor(() => expect(keep).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(unclaimed()).toEqual(['mail-unsubscribe:lt-1', 'task-sync:delete:gone:t3']))

    // The mail plugin activates after the doors opened: its answer runs at once, the delete stays.
    const answer = vi.fn(async () => {})
    p.work.registerDeferredReplay('mail-unsubscribe', answer)
    await vi.waitFor(() => expect(answer).toHaveBeenCalledWith({ letterId: 'lt-1', actionId: 'unsubscribe' }))
    await vi.waitFor(() => expect(unclaimed()).toEqual(['task-sync:delete:gone:t3']))
    expect(held()).toHaveLength(1)
    expect(answer).toHaveBeenCalledTimes(1)
  })

  it('two replays at once (the opening and an arm) run each entry once', async () => {
    const p = await boot(); last = p
    const open = { now: false }
    const run = vi.fn(async () => { await settle() })
    p.work.registerDeferredReplay('task-sync:delete', run)
    guard(p, open)
    for (let i = 0; i < 5; i++) await p.work.holdDurablyUntilDoorsOpen('task-sync:delete', `task-sync:delete:ms-todo:t${i}`, { i })
    open.now = true
    const ran = await Promise.all([p.work.replayDeferredDoorWork(), p.work.replayDeferredDoorWork(), p.work.replayDeferredDoorWork()])
    expect(ran.reduce((a, b) => a + b, 0)).toBe(5)
    expect(await p.work.replayDeferredDoorWork()).toBe(0)
    expect(run).toHaveBeenCalledTimes(5)
    expect(new Set(run.mock.calls.map((c) => (c[0] as { i: number }).i)).size).toBe(5)
  })
  it('a kept entry (its plugin not loaded yet) is tried again by the slow timer, and runs once then', async () => {
    const p = await boot(); last = p
    const timers = vi.spyOn(globalThis, 'setTimeout')
    let loaded = false
    const run = vi.fn(async () => (loaded ? 'done' as const : 'keep' as const))
    p.work.registerDeferredReplay('task-sync:mark-moved', run)
    guard(p, { now: true })
    await p.work.holdDurablyUntilDoorsOpen('task-sync:mark-moved', 'task-sync:mark-moved:slow:t5', { steps: ['title'] })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(unclaimed()).toEqual(['task-sync:mark-moved:slow:t5']))
    const retry = timers.mock.calls.find(([, ms]) => ms === p.work.KEEP_RETRY_MS)
    timers.mockRestore()
    expect(retry).toBeDefined()
    loaded = true
    ;(retry![0] as () => void)()
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(held()).toEqual([]))
    expect(await p.work.replayDeferredDoorWork()).toBe(0)
    expect(run).toHaveBeenCalledTimes(2)
    p.work._resetDeferredDoorWorkForTesting()
  })

  it('a hold made after the doors opened (a refusal racing an opening) runs at once', async () => {
    const p = await boot(); last = p
    const run = vi.fn(async () => {})
    p.work.registerDeferredReplay('task-sync:rename', run)
    guard(p, { now: true })
    await p.work.holdDurablyUntilDoorsOpen('task-sync:rename', 'task-sync:rename:ms-todo:Late', { canonical: 'L' })
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith({ canonical: 'L' }))
    await vi.waitFor(() => expect(held()).toEqual([]))
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('a file that cannot be written falls back to memory: still done once at the opening', async () => {
    const p = await boot(); last = p
    fs.writeFileSync(path.join(WALNUT_HOME, 'cache'), 'not a folder')
    const open = { now: false }
    const run = vi.fn(async () => {})
    p.work.registerDeferredReplay('task-sync:delete', run)
    guard(p, open)
    await p.work.holdDurablyUntilDoorsOpen('task-sync:delete', 'task-sync:delete:ms-todo:t6', { task: { id: 't6' } })
    open.now = true
    p.doors.notifyOutwardDoorsOpened()
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    p.doors.notifyOutwardDoorsOpened()
    expect(await p.work.replayDeferredDoorWork()).toBe(0)
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('a crash after the claim and before the run: the next boot takes the claim back and runs it once', async () => {
    const first = await boot(); last = first
    const open = { now: false }
    // The plugin is still loading when the process stops: the replay never ends.
    first.work.registerDeferredReplay('task-sync:rename', () => new Promise(() => {}))
    guard(first, open)
    await first.work.holdDurablyUntilDoorsOpen('task-sync:rename', 'task-sync:rename:ms-todo:Old', { canonical: 'New' })
    open.now = true
    first.doors.notifyOutwardDoorsOpened()
    await vi.waitFor(() => expect(held()?.[0]?.claim).toMatchObject({ pid: process.pid }))
    first.doors.setOutwardDoorChecker(null)

    // The next boot: a new incarnation (same pid in a test, another token).
    const second = await boot(); last = second
    const run = vi.fn(async () => {})
    second.work.registerDeferredReplay('task-sync:rename', run)
    guard(second, { now: true })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    expect(run).toHaveBeenCalledWith({ canonical: 'New' })
    await vi.waitFor(() => expect(held()).toEqual([]))
    expect(await second.work.replayDeferredDoorWork()).toBe(0)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('a claim of a dead process or another host is taken back; one of a live process here is not', async () => {
    const p = await boot(); last = p
    const run = vi.fn(async () => {})
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    const at = new Date().toISOString()
    const host = (await import('node:os')).hostname()
    fs.writeFileSync(FILE, JSON.stringify({ version: 1, entries: [
      { kind: 'task-sync:delete', key: 'dead', payload: 'dead', at, claim: { host, pid: 2 ** 22 + 12345, token: 'gone', at } },
      { kind: 'task-sync:delete', key: 'other-host', payload: 'other-host', at, claim: { host: `${host}-elsewhere`, pid: process.ppid, token: 'old-leader', at } },
      { kind: 'task-sync:delete', key: 'live', payload: 'live', at, claim: { host, pid: process.ppid, token: 'parent', at } },
    ] }))
    p.work.registerDeferredReplay('task-sync:delete', run)
    guard(p, { now: true })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    expect(run.mock.calls.map((c) => c[0]).sort()).toEqual(['dead', 'other-host'])
    await vi.waitFor(() => expect(held()?.map((e) => e.key)).toEqual(['live']))
    expect(await p.work.replayDeferredDoorWork()).toBe(0)
  })

  it('an I/O error reading the file leaves it untouched: the new hold waits in memory, nothing is written away', async () => {
    const p = await boot(); last = p
    const open = { now: false }
    const run = vi.fn(async () => {})
    p.work.registerDeferredReplay('task-sync:delete', run)
    guard(p, open)
    await p.work.holdDurablyUntilDoorsOpen('task-sync:delete', 'task-sync:delete:ms-todo:a', { n: 'a' })
    const before = fs.readFileSync(FILE, 'utf8')
    const fsp = (await import('node:fs/promises')).default
    const real = fsp.readFile.bind(fsp)
    const eio = vi.spyOn(fsp, 'readFile').mockImplementation(((file: unknown, ...rest: unknown[]) => {
      if (file === FILE) return Promise.reject(Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' }))
      return (real as (...a: unknown[]) => Promise<unknown>)(file, ...rest)
    }) as typeof fsp.readFile)
    try {
      await p.work.holdDurablyUntilDoorsOpen('task-sync:delete', 'task-sync:delete:ms-todo:b', { n: 'b' })
      expect(fs.readFileSync(FILE, 'utf8')).toBe(before)
      open.now = true
      expect(await p.work.replayDeferredDoorWork()).toBe(0)
      expect(fs.readFileSync(FILE, 'utf8')).toBe(before)
    } finally {
      eio.mockRestore()
    }
    // Readable again: both go, each once.
    p.doors.notifyOutwardDoorsOpened()
    await vi.waitFor(() => expect(run.mock.calls.map((c) => (c[0] as { n: string }).n).sort()).toEqual(['a', 'b']))
    await vi.waitFor(() => expect(held()).toEqual([]))
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('a file that does not parse is moved aside, logged, and held work goes on from empty', async () => {
    const p = await boot(); last = p
    const open = { now: false }
    const run = vi.fn(async () => {})
    p.work.registerDeferredReplay('task-sync:delete', run)
    guard(p, open)
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.writeFileSync(FILE, '{ "version": 1, "entries": [ torn')
    await p.work.holdDurablyUntilDoorsOpen('task-sync:delete', 'task-sync:delete:ms-todo:c', { n: 'c' })
    const aside = fs.readdirSync(path.dirname(FILE)).filter((n) => n.startsWith('leader-deferred-work.json.corrupt-'))
    expect(aside).toHaveLength(1)
    expect(fs.readFileSync(path.join(path.dirname(FILE), aside[0]!), 'utf8')).toContain('torn')
    expect(held()?.map((e) => e.key)).toEqual(['task-sync:delete:ms-todo:c'])
    open.now = true
    p.doors.notifyOutwardDoorsOpened()
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith({ n: 'c' }))
  })

  it('a newer hold kept in memory (the file could not be written) runs, not the older one on disk', async () => {
    const p = await boot(); last = p
    const open = { now: false }
    const run = vi.fn(async () => {})
    p.work.registerDeferredReplay('task-sync:rename', run)
    guard(p, open)
    await p.work.holdDurablyUntilDoorsOpen('task-sync:rename', 'task-sync:rename:ms-todo:Old', { canonical: 'B' })
    const fsp = (await import('node:fs/promises')).default
    const real = fsp.readFile.bind(fsp)
    const eio = vi.spyOn(fsp, 'readFile').mockImplementation(((file: unknown, ...rest: unknown[]) => {
      if (file === FILE) return Promise.reject(Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' }))
      return (real as (...a: unknown[]) => Promise<unknown>)(file, ...rest)
    }) as typeof fsp.readFile)
    await new Promise((r) => setTimeout(r, 5)) // the newer hold is stamped later
    await p.work.holdDurablyUntilDoorsOpen('task-sync:rename', 'task-sync:rename:ms-todo:Old', { canonical: 'C' })
    eio.mockRestore()
    open.now = true
    p.doors.notifyOutwardDoorsOpened()
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith({ canonical: 'C' }))
    await vi.waitFor(() => expect(held()).toEqual([]))
    expect(await p.work.replayDeferredDoorWork()).toBe(0)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('a boot that is not normal (a switch trial) holds and replays nothing', async () => {
    const p = await boot(); last = p
    const policy = await import('../../src/core/boot-policy.js')
    const run = vi.fn(async () => {})
    p.work.registerDeferredReplay('task-sync:delete', run)
    policy.setBootMode('trial', 'leader-switch')
    try {
      guard(p, { now: true })
      await p.work.holdDurablyUntilDoorsOpen('task-sync:delete', 'task-sync:delete:ms-todo:trial', { n: 1 })
      expect(fs.existsSync(FILE)).toBe(false)
      fs.mkdirSync(path.dirname(FILE), { recursive: true })
      const left = JSON.stringify({ version: 1, entries: [{ kind: 'task-sync:delete', key: 'k', payload: 1, at: new Date().toISOString() }] })
      fs.writeFileSync(FILE, left)
      p.doors.notifyOutwardDoorsOpened()
      expect(await p.work.replayDeferredDoorWork()).toBe(0)
      expect(run).not.toHaveBeenCalled()
      expect(fs.readFileSync(FILE, 'utf8')).toBe(left)
    } finally {
      policy.setBootMode('normal')
    }
  })
})
