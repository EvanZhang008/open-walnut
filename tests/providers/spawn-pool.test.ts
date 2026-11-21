/**
 * The spawn pool (spawn-pool.ts): a daemon runtime inside a server's process starts its children on
 * the pool's thread. execFile answers as node's does (stdout, an exit code, ENOENT for a program
 * that is not there, a timeout's kill), with the pool's umask; a detached child resolves with its
 * pid and tells its exit; the server's own thread is not held meanwhile.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSpawnPool, type SpawnPool } from '../../src/providers/spawn-pool.js'

const isBun = !!process.versions.bun
let pool: SpawnPool | null = null
afterEach(() => { pool?.close(); pool = null })

const run = (p: SpawnPool, file: string, args: string[], options: Record<string, unknown> = {}) =>
  new Promise<{ error: (Error & Record<string, unknown>) | null; stdout: unknown; stderr: unknown }>((resolve) => {
    p.execFile(file, args, options, (error, stdout, stderr) => resolve({ error: error as (Error & Record<string, unknown>) | null, stdout, stderr }))
  })

describe.skipIf(!isBun)('createSpawnPool', () => {
  it('execFile: output, exit codes and the umask, as from node', async () => {
    pool = createSpawnPool({ umask: 0o077 })
    const ok = await run(pool, 'sh', ['-c', 'echo hi; umask'], { encoding: 'utf8' })
    expect(ok.error).toBeNull()
    expect(String(ok.stdout).trim().split('\n')).toEqual(['hi', '0077'])
    const failed = await run(pool, 'sh', ['-c', 'echo bad >&2; exit 3'], { encoding: 'utf8' })
    expect(failed.error?.code).toBe(3)
    expect(String(failed.stderr).trim()).toBe('bad')
    const bytes = await run(pool, 'sh', ['-c', 'printf ab'], { encoding: 'buffer' })
    expect(Buffer.isBuffer(bytes.stdout)).toBe(true)
    expect((bytes.stdout as Buffer).toString()).toBe('ab')
  })

  it('a program that is not there is ENOENT, never the shell\'s 127', async () => {
    pool = createSpawnPool({ umask: 0o077 })
    const missing = await run(pool, 'walnut-no-such-program-x', [])
    expect(missing.error?.code).toBe('ENOENT')
  })

  it('a timeout kills the child, and kill() reaches it', async () => {
    pool = createSpawnPool({ umask: null })
    const slow = await run(pool, 'sleep', ['5'], { timeout: 100 })
    expect(slow.error?.killed).toBe(true)
    const child = pool.execFile('sleep', ['5'], {}, () => {})
    await new Promise<void>((resolve) => child.once('spawn', () => resolve()))
    expect(child.pid).toBeGreaterThan(1)
    const closed = new Promise<unknown[]>((resolve) => child.once('close', (...a) => resolve(a)))
    child.kill('SIGTERM')
    expect((await closed)[1]).toBe('SIGTERM')
  })

  it('stdin reaches the child', async () => {
    pool = createSpawnPool({ umask: null })
    const done = new Promise<unknown>((resolve) => {
      const child = pool!.execFile('cat', [], { encoding: 'utf8' }, (_e, stdout) => resolve(stdout))
      child.stdin.write('one ')
      child.stdin.end('two')
    })
    expect(await done).toBe('one two')
  })

  it('spawnDetached: resolves with the pid of a child writing to a descriptor of this process, then its exit', async () => {
    pool = createSpawnPool({ umask: 0o077 })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-pool-'))
    try {
      const out = path.join(dir, 'out')
      const fd = fs.openSync(out, 'a')
      const child = await pool.spawnDetached('sh', ['-c', 'echo started; umask; touch made'], { cwd: dir, detached: true, stdio: ['ignore', fd, 'ignore'] })
      fs.closeSync(fd)
      expect(child.pid).toBeGreaterThan(1)
      const [code] = await new Promise<unknown[]>((resolve) => child.once('exit', (...a) => resolve(a)))
      expect(code).toBe(0)
      expect(fs.readFileSync(out, 'utf8').trim().split('\n')).toEqual(['started', '0077'])
      expect(fs.statSync(path.join(dir, 'made')).mode & 0o777).toBe(0o600)
      await expect(pool.spawnDetached('walnut-no-such-program-x', [], { stdio: 'ignore', detached: true })).rejects.toThrow(/ENOENT/)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('starts never hold this thread', async () => {
    pool = createSpawnPool({ umask: 0o077 })
    let last = performance.now()
    let late = 0
    const iv = setInterval(() => { const now = performance.now(); late = Math.max(late, now - last - 5); last = now }, 5)
    try {
      const started = performance.now()
      const runs = Array.from({ length: 10 }, () => { const t = performance.now(); const p = run(pool!, 'true', []); return { ms: performance.now() - t, p } })
      await Promise.all(runs.map((r) => r.p))
      // Each call returns at once: the start happens on the pool's thread.
      expect(Math.max(...runs.map((r) => r.ms))).toBeLessThan(5)
      expect(performance.now() - started).toBeGreaterThan(0)
    } finally { clearInterval(iv) }
    expect(late).toBeLessThan(50)
  })

  it('close() answers what still waits', async () => {
    pool = createSpawnPool({ umask: null })
    const waiting = run(pool, 'sleep', ['5'])
    await new Promise((r) => setTimeout(r, 50))
    pool.close()
    pool = null
    expect((await waiting).error?.code).toBe('POOL_CLOSED')
  })
})
