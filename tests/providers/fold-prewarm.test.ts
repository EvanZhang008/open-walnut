/**
 * fold-prewarm.ts run for real against stand-in binaries: a /bin/sh script that
 * plays the new daemon's `--prewarm-folds` (its real fold is pinned by the twins
 * e2e). Pins the one-prewarm-per-dir lock, the deadline and the failure paths.
 *
 * MACHINE SAFETY: every path is a temp dir; the only processes are the scripts
 * this file writes, and the only signal is the deadline's SIGTERM to the child
 * the code under test spawned.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FOLD_PREWARM_MIN_BYTES, registryNeedsFoldPrewarm, runFoldPrewarm } from '../../src/providers/fold-prewarm.js'
import { guardedPath } from '../setup/exec-guard-core.js'

let dir = ''

function script(name: string, body: string): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}

const env = () => ({ PATH: guardedPath([], ['/usr/bin', '/bin'].join(path.delimiter)), HOME: dir })

beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-prewarm-'))) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('registryNeedsFoldPrewarm', () => {
  function registry(sessions: Record<string, unknown>): void {
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({ sessions }))
  }

  it('is true only when a registered stream reaches the checkpoint size', async () => {
    const small = path.join(dir, 'small.jsonl')
    const big = path.join(dir, 'big.jsonl')
    fs.writeFileSync(small, 'x\n')
    fs.writeFileSync(big, '')
    fs.truncateSync(big, FOLD_PREWARM_MIN_BYTES)
    registry({ a: { jsonlPath: small }, b: { jsonlPath: path.join(dir, 'gone.jsonl') } })
    expect(await registryNeedsFoldPrewarm(dir)).toBe(false)
    registry({ a: { jsonlPath: small }, b: { jsonlPath: big } })
    expect(await registryNeedsFoldPrewarm(dir)).toBe(true)
  })

  it('no registry, a torn one, or one of the wrong shape needs nothing', async () => {
    expect(await registryNeedsFoldPrewarm(dir)).toBe(false)
    fs.writeFileSync(path.join(dir, 'sessions.json'), '{"sess')
    expect(await registryNeedsFoldPrewarm(dir)).toBe(false)
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({ sessions: [] }))
    expect(await registryNeedsFoldPrewarm(dir)).toBe(false)
  })
})

describe('runFoldPrewarm', () => {
  it('runs the binary with --prewarm-folds in the daemon dir, reports its counts and clears its lock', async () => {
    const bin = script('daemon', 'echo "$1 $PWD $WALNUT_FOLD_PREWARM_DEADLINE" > args.txt; echo noise; echo \'{"sessions":4,"written":2,"cut":1,"ms":5}\'')
    const before = Date.now()
    const result = await runFoldPrewarm({ binaryPath: bin, version: 'v2', daemonDir: dir, env: env(), maxMs: 60_000 })
    expect(result).toMatchObject({ outcome: 'ran', sessions: 4, written: 2, cut: 1 })
    const [arg, cwd, deadline] = fs.readFileSync(path.join(dir, 'args.txt'), 'utf8').trim().split(' ')
    expect([arg, cwd]).toEqual(['--prewarm-folds', dir])
    // The child's own deadline lands before the backstop kill, so it can save and exit.
    expect(Number(deadline)).toBeGreaterThanOrEqual(before + 30_000)
    expect(Number(deadline)).toBeLessThanOrEqual(Date.now() + 60_000 - 20_000)
    expect(fs.existsSync(path.join(dir, 'fold-prewarm.json'))).toBe(false)
  })

  it('a second caller waits for the running prewarm of the same version instead of starting another', async () => {
    const bin = script('daemon', 'echo run >> runs.txt; sleep 1; echo "{}"')
    const first = runFoldPrewarm({ binaryPath: bin, version: 'v2', daemonDir: dir, env: env() })
    for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, 'fold-prewarm.json')); i++) await new Promise((r) => setTimeout(r, 10))
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'fold-prewarm.json'), 'utf8'))
    expect(lock.version).toBe('v2')
    const second = await runFoldPrewarm({ binaryPath: bin, version: 'v2', daemonDir: dir, env: env() })
    expect(second.outcome).toBe('waited')
    expect((await first).outcome).toBe('ran')
    expect(fs.readFileSync(path.join(dir, 'runs.txt'), 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('a lock of another version, or of a dead pid, is not waited on', async () => {
    const bin = script('daemon', 'echo "{}"')
    fs.writeFileSync(path.join(dir, 'fold-prewarm.json'), JSON.stringify({ pid: process.pid + 100000, version: 'v2', startedAt: Date.now() }))
    expect((await runFoldPrewarm({ binaryPath: bin, version: 'v2', daemonDir: dir, env: env() })).outcome).toBe('ran')
    const sleeper = script('sleeper', 'sleep 2')
    const other = runFoldPrewarm({ binaryPath: sleeper, version: 'v1', daemonDir: dir, env: env() })
    for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, 'fold-prewarm.json')); i++) await new Promise((r) => setTimeout(r, 10))
    const startedAt = Date.now()
    expect((await runFoldPrewarm({ binaryPath: bin, version: 'v2', daemonDir: dir, env: env() })).outcome).toBe('ran')
    expect(Date.now() - startedAt).toBeLessThan(1500)
    await other
  })

  it('rejects on a non-zero exit, a missing binary, and past the deadline (ending the child)', async () => {
    const failing = script('failing', 'exit 3')
    await expect(runFoldPrewarm({ binaryPath: failing, version: 'v2', daemonDir: dir, env: env() })).rejects.toThrow('code 3')
    await expect(runFoldPrewarm({ binaryPath: path.join(dir, 'nope'), version: 'v2', daemonDir: dir, env: env() })).rejects.toThrow()
    const slow = script('slow', 'echo $$ > slow.pid; exec sleep 30')
    await expect(runFoldPrewarm({ binaryPath: slow, version: 'v3', daemonDir: dir, env: env(), maxMs: 300 })).rejects.toThrow('exceeded')
    const pid = parseInt(fs.readFileSync(path.join(dir, 'slow.pid'), 'utf8'), 10)
    expect(pid).toBeGreaterThan(1)
    let alive = true
    for (let i = 0; i < 100 && alive; i++) {
      try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 20)) } catch { alive = false }
    }
    expect(alive).toBe(false)
    expect(fs.existsSync(path.join(dir, 'fold-prewarm.json'))).toBe(false)
  })
})
