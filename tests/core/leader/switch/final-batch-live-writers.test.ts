/**
 * The final batch of a leader switch settles while the leader's own clocks are live (review 2026-11-25, M1): a
 * parked row whose delivery keeps failing (the real delivery retry clock, sessions/delivery-retry.ts, every 60 s)
 * and a pull request whose CI is running (the real PR watch clock, pull-requests/pr-watch.ts, every 30 s, writing
 * the task in the home). Neither is in a stop of stopServer: both were started with their handle thrown away.
 *
 * Without the gate each batch finds the home changed again and the commit window ends with a refusal (the switch
 * would roll back with nobody leading). With stopLeaderClocks() (stopWritersForSwitch, at the switch stop's start)
 * the next batch finds nothing changed. Real queue file, real bus, real batches into a real standby folder; the
 * clocks run on fake time, an hour between two batches (the longest retry wait), so every clock is due each time.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../../helpers/mock-constants.js'

vi.mock('../../../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/constants.js')>()
  return { ...actual, ...createMockConstants('walnut-final-batch-writers') }
})

import { WALNUT_HOME } from '../../../../src/constants.js'
import { sessionRunner } from '../../../../src/providers/claude-code-session.js'
import { bus, EventNames } from '../../../../src/core/event-bus.js'
import { enqueueMessage, getQueue, resetCache } from '../../../../src/core/session-message-queue.js'
import { parkMessages } from '../../../../src/core/session-queue-park.js'
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../../../src/core/session-tracker.js'
import { startDeliveryRetry, stopDeliveryRetry } from '../../../../src/core/sessions/delivery-retry.js'
import { _resetPrWatchForTesting, startPrWatch, type PrWatchDeps } from '../../../../src/core/pull-requests/pr-watch.js'
import { _setPrProvidersForTesting, type PrProvider, type PrReadResult } from '../../../../src/core/pull-requests/providers.js'
import { runFinalBatch } from '../../../../src/core/leader/switch/final-stop.js'
import { LocalPeer } from '../../../../src/core/leader/switch/peer.js'
import { homeWritesStopped, resumeLeaderClocks, stopLeaderClocks } from '../../../../src/lib/leader-clocks.js'
import type { Task } from '../../../../src/core/types.js'

const SID = 'ffffffff-1111-4222-8333-555555555555'
const PR = 'https://github.com/acme/app/pull/7'
const FAILS = 'Not delivered: Claude Code exited before it read this message. Retry it.'
const BETWEEN_BATCHES_MS = 61 * 60_000

/** The CI of PR 7: one more check passed at every read, one still running. */
let ciReads = 0
const provider: PrProvider = {
  id: 'github',
  parse(url) {
    const m = /^https:\/\/github\.com\/acme\/app\/pull\/(\d+)$/.exec(url)
    return m ? { provider: 'github', url, owner: 'acme', name: 'app', number: Number(m[1]) } : null
  },
  async read(refs) {
    const results = new Map<string, PrReadResult>()
    for (const ref of refs) {
      ciReads++
      results.set(ref.url, {
        ok: true,
        read: {
          snapshot: {
            provider: 'github', url: ref.url, repo: 'acme/app', number: 7, title: 'Change 7', state: 'open', headSha: 'abc', base: 'main', head: 'b7', author: 'dana',
            checks: { total: ciReads + 1, passed: ciReads, failed: 0, pending: 1, skipped: 0, items: [{ name: 'e2e', status: 'pending', url: 'https://ci.example/e2e' }] },
            mergeable: 'clean', remarks: 0,
          },
          failed: [], remarks: [],
        },
      })
    }
    return { viewer: 'dana', results }
  },
}

/** The task store of the PR watch: one task, written into the home as the real store would. */
const taskFile = () => path.join(WALNUT_HOME, 'tasks', 't-ci.json')
let task: Task
let taskWrites = 0
const deps: PrWatchDeps = {
  openTasks: async () => [task],
  getTask: async () => task,
  writeTask: async (_id, patch) => {
    const p = patch(task)
    if (!p) return
    task = { ...task, ...p } as Task
    taskWrites++
    await fsp.mkdir(path.dirname(taskFile()), { recursive: true })
    await fsp.writeFile(taskFile(), JSON.stringify(task))
  },
  deliveryTarget: async () => null,
  send: async () => {},
  complete: async () => {},
  holdReason: async () => null,
  config: async () => ({ watch: true }),
  now: () => Date.now(),
}

/** Every file of the home with its size and mtime: equal twice in a row is a home at rest. */
function snapshot(dir: string): string {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else { try { const s = fs.statSync(p); out.push(`${p}:${s.size}:${s.mtimeMs}`) } catch { /* gone meanwhile */ } }
    }
  }
  walk(dir)
  return out.sort().join('\n')
}
async function atRest(): Promise<void> {
  let last = ''
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 100))
    const now = snapshot(WALNUT_HOME)
    if (now === last) return
    last = now
  }
}

