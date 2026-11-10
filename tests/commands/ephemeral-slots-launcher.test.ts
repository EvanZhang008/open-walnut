/**
 * The real `web --ephemeral` launcher (runEphemeralLauncher) with every slot held: it waits,
 * says who holds them, gives up after WALNUT_EPHEMERAL_WAIT_MINUTES with exit 1, and copies
 * nothing, starts nothing. The holder is a plain `sleep`, so no real server runs here.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

const LAUNCHER = path.join(import.meta.dirname, '../../src/commands/web-ephemeral.ts')
const dirs: string[] = []
const kids: ChildProcess[] = []
afterEach(() => {
  for (const k of kids.splice(0)) { try { process.kill(k.pid!, 'SIGKILL') } catch { /* gone */ } }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('web --ephemeral launcher with no free slot', () => {
  it('waits, names the holder, gives up with what to do, and leaves no snapshot or marker', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-eph-slot-e2e-')))
    // The runtime root must be short (unix socket length) and private.
    const runtimeRoot = fs.mkdtempSync('/tmp/wse-')
    fs.chmodSync(runtimeRoot, 0o700)
    dirs.push(root, runtimeRoot)
    const home = path.join(root, 'home'); fs.mkdirSync(home)
    const tmp = path.join(root, 'tmp'); fs.mkdirSync(tmp)
    const slots = path.join(root, 'slots'); fs.mkdirSync(slots)
    const holder = spawn('sleep', ['120'], { stdio: 'ignore' })
    kids.push(holder)
    fs.writeFileSync(path.join(slots, 'slot-0.json'), JSON.stringify({ pid: holder.pid, start: '', role: 'server', takenAt: Date.now() - 5 * 60_000, port: 47001, ownerPid: 4321, ownerCommand: 'claude -p', lastRequestAt: Date.now() - 2 * 60_000, idleLimitMinutes: 240 }))

    // `--ephemeral` in argv, as the CLI has it: the runtime root override is read only then.
    const driver = path.join(root, 'launch.ts')
    fs.writeFileSync(driver, `const m = await import(${JSON.stringify(LAUNCHER)}); await m.runEphemeralLauncher()\n`)
    const started = Date.now()
    const r = spawnSync(process.execPath, [driver, '--ephemeral'], {
      encoding: 'utf-8', timeout: 60_000,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.homedir(), TMPDIR: tmp,
        OPEN_WALNUT_HOME: home, WALNUT_EPHEMERAL_SLOT_DIR: slots, WALNUT_EPHEMERAL_RUNTIME_ROOT: runtimeRoot,
        WALNUT_EPHEMERAL_EXIT_LOG: path.join(root, 'exit.log'), WALNUT_EPHEMERAL_OWNER_PID: '0',
        WALNUT_EPHEMERAL_MAX: '1', WALNUT_EPHEMERAL_WAIT_MINUTES: '0.05',
      },
    })
    expect(r.status, r.stderr).toBe(1)
    expect(Date.now() - started).toBeGreaterThanOrEqual(3_000)
    expect(r.stderr).toContain('1 Walnut test server already runs on this machine, and at most 1 run at once (WALNUT_EPHEMERAL_MAX=1)')
    expect(r.stderr).toContain(`pid ${holder.pid}, port 47001, owner pid 4321 (claude -p), up 5 min, idle 2.0 min of 240`)
    expect(r.stderr).toContain('gave up after 3 s: 1 Walnut test server still runs')
    const json = JSON.parse(r.stdout.trim().split('\n').pop()!)
    expect(json).toMatchObject({ error: true, running: 1, limit: 1 })
    // Nothing was copied or started, and the holder keeps its slot.
    expect(fs.readdirSync(tmp).filter((n) => n.startsWith('open-walnut-'))).toEqual([])
    expect(fs.readdirSync(runtimeRoot)).toEqual([])
    expect(fs.readdirSync(slots).sort()).toEqual(['slot-0.json'])
  }, 90_000)
})
