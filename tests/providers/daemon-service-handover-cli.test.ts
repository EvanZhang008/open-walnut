import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handoverBusy, requestDaemonServiceHandover, requestDaemonServiceUpdate, requestRunningDaemonHandover } from '../../src/providers/daemon-service-cli.js'
import { DaemonServiceHandoverPendingError, DaemonServiceUpdateRefusedError } from '../../src/providers/daemon-service-manager.js'

let runtime: string
let state: string
let server: WebSocketServer | undefined
let alive: boolean
let frames: Record<string, unknown>[]
let errors: unknown[]
let kill: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    expect(pid).toBe(4242)
    expect(signal).toBe(0)
    if (!alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    return true
  })
  alive = true
  frames = []
  errors = []
  runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-handover-rpc-test-'))
  state = path.join(runtime, 'service')
  await fs.mkdir(state, { mode: 0o700 })
})

afterEach(async () => {
  if (server) {
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
  }
  vi.restoreAllMocks()
  await fs.rm(runtime, { recursive: true, force: true })
  expect(errors).toEqual([])
})

async function setup(reply: (frame: Record<string, unknown>, socket: WebSocket) => unknown) {
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => server!.once('listening', resolve))
  await Promise.all([
    fs.writeFile(path.join(runtime, 'daemon.pid'), '4242'),
    fs.writeFile(path.join(runtime, 'daemon.instance'), 'old-instance'),
    fs.writeFile(path.join(runtime, 'daemon.port'), String((server.address() as { port: number }).port)),
  ])
  server.on('connection', (socket) => socket.on('message', (raw) => {
    void (async () => {
      const frame = JSON.parse(String(raw))
      frames.push(frame)
      const value = await reply(frame, socket)
      if (value !== undefined) socket.send(JSON.stringify({ id: frame.id, ...value as object }))
    })().catch((error) => { errors.push(error); socket.terminate() })
  }))
}

const hello = () => ({ ok: true, instanceId: 'old-instance', capabilities: ['service-handover-v1'], cronSupervision: { managed: false } })

