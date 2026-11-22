/**
 * What the restore drill's trial server is given (src/core/backup/restore-drill-boot.ts): every
 * place it may write is inside the drill's folder, nothing that makes it another kind of server
 * reaches it, and the copy's config no longer names the live data home. And the doors of a trial
 * with no permit refuse as the permit's refusal does.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { checkTrialBoot, pointConfigAtCopy, trialChildEnv } from '../../../src/core/backup/restore-drill-boot.js'
import { TRIAL_NONCE_ENV } from '../../../src/core/trial-start/ticket.js'
import { assertOutwardDoor, closeOutwardDoorsForTrial, doorsClosed, isPermitRefusal, outwardDoorRefusal, setOutwardDoorChecker } from '../../../src/core/leader/switch/doors.js'

afterEach(() => setOutwardDoorChecker(null))

describe('trialChildEnv', () => {
  it('home, user home, XDG, temp, daemon and task folders all inside the sandbox; nothing else but how to run a program', () => {
    const base: NodeJS.ProcessEnv = {
      PATH: '/usr/bin', HOME: '/home/u', OPEN_WALNUT_HOME: '/home/u/.open-walnut', XDG_STATE_HOME: '/home/u/.local/state',
      WALNUT_LEADER_TRIAL: '1', WALNUT_LEADER_SWITCH_COMMIT: '3', WALNUT_ROLE: 'replica', WALNUT_CLOUD_MODE: '1', WALNUT_BIND_ADDRESS: '0.0.0.0',
      WALNUT_EPHEMERAL_BACKUP: '1', WALNUT_EPHEMERAL_LEADER_SWITCH: '1', WALNUT_SESSION_ID: 's', WALNUT_TASK_DIR: '/x', OPEN_WALNUT_EXIT_ON_ORPHAN: '1',
      ANTHROPIC_API_KEY: 'k', AWS_SECRET_ACCESS_KEY: 'k', HTTPS_PROXY: 'http://p', VITEST: 'true', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    }
    const env = trialChildEnv(base, '/tmp/walnut-restore-drill-Ab12Cd/home', '/tmp/walnut-restore-drill-Ab12Cd/boot', 'n0nce')
    expect(env.OPEN_WALNUT_HOME).toBe('/tmp/walnut-restore-drill-Ab12Cd/home')
    for (const k of ['HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'TMPDIR', 'WALNUT_DAEMON_DIR', 'WALNUT_TASK_DIR_ROOT']) {
      expect(env[k], k).toMatch(/^\/tmp\/walnut-restore-drill-Ab12Cd\/boot\//)
    }
    // Nothing else of the drill's env: only how to run a program here.
    expect(Object.keys(env).filter((k) => !/^(HOME|XDG_|TMPDIR$|TMP$|TEMP$|WALNUT_DAEMON_DIR$|WALNUT_TASK_DIR_ROOT$|OPEN_WALNUT_HOME$)/.test(k)).sort())
      .toEqual(['LANG', 'LC_ALL', 'PATH', TRIAL_NONCE_ENV].sort())
    expect(env[TRIAL_NONCE_ENV]).toBe('n0nce')
    expect(env.PATH).toBe('/usr/bin')
    // The parent's env is not touched.
    expect(base.WALNUT_ROLE).toBe('replica')
  })
})

describe('pointConfigAtCopy', () => {
  let dir: string
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  it('every string naming the live home points at the copy; other paths stay; no config, no change', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-cfg-'))
    const live = path.join(dir, 'live')
    const copy = path.join(dir, 'copy')
    await fs.mkdir(copy)
    expect(await pointConfigAtCopy(copy, [live])).toBe(0)
    await fs.writeFile(path.join(copy, 'config.yaml'), YAML.stringify({
      notes: { folder: `${live}/notes` }, lists: [live, `${live}x/not-inside`, '/elsewhere/y'], n: 3,
    }))
    expect(await pointConfigAtCopy(copy, [live, live])).toBe(2)
    expect(YAML.parse(await fs.readFile(path.join(copy, 'config.yaml'), 'utf8'))).toEqual({
      notes: { folder: `${copy}/notes` }, lists: [copy, `${live}x/not-inside`, '/elsewhere/y'], n: 3,
    })
  })
})

describe('closeOutwardDoorsForTrial', () => {
  it('every door refuses with the permit\'s refusal, and the doors read closed', () => {
    closeOutwardDoorsForTrial('restore-drill')
    expect(doorsClosed()).toBe(true)
    let err: unknown
    try { assertOutwardDoor('mail-send', 'op-1') } catch (e) { err = e }
    expect(isPermitRefusal(err)).toBe(true)
    expect(outwardDoorRefusal('push', 'op-2')).toMatch(/restore-drill trial server never acts outward/)
  })
})

describe('checkTrialBoot before its start', () => {
  let dir: string
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  it('a copy that cannot be readied fails the boot check with why, never the whole drill; a read-only config is made writable', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-restore-drill-'))
    const target = path.join(dir, 'home')
    await fs.mkdir(target)
    // local/ is a file: the ticket cannot be written there. Nothing is spawned.
    await fs.writeFile(path.join(target, 'local'), 'not a folder')
    await fs.writeFile(path.join(target, 'config.yaml'), YAML.stringify({ x: `${dir}/live/a` }), { mode: 0o400 })
    const r = await checkTrialBoot({ dir, target, dataDir: path.join(dir, 'live'), files: [], task: null })
    expect(r).toMatchObject({ id: 'boot', ok: false, detail: expect.stringMatching(/^The restored copy could not be readied for its boot: /) })
    expect(YAML.parse(await fs.readFile(path.join(target, 'config.yaml'), 'utf8'))).toEqual({ x: `${target}/a` })
  })
})
