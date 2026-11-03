/**
 * The restart handler `walnut web` registers (src/commands/web-restart.ts), run
 * for real in a child process (tests/fixtures/self-update/restart-handler-child.ts):
 *
 *   - supervised (a looping parent started it): teardown, then exit 75, nothing more;
 *   - not supervised: no handler at all (a server that can restart is always
 *     supervised: restart-supervisor.ts), so nothing is torn down.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = path.resolve(import.meta.dirname, '../fixtures/self-update/restart-handler-child.ts')

let dir: string
let log: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-restart-'))
  log = path.join(dir, 'log.jsonl')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

function run(extra: Record<string, string>): Promise<number> {
  const env: NodeJS.ProcessEnv = { ...process.env, OPEN_WALNUT_HOME: path.join(dir, 'home'), RESTART_HANDLER_LOG: log, ...extra }
  delete env.WALNUT_UPDATE_APPLIED
  if (!extra.WALNUT_RESTART_SUPERVISED) delete env.WALNUT_RESTART_SUPERVISED
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (b) => { err += b })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out: ${err}`)) }, 60_000)
    child.on('exit', (code) => { clearTimeout(timer); resolve(code ?? -1) })
  })
}

const entries = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)

describe('the live restart handler', () => {
  it('supervised: tears down, then exits 75 for its parent to start the update', async () => {
    expect(await run({ WALNUT_RESTART_SUPERVISED: '1' })).toBe(75)
    const seen = entries()
    expect(seen.map((e) => e.what)).toEqual(['start', 'asked', 'teardown'])
    expect(seen[0]).toMatchObject({ supervised: true, leaked: null })
    expect(seen[1]).toMatchObject({ ok: true })
    expect(fs.readFileSync(`${log}.exit`, 'utf8')).toMatch(/SERVER EXIT: restarting into an update \(exit 75\)/)
  }, 90_000)

  it('not supervised: no restart handler, so Restart answers no_restart and nothing is torn down', async () => {
    expect(await run({})).toBe(0)
    const seen = entries()
    expect(seen.map((e) => e.what)).toEqual(['start', 'asked'])
    expect(seen[0]).toMatchObject({ supervised: false })
    expect(seen[1]).toMatchObject({ ok: false, code: 'no_restart' })
    expect(fs.existsSync(`${log}.exit`)).toBe(false)
  }, 90_000)
})
