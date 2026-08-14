/**
 * Shared fixtures + deps builder for daemon-core unit tests.
 *
 * All L1 tests use vitest fake timers and an in-memory fs via memfs-style
 * indirection: we point streamsDir/registryFile at a real tmp dir per test.
 * The kill / readStartTime / broadcast fns are vi.fn() spies the test can
 * configure per case.
 */

import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { vi } from 'vitest'
import {
  createDaemonCore,
  type CoreSessionData,
  type DaemonCoreDeps,
  type RegistryEntry,
} from '../../src/providers/daemon-core.js'

/**
 * Extends CoreSessionData with the `watchers` map so tests can assert on
 * legacy exit fan-out without pulling Bun's ServerWebSocket type in.
 */
export interface TestSession extends CoreSessionData {
  watchers: Map<unknown, unknown>
}

export function makeTestSession(overrides: Partial<TestSession> = {}): TestSession {
  return {
    pipePath: '/tmp/test/fifo-x.pipe',
    jsonlPath: '/tmp/test/jsonl-x',
    pgidPath: '/tmp/test/pgid-x',
    pid: 1234,
    state: 'running',
    exitCode: null,
    exitReason: null,
    exitedAt: null,
    parented: true,
    startTime: '12345',
    cwd: '/tmp/test',
    args: ['claude', '-p'],
    orphanPollTimer: null,
    watchers: new Map(),
    ...overrides,
  }
}

export function makeRegistryEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    pid: 1234,
    startTime: '12345',
    pipePath: '/tmp/test/fifo-x.pipe',
    jsonlPath: '/tmp/test/jsonl-x',
    pgidPath: '/tmp/test/pgid-x',
    cwd: '/tmp/test',
    args: ['claude', '-p'],
    spawnedAt: '2026-01-01T00:00:00.000Z',
    parented: true,
    ...overrides,
  }
}

/**
 * Build a full deps bundle backed by real temp dir + spy functions.
 * Returns both the deps and the bag of spies so tests can introspect.
 */
export async function buildDeps(opts: {
  tmpDir?: string
  killImpl?: (pid: number, sig: number | string) => void
  readStartTimeImpl?: (pid: number) => string | null
  killProcessGroupImpl?: (pid: number, signal: string) => boolean
  clockImpl?: () => number
  orphanPollIntervalMs?: number
  fifoWriteDeadlineMs?: number
} = {}): Promise<{
  deps: DaemonCoreDeps<TestSession>
  sessions: Map<string, TestSession>
  spies: {
    killFn: ReturnType<typeof vi.fn>
    readStartTimeFn: ReturnType<typeof vi.fn>
    killProcessGroupFn: ReturnType<typeof vi.fn>
    broadcastSessionStateFn: ReturnType<typeof vi.fn>
    broadcastExitToWatchersFn: ReturnType<typeof vi.fn>
    logger: ReturnType<typeof vi.fn>
    setIntervalFn: ReturnType<typeof vi.fn>
    clearIntervalFn: ReturnType<typeof vi.fn>
    setTimeoutFn: ReturnType<typeof vi.fn>
  }
  tmpDir: string
  registryFile: string
  streamsDir: string
  cleanup: () => Promise<void>
}> {
  const tmpDir = opts.tmpDir
    ?? (await fsp.mkdtemp(path.join(os.tmpdir(), 'daemon-core-test-')))
  const streamsDir = path.join(tmpDir, 'streams')
  const registryFile = path.join(tmpDir, 'sessions.json')
  await fsp.mkdir(streamsDir, { recursive: true })

  const killFn = vi.fn(opts.killImpl ?? (() => {}))
  const readStartTimeFn = vi.fn(opts.readStartTimeImpl ?? (() => null))
  const killProcessGroupFn = vi.fn(opts.killProcessGroupImpl ?? (() => true))
  const broadcastSessionStateFn = vi.fn()
  const broadcastExitToWatchersFn = vi.fn()
  const logger = vi.fn()

  // Use real setInterval/clearInterval/setTimeout so vitest's fake timers can
  // actually drive them. Wrap in vi.fn so tests can assert call counts.
  const setIntervalFn = vi.fn((cb: () => void, ms: number) => setInterval(cb, ms))
  const clearIntervalFn = vi.fn((t: unknown) => clearInterval(t as NodeJS.Timeout))
  const setTimeoutFn = vi.fn((cb: () => void, ms: number) => setTimeout(cb, ms))

  const sessions = new Map<string, TestSession>()

  const deps: DaemonCoreDeps<TestSession> = {
    fs,
    clock: opts.clockImpl ?? (() => Date.now()),
    killFn,
    readStartTimeFn,
    killProcessGroupFn,
    setIntervalFn: setIntervalFn as unknown as typeof setInterval,
    clearIntervalFn: clearIntervalFn as unknown as typeof clearInterval,
    setTimeoutFn: setTimeoutFn as unknown as typeof setTimeout,
    streamsDir,
    registryFile,
    orphanPollIntervalMs: opts.orphanPollIntervalMs ?? 1000,
    fifoWriteDeadlineMs: opts.fifoWriteDeadlineMs,
    logger,
    broadcastSessionStateFn,
    broadcastExitToWatchersFn,
    sessions,
    createAdoptedSession: (_sid, entry) => makeTestSession({
      pipePath: entry.pipePath,
      jsonlPath: entry.jsonlPath,
      pgidPath: entry.pgidPath,
      pid: entry.pid,
      parented: false,
      startTime: entry.startTime,
      cwd: entry.cwd,
      args: entry.args,
      orphanPollTimer: null,
    }),
  }

  return {
    deps,
    sessions,
    spies: {
      killFn,
      readStartTimeFn,
      killProcessGroupFn,
      broadcastSessionStateFn,
      broadcastExitToWatchersFn,
      logger,
      setIntervalFn,
      clearIntervalFn,
      setTimeoutFn,
    },
    tmpDir,
    registryFile,
    streamsDir,
    cleanup: async () => {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    },
  }
}

/** kill(pid, sig) impl that throws ESRCH on specified pids. */
export function killWithDead(deadPids: Set<number>) {
  return (pid: number, _sig: number | string) => {
    if (deadPids.has(pid)) {
      const err = new Error('kill ESRCH') as NodeJS.ErrnoException
      err.code = 'ESRCH'
      throw err
    }
  }
}

/** kill(pid, sig) impl that throws EPERM on specified pids. */
export function killWithEperm(epermPids: Set<number>) {
  return (pid: number, _sig: number | string) => {
    if (epermPids.has(pid)) {
      const err = new Error('kill EPERM') as NodeJS.ErrnoException
      err.code = 'EPERM'
      throw err
    }
  }
}

export { createDaemonCore }
