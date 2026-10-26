/**
 * The startup update keeps its process alive while it waits for the install.
 *
 * History: 2026-10-25, the release rehearsal's serve and update scenarios.
 * `open-walnut web` printed "installing it before starting" and the process
 * ended with exit 0 at once, printing nothing more, while npm went on for two
 * minutes. Nothing in that wait held the event loop: the installer runs detached
 * and unref'd and its log copy is unref'd (background-install.ts, so that a
 * stopped server is never kept alive by npm), the budget timer is unref'd
 * (watchStop), and a signal handler holds nothing. So once the loop was idle the
 * process simply ended. updateOnStart now holds it open for as long as the wait
 * lasts (holdWhileWaiting) and no longer.
 *
 * A real bun child (the runner's own, process.execPath) with the real
 * startDetachedInstall and watchStop, an installer that is
 * `sh -c 'sleep 2; exit 0'`, and nothing else alive: no mocked loop. Before the
 * fix the first case ends at 0 s with no outcome line.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const CHILD = path.join(__dirname, 'fixtures/startup-wait-child.ts')
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

function runChild(budgetMs?: number, installerSecs?: number): Promise<{ code: number | null; ms: number; stderr: string; outcome: { outcome?: string; ms?: number } | null }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-wait-'))
  dirs.push(dir)
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const args = [CHILD, dir, String(budgetMs ?? ''), String(installerSecs ?? '')]
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OPEN_WALNUT_HOME: path.join(dir, 'home') },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => {
      const line = stdout.trim().split('\n').filter(Boolean).pop()
      let outcome: { outcome?: string; ms?: number } | null = null
      try { outcome = line ? JSON.parse(line) : null } catch { outcome = null }
      resolve({ code, ms: Date.now() - started, stderr, outcome })
    })
  })
}

describe('updateOnStart in a real process with nothing else alive', () => {
  it('lives through the install, then prints its outcome', async () => {
    const r = await runChild()
    expect(r.stderr).toContain('installing it before starting')
    expect(r.outcome, `no outcome line; the process ended after ${r.ms} ms with ${r.code}:\n${r.stderr}`).toEqual({ outcome: 'reexeced', ms: expect.any(Number) })
    expect(r.outcome!.ms!).toBeGreaterThanOrEqual(2_000)
    expect(r.ms).toBeGreaterThanOrEqual(2_000)
    expect(r.stderr).toContain('Installed Open Walnut 9.9.9; starting it.')
    expect(r.code).toBe(0)
  }, 60_000)

  it('out of time, it starts the version in use at once, and the install it leaves running does not hold the process', async () => {
    // A 10 s installer (it goes on, detached, after the test) and a 500 ms budget.
    const r = await runChild(500, 10)
    expect(r.outcome, r.stderr).toEqual({ outcome: 'continue', ms: expect.any(Number) })
    expect(r.stderr).toContain('is still installing; starting 9.9.8 now')
    // The hold ends with the wait: the child exits long before its installer does.
    expect(r.ms).toBeLessThan(10_000)
    expect(r.code).toBe(0)
  }, 60_000)
})
