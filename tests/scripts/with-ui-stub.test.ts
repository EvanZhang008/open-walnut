/**
 * ios-native/tests/ui/with-ui-stub.sh: the one way a UI run gets the mid-turn stub
 * (`scripts/ios-fleet-test.sh --stub ui`, remote-run.sh's `--stub`). It starts the stub on a
 * port the kernel picks, hands the command WALNUT_UITEST_SERVER, keeps the command's exit
 * status, and stops the stub it started.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const SCRIPT = path.resolve(__dirname, '../../ios-native/tests/ui/with-ui-stub.sh')
let dir = ''

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'with-ui-stub-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

describe('with-ui-stub.sh', () => {
  it('runs the command against a live stub, keeps its exit status and stops the stub', () => {
    const log = path.join(dir, 'stub.log')
    const probe = `fetch(process.env.WALNUT_UITEST_SERVER + '/__stub/state').then((r) => process.exit(r.ok ? 7 : 1), () => process.exit(2))`
    const r = spawnSync('bash', [SCRIPT, log, process.execPath, '-e', probe], { encoding: 'utf8', timeout: 60_000 })
    expect(r.status, r.stderr).toBe(7)
    const pid = Number(/pid (\d+)\)/.exec(r.stdout)?.[1])
    expect(pid).toBeGreaterThan(0)
    expect(alive(pid)).toBe(false)
    expect(fs.readFileSync(log, 'utf8')).toMatch(/^PORT \d+/)
  })

  it('refuses with nothing to run', () => {
    const r = spawnSync('bash', [SCRIPT, path.join(dir, 'stub.log')], { encoding: 'utf8' })
    expect(r.status).toBe(64)
  })
})
