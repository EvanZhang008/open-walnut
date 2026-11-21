/**
 * daemon-child-spawn.ts: a child of a daemon runtime gets the runtime's env, its dir as cwd and
 * umask 077 when its caller names none, through every way the daemon starts one, and the
 * process's own umask is back the moment the call returns. Real children (`sh -c`), temp dirs.
 */
import { describe, expect, it } from 'vitest'
import * as cp from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { createDaemonChildSpawn } from '../../src/providers/daemon-child-spawn.js'

const PROBE = 'printf "%s|%s|%s" "$(umask)" "$(pwd -P)" "$PROBE_MARK"'

function make(umask: number | null = 0o077) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'child-spawn-')))
  const masks: Array<number | undefined> = []
  const child = createDaemonChildSpawn({
    spawn: cp.spawn, execFile: cp.execFile, execFileSync: cp.execFileSync, execSync: cp.execSync,
    ...(process.versions.bun ? { bunSpawn: ((...a: never[]) => (Bun.spawn as (...b: never[]) => unknown)(...a)) as never } : {}),
    umask: (mask?: number) => { masks.push(mask); return mask === undefined ? process.umask() : process.umask(mask) },
  }, { env: { ...process.env, PROBE_MARK: 'runtime' }, cwd: () => dir, umask })
  return { dir, masks, child }
}

const collect = (proc: cp.ChildProcess): Promise<string> => new Promise((resolve) => {
  let out = ''
  proc.stdout!.on('data', (d) => { out += d })
  proc.on('close', () => resolve(out))
})

describe('createDaemonChildSpawn', () => {
  it('spawn: env, cwd and umask 077 filled in; the process umask is back at once', async () => {
    const before = process.umask()
    const { dir, child } = make()
    const out = await collect(child.spawn('sh', ['-c', PROBE], { stdio: ['ignore', 'pipe', 'ignore'] }))
    expect(out).toBe(`0077|${dir}|runtime`)
    expect(process.umask()).toBe(before)
  })

  it('execFile in all its forms, and promisify(execFile) resolves { stdout, stderr }', async () => {
    const { dir, child } = make()
    const viaCallback = await new Promise<string>((resolve, reject) =>
      child.execFile('sh', ['-c', PROBE], (err, stdout) => (err ? reject(err) : resolve(String(stdout)))))
    expect(viaCallback).toBe(`0077|${dir}|runtime`)
    const withOpts = await new Promise<string>((resolve, reject) =>
      child.execFile('sh', ['-c', PROBE], { encoding: 'utf-8', timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))))
    expect(withOpts).toBe(`0077|${dir}|runtime`)
    const nullArgs = await new Promise<string>((resolve, reject) =>
      child.execFile('sh', null, { encoding: 'utf-8', env: { ...process.env, PROBE_MARK: 'null-args' } }, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))).stdin!.end(PROBE))
    expect(nullArgs).toBe(`0077|${dir}|null-args`)
    const promised = await promisify(child.execFile)('sh', ['-c', PROBE])
    expect(String(promised.stdout)).toBe(`0077|${dir}|runtime`)
    expect(promised).toHaveProperty('stderr')
  })

  it('the caller\'s own cwd and env win', async () => {
    const { child } = make()
    const other = fs.realpathSync(os.tmpdir())
    const out = await collect(child.spawn('sh', ['-c', PROBE], { cwd: other, env: { ...process.env, PROBE_MARK: 'caller' }, stdio: ['ignore', 'pipe', 'ignore'] }))
    expect(out).toBe(`0077|${other}|caller`)
  })

  it('execFileSync and execSync', () => {
    const before = process.umask()
    const { dir, child } = make()
    expect(String(child.execFileSync('sh', ['-c', PROBE]))).toBe(`0077|${dir}|runtime`)
    expect(String(child.execSync(PROBE))).toBe(`0077|${dir}|runtime`)
    expect(process.umask()).toBe(before)
  })

  it.skipIf(!process.versions.bun)('Bun.spawn, argv and options forms', async () => {
    const { dir, child } = make()
    const a = child.bunSpawn(['sh', '-c', PROBE], { stdout: 'pipe' }) as { stdout: ReadableStream }
    expect(await new Response(a.stdout).text()).toBe(`0077|${dir}|runtime`)
    const b = (child.bunSpawn as unknown as (o: Record<string, unknown>) => { stdout: ReadableStream })({ cmd: ['sh', '-c', PROBE], stdout: 'pipe' })
    expect(await new Response(b.stdout).text()).toBe(`0077|${dir}|runtime`)
  })

  it('a null umask leaves the process\'s own, and a cwd not set yet leaves the process\'s cwd', async () => {
    const masks: Array<number | undefined> = []
    const child = createDaemonChildSpawn({
      spawn: cp.spawn, execFile: cp.execFile, execFileSync: cp.execFileSync, execSync: cp.execSync,
      umask: (mask?: number) => { masks.push(mask); return process.umask() },
    }, { env: process.env, cwd: () => undefined, umask: null })
    const out = String(child.execFileSync('sh', ['-c', 'pwd -P']))
    expect(out.trim()).toBe(fs.realpathSync(process.cwd()))
    expect(masks).toEqual([])
  })

  it('restores the umask when the call throws', () => {
    const before = process.umask()
    const { child } = make()
    expect(() => child.execFileSync('/nonexistent/program-for-this-test', [])).toThrow()
    expect(process.umask()).toBe(before)
  })
})

// In a server's process an uncaught throw in a child's handler ends the server (review S6,
// 2026-11-21): with `contain`, every callback handed in through the seam is guarded.
describe('createDaemonChildSpawn with contain', () => {
  const makeContained = () => {
    const errors: string[] = []
    const contain = <A extends unknown[]>(what: string, fn: (...a: A) => unknown) => (...a: A) => {
      try { fn(...a) } catch (err) { errors.push(`${what}: ${(err as Error).message}`) }
    }
    const child = createDaemonChildSpawn({
      spawn: cp.spawn, execFile: cp.execFile, execFileSync: cp.execFileSync, execSync: cp.execSync,
      umask: (mask?: number) => (mask === undefined ? process.umask() : process.umask(mask)),
    }, { env: process.env, cwd: () => undefined, umask: null, contain })
    return { child, errors }
  }

  it('a throwing exit, data and stream listener is reported, never thrown; removal by the own function works', async () => {
    const { child, errors } = makeContained()
    const proc = child.spawn('sh', ['-c', 'echo hi'], { stdio: ['ignore', 'pipe', 'ignore'] })
    const removed = () => { throw new Error('removed one ran') }
    proc.on('exit', removed)
    proc.off('exit', removed)
    proc.stdout!.on('data', () => { throw new Error('data boom') })
    await new Promise<void>((resolve) => {
      proc.on('close', () => { resolve(); throw new Error('close boom') })
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(errors.some((e) => e.includes('data boom'))).toBe(true)
    expect(errors.some((e) => e.includes('close boom'))).toBe(true)
    expect(errors.some((e) => e.includes('removed one ran'))).toBe(false)
  })

  it('a throwing execFile callback is reported', async () => {
    const { child, errors } = makeContained()
    await new Promise<void>((resolve) => {
      child.execFile('echo', ['x'], () => { resolve(); throw new Error('cb boom') })
    })
    expect(errors).toEqual([expect.stringContaining('cb boom')])
  })
})
