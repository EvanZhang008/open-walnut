/**
 * A service set's daemon never writes the account's engine skill places, on the real daemon.
 *
 * The hub pushes its skills on every connect (`skills.sync`): one real copy per skill in
 * ~/.open-walnut/distributed-skills/<name>/ and a link to it in each engine's skill dir
 * (~/.claude/skills, ~/.agents/skills, ~/.gemini/skills). Those places are one per OS account,
 * and on a shared machine the default service belongs to the other person's Walnut: a set's
 * daemon writing them overwrites their skills (2026-11-24 decision). So, as with the user PATH
 * shim, only the default set writes them. A set's daemon answers the push and its probe with
 * `skipped: 'default-service'` (held, so the hub sends nothing again), never an error.
 * The control: the same daemon as the default set writes them.
 *
 * What's real: the daemon under bun, in `--service` mode. MACHINE SAFETY: every dir is under this file's temp dir, and the test signals
 * only its own children's process groups.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'
import { TRIGGER_BUN as BUN, TriggerDaemon, killTriggerDaemons, type Twin } from '../helpers/trigger-daemon.js'

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-set-skills-')))
afterAll(() => { if (base.includes('walnut-set-skills-')) fs.rmSync(base, { recursive: true, force: true }) })
afterEach(killTriggerDaemons)

const SET = '0123456789abcdef'
const SKILL = '---\nname: walnut\n---\n<!-- walnut-managed v1: READ-ONLY -->\n# Walnut manual\n'
const TWINS: Twin[] = BUN ? ['standalone'] : []

const run = (set: string, home: string, dir: (n: string) => string) => (set ? dir('run') : path.join(home, '.cache', 'open-walnut'))

async function daemon(twin: Twin, set: string): Promise<{ d: TriggerDaemon; home: string }> {
  const t = fs.mkdtempSync(path.join(base, `${twin}-${set || 'default'}-`))
  const dir = (name: string) => path.join(t, name)
  const home = dir('h')
  // Engines installed for this account: each engine dir would get its link.
  for (const d of ['.claude', '.codex', '.gemini']) fs.mkdirSync(path.join(home, d), { recursive: true })
  fs.mkdirSync(dir('tmp'))
  const env: Record<string, string> = {
    HOME: home, PATH: guardedPath([], '/usr/bin:/bin'), TMPDIR: dir('tmp'), LANG: 'C',
    // A set runs in its own dir; the default set in a production dir: the home fallback one, so it stays under this test's HOME.
    WALNUT_DAEMON_DIR: run(set, home, dir), WALNUT_DAEMON_STATE_DIR: dir('install-root'), WALNUT_DAEMON_SUPERVISOR: 'cron',
    WALNUT_STREAMS_DIR: dir('st'), WALNUT_LEGACY_STREAMS_DIR: dir('ls'), WALNUT_SPAWN_JOURNAL: dir('sj.jsonl'),
    WALNUT_JOURNAL_DIR: dir('j'), WALNUT_TASK_DIR_ROOT: dir('t'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    ...(set ? { WALNUT_SERVICE_SET: set } : {}),
  }
  return { d: await TriggerDaemon.start(twin, { mode: '--service', env, runDir: run(set, home, dir), cwd: home }), home }
}

/** The account-wide skill places under `home` that hold anything. */
function skillPlaces(home: string): string[] {
  return [
    ['.open-walnut', 'distributed-skills'], ['.claude', 'skills'], ['.agents', 'skills'], ['.gemini', 'skills'],
  ].map((p) => path.join(home, ...p)).filter((p) => { try { return fs.readdirSync(p).length > 0 } catch { return false } })
}

describe.skipIf(!BUN)('a service set\'s daemon leaves the account\'s engine skill places to the default service', () => {
  it.each(TWINS)('%s: a set answers the push and its probe as kept by the default service, and writes nothing', async (twin) => {
    const { d, home } = await daemon(twin, SET)
    const push = await d.rpc({ cmd: 'skills.sync', hash: 'h1', skill: SKILL, skills: [{ name: 'walnut', skill: SKILL }, { name: 'walnut-trigger', skill: SKILL }] })
    expect(skillPlaces(home)).toEqual([])
    expect(push).toMatchObject({ ok: true, changed: false, skipped: 'default-service' })
    expect(String(push.why)).toMatch(/kept by the default service/)
    // The probe a restarted hub sends first: held, so the skills (about 360 KB) never cross again.
    const probe = await d.rpc({ cmd: 'skills.sync', probe: true, hash: 'h1' })
    expect(probe).toMatchObject({ ok: true, held: true, skipped: 'default-service' })
    expect(skillPlaces(home)).toEqual([])
  }, 120_000)

  it.each(TWINS)('%s: the default set\'s daemon writes them, as before', async (twin) => {
    const { d, home } = await daemon(twin, '')
    const push = await d.rpc({ cmd: 'skills.sync', hash: 'h1', skill: SKILL, skills: [{ name: 'walnut', skill: SKILL }] })
    expect(push).toMatchObject({ ok: true, applied: true, changed: true })
    expect(skillPlaces(home)).toEqual(expect.arrayContaining([path.join(home, '.open-walnut', 'distributed-skills'), path.join(home, '.claude', 'skills')]))
  }, 120_000)
})
