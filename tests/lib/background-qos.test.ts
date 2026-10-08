/**
 * src/lib/background-qos.ts: the server's background children go into the
 * macOS utility QoS band only when the server was raised to Interactive and
 * says so (WALNUT_DAEMON_QOS_CLAMP=1). Every other launch (a terminal, the Mac
 * app) leaves them in the band they inherit.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { fork, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  QOS_CLAMP_ENV,
  TASKPOLICY,
  _resetQosClampRequestForTest,
  backgroundQosClampOn,
  takeQosClampRequest,
  utilityQosForkExec,
  withUtilityQosClamp,
} from '../../src/lib/background-qos.js'

const all = () => true
const ON = { WALNUT_DAEMON_QOS_CLAMP: '1' }
const realClamp = process.platform === 'darwin' && fs.existsSync(TASKPOLICY)

describe('withUtilityQosClamp', () => {
  it('wraps the program in taskpolicy -c utility when the server asked for it', () => {
    expect(withUtilityQosClamp('/opt/walnut/daemon', ['--start'], { platform: 'darwin', env: ON, exists: all }))
      .toEqual([TASKPOLICY, ['-c', 'utility', '/opt/walnut/daemon', '--start']])
  })

  it.each([
    ['no request (a terminal or Mac app server)', { platform: 'darwin' as const, env: {}, exists: all }],
    ['an explicit 0', { platform: 'darwin' as const, env: { WALNUT_DAEMON_QOS_CLAMP: '0' }, exists: all }],
    ['any value other than 1', { platform: 'darwin' as const, env: { WALNUT_DAEMON_QOS_CLAMP: 'yes' }, exists: all }],
    ['another platform', { platform: 'linux' as const, env: ON, exists: all }],
    ['no taskpolicy on this Mac', { platform: 'darwin' as const, env: ON, exists: (p: string) => p !== TASKPOLICY }],
    ['a program that is not there (it must still fail as a spawn ENOENT)', { platform: 'darwin' as const, env: ON, exists: (p: string) => p === TASKPOLICY }],
  ])('leaves the command alone for %s', (_name, opts) => {
    expect(withUtilityQosClamp('/opt/walnut/daemon', ['--start'], opts)).toEqual(['/opt/walnut/daemon', ['--start']])
  })

  it('resolves a bare command on the given PATH', () => {
    const exists = (p: string) => p === TASKPOLICY || p === '/usr/local/bin/git'
    expect(withUtilityQosClamp('git', ['gc'], { platform: 'darwin', env: ON, exists, searchPath: '/usr/bin:/usr/local/bin' }))
      .toEqual([TASKPOLICY, ['-c', 'utility', 'git', 'gc']])
    expect(withUtilityQosClamp('git', ['gc'], { platform: 'darwin', env: ON, exists, searchPath: '/usr/bin' }))
      .toEqual(['git', ['gc']])
  })

  it.runIf(realClamp)('really execs the program with its arguments and exit code', () => {
    const [cmd, args] = withUtilityQosClamp('/bin/sh', ['-c', 'echo "$0 $1"; exit 7', 'a b', 'c'], { env: ON })
    expect(cmd).toBe(TASKPOLICY)
    const r = spawnSync(cmd, args, { encoding: 'utf8' })
    expect(r.stdout.trim()).toBe('a b c')
    expect(r.status).toBe(7)
  })
})

describe('utilityQosForkExec', () => {
  it('moves node behind the clamp program when asked, and is a plain execArgv otherwise', () => {
    expect(utilityQosForkExec(['--max-old-space-size=512'], { platform: 'darwin', env: ON, exists: all }))
      .toEqual({ execPath: TASKPOLICY, execArgv: ['-c', 'utility', process.execPath, '--max-old-space-size=512'] })
    expect(utilityQosForkExec(['--max-old-space-size=512'], { platform: 'darwin', env: {}, exists: all }))
      .toEqual({ execArgv: ['--max-old-space-size=512'] })
    expect(backgroundQosClampOn({ platform: 'darwin', env: {}, exists: all })).toBe(false)
  })

  it.runIf(realClamp)('a forked child keeps its own pid and its IPC channel (advanced serialization)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-qos-fork-'))
    try {
      const child = path.join(dir, 'child.cjs')
      fs.writeFileSync(child, "process.on('message', (m) => { process.send({ bytes: m.byteLength, pid: process.pid }); process.exit(0) })\n")
      const launch = utilityQosForkExec([], { env: ON })
      expect(launch.execPath).toBe(TASKPOLICY)
      const c = fork(child, [], { ...launch, serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
      const reply = await new Promise<{ bytes: number; pid: number }>((resolve, reject) => {
        c.once('message', (m) => resolve(m as { bytes: number; pid: number }))
        c.once('error', reject)
        c.send(new Uint8Array([1, 2, 3, 4]).buffer)
      })
      expect(reply).toEqual({ bytes: 4, pid: c.pid })
      await new Promise((r) => c.once('exit', r))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the clamp request is read once and leaves process.env', () => {
  const saved = process.env[QOS_CLAMP_ENV]
  afterEach(() => {
    _resetQosClampRequestForTest()
    if (saved === undefined) delete process.env[QOS_CLAMP_ENV]
    else process.env[QOS_CLAMP_ENV] = saved
  })

  /** What a child built the way the terminal and the model turns build theirs sees. */
  const childSees = (): string =>
    spawnSync(process.execPath, ['-e', `process.stdout.write(process.env.${QOS_CLAMP_ENV} ?? 'unset')`], {
      encoding: 'utf8', env: { ...process.env, TERM: 'xterm-256color' },
    }).stdout

  it('startup takes it: the server keeps the decision, no child built from process.env inherits it', () => {
    // 2026-10-03 (r4 gate): the in-app terminal and the model's `claude -p`
    // turns copy process.env, and both showed clamp=1.
    _resetQosClampRequestForTest()
    process.env[QOS_CLAMP_ENV] = '1'
    expect(childSees()).toBe('1')
    expect(takeQosClampRequest()).toBe(true)
    expect(process.env[QOS_CLAMP_ENV]).toBeUndefined()
    expect(childSees()).toBe('unset')
    expect(backgroundQosClampOn({ platform: 'darwin', exists: all })).toBe(true)
    // Read once: setting it again later is not a new request, and is taken too.
    process.env[QOS_CLAMP_ENV] = '0'
    expect(takeQosClampRequest()).toBe(true)
    expect(process.env[QOS_CLAMP_ENV]).toBeUndefined()
  })

  it('no request at startup stays no request', () => {
    _resetQosClampRequestForTest()
    delete process.env[QOS_CLAMP_ENV]
    expect(takeQosClampRequest()).toBe(false)
    process.env[QOS_CLAMP_ENV] = '1'
    expect(backgroundQosClampOn({ platform: 'darwin', exists: all })).toBe(false)
    expect(process.env[QOS_CLAMP_ENV]).toBeUndefined()
  })

  it('startServer takes it before its first await, ahead of any child', () => {
    const server = fs.readFileSync(path.join(import.meta.dirname, '../../src/web/server.ts'), 'utf8')
    const start = server.indexOf('export async function startServer(')
    const body = server.slice(start, server.indexOf('\n}\n', start))
    const take = body.indexOf('takeQosClampRequest()')
    expect(take).toBeGreaterThan(0)
    expect(take).toBeLessThan(body.indexOf('await '))
  })
})