describe('managed daemon update transport', () => {
  const update = () => requestRunningDaemonHandover(runtime, state, false, true)
  const managedHello = () => ({ ...hello(), cronSupervision: { managed: true }, capabilities: ['service-update-v1'] })

  it('requires a running daemon rather than restarting a stopped one', async () => {
    await expect(update()).rejects.toBeInstanceOf(DaemonServiceUpdateRefusedError)
    await fs.writeFile(path.join(runtime, 'daemon.pid'), '4242')
    alive = false
    await expect(update()).rejects.toBeInstanceOf(DaemonServiceUpdateRefusedError)
    expect(frames).toEqual([])
  })

  it('requests managed shutdown before allowing the service manager to update', async () => {
    await setup((frame) => {
      if (frame.cmd === 'hello') return managedHello()
      alive = false
      return { ok: true, prepared: true, instanceId: 'old-instance' }
    })
    expect(await update()).toBe(true)
    expect(frames[1]).toEqual({ id: 2, cmd: 'service.update', stateDir: state, instanceId: 'old-instance' })
  })

  it.each([false, true])('acknowledges receipt before waiting for the daemon to exit (update failure: %s)', async (failed) => {
    let received = false
    await setup((frame, socket) => {
      if (frame.cmd === 'hello') return managedHello()
      socket.once('close', () => { received = true; alive = false })
      return failed
        ? { ok: false, updateStarted: true, instanceId: 'old-instance', error: 'registry sync failed' }
        : { ok: true, prepared: true, instanceId: 'old-instance' }
    })
    if (failed) await expect(update()).rejects.toThrow('registry sync failed')
    else expect(await update()).toBe(true)
    expect(received).toBe(true)
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true)
  })

  it('does not mistake a busy refusal for an update already underway', async () => {
    await setup((frame) => frame.cmd === 'hello' ? managedHello() : { ok: false, error: 'active ACP workers' })
    await expect(update()).rejects.toBeInstanceOf(DaemonServiceUpdateRefusedError)
  })

  it('distinguishes a failed update whose daemon has exited from refusal and uncertain transport', async () => {
    await setup((frame) => {
      if (frame.cmd === 'hello') return managedHello()
      alive = false
      return { ok: false, updateStarted: true, instanceId: 'old-instance', error: 'registry sync failed' }
    })
    const error = await update().catch((reason: Error) => reason)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(DaemonServiceUpdateRefusedError)
    expect(error).not.toBeInstanceOf(DaemonServiceHandoverPendingError)
    expect((error as Error).message).toBe('registry sync failed')
  })

  it('keeps disconnected preparation pending', async () => {
    await setup((frame, socket) => {
      if (frame.cmd === 'hello') return managedHello()
      socket.close()
    })
    await expect(update()).rejects.toBeInstanceOf(DaemonServiceHandoverPendingError)
  })
  // 2026-11-03: a deploy's update met one relay in flight and gave up at once.
  const RELAYS = 'service.handover: active ACP workers or relay requests must finish first'
  const EXEC = 'service.handover: running host_exec jobs must finish first'
  it.each([RELAYS, EXEC])('asks a busy daemon again until it prepares the update: %s', async (busy) => {
    let asked = 0
    await setup((frame) => {
      if (frame.cmd === 'hello') return managedHello()
      if (++asked < 3) return { ok: false, error: busy }
      alive = false
      return { ok: true, prepared: true, instanceId: 'old-instance' }
    })
    const notes: string[] = []
    await requestDaemonServiceUpdate(runtime, state, { pauseMs: 10, note: (text) => notes.push(text) })
    expect(frames.map((frame) => frame.cmd)).toEqual(['hello', 'service.update', 'hello', 'service.update', 'hello', 'service.update'])
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain(busy)
  })

  it('gives up on a daemon that stays busy, as the busy refusal it is', async () => {
    await setup((frame) => frame.cmd === 'hello' ? managedHello() : { ok: false, error: RELAYS })
    const error = await requestDaemonServiceUpdate(runtime, state, { busyMs: 100, pauseMs: 20, note: () => {} }).catch((reason: Error) => reason)
    expect(error).toBeInstanceOf(DaemonServiceUpdateRefusedError)
    expect((error as Error).message).toContain(RELAYS)
    expect(frames.filter((frame) => frame.cmd === 'service.update').length).toBeGreaterThan(1)
  })

  it('never asks again after any other refusal, or once the update may have started', async () => {
    await setup((frame) => frame.cmd === 'hello' ? managedHello() : { ok: false, error: 'service.handover: daemon mode or instance does not match the requested operation' })
    await expect(requestDaemonServiceUpdate(runtime, state, { pauseMs: 10, note: () => {} })).rejects.toBeInstanceOf(DaemonServiceUpdateRefusedError)
    expect(frames.map((frame) => frame.cmd)).toEqual(['hello', 'service.update'])
    for (const socket of server!.clients) socket.terminate()
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    frames = []
    await setup((frame, socket) => {
      if (frame.cmd === 'hello') return managedHello()
      socket.close()
    })
    await expect(requestDaemonServiceUpdate(runtime, state, { pauseMs: 10, note: () => {} })).rejects.toBeInstanceOf(DaemonServiceHandoverPendingError)
    expect(frames.map((frame) => frame.cmd)).toEqual(['hello', 'service.update'])
  })

  // daemon-over-busy.ts step 3: an overdue update never waits on a daemon that will not finish.
  it('overdue, a daemon that takes the update and never answers is restarted by its service, within the deadline', async () => {
    await setup((frame) => frame.cmd === 'hello' ? managedHello() : undefined)
    const notes: string[] = []
    const asked = Date.now()
    expect(await requestDaemonServiceUpdate(runtime, state, { force: true, plainMs: 0, busyMs: 5_000, note: (text) => notes.push(text) })).toBe('unprepared')
    expect(Date.now() - asked).toBeLessThan(15_000)
    expect(frames.filter((frame) => frame.cmd === 'service.update')).toHaveLength(1)
    expect(notes.at(-1)).toContain('restarting it instead')
  }, 30_000)

  it('overdue, a disconnect after the request is a restart too; without force it stays pending', async () => {
    await setup((frame, socket) => {
      if (frame.cmd === 'hello') return managedHello()
      socket.close()
    })
    expect(await requestDaemonServiceUpdate(runtime, state, { force: true, plainMs: 0, busyMs: 1_000, note: () => {} })).toBe('unprepared')
    await expect(requestDaemonServiceUpdate(runtime, state, { busyMs: 1_000, pauseMs: 10, note: () => {} })).rejects.toBeInstanceOf(DaemonServiceHandoverPendingError)
  })

  it('overdue, a daemon that never answers its hello is restarted by its service; without force it is refused', async () => {
    await setup(() => undefined)
    const asked = Date.now()
    expect(await requestDaemonServiceUpdate(runtime, state, { force: true, plainMs: 0, busyMs: 1_000, pauseMs: 20, note: () => {} })).toBe('unprepared')
    expect(Date.now() - asked).toBeLessThan(15_000)
    expect(frames.every((frame) => frame.cmd === 'hello')).toBe(true)
    await expect(requestDaemonServiceUpdate(runtime, state, { busyMs: 1_000, pauseMs: 20, note: () => {} })).rejects.toBeInstanceOf(DaemonServiceUpdateRefusedError)
  }, 30_000)

  it('overdue, a daemon that stays busy past the deadline is restarted by its service, not refused', async () => {
    await setup((frame) => frame.cmd === 'hello' ? managedHello() : { ok: false, error: RELAYS })
    expect(await requestDaemonServiceUpdate(runtime, state, { force: true, plainMs: 0, busyMs: 100, pauseMs: 20, note: () => {} })).toBe('unprepared')
    expect(frames.filter((frame) => frame.cmd === 'service.update').every((frame) => frame.force === true)).toBe(true)
  })
})

