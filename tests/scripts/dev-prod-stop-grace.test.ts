/**
 * scripts/dev-prod.sh: the outgoing server gets to finish its teardown.
 *
 * The server closes its listener first and only then finishes shutting down
 * (an import mid-write, embed runs, the stores), bounded by its own 4s bail.
 * The deploy used to SIGKILL every PID still alive the moment the port freed, so
 * on 2026-09-30 it killed the outgoing server a second into its teardown. A
 * server that ignores SIGTERM must still be SIGKILLed (2026-08-09: 62 immune
 * servers piled up), just after the grace instead of at once.
 *
 * The stop block is executed on its own, with `listener_pids` stubbed and two
 * stand-in servers: one that frees the port and exits 1.5 s later, and one that
 * frees the port and never exits. Nothing here touches a real port or server.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'

const SCRIPT = path.join(import.meta.dirname, '..', '..', 'scripts', 'dev-prod.sh')
const script = fs.readFileSync(SCRIPT, 'utf-8')

const BLOCK_START = 'existing_pids="$(listener_pids)"'
const BLOCK_END = '# ── Zombie sweep'

function block(): string {
  const a = script.indexOf(BLOCK_START)
  const b = script.indexOf(BLOCK_END, a)
  expect(a, 'stop block present').toBeGreaterThan(-1)
  expect(b).toBeGreaterThan(a)
  return script.slice(a, b)
}

let dir = ''
const children: ChildProcess[] = []

afterEach(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
  children.length = 0
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

/** A stand-in server: SIGTERM frees its "port" (a marker file), then it exits after `exitAfter` s, or never. */
function fakeServer(exitAfter: number | null): ChildProcess {
  const onTerm = exitAfter === null
    ? 'touch "$D/closed-$$"'
    : `touch "$D/closed-$$"; sleep ${exitAfter}; touch "$D/done-$$"; exit 0`
  const child = spawn('bash', ['-c', `trap '${onTerm}' TERM; while :; do sleep 0.1; done`], {
    env: { ...process.env, D: dir },
    stdio: 'ignore',
  })
  children.push(child)
  return child
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('exit', () => resolve()))
}

function runBlock(pids: number[], graceSecs: number): Promise<{ code: number | null; stderr: string; ms: number }> {
  const prelude = [
    'set -euo pipefail',
    `STOP_GRACE_SECS=${graceSecs}`,
    `FAKE_PIDS='${pids.join(' ')}'`,
    // A listener stays listed until its SIGTERM trap has freed the port.
    'listener_pids() { for p in $FAKE_PIDS; do [[ -e "$D/closed-$p" ]] || echo "$p"; done; }',
  ].join('\n')
  const t0 = Date.now()
  const runner = spawn('bash', ['-c', `${prelude}\n${block()}\necho DONE`], { env: { ...process.env, D: dir } })
  let stderr = ''
  runner.stderr.on('data', (d) => { stderr += String(d) })
  return new Promise((resolve) => runner.once('close', (code) => resolve({ code, stderr, ms: Date.now() - t0 })))
}

describe('dev-prod.sh stop grace', () => {
  it('is valid bash', () => {
    execFileSync('bash', ['-n', SCRIPT])
  })

  it('lets a server that frees the port and is still tearing down exit on its own', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-stop-grace-'))
    const slow = fakeServer(1.5)
    await new Promise((r) => setTimeout(r, 200))

    const out = await runBlock([slow.pid!], 8)
    await exited(slow)

    expect(out.code).toBe(0)
    expect(slow.signalCode).toBeNull()
    expect(slow.exitCode).toBe(0)
    expect(fs.existsSync(path.join(dir, `done-${slow.pid}`))).toBe(true)
    expect(out.stderr).not.toContain('SIGKILL')
  })

  it('still SIGKILLs a server that ignores SIGTERM, once the grace is over', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-stop-grace-'))
    const immune = fakeServer(null)
    const slow = fakeServer(1)
    await new Promise((r) => setTimeout(r, 200))

    const out = await runBlock([immune.pid!, slow.pid!], 3)
    await Promise.all([exited(immune), exited(slow)])

    expect(out.code).toBe(0)
    expect(immune.signalCode).toBe('SIGKILL')
    expect(out.stderr).toContain(`Server PID ${immune.pid} did not exit 3s after SIGTERM; sending SIGKILL.`)
    expect(out.ms).toBeGreaterThanOrEqual(2_000)
    // The slow one exits inside the same grace window, never killed.
    expect(slow.signalCode).toBeNull()
    expect(fs.existsSync(path.join(dir, `done-${slow.pid}`))).toBe(true)
  })

  it('rejects a non-numeric grace knob with a default instead of aborting under set -u', () => {
    const knob = script.slice(script.indexOf('STOP_GRACE_SECS="${WALNUT_DEVPROD_STOP_GRACE_SECS:-8}"'))
    expect(knob).toMatch(/\^\[0-9\]\+\$/)
    const r = execFileSync('bash', ['-c', `set -euo pipefail\nWALNUT_DEVPROD_STOP_GRACE_SECS=soon\n${knob.slice(0, knob.indexOf('fi') + 2)}\necho "grace=$STOP_GRACE_SECS"`], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
    expect(r.trim()).toBe('grace=8')
  })
})
