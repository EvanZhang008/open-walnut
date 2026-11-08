import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAcpDaemon } from '../../src/providers/acp-daemon.js'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-stop-policy-'))
  vi.useFakeTimers()
  vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill)
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

function fixture(strict: boolean) {
  const daemon = createAcpDaemon<null>({
    daemonDir: path.join(dir, 'daemon'), streamsDir: path.join(dir, 'streams'),
    sendEvent: () => {}, isWsOpen: () => false, log: () => {}, strictStop: () => strict,
    setIntervalFn: (() => 0) as unknown as typeof setInterval,
  })
  const entry: any = {
    sid: 'fixture', state: 'running', stopping: false, aborting: false,
    proc: { pid: 4242, exitCode: null, stdin: { write: (line: string) => {
      const frame = JSON.parse(line)
      const pending = entry.pendingRpc.get(frame.id)
      clearTimeout(pending.timer)
      entry.pendingRpc.delete(frame.id)
      pending.resolve({ id: frame.id, ok: true, result: {} })
    } } },
    journalPath: path.join(dir, 'journal'), pushOffset: 0, subscribers: new Set(),
    pendingRpc: new Map(), nextRpcId: 0, lastActivity: 0,
    terminalVersion: 0, activeCommandId: null, activeControlCommandId: null,
    cmd: 'fixture-worker', adapter: 'fixture-adapter',
  }
  daemon.workers.set('fixture', entry)
  return { daemon, entry }
}

describe('ACP ordinary and Demo stop policy', () => {
  it('retains the ordinary owned-worker timeout cleanup', async () => {
    const { daemon } = fixture(false)
    await daemon.acpStop('fixture')
    expect(process.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(6000)
    expect(process.kill).toHaveBeenCalledWith(-4242, 'SIGKILL')
    expect(daemon.hasWorker('fixture')).toBe(false)
    expect(daemon.listWorkers()).toEqual([])
  })

  it('never signals a replaced ordinary worker from an old stop timer', async () => {
    const { daemon, entry } = fixture(false)
    await daemon.acpStop('fixture')
    daemon.workers.set('fixture', { ...entry, proc: { ...entry.proc, pid: 4243 } })
    await vi.advanceTimersByTimeAsync(6000)
    expect(process.kill).not.toHaveBeenCalled()
    expect(daemon.hasWorker('fixture')).toBe(true)
  })

  it('Demo refuses a surviving group without adding a force signal', async () => {
    const { daemon } = fixture(true)
    const result = daemon.acpStop('fixture')
    const rejected = expect(result).rejects.toThrow(/process group has not exited/)
    await vi.advanceTimersByTimeAsync(6100)
    await rejected
    expect(vi.mocked(process.kill).mock.calls.every(([, signal]) => signal === 0)).toBe(true)
    expect(daemon.hasWorker('fixture')).toBe(true)
  })
})
