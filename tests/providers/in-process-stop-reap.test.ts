/**
 * An isolated dir's CLIs end with its in-process runtime, without holding the server's event loop
 * (A3b, 2026-11-21): the stop's reap used a sync sleep between polls, one stall of 0.2 s at best and
 * 3.7 s with a real CLI's exit, during which the server answered nothing and the stop's own budget
 * could not fire. The work runs in a bun child (fixtures/in-process-stop-reap.ts).
 * MACHINE SAFETY: a temp root; only the runtime signals the groups it started.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'

const FIXTURE = path.resolve(__dirname, 'fixtures/in-process-stop-reap.ts')
const BUN = process.versions.bun ? process.execPath : null
const roots: string[] = []
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }) })

describe.skipIf(!BUN || process.platform !== 'linux')('the in-process stop of an isolated dir', () => {
  it('waits for its CLIs to exit, with the event loop free meanwhile', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inproc-reap-'))
    roots.push(root)
    const home = path.join(root, 'home')
    fs.mkdirSync(home, { recursive: true })
    const env: NodeJS.ProcessEnv = {
      ...process.env, HOME: home, WALNUT_HOME_OVERRIDE: home, OPEN_WALNUT_HOME: path.join(root, 'walnut-home'),
      WALNUT_DAEMON_DIR: path.join(root, 'd'), WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy'), REAP_ROOT: root,
      SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'),
    }
    for (const k of ['WALNUT_STREAMS_DIR', 'WALNUT_DAEMON_KEEP_SESSIONS', 'WALNUT_DAEMON_STATE_DIR', 'WALNUT_DAEMON_PARENT_PID']) delete env[k]
    const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
      execFile(BUN!, [FIXTURE], { env, timeout: 60_000 }, (error, out, err) => resolve({ stdout: String(out), stderr: String(err), code: error ? (typeof error.code === 'number' ? error.code : null) : 0 }))
    })
    expect(code, stderr.slice(-2000)).toBe(0)
    const out = JSON.parse(stdout.trim().split('\n').pop()!)
    expect(out.started).toBe(3)
    // The CLIs had their 1.5 s to exit (SIGINT honoured, never cut short), and none is left.
    expect(out.stopMs).toBeGreaterThanOrEqual(1400)
    expect(out.aliveAfter).toBe(0)
    // The loop stayed free: the old ladder held it for the whole wait (1.5 s and more).
    expect(out.maxLateMs).toBeLessThan(400)
  }, 90_000)
})
