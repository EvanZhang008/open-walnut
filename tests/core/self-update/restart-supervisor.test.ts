/**
 * The restart loop (src/core/self-update/restart-supervisor.ts): a supervised
 * child that exits 75 is started again, as many times as it asks and never
 * after a person stopped it; a child no looping parent started never exits 75.
 * The main case spawns a real child (tests/fixtures/self-update/restart-child.mjs)
 * through reexecSelf, the same spawn the parent uses.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-restart-supervisor'))

import {
  RESTART_EXIT_CODE, RESTART_SUPERVISED_ENV, loopCurrent, superviseFromStart, superviseRestarts, takeRestartSupervised, type SignalRecorder, type SuperviseDeps,
} from '../../../src/core/self-update/restart-supervisor.js'
import { updateOnStart, type StartupUpdateDeps } from '../../../src/core/self-update/startup-update.js'
import type { UpdateStatus } from '../../../src/core/self-update/update-check.js'
import { APPLIED_ENV, reexecSelf, type ReexecResult } from '../../../src/core/self-update/startup-relaunch.js'
import type { InstallInfo } from '../../../src/core/self-update/install-kind.js'

const CHILD = path.resolve(import.meta.dirname, '../../fixtures/self-update/restart-child.mjs')
const install = { relaunch: [process.execPath, CHILD], binary: null } as unknown as InstallInfo
const noSignal: SignalRecorder = { received: () => null, done: () => {} }
const continueOutcome = async () => ({ kind: 'continue' as const, decision: { action: 'skip' as const, reason: 'current' as const } })

let dir: string
let log: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-supervisor-'))
  log = path.join(dir, 'runs.jsonl')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const runs = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { supervised: string | null; applied: string | null })

describe('superviseRestarts with a real child', () => {
  it('a supervised child that exits 75 once is started again once, supervised, and its 0 ends the loop', async () => {
    const env = { ...process.env, [RESTART_SUPERVISED_ENV]: '1', RESTART_CHILD_LOG: log }
    delete env[APPLIED_ENV]
    const first = await reexecSelf(env, install)
    expect(first.exitCode).toBe(RESTART_EXIT_CODE)
    const update = vi.fn(continueOutcome)
    const code = await superviseRestarts(first.exitCode, {
      update, start: (e) => reexecSelf(e, install), env, signals: noSignal, err: () => {},
    })
    expect(code).toBe(0)
    expect(update).toHaveBeenCalledTimes(1)
    expect(runs()).toEqual([
      { supervised: '1', applied: null },
      { supervised: '1', applied: '1' }, // started again without asking the registry
    ])
  }, 30_000)

  it('a child an older parent started (no marker) never exits 75, so nothing restarts it', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, RESTART_CHILD_LOG: log }
    delete env[RESTART_SUPERVISED_ENV]
    const first = await reexecSelf(env, install)
    expect(first.exitCode).toBe(0)
    const update = vi.fn(continueOutcome)
    const start = vi.fn(async () => ({ exitCode: 0, served: true, stopped: false, ms: 1 }))
    expect(await superviseRestarts(first.exitCode, { update, start, env, signals: noSignal, err: () => {} })).toBe(0)
    expect(update).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(runs()).toEqual([{ supervised: null, applied: null }])
  }, 30_000)
})

describe('superviseFromStart with a real child (a walnut web whose install can live-update)', () => {
  it('serves nothing itself: its first child is supervised and applied; exit 75 starts a new child; the outer ready file is told', async () => {
    const env = { ...process.env, [RESTART_SUPERVISED_ENV]: '1', RESTART_CHILD_LOG: log }
    delete env[APPLIED_ENV]
    const outerReady = path.join(dir, 'outer-ready')
    const update = vi.fn(continueOutcome)
    const code = await superviseFromStart({
      update, start: (e, readyAlso) => reexecSelf(e, install, { readyAlso }), env, signals: noSignal, err: () => {},
    }, outerReady)
    expect(code).toBe(0)
    expect(update).toHaveBeenCalledTimes(1)
    expect(runs()).toEqual([
      { supervised: '1', applied: '1' }, // the startup update already ran in the supervisor
      { supervised: '1', applied: '1' },
    ])
    // An older thin parent above the supervisor learns that the server listened.
    expect(fs.existsSync(outerReady)).toBe(true)
  }, 30_000)

  it('a signal before the first child starts nothing', async () => {
    const start = vi.fn(async () => ({ exitCode: 0, served: true, stopped: false, ms: 1 }))
    const code = await superviseFromStart({
      update: continueOutcome, start, env: {}, signals: { received: () => 'SIGTERM', done: () => {} }, err: () => {},
    })
    expect(code).toBe(143)
    expect(start).not.toHaveBeenCalled()
  })
})

describe('superviseRestarts', () => {
  const exited = (code: number): ReexecResult => ({ exitCode: code, served: true, stopped: false, ms: 1000 })
  const deps = (o: Partial<SuperviseDeps>): SuperviseDeps => ({
    update: continueOutcome, start: async () => exited(0), env: { [RESTART_SUPERVISED_ENV]: '1' }, signals: noSignal, err: () => {}, ...o,
  })

  it('the startup path may start the new version itself (watched): its exit code is the loop\'s', async () => {
    const start = vi.fn(async () => exited(0))
    const update = vi.fn()
      .mockResolvedValueOnce({ kind: 'reexeced', version: '0.6.0', exitCode: RESTART_EXIT_CODE })
      .mockResolvedValueOnce({ kind: 'reexeced', version: '0.6.1', exitCode: 3 })
    expect(await superviseRestarts(RESTART_EXIT_CODE, deps({ update, start }))).toBe(3)
    expect(update).toHaveBeenCalledTimes(2)
    expect(start).not.toHaveBeenCalled()
  })

  it('the child env carries the marker and APPLIED; a signal while it ran ends the loop, a 75 then reads as 0', async () => {
    let got: NodeJS.Signals | null = null
    const envs: Array<Record<string, string | undefined>> = []
    const start = vi.fn(async (e: Record<string, string | undefined>) => { envs.push(e); got = 'SIGTERM'; return exited(RESTART_EXIT_CODE) })
    const code = await superviseRestarts(RESTART_EXIT_CODE, deps({ start, signals: { received: () => got, done: () => {} } }))
    expect(code).toBe(0)
    expect(start).toHaveBeenCalledTimes(1)
    expect(envs[0]).toMatchObject({ [RESTART_SUPERVISED_ENV]: '1', [APPLIED_ENV]: '1' })
  })

  it('a signal between children starts nothing; a stop during the update ends with the signal\'s code', async () => {
    const start = vi.fn(async () => exited(0))
    expect(await superviseRestarts(RESTART_EXIT_CODE, deps({ start, signals: { received: () => 'SIGINT', done: () => {} } }))).toBe(130)
    expect(start).not.toHaveBeenCalled()
    const stopped = vi.fn(async () => ({ kind: 'stopped' as const, signal: 'SIGTERM' as const }))
    expect(await superviseRestarts(RESTART_EXIT_CODE, deps({ update: stopped, start }))).toBe(143)
    expect(start).not.toHaveBeenCalled()
  })

  it('a child that asks for ever stops after 5 restarts in 10 minutes', async () => {
    const start = vi.fn(async () => exited(RESTART_EXIT_CODE))
    const lines: string[] = []
    expect(await superviseRestarts(RESTART_EXIT_CODE, deps({ start, err: (l) => lines.push(l), now: () => 1_000 }))).toBe(1)
    expect(start).toHaveBeenCalledTimes(5)
    expect(lines.at(-1)).toMatch(/not starting it again/)
  })
})

describe('takeRestartSupervised', () => {
  it('reads the marker and removes it, so no session or child inherits it', () => {
    const env: NodeJS.ProcessEnv = { [RESTART_SUPERVISED_ENV]: '1' }
    expect(takeRestartSupervised(env)).toBe(true)
    expect(env[RESTART_SUPERVISED_ENV]).toBeUndefined()
    expect(takeRestartSupervised(env)).toBe(false)
    expect(takeRestartSupervised({ [RESTART_SUPERVISED_ENV]: '0' })).toBe(false)
  })
})

describe('the loop through the startup path (a parent older than the install)', () => {
  // What the parent's checker reports once it knows the install runs 0.6.0 (loopCurrent).
  const STATUS: UpdateStatus = {
    enabled: true,
    install: { kind: 'binary', sourceDir: null, packageRoot: null, manager: null, updateCommand: 'walnut update', binary: { root: '/opt/w', target: 'linux-x64', version: '0.5.1' } },
    current: '0.6.0', channel: 'stable', latest: '0.6.0', tags: { latest: '0.6.0', nightly: null }, available: false,
    checkedAt: '2026-11-03T10:00:00.000Z', error: null, checking: false, packageUrl: '',
  }
  const exited = (exitCode: number, served: boolean): ReexecResult => ({ exitCode, served, stopped: false, ms: 1000 })

  function startupDeps(o: Partial<StartupUpdateDeps> = {}) {
    const calls = { reexec: [] as Array<Record<string, string | undefined>>, rollBack: [] as string[][], marked: [] as unknown[] }
    const results = [exited(1, false), exited(0, true)]
    const deps: StartupUpdateDeps = {
      checkNow: async () => STATUS,
      configAuto: async () => undefined,
      env: { [RESTART_SUPERVISED_ENV]: '1' },
      writable: () => true,
      run: async () => 0,
      unverified: async () => ({ version: '0.6.0', from: '0.5.1' }),
      markUnverified: (p) => { calls.marked.push(p) },
      reexec: async (env) => { calls.reexec.push(env); return results.shift()! },
      rollBack: async (_s, from, to) => { calls.rollBack.push([from, to]) },
      err: () => {},
      ...o,
    }
    return { deps, calls }
  }

  it('the live install\'s record: its first start is watched, a failed start rolls back, the version before runs', async () => {
    const { deps, calls } = startupDeps()
    const code = await superviseRestarts(RESTART_EXIT_CODE, {
      update: () => updateOnStart(deps), start: async () => exited(0, true), env: deps.env, signals: noSignal, err: () => {},
    })
    expect(code).toBe(0)
    expect(calls.marked).toEqual([null]) // the record is taken: this start is the one it named
    expect(calls.rollBack).toEqual([['0.5.1', '0.6.0']])
    expect(calls.reexec).toHaveLength(2)
    expect(calls.reexec[0]).toMatchObject({ [RESTART_SUPERVISED_ENV]: '1', [APPLIED_ENV]: '1' })
  })

  it('a signal during the update step starts nothing, and the loop ends with its code', async () => {
    let got: NodeJS.Signals | null = null
    const { deps, calls } = startupDeps({ checkNow: async () => { got = 'SIGTERM'; return STATUS }, stopSignal: () => got })
    const start = vi.fn(async () => exited(0, true))
    const code = await superviseRestarts(RESTART_EXIT_CODE, {
      update: () => updateOnStart(deps), start, env: deps.env, signals: { received: () => got, done: () => {} }, err: () => {},
    })
    expect(code).toBe(143)
    expect(calls.reexec).toEqual([])
    expect(start).not.toHaveBeenCalled()
  })

  it('loopCurrent: the relaunch\'s word, else the recorded version, never the parent\'s own', () => {
    const valid = (v: string) => /^\d+\.\d+\.\d+/.test(v)
    expect(loopCurrent('0.6.0 (abc)', { version: '0.6.0' }, valid)).toBe('0.6.0')
    expect(loopCurrent(null, { version: '0.6.0' }, valid)).toBe('0.6.0')
    expect(loopCurrent('garbage', { version: '0.6.0' }, valid)).toBe('0.6.0')
    expect(loopCurrent(null, null, valid)).toBeUndefined()
  })
})
