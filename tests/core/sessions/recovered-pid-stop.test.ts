/**
 * A pid written back by recovery can never turn into a stop of another
 * Walnut's session.
 *
 * The chain this pins: an ephemeral server scrubs every pid it inherited, but
 * with remote hosts on it reconnects to the SAME shared daemon production uses.
 * Recovery asks that daemon for `status` and writes the pid it reports back
 * into the record (daemon-connection.ts, the reconnect path), so the test
 * server's copy of a production session ends up holding the live production
 * pid again. Every later stop decision (idle timeout, capacity eviction, task
 * completion, the orphan sweep) must then be refused by the daemon, or not sent
 * at all when the daemon cannot check ownership.
 *
 * The "shared daemon" is a fake connection that answers with the daemon's OWN
 * decision code, sliced from daemon-standalone.ts (the twins are pinned
 * identical by daemon-orphan-stop-twins.test.ts). Its journal records the
 * session for the production Walnut. Nothing is signalled: process.kill is
 * spied on, and the fake daemon only records what it would have stopped. The
 * pid is fabricated above any real pid limit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import nodeFs from 'node:fs'
import nodePath from 'node:path'
import ts from 'typescript'
import { createMockConstants } from '../../helpers/mock-constants.js'

const state = vi.hoisted(() => ({ ephemeral: true, conn: null as unknown }))

vi.mock('../../../src/constants.js', () => ({
  ...createMockConstants('walnut-recovered-pid-stop'),
  get IS_EPHEMERAL() { return state.ephemeral },
}))
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  getConnectedDaemonConnection: () => state.conn,
  isDaemonConnected: () => true,
  getDaemonDisconnectedSince: () => null,
}))
vi.mock('../../../src/providers/claude-code-session.js', () => ({
  sessionRunner: { markExpectedTeardown: () => () => {} },
}))
vi.mock('../../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async (s: { process_status?: string }) => s.process_status !== 'stopped' && s.process_status !== 'error',
}))
// Terminal reaping runs a shell on the session's host; nothing here may reach one.
vi.mock('../../../src/web/terminal/dtach-lifecycle.js', () => ({
  conditionalReap: async () => 'kept',
}))

import {
  checkSessionLimit,
  completeTaskSessions,
  createSessionRecord,
  getSessionByClaudeId,
  updateSessionRecord,
  _resetSessionTrackerForTesting,
} from '../../../src/core/session-tracker.js'
import { closeDb } from '../../../src/core/session-db.js'
import { stopThroughOwner, sweepOrphansThroughOwner, ORPHAN_STOP_CAPABILITY } from '../../../src/core/sessions/owner-stop.js'
import { OWNER_HOME_CAPABILITY } from '../../../src/core/sessions/stop-provenance.js'
import { WALNUT_HOME } from '../../../src/constants.js'

const REPO_ROOT = nodePath.resolve(__dirname, '../../..')
const SID = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f'
/** Above any real pid limit: nothing can ever answer to it. */
const PID = 2 ** 22 + 41
const PROD_HOME = '/fixture/production-walnut-home'
const PGID_PATH = `/fixture/streams/${SID}.pgid`
const JSONL_PATH = `/fixture/streams/${SID}.jsonl`
const HOUR_AGO = () => new Date(Date.now() - 60 * 60 * 1000).toISOString()

type Decide = {
  stopOwnerRefusal(sid: string, cmd: Record<string, unknown>): Record<string, unknown> | null
  orphanStopRefusal(sid: string, expectPid: unknown, home: unknown): Record<string, unknown> | null
}

function sliceTopLevelFn(src: string, name: string): string {
  const at = src.search(new RegExp('function ' + name + '\\('))
  expect(at, `${name} not found`).toBeGreaterThan(-1)
  return src.slice(at, src.indexOf('\n}', at) + 2)
}

