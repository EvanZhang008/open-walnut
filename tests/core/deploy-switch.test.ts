/**
 * src/core/deploy-switch.ts: a server Walnut.app starts on its own while a deploy switches the
 * server lets the deploy's server take the instance lock.
 *
 * 2026-11-21: the app restarted the server it had started one second after every deploy stopped
 * it, and that restart took the lock before the deploy's compiled file could; production then
 * ran the app's `bun dist/cli.js` server and remote hosts got a daemon without the ACP files.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  DEPLOY_SWITCH_TTL_MS, deploySwitchFile, isAppStartedServer, liveServiceLauncher, parseDeploySwitch, serviceLauncherFile, waitOutDeploySwitch,
} from '../../src/core/deploy-switch.js'

const APP_ENV = { WALNUT_LAUNCHER: 'mac-app' } as NodeJS.ProcessEnv
const dirs: string[] = []
const kids: { kill: (s: NodeJS.Signals) => void }[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  for (const k of kids.splice(0)) { try { k.kill('SIGKILL') } catch { /* gone */ } }
})

function home(): { home: string; lockFile: string } {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-switch-'))
  dirs.push(h)
  fs.mkdirSync(path.join(h, 'local'))
  return { home: h, lockFile: path.join(h, 'server.lock.json') }
}

/** A live process that is not this one: a deploy, or the deploy's server holding the lock. */
function livePid(): number {
  const c = spawn('sleep', ['30'], { stdio: 'ignore' })
  kids.push(c)
  return c.pid!
}

function writeSwitch(h: string, pid: number, at = new Date().toISOString()): void {
  fs.writeFileSync(deploySwitchFile(h), JSON.stringify({ pid, at }))
}

/** A clock the waits advance, so no test sleeps for real. */
function clock() {
  let t = Date.now()
  return { now: () => t, sleep: async (ms: number) => { t += ms } }
}

describe('who waits', () => {
  it('only a server Walnut.app started itself (its own mark), never a deploy\'s server or any other', () => {
    expect(isAppStartedServer({ WALNUT_LAUNCHER: 'mac-app' })).toBe(true)
    // The app passes its own environment on: opened from a deploy's server, it carries that label.
    expect(isAppStartedServer({ WALNUT_LAUNCHER: 'mac-app', WALNUT_LAUNCHD_LABEL: 'com.open-walnut.dev-prod' })).toBe(true)
    expect(isAppStartedServer({})).toBe(false)
    expect(isAppStartedServer({ WALNUT_LAUNCHER: 'cli' })).toBe(false)
  })

  it('reads only a marker that names a pid and a recent time', () => {
    const now = Date.parse('2026-11-21T02:00:00Z')
    expect(parseDeploySwitch('{"pid":4242,"at":"2026-11-21T01:59:00Z"}', now)).toEqual({ pid: 4242, at: Date.parse('2026-11-21T01:59:00Z') })
    expect(parseDeploySwitch(`{"pid":4242,"at":"${new Date(now - DEPLOY_SWITCH_TTL_MS - 1000).toISOString()}"}`, now)).toBeNull()
    expect(parseDeploySwitch('{"pid":1,"at":"2026-11-21T01:59:00Z"}', now)).toBeNull()
    expect(parseDeploySwitch('{"at":"2026-11-21T01:59:00Z"}', now)).toBeNull()
    expect(parseDeploySwitch('not json', now)).toBeNull()
  })
})

describe('waitOutDeploySwitch', () => {
  it('waits until the deploy\'s server holds the lock (the 2026-11-21 race)', async () => {
    const { home: h, lockFile } = home()
    writeSwitch(h, livePid())
    const c = clock()
    let polls = 0
    const outcome = await waitOutDeploySwitch({
      home: h, lockFile, env: APP_ENV, now: c.now,
      sleep: async (ms) => {
        await c.sleep(ms)
        // The deploy's server takes the lock a few polls in.
        // First the outgoing server still holds the lock while it shuts down: not the deploy's.
        if (++polls === 1) fs.writeFileSync(lockFile, JSON.stringify({ pid: livePid(), port: 3456, startedAt: '2026-11-20T01:00:00.000Z' }))
        if (polls === 3) fs.writeFileSync(lockFile, JSON.stringify({ pid: livePid(), port: 3456, startedAt: new Date(c.now()).toISOString() }))
      },
    })
    expect(outcome).toBe('lock-taken')
    expect(polls).toBe(3)
  })

  it('starts as before once the deploy ends, its process is gone, or the wait runs out', async () => {
    const { home: h, lockFile } = home()
    const deploy = livePid()
    writeSwitch(h, deploy)
    const c = clock()
    expect(await waitOutDeploySwitch({ home: h, lockFile, env: APP_ENV, now: c.now, sleep: async (ms) => { await c.sleep(ms); fs.rmSync(deploySwitchFile(h)) } })).toBe('ended')

    writeSwitch(h, deploy)
    expect(await waitOutDeploySwitch({ home: h, lockFile, env: APP_ENV, now: c.now, sleep: c.sleep, maxWaitMs: 5_000 })).toBe('timeout')

    // A lock this process holds itself is not the deploy's server.
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date(c.now()).toISOString() }))
    expect(await waitOutDeploySwitch({ home: h, lockFile, env: APP_ENV, now: c.now, sleep: c.sleep, maxWaitMs: 1_000 })).toBe('timeout')
  })

  it('does not wait at all without a live switch, or for a server the app did not start', async () => {
    const { home: h, lockFile } = home()
    const c = clock()
    expect(await waitOutDeploySwitch({ home: h, lockFile, env: APP_ENV, now: c.now, sleep: c.sleep })).toBe('none')
    const gone = spawn('true'); await new Promise((r) => gone.on('exit', r))
    writeSwitch(h, gone.pid!)
    expect(await waitOutDeploySwitch({ home: h, lockFile, env: APP_ENV, now: c.now, sleep: c.sleep })).toBe('none')
    writeSwitch(h, livePid())
    expect(await waitOutDeploySwitch({ home: h, lockFile, env: { WALNUT_LAUNCHD_LABEL: 'x' }, now: c.now, sleep: c.sleep })).toBe('none')
  })
})

