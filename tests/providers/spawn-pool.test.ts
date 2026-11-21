/**
 * The spawn pool (spawn-pool.ts): a daemon runtime inside a server's process starts its children on
 * the pool's thread. execFile answers as node's does (stdout, an exit code, ENOENT for a program
 * that is not there, a timeout's kill, an abort, a relative path of the cwd), with the pool's umask;
 * a detached child resolves with its pid and tells its exit; the server's own thread is not held
 * meanwhile; a child's EPIPE never ends the pool, and a pool whose thread dies answers what waits.
 */
import cp from 'node:child_process'
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

  it('a start happens on the pool\'s thread: not in the call, and not on this thread\'s later turns', async () => {
    pool = createSpawnPool({ umask: 0o077 })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-pool-'))
    try {
      const marker = path.join(dir, 'ran')
      const done = run(pool, 'sh', ['-c', `touch "${marker}"`])
      // pool.execFile returned before any child exists (a start in the call would have a pid now)...
      const child = pool.execFile('true', [], {})
      expect(child.pid).toBeUndefined()
      // ...and while this thread is held, without one turn of its loop, the child starts and runs.
      const until = Date.now() + 5000
      while (!fs.existsSync(marker) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
      expect(fs.existsSync(marker)).toBe(true)
      expect((await done).error).toBeNull()
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('20 starts at once leave this thread\'s loop on time', async () => {
    pool = createSpawnPool({ umask: 0o077 })
    // One start on this thread, for scale (about 30 ms at the container's nofile of 32768).
    const t = performance.now()
    cp.spawn('true', [], { stdio: 'ignore' }).on('error', () => {})
    const oneStart = performance.now() - t
    let last = performance.now()
    let late = 0
    const iv = setInterval(() => { const now = performance.now(); late = Math.max(late, now - last - 5); last = now }, 5)
    try {
      await Promise.all(Array.from({ length: 20 }, () => run(pool!, 'true', [])))
    } finally { clearInterval(iv) }
    // On this thread the 20 would hold it about 20 x oneStart; here at most a few ms of messages.
    expect(late).toBeLessThan(Math.max(50, 4 * oneStart))
  })

  it('a child that closes its stdin early (EPIPE) never ends the pool: the next start still answers', async () => {
    pool = createSpawnPool({ umask: null })
    for (const program of [['sh', '-c', 'exit 0'], ['head', '-c', '1']]) {
      const first = new Promise<(Error & Record<string, unknown>) | null>((resolve) => {
        const child = pool!.execFile(program[0]!, program.slice(1), { encoding: 'buffer' }, (error) => resolve(error as (Error & Record<string, unknown>) | null))
        child.stdin.on('error', () => { /* the caller's guard, as session-changes-core's */ })
        child.stdin.write(Buffer.alloc(1 << 20))
        child.stdin.end()
      })
      expect((await first)?.code ?? 0).not.toBe('POOL_WORKER_DIED')
    }
    // No guard at all: still nothing thrown, here or there.
    const bare = pool.execFile('sh', ['-c', 'exit 0'], {}, () => {})
    bare.stdin.end(Buffer.alloc(1 << 20))
    const next = await run(pool, 'echo', ['ok'], { encoding: 'utf8' })
    expect(String(next.stdout).trim()).toBe('ok')
    await new Promise((r) => setTimeout(r, 50))
    expect(pool.pending).toBe(0)
  })

  it('a pool thread that dies answers every waiting call, keeps a started child reachable, and the next call works', async () => {
    const errors: unknown[] = []
    pool = createSpawnPool({ umask: null, onError: (e) => errors.push(e) })
    const waiting = run(pool, 'sleep', ['5'])
    const detached = await pool.spawnDetached('sleep', ['5'], { stdio: 'ignore', detached: true })
    const told = new Promise<Error & Record<string, unknown>>((resolve) => detached.once('error', resolve))
    let exited = false
    detached.once('exit', () => { exited = true })
    await new Promise((r) => setTimeout(r, 50))
    pool.__terminateWorkerForTest()
    expect((await waiting).error?.code).toBe('POOL_WORKER_DIED')
    expect((await told).code).toBe('POOL_WORKER_DIED')
    expect(errors.some((e) => (e as Record<string, unknown>).code === 'POOL_WORKER_DIED')).toBe(true)
    expect(pool.pending).toBe(0)
    // Its end can no longer be told, so no 'exit' says it ended; kill() reaches it by its pid.
    expect(exited).toBe(false)
    expect(detached.kill('SIGKILL')).toBe(true)
    const next = await run(pool, 'echo', ['ok'], { encoding: 'utf8' })
    expect(next.error).toBeNull()
    expect(String(next.stdout).trim()).toBe('ok')
  })

  it('signal: an abort kills the child and answers AbortError; one aborted already never starts', async () => {
    pool = createSpawnPool({ umask: null })
    const ac = new AbortController()
    const closed = new Promise<{ error: Error | null; signal: unknown }>((resolve) => {
      let error: Error | null = null
      const child = pool!.execFile('sleep', ['5'], { signal: ac.signal }, (e) => { error = e })
      child.on('error', () => {})
      child.once('spawn', () => ac.abort())
      child.once('close', (_code, signal) => resolve({ error, signal }))
    })
    const { error, signal } = await closed
    expect(error?.name).toBe('AbortError')
    expect(signal).toBe('SIGTERM')
    const before = new AbortController()
    before.abort()
    const early = await run(pool, 'sleep', ['5'], { signal: before.signal })
    expect(early.error?.name).toBe('AbortError')
    await expect(pool.spawnDetached('sleep', ['5'], { stdio: 'ignore', signal: before.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(pool.pending).toBe(0)
  })

  it('a relative program path is the cwd\'s, with and without the umask shell', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-pool-'))
    try {
      fs.mkdirSync(path.join(dir, 'bin'))
      fs.writeFileSync(path.join(dir, 'bin', 'hello'), '#!/bin/sh\necho rel\n', { mode: 0o755 })
      for (const umask of [0o077, null]) {
        pool = createSpawnPool({ umask })
        const out = await run(pool, './bin/hello', [], { cwd: dir, encoding: 'utf8' })
        expect(out.error).toBeNull()
        expect(String(out.stdout).trim()).toBe('rel')
        pool.close()
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('a start that fails is \'error\' then \'close\', never \'exit\'; kill() of an ended child is false; stdin bytes stay bytes', async () => {
    pool = createSpawnPool({ umask: null })
    const events: string[] = []
    const missing = await new Promise<(Error & Record<string, unknown>) | null>((resolve) => {
      const child = pool!.execFile('walnut-no-such-program-x', [], {}, (e) => resolve(e as (Error & Record<string, unknown>) | null))
      for (const ev of ['error', 'exit', 'close']) child.on(ev, () => events.push(ev))
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(missing?.code).toBe('ENOENT')
    expect(events).toEqual(['error', 'close'])
    const ended = pool.execFile('true', [], {}, () => {})
    await new Promise((r) => ended.once('close', r))
    expect(ended.kill()).toBe(false)
    const raw = Buffer.from([0xff, 0x00, 0xfe])
    const echoed = await new Promise<unknown>((resolve) => {
      const child = pool!.execFile('cat', [], { encoding: 'buffer' }, (_e, stdout) => resolve(stdout))
      child.stdin.end(raw)
    })
    expect(Buffer.compare(echoed as Buffer, raw)).toBe(0)
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
