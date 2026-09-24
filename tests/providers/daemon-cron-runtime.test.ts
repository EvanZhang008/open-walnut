import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { createDaemonCronRuntime, DaemonSessionGate, type CronRuntimeSession } from '../../src/providers/daemon-cron-runtime.js'

const sid = '11111111-2222-4333-8444-555555555555'
const otherSid = '11111111-2222-4333-8444-555555555556'
let home: string
let now: number
let boot: string
let live: Map<number, string>
let runtimes: Array<Awaited<ReturnType<typeof createDaemonCronRuntime>>>

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-cron-runtime-'))
  now = Date.now()
  boot = 'boot-a'
  live = new Map([[200, '100']])
  runtimes = []
  const readFile = fs.readFile.bind(fs)
  vi.spyOn(fs, 'readFile').mockImplementation(((target: unknown, options: unknown) => {
    if (String(target) === '/proc/sys/kernel/random/boot_id') return Promise.resolve(boot)
    if (String(target).startsWith('/proc/')) {
      const pid = Number(String(target).split('/')[2])
      const start = live.get(pid)
      if (!start) return Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))
      return Promise.resolve(`${pid} (cli) S ${Array(18).fill('0').join(' ')} ${start} 0\n`)
    }
    return readFile(target as string, options as never)
  }) as typeof fs.readFile)
  execFileMock.mockImplementation((_program, _args, _options, callback) => callback(null, '2.1.258 (Claude Code)\n', ''))
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  vi.spyOn(Math, 'random').mockReturnValue(0)
})

afterEach(async () => {
  await Promise.all(runtimes.map((runtime) => runtime.close()))
  vi.restoreAllMocks()
  execFileMock.mockReset()
  await fs.rm(home, { recursive: true, force: true })
})

async function seed(id = sid) {
  const cwd = path.join(home, 'workspace')
  await fs.mkdir(cwd, { recursive: true })
  const project = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  await fs.mkdir(project, { recursive: true })
  const transcript = path.join(project, `${id}.jsonl`)
  await fs.writeFile(transcript, [
    { type: 'assistant', uuid: 'a', parentUuid: null, timestamp: new Date(now).toISOString(), message: { content: [{ type: 'tool_use', name: 'CronCreate', id: 'tool', input: { cron: '* * * * *', prompt: 'Example' } }] } },
    { type: 'user', uuid: 'b', parentUuid: 'a', timestamp: new Date(now + 1).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'tool' }] }, toolUseResult: { id: '1234abcd', durable: false, recurring: true } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n')
  const session: CronRuntimeSession = {
    sid: id, pid: 200, startTime: '100', bootId: 'boot-a', cwd,
    args: ['claude', '-p', '--session-id', id, '--permission-mode', 'default'],
    mode: 'default', cliVersion: '2.1.258', cronCandidate: true,
  }
  return { session, transcript }
}

async function lab(sessions: CronRuntimeSession[], hooks: () => string | null | undefined = () => null) {
  const start = vi.fn(async (id, launch, current) => {
    if (!current()) throw new Error('superseded')
    const original = sessions.find((session) => session.sid === id)
    const result = { pid: 300, startTime: '200' }
    live.set(300, '200')
    const replacement = { ...original!, ...result, bootId: boot, args: launch.args, cronCandidate: true }
    if (original) Object.assign(original, replacement)
    return result
  })
  const changed = vi.fn()
  const gate = new DaemonSessionGate()
  const runtime = await createDaemonCronRuntime({
    home, platform: 'linux', env: {}, stateDir: path.join(home, 'state'), gate,
    sessions: () => sessions, hooksHash: hooks, start, changed, error: vi.fn(),
  })
  runtimes.push(runtime)
  return { runtime, start, changed, gate }
}