/** The shared daemon's own ownership decisions, over a world where it runs SID for production. */
function productionDaemonDecisions(): Decide {
  const src = nodeFs.readFileSync(nodePath.join(REPO_ROOT, 'src/providers/daemon-standalone.ts'), 'utf-8')
  const code = ['stopOwnerRefusal', 'orphanStopRefusal'].map((n) => sliceTopLevelFn(src, n)).join('\n')
  const js = ts.transpileModule(code + '\nreturn { stopOwnerRefusal, orphanStopRefusal };', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  const journal = new Map([[SID, PROD_HOME]])
  const injected: Record<string, unknown> = {
    sessions: new Map([[SID, {
      pid: PID, state: 'running', exitCode: null, bootId: 'boot-1',
      pgidPath: PGID_PATH, jsonlPath: JSONL_PATH, foldState: { turnActive: false },
    }]]),
    SERVICE_MODE: false,
    daemonBootId: 'boot-1',
    fs: {
      readFileSync: (p: string) => { if (p === PGID_PATH) return `${PID}\n`; throw enoent() },
      statSync: (p: string) => { if (p === JSONL_PATH) return { mtimeMs: Date.now() - 30 * 60 * 1000 }; throw enoent() },
    },
    journaledIds: () => new Set(journal.keys()),
    journaledHome: (sid: string) => journal.get(sid),
    SESSION_IDLE_WARNING_MS: 5 * 60 * 1000,
    SESSION_IDLE_KILL_MS: 2 * 60 * 60 * 1000,
    deriveSessionProtection: () => ({ source: null }),
    hasRecentSchedulerFiring: () => false,
  }
  return new Function(...Object.keys(injected), js)(...Object.values(injected)) as Decide
}

interface SharedDaemon {
  connected: boolean
  hasCapability(cap: string): boolean
  send(command: string, args: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  calls: Array<{ command: string; args: Record<string, unknown> }>
  /** Stops the daemon would have carried out: must stay empty. */
  wouldStop: string[]
}

function sharedDaemon(caps: string[]): SharedDaemon {
  const decide = productionDaemonDecisions()
  const calls: SharedDaemon['calls'] = []
  const wouldStop: string[] = []
  return {
    connected: true,
    hasCapability: (cap) => caps.includes(cap),
    calls,
    wouldStop,
    async send(command, args) {
      calls.push({ command, args })
      if (command !== 'stop') return { ok: true }
      // An old daemon has no check at all: whatever reaches it is carried out.
      const refusal = args.reason === 'orphan'
        ? (caps.includes(ORPHAN_STOP_CAPABILITY) ? decide.orphanStopRefusal(String(args.sid), args.expectPid, args.home) : null)
        : (caps.includes(OWNER_HOME_CAPABILITY) ? decide.stopOwnerRefusal(String(args.sid), args) : null)
      if (refusal) return { ok: true, stopped: false, ...refusal }
      wouldStop.push(String(args.sid))
      return { ok: true, stopped: true }
    },
  }
}

const CURRENT_DAEMON = ['stop', 'status', ORPHAN_STOP_CAPABILITY, OWNER_HOME_CAPABILITY]
const OLD_DAEMON = ['stop', 'status']

/** The test server's copy of the production session, after recovery wrote the live pid back. */
async function recoveredCopy(): Promise<void> {
  await createSessionRecord(SID, 'task-copied', 'proj', undefined, { host: 'devbox' })
  await updateSessionRecord(SID, { process_status: 'idle', lastActiveAt: HOUR_AGO() })
  // The reconnect path's transport-fact patch: the pid the daemon's `status` reported.
  await updateSessionRecord(SID, { pid: PID } as never)
  expect((await getSessionByClaudeId(SID))?.pid).toBe(PID)
}

async function runEveryStopDecision(): Promise<void> {
  // Idle timeout with no live manager (the health monitor's owner stop).
  await stopThroughOwner({ claudeSessionId: SID, host: 'devbox' }, 'idle', 'idle_timeout')
  // Capacity eviction: the copy is the only idle session on the host.
  await checkSessionLimit('devbox', { devbox: 7 }, { max_idle: 1 })
  // The orphan sweep: the record says it was deliberately ended an hour ago.
  await updateSessionRecord(SID, { process_status: 'stopped', status_reason: 'idle_eviction', status_changed_by: 'system', last_status_change: HOUR_AGO() } as never)
  const row = await getSessionByClaudeId(SID)
  await sweepOrphansThroughOwner([row!], 'test')
  // Task completion (its owner stop is fire-and-forget).
  await updateSessionRecord(SID, { process_status: 'idle' })
  await completeTaskSessions([SID])
}

let signals: Array<[number, unknown]>

beforeEach(async () => {
  // A fresh store per test: the cases reuse session ids.
  closeDb()
  _resetSessionTrackerForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  state.ephemeral = true
  signals = []
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
    if (sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    signals.push([pid, sig])   // record, never deliver
    return true
  }) as typeof process.kill)
})

afterEach(async () => {
  expect(signals, 'no stop path may signal a pid').toEqual([])
  state.conn = null
  vi.restoreAllMocks()
  closeDb()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('a recovered production pid on an ephemeral server', () => {
  it('every stop decision reaches a current shared daemon named and strict, and every one is refused', async () => {
    const daemon = sharedDaemon(CURRENT_DAEMON)
    state.conn = daemon
    await recoveredCopy()

    await runEveryStopDecision()
    await vi.waitFor(() => expect(daemon.calls).toHaveLength(4))

    expect(daemon.wouldStop, 'the production session must never be stopped').toEqual([])
    const stops = daemon.calls.filter((c) => c.command === 'stop')
    expect(stops.map((c) => c.args.reason)).toEqual(['idle', 'idle', 'orphan', 'maintenance'])
    for (const call of stops) expect(call.args.home).toBe(WALNUT_HOME)
    for (const call of stops.filter((c) => c.args.reason !== 'orphan')) expect(call.args.strict).toBe(true)
  })

  it('the eviction keeps the refused session idle, with its pid', async () => {
    state.conn = sharedDaemon(CURRENT_DAEMON)
    await recoveredCopy()
    const result = await checkSessionLimit('devbox', { devbox: 7 }, { max_idle: 1 })
    expect(result.evicted).toBeUndefined()
    expect(await getSessionByClaudeId(SID)).toMatchObject({ process_status: 'idle', pid: PID })
  })

  it('a daemon without the ownership checks is sent nothing at all', async () => {
    const daemon = sharedDaemon(OLD_DAEMON)
    state.conn = daemon
    await recoveredCopy()

    await runEveryStopDecision()
    // Let the fire-and-forget completion stop settle before asserting silence.
    await new Promise((r) => setTimeout(r, 20))

    expect(daemon.calls).toEqual([])
    expect(daemon.wouldStop).toEqual([])
  })
})

describe('a recovered production pid on a second, non-ephemeral Walnut sharing the daemon', () => {
  it('its stops are refused too: the journal names production, not this Walnut', async () => {
    state.ephemeral = false
    const daemon = sharedDaemon(CURRENT_DAEMON)
    state.conn = daemon
    await recoveredCopy()

    await runEveryStopDecision()
    await vi.waitFor(() => expect(daemon.calls).toHaveLength(4))

    expect(daemon.wouldStop).toEqual([])
    for (const call of daemon.calls) {
      expect(call.args.home).toBe(WALNUT_HOME)
      expect(call.args).not.toHaveProperty('strict')
    }
  })
})
