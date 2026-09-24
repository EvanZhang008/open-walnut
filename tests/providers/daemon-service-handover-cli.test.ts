import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestDaemonServiceHandover, requestRunningDaemonHandover } from '../../src/providers/daemon-service-cli.js'
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
