/**
 * A service set's session keeps the set's runtime place, so the `walnut` it runs unpacks there.
 *
 * The gateway shim a session runs `walnut` through executes `<copy of the daemon's file> walnut ...`;
 * when that file is the compiled walnut file it unpacks its runtime tree first. The daemon used to
 * drop WALNUT_RUNTIME_DIR from every session's env (it names a deploy's stage dir, which a later
 * deploy deletes), so in a set's session every `walnut` call unpacked into the default Walnut's
 * ~/.open-walnut/local/runtime and pruned it (review of the 2026-11-24 drill fixes, B2). A set's
 * runtime dir is its install root's, which no deploy deletes: a set's daemon keeps it.
 *
 * What's real: the daemon under bun in `--service` mode, a session it starts (a shell that writes
 * its env), and the walnut file's unpack (ensureRuntime) run with exactly that env.
 * MACHINE SAFETY: every dir is under this file's temp dir; the test signals only its own children.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { packArchive } from '../../src/binary/asset-archive.js'
import { RUNTIME_MARKER, ensureRuntime } from '../../src/binary/runtime-tree.js'
import { guardedPath } from '../setup/exec-guard.js'
import { TRIGGER_BUN as BUN, TriggerDaemon, killTriggerDaemons, waitFor } from '../helpers/trigger-daemon.js'

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-set-session-rt-')))
afterAll(() => { if (base.includes('walnut-set-session-rt-')) fs.rmSync(base, { recursive: true, force: true }) })
afterEach(killTriggerDaemons)

const SET = '0123456789abcdef'
const SID = 'eeeeeeee-0000-4000-8000-0000000000b2'
const saved = { ...process.env }
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
  Object.assign(process.env, saved)
})

/** The env a session of this daemon gets, as its CLI sees it. */
async function sessionEnv(set: string, runtimeDir: string): Promise<{ env: Record<string, string>; home: string }> {
  const t = fs.mkdtempSync(path.join(base, `${set || 'default'}-`))
  const dir = (name: string) => path.join(t, name)
  const home = dir('h')
  fs.mkdirSync(home)
  fs.mkdirSync(dir('tmp'))
  const run = set ? dir('run') : path.join(home, '.cache', 'open-walnut')
  const env: Record<string, string> = {
    HOME: home, SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'), TMPDIR: dir('tmp'), LANG: 'C',
    WALNUT_DAEMON_DIR: run, WALNUT_DAEMON_STATE_DIR: dir('install-root'), WALNUT_DAEMON_SUPERVISOR: 'cron',
    WALNUT_STREAMS_DIR: dir('st'), WALNUT_LEGACY_STREAMS_DIR: dir('ls'), WALNUT_SPAWN_JOURNAL: dir('sj.jsonl'),
    WALNUT_JOURNAL_DIR: dir('j'), WALNUT_TASK_DIR_ROOT: dir('t'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    WALNUT_RUNTIME_DIR: runtimeDir.replace('$HOME', home),
    ...(set ? { WALNUT_SERVICE_SET: set } : {}),
  }
  const d = await TriggerDaemon.start('standalone', { mode: '--service', env, runDir: run, cwd: home })
  const out = dir('session-env.json')
  const sh = `${JSON.stringify(process.execPath)} -e 'require("fs").writeFileSync(process.argv[process.argv.length - 1], JSON.stringify(process.env))' ${JSON.stringify(out)}; sleep 30`
  const r = await d.rpc({ cmd: 'start', sid: SID, cwd: home, message: '', mode: 'default', resume: false, args: ['/bin/sh', '-c', sh, 'sh', '--session-id', SID] })
  expect(r, JSON.stringify(r)).toMatchObject({ ok: true })
  await waitFor(() => (fs.existsSync(out) && fs.statSync(out).size > 0 ? true : undefined), 20_000, 'the session to write its env')
  try { if (typeof r.pid === 'number' && r.pid > 1) process.kill(r.pid, 'SIGKILL') } catch { /* gone */ }
  return { env: JSON.parse(fs.readFileSync(out, 'utf8')) as Record<string, string>, home }
}

const OLD = ['0.9.0-000000000001', '0.9.0-000000000002', '0.9.0-000000000003']
function plantOld(parent: string): void {
  OLD.forEach((id, i) => {
    fs.mkdirSync(path.join(parent, id), { recursive: true })
    fs.writeFileSync(path.join(parent, id, RUNTIME_MARKER), `${id}\n`)
    const t = new Date(Date.now() - (OLD.length - i) * 3600_000)
    fs.utimesSync(path.join(parent, id, RUNTIME_MARKER), t, t)
  })
}
const ls = (dir: string): string[] => { try { return fs.readdirSync(dir).sort() } catch { return [] } }

describe.skipIf(!BUN)('a set\'s session runs walnut with the set\'s runtime place', () => {
  it('the session env keeps the set\'s WALNUT_RUNTIME_DIR, and a walnut run with it leaves the default home untouched', async () => {
    const setTrees = `$HOME/.open-walnut-host/walnuts/${SET}/daemon/runtime`
    const { env, home } = await sessionEnv(SET, setTrees)
    expect(env.WALNUT_RUNTIME_DIR).toBe(setTrees.replace('$HOME', home))
    expect(env.WALNUT_SERVICE_SET).toBe(SET)
    // The walnut file the shim runs, started with exactly this env.
    const defaultTrees = path.join(home, '.open-walnut', 'local', 'runtime')
    plantOld(defaultTrees)
    for (const k of Object.keys(process.env)) delete process.env[k]
    Object.assign(process.env, env)
    const archive = path.join(home, 'assets.bin')
    fs.writeFileSync(archive, packArchive([{ path: 'package.json', mode: 0o644, data: Buffer.from('{}\n') }], 3))
    const root = ensureRuntime(archive, '1.0.0-bbbbbbbbbbbb')
    expect(root).toBe(path.join(env.WALNUT_RUNTIME_DIR!, '1.0.0-bbbbbbbbbbbb'))
    expect(ls(defaultTrees)).toEqual([...OLD].sort())
  }, 120_000)

  it('the default set\'s daemon still drops a deploy stage\'s WALNUT_RUNTIME_DIR', async () => {
    const { env } = await sessionEnv('', '/stage/dead-later/runtime')
    expect(env.WALNUT_RUNTIME_DIR).toBeUndefined()
  }, 120_000)
})
