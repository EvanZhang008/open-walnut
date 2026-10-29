/**
 * boundedExecFile: an execFile that settles at its deadline even when the child
 * does not exit.
 *
 * Incident 2026-10-29: on a Mac at load 500+, every `ps` hung for about 17
 * minutes. execFile's `timeout` only sends a signal and calls back once the child
 * is gone, so each daemon start waited on the cli-owner `ps` scan that long and
 * every session start on the host hit the server's 30 s start deadline.
 *
 * MACHINE SAFETY: the only processes spawned are `/bin/sh` children of this test,
 * and the only signals sent are to those pids.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { boundedExecFile, createAsyncStartTimeReader } from '../../src/providers/daemon-core.js'

type Opts = { encoding: 'utf-8'; timeout: number }
const spawned = new Set<number>()

/** Real execFile with string stdout, remembering every child it started. */
const realExec = (file: string, args: string[], options: Opts, cb: (e: Error | null, stdout: string) => void) => {
  const child = execFile(file, args, options, (error, stdout) => cb(error, String(stdout ?? '')))
  if (child.pid) spawned.add(child.pid)
  return child
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (!alive(pid)) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return !alive(pid)
}

afterEach(() => {
  for (const pid of spawned) if (pid > 1 && alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  spawned.clear()
  vi.useRealTimers()
})

describe('boundedExecFile on real children', () => {
  it('a child that ignores SIGTERM settles at the deadline as a timeout, and is killed', async () => {
    const deadline = 300
    const started = Date.now()
    // `exec` keeps one process: sleep inherits the ignored SIGTERM.
    const result = await boundedExecFile(realExec, '/bin/sh', ['-c', "trap '' TERM; exec sleep 5"], { encoding: 'utf-8', timeout: deadline })
    const took = Date.now() - started
    expect(took).toBeLessThan(2 * deadline)
    expect(result.timedOut).toBe(true)
    expect(result.stdout).toBe('')
    expect(result.error?.killed).toBe(true)
    expect(result.error?.code).not.toBe(1)
    const [pid] = [...spawned]
    expect(pid).toBeGreaterThan(1)
    expect(await waitGone(pid!, 2000)).toBe(true)
  })

  it('a fast child returns its stdout', async () => {
    const result = await boundedExecFile(realExec, '/bin/sh', ['-c', 'printf hello'], { encoding: 'utf-8', timeout: 5000 })
    expect(result).toEqual({ error: null, stdout: 'hello', timedOut: false })
  })

  it('exit 1 with output keeps what the cli-owner exec reads as a table (ps naming a gone pid)', async () => {
    const result = await boundedExecFile(realExec, '/bin/sh', ['-c', 'printf "123 456 claude\\n"; exit 1'], { encoding: 'utf-8', timeout: 5000 })
    expect(result.timedOut).toBe(false)
    expect(result.stdout).toBe('123 456 claude\n')
    expect(result.error?.code).toBe(1)
    expect(result.error?.killed).toBeFalsy()
    expect(result.error?.signal).toBeFalsy()
  })

  it('a missing executable resolves as a failure, never throws', async () => {
    const result = await boundedExecFile(realExec, '/nonexistent/walnut-no-such-ps', [], { encoding: 'utf-8', timeout: 5000 })
    expect(result.timedOut).toBe(false)
    expect(result.error).toBeTruthy()
    expect(result.stdout).toBe('')
  })
})

describe('boundedExecFile contract (stand-in execFile)', () => {
  it('settles once: a late callback after the deadline is ignored, and the child gets SIGKILL', async () => {
    vi.useFakeTimers()
    const kill = vi.fn()
    let callback: ((e: Error | null, stdout: string) => void) | null = null
    const pending = boundedExecFile((_f, _a, _o: { timeout: number }, cb) => { callback = cb; return { kill } }, 'ps', [], { timeout: 100 })
    await vi.advanceTimersByTimeAsync(100)
    const result = await pending
    expect(result.timedOut).toBe(true)
    expect(kill).toHaveBeenCalledTimes(1)
    expect(kill).toHaveBeenCalledWith('SIGKILL')
    callback!(null, 'late table')
    expect(await pending).toBe(result)
  })

  it('a normal exit clears the deadline: the child is never signalled', async () => {
    vi.useFakeTimers()
    const kill = vi.fn()
    const pending = boundedExecFile((_f, _a, _o: { timeout: number }, cb) => { setTimeout(() => cb(null, 'ok'), 10); return { kill } }, 'ps', [], { timeout: 100 })
    await vi.advanceTimersByTimeAsync(10)
    const result = await pending
    expect(result).toEqual({ error: null, stdout: 'ok', timedOut: false })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(kill).not.toHaveBeenCalled()
  })

  it('a spawn that throws resolves as a failure', async () => {
    const result = await boundedExecFile(() => { throw new Error('EAGAIN') }, 'ps', [], { timeout: 100 })
    expect(result).toMatchObject({ stdout: '', timedOut: false })
    expect(result.error?.message).toBe('EAGAIN')
  })
})

describe('createAsyncStartTimeReader with a ps that never exits', () => {
  it('answers null at the 5 s deadline instead of holding its waiters', async () => {
    vi.useFakeTimers()
    const kill = vi.fn()
    const noProcFs = { readFileSync: () => { throw new Error('ENOENT') }, existsSync: () => false } as unknown as typeof fs
    const read = createAsyncStartTimeReader({ fs: noProcFs, batchWindowMs: 0, execFileFn: () => ({ kill }) })
    let answer: string | null | undefined
    const pending = read(4300).then((v) => { answer = v })
    await vi.advanceTimersByTimeAsync(4900)
    expect(answer).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    await pending
    expect(answer).toBeNull()
    expect(kill).toHaveBeenCalledWith('SIGKILL')
  })
})
