/**
 * Parent-liveness watchdog E2E — spawn the REAL daemon-source.ts template and
 * prove an isolated-dir daemon self-exits once its parent walnut process dies.
 *
 * Root-cause regression test for the 2026-07-23 prod slow-load incident:
 * Playwright/test servers spawn a detached daemon into an isolated
 * WALNUT_DAEMON_DIR; when the test process is SIGKILLed nothing reaps the
 * daemon, and 300+ orphans accumulated (~3 GB RSS) and starved the machine.
 *
 * What's real: the daemon process, its heartbeat timer, the watchdog exit.
 * What's faked: the "parent" is a `sleep` child we kill on cue; heartbeat
 * shrunk to 150ms via WALNUT_DAEMON_HEARTBEAT_MS so the test runs in <5s.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

const procs: ChildProcess[] = []
const tmpDirs: string[] = []

function writeDaemonScript(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-watchdog-e2e-'))
  tmpDirs.push(dir)
  const scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
  return scriptPath
}

async function spawnDaemon(scriptPath: string, extraEnv: Record<string, string>): Promise<ChildProcess> {
  const daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-watchdog-dir-'))
  tmpDirs.push(daemonDir)
  const proc = spawn('node', [scriptPath, '--start'], {
    env: {
      ...process.env,
      WALNUT_DAEMON_DIR: daemonDir,
      WALNUT_DAEMON_HEARTBEAT_MS: '150',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  procs.push(proc)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 10_000)
    proc.stdout?.on('data', (chunk) => {
      if (/^\d+$/m.test(chunk.toString().trim())) { clearTimeout(timer); resolve() }
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })
  return proc
}

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (proc.exitCode !== null) return resolve(proc.exitCode)
    const timer = setTimeout(() => reject(new Error('daemon did not exit within ' + timeoutMs + 'ms')), timeoutMs)
    proc.on('exit', (code) => { clearTimeout(timer); resolve(code) })
  })
}

afterEach(() => {
  for (const p of procs.splice(0)) {
    try { if (p.exitCode === null) p.kill('SIGKILL') } catch {}
  }
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

describe('daemon parent-liveness watchdog', () => {
  it('exits cleanly after WALNUT_DAEMON_PARENT_PID dies', async () => {
    const fakeParent = spawn('sleep', ['600'], { stdio: 'ignore' })
    procs.push(fakeParent)

    const scriptPath = writeDaemonScript()
    const daemon = await spawnDaemon(scriptPath, {
      WALNUT_DAEMON_PARENT_PID: String(fakeParent.pid),
    })

    // Parent alive → daemon must survive several heartbeats.
    await new Promise((r) => setTimeout(r, 600))
    expect(daemon.exitCode).toBeNull()

    fakeParent.kill('SIGKILL')
    const code = await waitForExit(daemon, 5_000)
    expect(code).toBe(0)
  })

  it('stays alive without the env var (production behavior)', async () => {
    const scriptPath = writeDaemonScript()
    const daemon = await spawnDaemon(scriptPath, {})
    // Several heartbeat ticks with no parent var → no self-exit.
    await new Promise((r) => setTimeout(r, 800))
    expect(daemon.exitCode).toBeNull()
  })
})