describe('the service launcher keeps the server (the Mac\'s one service)', () => {
  /** A launcher state dir with a live launcher pid, named by the home's service-launcher.json. */
  function installLauncher(h: string, pid: number): string {
    const state = path.join(h, 'service')
    fs.mkdirSync(state, { recursive: true })
    fs.writeFileSync(path.join(state, 'daemon-boot.pid'), `${pid}\n`)
    fs.writeFileSync(serviceLauncherFile(h), JSON.stringify({ state }))
    return state
  }

  it('an app-started server waits for the launcher\'s server, even one that started before it, and then attaches', async () => {
    const { home: h, lockFile } = home()
    installLauncher(h, livePid())
    expect(await liveServiceLauncher(h)).toBeGreaterThan(1)
    const c = clock()
    let polls = 0
    const outcome = await waitOutDeploySwitch({
      home: h, lockFile, env: APP_ENV, now: c.now,
      sleep: async (ms) => {
        await c.sleep(ms)
        // The launcher's server (started long ago, after a login) holds the lock.
        if (++polls === 2) fs.writeFileSync(lockFile, JSON.stringify({ pid: livePid(), port: 3456, startedAt: '2026-11-01T00:00:00.000Z' }))
      },
    })
    expect(outcome).toBe('lock-taken')
    expect(polls).toBe(2)
  })

  it('a launcher that is not running, or no launcher, lets the app\'s server start as before', async () => {
    const { home: h, lockFile } = home()
    const c = clock()
    const gone = spawn('true'); await new Promise((r) => gone.on('exit', r))
    installLauncher(h, gone.pid!)
    expect(await liveServiceLauncher(h)).toBeNull()
    expect(await waitOutDeploySwitch({ home: h, lockFile, env: APP_ENV, now: c.now, sleep: c.sleep })).toBe('none')
    fs.writeFileSync(serviceLauncherFile(h), 'not json')
    expect(await liveServiceLauncher(h)).toBeNull()
    fs.writeFileSync(serviceLauncherFile(h), JSON.stringify({ state: 'relative/dir' }))
    expect(await liveServiceLauncher(h)).toBeNull()
  })

  it('bounded: a launcher whose server never takes the lock lets it start after the wait, and one that dies ends the wait', async () => {
    const { home: h, lockFile } = home()
    const launcher = spawn('sleep', ['30'], { stdio: 'ignore' })
    kids.push(launcher)
    installLauncher(h, launcher.pid!)
    const c = clock()
    expect(await waitOutDeploySwitch({ home: h, lockFile, env: APP_ENV, now: c.now, sleep: c.sleep, maxWaitMs: 2_000 })).toBe('timeout')
    let polls = 0
    expect(await waitOutDeploySwitch({
      home: h, lockFile, env: APP_ENV, now: c.now,
      sleep: async (ms) => {
        await c.sleep(ms)
        if (++polls === 1) { launcher.kill('SIGKILL'); await new Promise((r) => launcher.on('exit', r)) }
      },
    })).toBe('ended')
    // Never for a server the app did not start (the launcher's own, a deploy's).
    installLauncher(h, livePid())
    expect(await waitOutDeploySwitch({ home: h, lockFile, env: {}, now: c.now, sleep: c.sleep })).toBe('none')
  })
})

describe('the server and the deploy keep the contract', () => {
  const repo = path.join(import.meta.dirname, '..', '..')
  const server = fs.readFileSync(path.join(repo, 'src', 'web', 'server.ts'), 'utf8')
  const devProd = fs.readFileSync(path.join(repo, 'scripts', 'dev-prod.sh'), 'utf8')

  it('the server waits right before it takes the instance lock', () => {
    const wait = server.indexOf('await waitOutDeploySwitch(')
    const lock = server.indexOf('acquireInstanceLock(port)')
    expect(wait).toBeGreaterThan(-1)
    expect(lock).toBeGreaterThan(wait)
  })

  it('the deploy writes the switch right before the stop, at the file the server reads, and removes its own at exit', () => {
    expect(devProd).toMatch(/^drain_active_turns\nwrite_planned_restart\nwrite_deploy_switch\n/m)
    expect(devProd.search(/^write_deploy_switch$/m)).toBeLessThan(devProd.indexOf('kill -15 $existing_pids'))
    expect(devProd).toContain('DEPLOY_SWITCH_FILE="${REHEARSAL_HOME:-$HOME/.open-walnut}/local/deploy-switch.json"')
    expect(deploySwitchFile('/h')).toBe('/h/local/deploy-switch.json')
    const traps = [...devProd.matchAll(/^trap '([^']*)' EXIT$/gm)]
    expect(traps.at(-1)![1]).toMatch(/deploy_switch_cleanup/)
    // What it writes is what the server parses.
    const fmt = /printf '(\{"pid":%s,"at":"%s"\})\\n' "\$\$"/.exec(devProd)
    expect(fmt).not.toBeNull()
    expect(parseDeploySwitch(fmt![1].replace('%s', '4242').replace('%s', new Date().toISOString().replace(/\.\d+Z$/, 'Z')))?.pid).toBe(4242)
  })
})