describe('daemon service handover CLI transport', () => {
  it('does nothing when no daemon PID was recorded', async () => {
    await requestDaemonServiceHandover(runtime, state)
    expect(kill).not.toHaveBeenCalled()
  })

  it.each(['-1', '0', '1', '1.5', 'not-a-pid'])('never probes invalid PID %s', async (pid) => {
    await fs.writeFile(path.join(runtime, 'daemon.pid'), pid)
    await expect(requestDaemonServiceHandover(runtime, state)).rejects.toThrow('Invalid daemon PID')
    expect(kill).not.toHaveBeenCalled()
  })

  it('does not require an endpoint after proving the old process dead', async () => {
    await fs.writeFile(path.join(runtime, 'daemon.pid'), '4242')
    alive = false
    await requestDaemonServiceHandover(runtime, state)
    expect(kill).toHaveBeenCalledExactlyOnceWith(4242, 0)
  })

  it.each([false, true])('remembers a pending handover even when the old PID file is absent or dead (%s)', async (hasPid) => {
    await fs.writeFile(path.join(state, 'handover.json'), '{}', { mode: 0o600 })
    if (hasPid) await fs.writeFile(path.join(runtime, 'daemon.pid'), '4242')
    alive = false
    expect(await requestDaemonServiceHandover(runtime, state)).toBe(true)
  })

  it('keeps a pending handover protected when endpoint discovery fails before an RPC', async () => {
    await fs.writeFile(path.join(state, 'handover.json'), '{}', { mode: 0o600 })
    await fs.writeFile(path.join(runtime, 'daemon.pid'), '4242')
    await expect(requestDaemonServiceHandover(runtime, state)).rejects.toBeInstanceOf(DaemonServiceHandoverPendingError)
  })

  it('keeps liveness permission errors distinct from process death', async () => {
    await fs.writeFile(path.join(runtime, 'daemon.pid'), '4242')
    kill.mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) })
    await expect(requestDaemonServiceHandover(runtime, state)).rejects.toMatchObject({ code: 'EPERM' })
  })

  it('waits for a prepared reply and old-process exit without sending a signal or user message', async () => {
    await setup((frame) => {
      if (frame.cmd === 'hello') return hello()
      alive = false
      return { ok: true, prepared: true, instanceId: 'old-instance' }
    })
    await requestDaemonServiceHandover(runtime, state)
    expect(frames).toEqual([
      { id: 1, cmd: 'hello' },
      { id: 2, cmd: 'service.handover', instanceId: 'old-instance', stateDir: state },
    ])
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true)
  })

  it('leaves an already managed daemon to the service manager', async () => {
    await setup(() => ({ ...hello(), cronSupervision: { managed: true } }))
    await requestDaemonServiceHandover(runtime, state)
    expect(frames).toEqual([{ id: 1, cmd: 'hello' }])
  })

  it.each([
    { ...hello(), instanceId: 'replacement' },
    { ...hello(), capabilities: [] },
    { ...hello(), ok: false },
  ])('does not request handover from an incompatible hello: %j', async (reply) => {
    await setup(() => reply)
    await expect(requestDaemonServiceHandover(runtime, state)).rejects.not.toBeInstanceOf(DaemonServiceHandoverPendingError)
    expect(frames).toEqual([{ id: 1, cmd: 'hello' }])
  })

  it('distinguishes an explicit preparation refusal from an uncertain transport result', async () => {
    await setup((frame) => frame.cmd === 'hello' ? hello() : { ok: false, error: 'active operations' })
    const error = await requestDaemonServiceHandover(runtime, state).catch((reason: Error) => reason)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(DaemonServiceHandoverPendingError)
    expect((error as Error).message).toBe('active operations')
    expect(frames).toHaveLength(2)
  })

  // 2026-11-02: the existing-Mac join stopped at step 2 when the older Walnut's daemon was
  // busy right after its server started; the install gave up on the first answer.
  const BUSY = 'service.handover: active ACP workers or relay requests must finish first'
  const ACTIVE = 'internal daemon error handling service.handover: Daemon has active operations; retry after they finish'
  const DRAIN = 'Service preparation timed out; existing work is still running, retry after it finishes'
  it.each([BUSY, ACTIVE])('asks a busy daemon again until it hands over: %s', async (busy) => {
    let asked = 0
    await setup((frame) => {
      if (frame.cmd === 'hello') return hello()
      if (++asked < 3) return { ok: false, error: busy }
      alive = false
      return { ok: true, prepared: true, instanceId: 'old-instance' }
    })
    const notes: string[] = []
    expect(await requestDaemonServiceHandover(runtime, state, { pauseMs: 10, note: (text) => notes.push(text) })).toBe(true)
    expect(frames.map((frame) => frame.cmd)).toEqual(['hello', 'service.handover', 'hello', 'service.handover', 'hello', 'service.handover'])
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain(busy)
  })

  it('does not ask again after the daemon held its commands for the drain and gave up', async () => {
    await setup((frame) => frame.cmd === 'hello' ? hello() : { ok: false, error: DRAIN })
    await expect(requestDaemonServiceHandover(runtime, state, { pauseMs: 10, note: () => {} })).rejects.toThrow(DRAIN)
    expect(frames.map((frame) => frame.cmd)).toEqual(['hello', 'service.handover'])
  })

  it('waits for a starting daemon to write its instance', async () => {
    await setup((frame) => {
      if (frame.cmd === 'hello') return hello()
      alive = false
      return { ok: true, prepared: true, instanceId: 'old-instance' }
    })
    await fs.rm(path.join(runtime, 'daemon.instance'))
    const later = setTimeout(() => void fs.writeFile(path.join(runtime, 'daemon.instance'), 'old-instance'), 50)
    try {
      expect(await requestDaemonServiceHandover(runtime, state, { pauseMs: 20, note: () => {} })).toBe(true)
    } finally { clearTimeout(later) }
    expect(frames.map((frame) => frame.cmd)).toEqual(['hello', 'service.handover'])
  })

  it('asks again when the connection drops before the handover was requested', async () => {
    let hellos = 0
    await setup((frame, socket) => {
      if (frame.cmd === 'hello') {
        if (++hellos === 1) { socket.close(); return }
        return hello()
      }
      alive = false
      return { ok: true, prepared: true, instanceId: 'old-instance' }
    })
    expect(await requestDaemonServiceHandover(runtime, state, { pauseMs: 10, note: () => {} })).toBe(true)
    expect(frames.map((frame) => frame.cmd)).toEqual(['hello', 'hello', 'service.handover'])
  })

  it('gives up on a daemon that stays busy, with its reason and nothing pending', async () => {
    await setup((frame) => frame.cmd === 'hello' ? hello() : { ok: false, error: BUSY })
    const error = await requestDaemonServiceHandover(runtime, state, { busyMs: 100, pauseMs: 20, note: () => {} }).catch((reason: Error) => reason)
    expect(error).not.toBeInstanceOf(DaemonServiceHandoverPendingError)
    expect((error as Error).message).toBe(BUSY)
    expect(frames.filter((frame) => frame.cmd === 'service.handover').length).toBeGreaterThan(1)
  })

  it('never asks again once the daemon may have started the handover', async () => {
    await setup((frame, socket) => {
      if (frame.cmd === 'hello') return hello()
      socket.close()
    })
    await expect(requestDaemonServiceHandover(runtime, state, { pauseMs: 10, note: () => {} })).rejects.toBeInstanceOf(DaemonServiceHandoverPendingError)
    expect(frames.map((frame) => frame.cmd)).toEqual(['hello', 'service.handover'])
  })

  it('rechecks disk after a failed RPC because preparation may have published before failing', async () => {
    await setup(async (frame) => {
      if (frame.cmd === 'hello') return hello()
      await fs.writeFile(path.join(state, 'handover.json'), '{}', { mode: 0o600 })
      return { ok: false, error: 'snapshot sync failed' }
    })
    await expect(requestDaemonServiceHandover(runtime, state)).rejects.toBeInstanceOf(DaemonServiceHandoverPendingError)
    expect(frames).toHaveLength(2)
  })

  it.each(['disconnect', 'missing-confirmation', 'wrong-instance'])('keeps an ambiguous %s pending after the handover request', async (fault) => {
    await setup((frame, socket) => {
      if (frame.cmd === 'hello') return hello()
      if (fault === 'disconnect') { socket.close(); return }
      return { ok: true, prepared: fault !== 'missing-confirmation', instanceId: fault === 'wrong-instance' ? 'replacement' : 'old-instance' }
    })
    await expect(requestDaemonServiceHandover(runtime, state)).rejects.toBeInstanceOf(DaemonServiceHandoverPendingError)
    expect(frames).toHaveLength(2)
  })
})

