/**
 * The trial run before a service change (src/providers/daemon-boot-proof.ts) against BOTH
 * real daemon twins in service mode (`--service`, as the LaunchAgent, the user unit and the
 * boot script start it): each boots in the trial's own dirs, with nothing of this process's
 * env, listens, stays up, and is stopped; the trial dir is gone afterwards.
 *
 * MACHINE SAFETY: the trial's dirs are under this file's temp dir (base), its PATH has the
 * exec guard first, and the code under test signals only its own child's group.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { afterAll, describe, expect, it } from 'vitest'
import { proveDaemonBoot } from '../../src/providers/daemon-boot-proof.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { guardedPath } from '../setup/exec-guard.js'
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-boot-proof-twins-')))
afterAll(() => { if (root.includes('walnut-boot-proof-twins-')) fs.rmSync(root, { recursive: true, force: true }) })
const script = path.join(root, 'daemon.cjs')
fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
const BUN = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
if (BUN) {
  // The sidecars the JS twin loads from beside itself; --service needs the cron runtime and the lock.
  for (const name of ['task-dir-core', 'host-exec-core', 'daemon-cron-runtime', 'daemon-instance-lock']) {
    const built = spawnSync(BUN, ['build', '--target=node', '--format=cjs', '--outfile', path.join(root, `${name}.cjs`),
      path.resolve(__dirname, `../../src/providers/${name}.ts`)], { encoding: 'utf8' })
    if (built.status !== 0) throw new Error('sidecar build failed: ' + built.stderr)
  }
}
const TWINS: Array<[string, () => { executable: string; args: string[] }]> = BUN ? [
  [`source twin (${SOURCE_TWIN.runtime})`, () => ({ executable: SOURCE_TWIN.file, args: [script, '--service'] })],
  ['standalone twin (bun)', () => ({ executable: BUN, args: [STANDALONE, '--service'] })],
] : []

describe.skipIf(!BUN)('the trial run against the real daemon twins', () => {
  it.each(TWINS)('%s boots in service mode in its own dirs and is stopped', async (_name, twin) => {
    const base = fs.mkdtempSync(path.join(root, 'base-'))
    const why = await proveDaemonBoot({ ...twin(), path: guardedPath([], '/usr/bin:/bin'), base, waitMs: 30_000, aliveMs: 1_500 })
    expect(why).toBeNull()
    // Nothing of the trial is left: no dir, so no daemon's runtime files either.
    expect(fs.readdirSync(base)).toEqual([])
  }, 60_000)
})

// 2026-11-04 review: a --service trial has no parent watchdog, so one whose prover died (the CLI,
// the server, the SSH session) stayed as a full daemon in its proof dir for good.
describe.skipIf(!BUN)('a trial daemon ends by itself after its lifetime', () => {
  it.each(TWINS)('%s exits on its own once WALNUT_DAEMON_LIFETIME_SECONDS is over', async (_name, twin) => {
    const t = fs.mkdtempSync(path.join(root, 'life-'))
    const dir = (name: string) => path.join(t, name)
    for (const name of ['h', 'tmp']) fs.mkdirSync(dir(name))
    const env: Record<string, string> = {
      HOME: dir('h'), PATH: guardedPath([], '/usr/bin:/bin'), TMPDIR: dir('tmp'), LANG: 'C',
      WALNUT_DAEMON_DIR: dir('d'), WALNUT_DAEMON_STATE_DIR: dir('s'), WALNUT_STREAMS_DIR: dir('st'), WALNUT_LEGACY_STREAMS_DIR: dir('ls'),
      WALNUT_SPAWN_JOURNAL: dir('sj.jsonl'), WALNUT_JOURNAL_DIR: dir('j'), WALNUT_TASK_DIR_ROOT: dir('t'),
      XDG_STATE_HOME: path.join(dir('h'), '.local', 'state'), XDG_CONFIG_HOME: path.join(dir('h'), '.config'),
      XDG_CACHE_HOME: path.join(dir('h'), '.cache'), XDG_DATA_HOME: path.join(dir('h'), '.local', 'share'),
      WALNUT_DAEMON_LIFETIME_SECONDS: '4',
    }
    const { executable, args } = twin()
    const child = spawn(executable, args, { cwd: dir('h'), env, detached: true, stdio: 'ignore' })
    let exited = false
    child.on('exit', () => { exited = true })
    const started = Date.now()
    try {
      // It served first: the lifetime is not a failure to start.
      while (!fs.existsSync(path.join(dir('d'), 'daemon.port')) && !exited && Date.now() - started < 30_000) await new Promise((r) => setTimeout(r, 100))
      expect(exited).toBe(false)
      while (!exited && Date.now() - started < 40_000) await new Promise((r) => setTimeout(r, 100))
      expect(exited).toBe(true)
      expect(Date.now() - started).toBeGreaterThanOrEqual(3_500)
    } finally {
      // Only this test's own child group, and only while it still runs.
      if (!exited && typeof child.pid === 'number' && child.pid > 1) try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ }
    }
  }, 60_000)
})

// 2026-11-04 review: the lifetime was armed only once startup was done, so a trial that hung on
// its way up (before it served) stayed for good. Both twins now arm it at load, before startup.
describe('the trial lifetime is armed before startup in both twins', () => {
  it.each([
    ['source twin', () => getDaemonSource()],
    ['standalone twin', () => fs.readFileSync(STANDALONE, 'utf8')],
  ] as const)('%s', (_name, text) => {
    const source = text()
    const armed = source.indexOf('trial lifetime reached')
    expect(armed).toBeGreaterThan(0)
    expect(armed).toBeLessThan(source.search(/\nconst action = process\.argv\[2\]/))
    expect(armed).toBeLessThan(source.search(/\n(\} else )?if \(action === '--start' \|\| SERVICE_MODE\)/))
    expect(source.split('trial lifetime reached')).toHaveLength(2)
  })
})