describe('daemon cron runtime with real transcript and durable state', () => {
  it('registers only active session-only cron and resumes without a user message', async () => {
    const { session, transcript } = await seed()
    const before = await fs.readFile(transcript)
    const l = await lab([session])
    await l.runtime.tick()
    expect(l.runtime.get(sid)).toMatchObject({ enabled: true, state: 'checking' })
    expect(l.start).not.toHaveBeenCalled()
    live.delete(200)
    await l.runtime.tick()
    now += 5000
    await Promise.all(Array.from({ length: 25 }, () => l.runtime.tick()))
    expect(l.start).toHaveBeenCalledTimes(1)
    expect(l.start.mock.calls[0][1].args).toEqual(['claude', '-p', '--permission-mode', 'default', '--resume', sid])
    expect(l.runtime.get(sid)).toMatchObject({ process: { pid: 300 }, reason: 'scheduler-unconfirmed' })
    expect(await fs.readFile(transcript)).toEqual(before)
  })

  it('finds a cron whose process exited before its first supervision scan', async () => {
    const { session } = await seed()
    live.delete(200)
    const l = await lab([session])
    await l.runtime.tick()
    expect(l.runtime.get(sid)?.retryAt).toBe(now + 5000)
    now += 5000
    await l.runtime.tick()
    expect(l.start).toHaveBeenCalledTimes(1)
  })

  it('restores persisted supervision after a reboot without a runtime registry', async () => {
    const { session } = await seed()
    const first = await lab([session])
    await first.runtime.tick()
    await first.runtime.close()
    boot = 'boot-b'
    live.clear()
    const second = await lab([])
    await second.runtime.tick()
    now += 5000
    await second.runtime.tick()
    expect(second.start).toHaveBeenCalledTimes(1)
    expect(second.runtime.get(sid)?.process?.bootId).toBe('boot-b')
  })

  it('keeps the stop fence across daemon restart and requires the new request id for delivery', async () => {
    const { session } = await seed()
    const first = await lab([session])
    await first.runtime.tick()
    const stopId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const stopping = first.runtime.disable(sid, stopId)
    expect(first.runtime.deliveryAllowed(sid, null)).toBe(false)
    await stopping
    await first.runtime.close()
    const second = await lab([session])
    expect(second.runtime.deliveryAllowed(sid, null)).toBe(false)
    expect(second.runtime.deliveryAllowed(sid, 'older-request')).toBe(false)
    expect(second.runtime.deliveryAllowed(sid, stopId)).toBe(true)
    await expect(second.runtime.enable(sid)).rejects.toThrow('superseded by a stop')
    await second.runtime.enable(sid, stopId)
    expect(second.runtime.deliveryAllowed(sid, null)).toBe(false)
  })

  it('drains a tick waiting on the native gate without letting an old resume reopen a newer pause', async () => {
    const { session } = await seed()
    const l = await lab([session])
    await l.runtime.tick()
    let release!: () => void
    const gateWork = l.gate.run(sid, () => new Promise<void>((resolve) => { release = resolve }))
    await Promise.resolve()
    await Promise.resolve()
    const tick = l.runtime.tick()
    const pause = l.runtime.pause()
    let drained = false
    const waiting = pause.drained.then(() => { drained = true })
    await l.runtime.tick()
    expect(drained).toBe(false)
    pause.resume()
    expect(l.runtime.tick()).toBe(tick)
    const again = l.runtime.pause()
    pause.resume()
    expect(() => l.runtime.pause()).toThrow('already stopping')
    release()
    await Promise.all([gateWork, tick, waiting, again.drained])
    expect(l.start).not.toHaveBeenCalled()
    await l.runtime.close()
    again.resume()
    live.delete(200)
    now += 60000
    await l.runtime.tick()
    expect(l.start).not.toHaveBeenCalled()
  })

  it('resumes registration and recovery after a cancelled pause while keeping explicit stops', async () => {
    const { session } = await seed()
    const l = await lab([session])
    const paused = l.runtime.pause()
    await paused.drained
    await l.runtime.tick()
    expect(l.runtime.list()).toEqual([])
    paused.resume()
    await l.runtime.tick()
    expect(l.runtime.get(sid)?.enabled).toBe(true)
    live.delete(200)
    await l.runtime.tick()
    now += 5000
    const again = l.runtime.pause()
    await again.drained
    await l.runtime.tick()
    expect(l.start).not.toHaveBeenCalled()
    again.resume()
    await l.runtime.tick()
    expect(l.start).toHaveBeenCalledTimes(1)
    const stopped = l.runtime.pause()
    await l.runtime.disable(sid, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    stopped.resume()
    live.clear()
    now += 60000
    await l.runtime.tick()
    expect(l.runtime.get(sid)).toMatchObject({ enabled: false, stopRequestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' })
    expect(l.start).toHaveBeenCalledTimes(1)
  })

  it('does not revive a stopped record after reboot or ordinary registration', async () => {
    const { session } = await seed()
    const first = await lab([session])
    await first.runtime.tick()
    await first.runtime.disable(sid)
    await first.runtime.close()
    boot = 'boot-b'
    live.clear()
    const second = await lab([session])
    now += 60000
    await second.runtime.tick()
    expect(second.start).not.toHaveBeenCalled()
    expect(second.runtime.get(sid)).toMatchObject({ enabled: false, state: 'disabled' })
  })

  it('does not treat stale stream cron candidates as canonical active jobs', async () => {
    const { session, transcript } = await seed()
    const second = await seed(otherSid)
    await fs.appendFile(transcript, JSON.stringify({ type: 'assistant', uuid: 'delete', parentUuid: 'b', timestamp: new Date(now + 2000).toISOString(), message: { content: [{ type: 'tool_use', name: 'CronDelete', input: { id: '1234abcd' } }] } }) + '\n')
    const l = await lab([session, { ...second.session, cliVersion: '2.1.999' }])
    await l.runtime.tick()
    expect(l.runtime.list()).toEqual([])
    expect(l.start).not.toHaveBeenCalled()
  })

  it('waits for hook policy persistence before registering an active cron', async () => {
    const { session } = await seed()
    let hooks: string | null | undefined
    const l = await lab([session], () => hooks)
    await l.runtime.tick()
    expect(l.runtime.get(sid)).toBeNull()
    expect(l.start).not.toHaveBeenCalled()
    hooks = 'persisted-session-only'
    await l.runtime.tick()
    expect(l.runtime.get(sid)).toMatchObject({ enabled: true, launch: { hooksHash: hooks } })
  })

  it('blocks recovery if the previously required hook policy disappears', async () => {
    const { session } = await seed()
    let hooks: string | null = 'rules-1'
    const l = await lab([session], () => hooks)
    await l.runtime.tick()
    live.delete(200)
    hooks = null
    await l.runtime.tick()
    expect(l.runtime.get(sid)).toMatchObject({ state: 'blocked', reason: 'hooks-unavailable', launch: { hooksHash: 'rules-1' } })
    now += 60000
    await l.runtime.tick()
    expect(l.start).not.toHaveBeenCalled()
  })
})
