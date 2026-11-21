/**
 * An in-process runtime that ends itself (review S3, 2026-11-21): a program would exit, which closes
 * every socket and thread; inside the server the exit is a callback, so the runtime gives those back
 * itself. Without it the server's DaemonConnection kept talking to a stopped runtime and never
 * dialled again, and every session's `walnut` call failed until a restart.
 * The work runs in a bun child (fixtures/in-process-daemon-self-end.ts) that prints one JSON line.
 * MACHINE SAFETY: everything in a temp root; nothing is signalled.
 */
import { describe, expect, it, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FIXTURE = path.resolve(__dirname, 'fixtures/in-process-daemon-self-end.ts')
const BUN = process.versions.bun ? process.execPath : null
const roots: string[] = []
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }) })

describe.skipIf(!BUN)('an in-process runtime that ends itself', () => {
  it('closes its clients, its gateway and everything that would keep the process alive', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inproc-self-end-'))
    roots.push(root)
    const home = path.join(root, 'home')
    fs.mkdirSync(home, { recursive: true })
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      WALNUT_HOME_OVERRIDE: home,
      OPEN_WALNUT_HOME: path.join(root, 'walnut-home'),
      WALNUT_DAEMON_DIR: path.join(root, 'd'),
      WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy'),
      WALNUT_DAEMON_HEARTBEAT_MS: '200',
      SHELL: '/bin/sh',
      PATH: '/usr/bin:/bin',
    }
    for (const k of ['WALNUT_STREAMS_DIR', 'WALNUT_DAEMON_KEEP_SESSIONS', 'WALNUT_DAEMON_STATE_DIR', 'WALNUT_DAEMON_PARENT_PID']) delete env[k]
    const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
      const child = execFile(BUN!, [FIXTURE], { env, timeout: 40_000 }, (error, out, err) => {
        resolve({ stdout: String(out), stderr: String(err), code: error ? (typeof error.code === 'number' ? error.code : null) : 0 })
      })
      child.stdin?.end()
    })
    // The process ended by itself: no listener, thread or clock of the runtime was left.
    expect(code, stderr.slice(-2000)).toBe(0)
    const out = JSON.parse(stdout.trim().split('\n').pop()!)
    expect(out).toEqual({ started: 'started', hello: true, gatewayBefore: true, lockHeldBefore: true, closed: true, lockHeldAtClose: false, running: false, gatewayAnswers: false })
  }, 60_000)
})
