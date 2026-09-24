import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { run } = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: run }))

import { daemonReady, runDaemonServiceArgs, runDaemonServiceCli, runDaemonServiceCommand } from '../../src/providers/daemon-service-cli.js'
import { EventEmitter } from 'node:events'

describe('daemon service CLI mutation boundary', () => {
  it.each(['install', 'update', 'uninstall', 'restart'])('requires explicit confirmation for %s', async (action) => {
    await expect(runDaemonServiceCli(action, {})).rejects.toThrow('--yes')
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects unknown operations and malformed options before any command', async () => {
    await expect(runDaemonServiceArgs(['unknown', '--yes'])).rejects.toThrow('Expected daemon')
    await expect(runDaemonServiceArgs(['install', '--scope'])).rejects.toThrow('--scope requires')
    await expect(runDaemonServiceArgs(['install', '--executable'])).rejects.toThrow('--executable requires')
    await expect(runDaemonServiceArgs(['install', '--administrator'])).rejects.toThrow('Unknown daemon option')
    await expect(runDaemonServiceArgs(['install', '--sudo', '--yes'])).rejects.toThrow('--sudo requires')
    await expect(runDaemonServiceCli('install', { yes: true, scope: 'global' as never })).rejects.toThrow('Scope must')
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses host mutation from a test process even with confirmation', async () => {
    await expect(runDaemonServiceCli('install', { yes: true })).rejects.toThrow('not a test or isolated home')
    expect(run).not.toHaveBeenCalled()
  })
})

describe('daemon service command lifetime', () => {
  afterEach(() => run.mockReset())

  it.each([
    ['/fixture/daemon', ['walnut', 'daemon', 'update', '--yes'], 600000],
    ['systemctl', ['--user', 'restart', 'open-walnut-daemon.service'], 75000],
    ['launchctl', ['bootout', 'gui/501/dev.openwalnut.session-daemon'], 75000],
    ['sudo', ['-n', '--', '/usr/bin/systemctl', 'restart', 'open-walnut-daemon.service'], 75000],
    ['sudo', ['-n', '--', '/usr/bin/python3', '-I', '-c', 'fixture'], 15000],
  ] as const)('gives %s enough time for the configured service exit grace', async (program, args, timeout) => {
    const child = new EventEmitter()
    let finish!: (error: null, stdout: string, stderr: string) => void
    run.mockImplementation((_program, _args, options, callback) => {
      expect(options.timeout).toBe(timeout)
      finish = callback
      return child
    })
    const result = runDaemonServiceCommand(program, [...args])
    finish(null, '', '')
    child.emit('close', 0)
    expect((await result).code).toBe(0)
  })

  it('warns when a child has not closed without releasing the installation lock', async () => {
    vi.useFakeTimers()
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const child = new EventEmitter()
    let finish!: (error: Error, stdout: string, errorOutput: string) => void
    run.mockImplementation((_program, _args, _options, callback) => { finish = callback; return child })
    try {
      let closed = false
      const result = runDaemonServiceCommand('fixture', []).then(() => { closed = true })
      finish(Object.assign(new Error('kill EPERM'), { code: 'EPERM' }), '', '')
      await vi.advanceTimersByTimeAsync(16_000)
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('installation lock'))
      expect(closed).toBe(false)
      child.emit('close', 1)
      await result
      expect(closed).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers(); stderr.mockRestore() }
  })

  it.each([false, true])('keeps the transaction open until close, including an early termination error (%s)', async (fails) => {
    const child = Object.assign(new EventEmitter(), { stdin: { on: vi.fn(), end: vi.fn() } })
    let finish!: (error: Error | null, stdout: string, stderr: string) => void
    run.mockImplementation((_program, _args, _options, callback) => { finish = callback; return child })
    let returned = false
    const result = runDaemonServiceCommand('fixture', [], 'payload').then((value) => { returned = true; return value })
    const error = fails ? Object.assign(new Error('kill EPERM'), { code: 'EPERM' }) : null
    finish(error, fails ? '' : 'done', '')
    await Promise.resolve()
    expect(returned).toBe(false)
    expect(child.stdin.end).toHaveBeenCalledWith('payload')
    child.emit('close', fails ? 1 : 0)
    expect(await result).toEqual({ code: fails ? 1 : 0, stdout: fails ? '' : 'done', stderr: fails ? 'kill EPERM' : '' })
  })
})

describe('daemon service readiness over loopback', () => {
  let root: string | undefined
  let server: WebSocketServer | undefined
  let responseErrors: unknown[] = []

  afterEach(async () => {
    if (server) {
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = undefined
    }
    if (root) { await fs.rm(root, { recursive: true, force: true }); root = undefined }
    expect(responseErrors).toEqual([])
    responseErrors = []
  })

  async function setup(reply: (attempt: number) => unknown | Promise<unknown>) {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-service-ready-test-'))
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => server!.once('listening', resolve))
    const port = (server.address() as { port: number }).port
    await Promise.all([
      fs.writeFile(path.join(root, 'daemon.port'), String(port)),
      fs.writeFile(path.join(root, 'daemon.instance'), 'new-instance'),
      fs.writeFile(path.join(root, 'daemon.service'), 'new-instance'),
    ])
    let attempts = 0
    server.on('connection', (socket) => socket.on('message', (raw) => {
      void (async () => {
        expect(JSON.parse(String(raw))).toEqual({ id: 1, cmd: 'hello' })
        const value = await reply(++attempts)
        socket.send(typeof value === 'string' ? value : JSON.stringify(value))
      })().catch((error) => { responseErrors.push(error); socket.terminate() })
    }))
    return root
  }

  const good = () => ({ id: 1, ok: true, instanceId: 'new-instance', cronSupervision: { managed: true }, capabilities: ['cron-supervision-v1'], serviceExecutable: process.execPath })

  it('requires a managed hello from the expected executable and instance', async () => {
    const runtime = await setup(good)
    expect(await daemonReady(runtime, process.execPath, 500)).toBe(true)
  })

  it.each([
    () => ({ ...good(), ok: false }),
    () => ({ ...good(), instanceId: 'old-instance' }),
    () => ({ ...good(), cronSupervision: { managed: false } }),
    () => ({ ...good(), capabilities: [] }),
    () => ({ ...good(), serviceExecutable: '/missing/executable' }),
    () => 'not json',
  ])('rejects stale, incomplete, or malformed hello responses', async (reply) => {
    const runtime = await setup(reply)
    expect(await daemonReady(runtime, process.execPath, 80)).toBe(false)
  })

  it('does not report restart success while the previous instance still answers', async () => {
    const runtime = await setup(good)
    expect(await daemonReady(runtime, process.execPath, 80, 'new-instance')).toBe(false)
    expect(await daemonReady(runtime, process.execPath, 500, 'older-instance')).toBe(true)
  })

  it('does not accept a marker replaced during hello', async () => {
    const runtime = await setup(async () => {
      await fs.writeFile(path.join(root!, 'daemon.instance'), 'replacement')
      return good()
    })
    expect(await daemonReady(runtime, process.execPath, 80)).toBe(false)
  })

  it('retries a stale response until the new process is ready', async () => {
    const runtime = await setup((attempt) => attempt === 1 ? { ...good(), instanceId: 'old-instance' } : good())
    expect(await daemonReady(runtime, process.execPath, 1500)).toBe(true)
  })
})