describe('every refusal a daemon gives a handover is classified', () => {
  // A daemon that refuses before it changed anything may be asked again (busy: true); any other
  // refusal ends the install. A new refusal in either twin fails here until someone decides
  // which it is (2026-11-02: "has active operations" ended the join's install on a busy daemon).
  const KNOWN: Record<string, boolean> = {
    'service.handover: daemon mode or instance does not match the requested operation': false,
    'service.handover: active ACP workers or relay requests must finish first': true,
    // 2026-11-03: a daemon swap ended a running iOS test run; the run's end is asked again for.
    'service.handover: running host_exec jobs must finish first': true,
    'service.handover: unsupported platform': false,
    'Service preparation timed out; existing work is still running, retry after it finishes': false,
    'Daemon is shutting down; retry after reconnecting': false,
    'Daemon has active operations; retry after they finish': true,
  }
  const root = path.resolve(__dirname, '../..')
  const body = (file: string, start: RegExp) => {
    const text = readFileSync(path.join(root, file), 'utf8')
    const from = text.search(start)
    expect(from, `${file}: ${start}`).toBeGreaterThan(-1)
    // To the next top-level function: the handover command and nothing after it.
    const rest = text.slice(from + 1)
    const end = rest.search(/\n(async )?function /)
    return text.slice(from, end < 0 ? undefined : from + 1 + end)
  }
  const literals = (code: string) => [...code.matchAll(/(?:sendError\(ws, id, |new Error\()'([^']+)'/g)].map((m) => m[1])
  it.each([
    ['src/providers/daemon-standalone.ts', /async function cmdServiceHandover\(/],
    ['src/providers/daemon-source.ts', /async function cmdServiceHandover\(/],
    ['src/providers/daemon-command-drain.ts', /export function createDaemonCommandDrain\(/],
  ])('%s', (file, start) => {
    const found = literals(body(file, start))
    expect(found.length).toBeGreaterThan(0)
    for (const text of found) {
      expect(Object.keys(KNOWN), `unclassified refusal in ${file}: ${text}`).toContain(text)
      // As the client receives it: alone, or behind the daemon's own error prefix.
      for (const sent of [text, `internal daemon error handling service.handover: ${text}`]) {
        expect(handoverBusy(new Error(sent)), sent).toBe(KNOWN[text])
      }
    }
  })
})
