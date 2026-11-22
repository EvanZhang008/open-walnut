/**
 * One Walnut service per machine and daemon dir (A3b): a dir whose session daemon another service
 * runs in its own process (its lock banner says inProcess) is refused with why, and never stopped
 * the way a daemon program is (that service's door answers on daemon.port as a program's does).
 * Another dir (a test's, dev:ephemeral's) is not touched.
 * The holder is a real second process (fixtures/in-process-service-holder.ts).
 * MACHINE SAFETY: temp roots only; the holder ends when its stdin closes; nothing is signalled.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AnotherServiceError, anotherServiceHolds, ensureInProcessDaemon } from '../../src/providers/in-process-daemon.js'
import { guardedPath } from '../setup/exec-guard.js'

const FIXTURE = path.resolve(__dirname, 'fixtures/in-process-service-holder.ts')
const BUN = process.versions.bun ? process.execPath : null
const roots: string[] = []
const holders: ChildProcess[] = []
afterAll(async () => {
  for (const h of holders) { try { h.stdin?.end() } catch { /* gone */ } }
  await Promise.all(holders.map((h) => new Promise((r) => (h.exitCode !== null ? r(null) : h.once('exit', r)))))
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true })
})

function envFor(root: string): NodeJS.ProcessEnv {
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, WALNUT_HOME_OVERRIDE: home, OPEN_WALNUT_HOME: path.join(root, 'walnut-home'),
    WALNUT_DAEMON_DIR: path.join(root, 'd'), WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy'),
    SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'),
  }
  for (const k of ['WALNUT_STREAMS_DIR', 'WALNUT_DAEMON_KEEP_SESSIONS', 'WALNUT_DAEMON_STATE_DIR', 'WALNUT_DAEMON_PARENT_PID']) delete env[k]
  return env
}

function startHolder(env: NodeJS.ProcessEnv): Promise<{ pid: number; child: ChildProcess }> {
  const child = spawn(BUN!, [FIXTURE], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  holders.push(child)
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    const timer = setTimeout(() => reject(new Error(`the holder did not start: ${err.slice(-1500)}`)), 40_000)
    child.stderr!.on('data', (c) => { err += c })
    child.stdout!.on('data', (c) => {
      out += c
      const m = /ready (\d+) started/.exec(out)
      if (m) { clearTimeout(timer); resolve({ pid: Number(m[1]), child }) }
    })
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the holder exited ${code}: ${err.slice(-1500)}`)) })
  })
}

describe.skipIf(!BUN)('one Walnut service per machine and daemon dir', () => {
  it('a second service on the dir is refused with why, and the first is never stopped', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-service-'))
    roots.push(root)
    const env = envFor(root)
    const dir = env.WALNUT_DAEMON_DIR!
    const holder = await startHolder(env)

    expect(await anotherServiceHolds(dir)).toEqual({ pid: holder.pid })
    // The first service's door answers on daemon.port like a program's would: it is not stopped.
    expect(fs.existsSync(path.join(dir, 'daemon.port'))).toBe(true)
    let stopped = false
    const second = ensureInProcessDaemon({
      dir, readPort: () => Number(fs.readFileSync(path.join(dir, 'daemon.port'), 'utf8')), alive: async () => true,
      stopProgram: async () => { stopped = true }, env: async () => env,
    })
    await expect(second).rejects.toBeInstanceOf(AnotherServiceError)
    await expect(second).rejects.toThrow(new RegExp(`pid ${holder.pid}.*one service per machine and data dir`))
    expect(stopped).toBe(false)
    // Still running and still holding its dir.
    expect(holder.child.exitCode).toBeNull()
    expect(await anotherServiceHolds(dir)).toEqual({ pid: holder.pid })

    // Another dir (an isolated test or ephemeral server) is its own: nothing holds it.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'one-service-other-'))
    roots.push(other)
    expect(await anotherServiceHolds(other)).toBeNull()

    // Once the holder stops, the dir is free.
    holder.child.stdin!.end()
    await new Promise((r) => holder.child.once('exit', r))
    expect(await anotherServiceHolds(dir)).toBeNull()
  }, 90_000)

  it('a daemon program holding the dir is no other service (it is stopped and taken over, as before)', async () => {
    const read = async () => ({ uid: 1, dir: '/x', pid: 4242, instanceId: 'd-x', wsPort: 5555 })
    expect(await anotherServiceHolds('/x', read)).toBeNull()
    expect(await anotherServiceHolds('/x', async () => ({ ...(await read()), inProcess: true as const }))).toEqual({ pid: 4242 })
    expect(await anotherServiceHolds('/x', async () => ({ ...(await read()), pid: process.pid, inProcess: true as const }))).toBeNull()
  })
})