/** The real copy link into a standby folder; before each batch the clocks get an hour of time and the home comes to rest. */
function livePeer(standbyDir: string): LocalPeer & { batches: number } {
  const peer = new LocalPeer({ id: 'machine-b', home: path.join(path.dirname(standbyDir), 'b-home'), standbyDir, port: 1 }, standbyDir) as LocalPeer & { batches: number }
  peer.batches = 0
  const batch = peer.batch.bind(peer)
  peer.batch = async (home: string) => {
    await vi.advanceTimersByTimeAsync(BETWEEN_BATCHES_MS)
    await atRest()
    peer.batches++
    return batch(home)
  }
  return peer
}

const tmp: string[] = []
let parkedSends = 0
beforeAll(() => { _setPrProvidersForTesting([provider]) })
afterAll(() => { _setPrProvidersForTesting(null) })

async function startClocks(): Promise<void> {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  _resetSessionTrackerForTesting()
  _resetPrWatchForTesting()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], shouldAdvanceTime: true })
  vi.spyOn(sessionRunner, 'isTurnRunning').mockReturnValue(false)
  await createSessionRecord(SID, 't-retry', 'Acme', '/tmp', { initialProcessStatus: 'idle' })
  // The delivery fails every time: each send the retry asks for parks the row again.
  bus.subscribe('final-batch-writers', (e) => {
    if (e.name !== EventNames.SESSION_SEND || e.source !== 'delivery-retry') return
    parkedSends++
    void getQueue(SID).then((rows) => parkMessages(rows.filter((r) => r.status === 'pending'), FAILS))
  }, { global: true, interest: [EventNames.SESSION_SEND] })
  const row = await enqueueMessage(SID, 'the user\'s words')
  await parkMessages([row], FAILS)
  task = { id: 't-ci', title: 'CI running', phase: 'IN_PROGRESS', tags: [`pr:${PR}`] } as Task
  taskWrites = 0
  ciReads = 0
  parkedSends = 0
  // As web/server.ts starts them: nothing here stops them before the final batch (the handle is kept only for
  // this test's cleanup).
  startDeliveryRetry()
  prWatch = await startPrWatch(deps)
}
let prWatch: Awaited<ReturnType<typeof startPrWatch>> = null

afterEach(async () => {
  resumeLeaderClocks()
  stopDeliveryRetry()
  prWatch?.stop()
  prWatch = null
  bus.unsubscribe('final-batch-writers')
  vi.restoreAllMocks()
  vi.useRealTimers()
  resetCache()
  for (const d of tmp.splice(0)) {
    const open = (p: string) => { try { fs.chmodSync(p, 0o700) } catch { return } for (const e of fs.readdirSync(p, { withFileTypes: true })) if (e.isDirectory()) open(path.join(p, e.name)) }
    open(d)
    fs.rmSync(d, { recursive: true, force: true })
  }
})

const standby = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'final-batch-writers-')); tmp.push(d); return path.join(d, 'standby') }

describe('the final batch with the leader\'s clocks live', () => {
  it('without the gate, a retried delivery and a running CI change the home at every batch: the window ends in a refusal', async () => {
    await startClocks()
    const peer = livePeer(standby())
    const r = await runFinalBatch({ home: WALNUT_HOME, peer, deadlineAt: 5, now: () => peer.batches, signal: new AbortController().signal })
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.why).toMatch(/the home still changed when the commit window ended .*a writer the stop did not end/)
    expect(peer.batches).toBeGreaterThanOrEqual(5)
    // Both writers were at it between the batches.
    expect(parkedSends).toBeGreaterThanOrEqual(peer.batches - 1)
    expect(taskWrites).toBeGreaterThanOrEqual(peer.batches - 1)
  }, 120_000)

  it('with stopLeaderClocks() at the stop\'s start, the next batch finds nothing changed', async () => {
    await startClocks()
    // The clocks ran before the stop: the row was retried and the task written.
    await vi.advanceTimersByTimeAsync(BETWEEN_BATCHES_MS)
    await atRest()
    expect(parkedSends).toBeGreaterThan(0)
    expect(taskWrites).toBeGreaterThan(0)
    stopLeaderClocks()
    expect(homeWritesStopped()).toBe(true)
    const [sends, writes] = [parkedSends, taskWrites]
    const peer = livePeer(standby())
    const r = await runFinalBatch({ home: WALNUT_HOME, peer, deadlineAt: 5, now: () => peer.batches, signal: new AbortController().signal })
    expect(r).toMatchObject({ ok: true, batches: 2 })
    // An hour a batch, and neither clock wrote again; the row waits parked on disk for the next leader.
    expect([parkedSends, taskWrites]).toEqual([sends, writes])
    expect((await getQueue(SID))[0]).toMatchObject({ status: 'parked' })
    expect(fs.existsSync(path.join(path.dirname(peer.standbyDir), 'standby', 'copy', 'tasks', 't-ci.json'))).toBe(true)
  }, 120_000)
})
