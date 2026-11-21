/**
 * `walnut daemon update --launcher` (daemon-service-manager.ts) against the REAL launcher script and its
 * real control files (service-launcher-control.ts), systemctl played by the test: its restart stops the
 * running launcher with SIGTERM and starts the unit's script again, as systemd does. Review 2026-11-21:
 * an update whose unit text changed marked its switch prepared before that restart, so the old
 * launcher began the switch, the restart cut it off, and a healthy build read as rolled back (and was
 * held for a day). The switch must commit, with no switch cut off on the way.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createDaemonServiceManager, daemonServiceConfigPath, type DaemonServiceCommandResult } from '../../src/providers/daemon-service-manager.js'
import { renderDaemonSystemdUnit, type DaemonServiceConfig } from '../../src/providers/daemon-service-config.js'
import { createLauncherControl } from '../../src/providers/service-launcher-control.js'
import { guardedPath } from '../setup/exec-guard.js'

const DASH = fs.existsSync('/bin/dash') ? '/bin/dash' : null
let dir = ''
const launchers: ChildProcess[] = []

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-launcher-mgr-')) })
afterEach(() => {
  for (const c of launchers.splice(0)) { try { process.kill(c.pid!, 'SIGKILL') } catch { /* gone */ } }
  for (const line of (fs.existsSync(path.join(dir, 'runs')) ? fs.readFileSync(path.join(dir, 'runs'), 'utf8') : '').split('\n')) {
    const pid = Number(line.split(' ')[1]); if (pid > 1) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

const alive = (pid: number) => { try { process.kill(pid, 0) } catch { return false } return !/Z/.test(spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout) }
async function until(test: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms
  while (!test()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 100)) }
}

/** A daemon double: beats, writes ready, exits on TERM; each start logged in runs. */
function stub(name: string): string {
  const exe = path.join(dir, name)
  fs.writeFileSync(exe, [
    '#!/bin/sh', `echo "${name} $$" >> '${dir}/runs'`, "trap 'exit 0' TERM",
    'while :; do now=$(date +%s); echo "$now 0 $$" > "$WALNUT_LAUNCHER_DIR/hb.$$" && mv -f "$WALNUT_LAUNCHER_DIR/hb.$$" "$WALNUT_LAUNCHER_DIR/heartbeat"',
    '  [ -f "$WALNUT_LAUNCHER_DIR/ready.$$" ] || { printf "pid=%s\\n" $$ > "$WALNUT_LAUNCHER_DIR/ready"; : > "$WALNUT_LAUNCHER_DIR/ready.$$"; }',
    '  /bin/sleep 0.2', 'done', '',
  ].join('\n'), { mode: 0o700 })
  return exe
}
const running = (name: string) => (fs.existsSync(path.join(dir, 'runs')) ? fs.readFileSync(path.join(dir, 'runs'), 'utf8') : '').split('\n').filter((l) => l.startsWith(`${name} `)).map((l) => Number(l.split(' ')[1])).filter(alive)

describe.skipIf(!DASH || process.platform !== 'linux')('an update with the real launcher', () => {
  it('a launcher unit whose text changes: the restart comes first, then the switch, which commits', async () => {
    const home = path.join(dir, 'home'); const state = path.join(dir, 'state')
    fs.mkdirSync(home); fs.mkdirSync(state, { mode: 0o700 })
    const v1 = stub('v1'); const v2 = stub('v2')
    const L = createLauncherControl({ stateDir: state, backend: 'systemd', buildOf: async () => undefined })
    const config = (exe: string, searchPath: string): DaemonServiceConfig => ({ platform: 'linux', home, executable: exe, args: ['--service'], runtimeDir: path.join(dir, 'rt'), stateDir: state, path: searchPath })
    // What runs now: the launcher of an earlier build, its unit with another PATH (so the new unit differs).
    fs.writeFileSync(L.script, L.render(config(v1, '/usr/bin:/bin'), v1), { mode: 0o700 })
    const unitFile = daemonServiceConfigPath('linux', home, 'user')
    fs.mkdirSync(path.dirname(unitFile), { recursive: true })
    fs.writeFileSync(unitFile, renderDaemonSystemdUnit(config(v1, '/usr/bin:/bin'), 'user', { launcher: L.script }))
    const start = () => {
      const c = spawn(DASH!, [L.script, '--service'], { stdio: 'ignore', detached: true, env: { HOME: home, PATH: guardedPath([], '/usr/bin:/bin') } })
      launchers.push(c); return c
    }
    let current = start()
    await until(() => running('v1').length === 1, 8_000, 'v1 up')
    const order: string[] = []
    const run = async (program: string, args: string[]): Promise<DaemonServiceCommandResult> => {
      const line = [program, ...args].join(' ')
      if (line.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' }
      if (line.includes('is-enabled')) return { code: 0, stdout: 'enabled\n', stderr: '' }
      if (line.includes(' show ')) return { code: 0, stdout: `FragmentPath=${unitFile}\nDropInPaths=\n`, stderr: '' }
      if (line.startsWith('loginctl')) return { code: 0, stdout: 'Linger=yes\n', stderr: '' }
      if (line.includes(' restart ')) {
        // systemd's restart: SIGTERM to the unit's main process (the launcher), then its ExecStart again.
        const request = fs.readFileSync(path.join(state, 'launcher', 'request'), 'utf8')
        order.push(`restart with the request ${/prepared=1/.test(request) ? 'prepared' : 'not prepared'}`)
        process.kill(current.pid!, 'SIGTERM')
        await until(() => !alive(current.pid!), 70_000, 'old launcher stopped')
        current = start()
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    const manager = createDaemonServiceManager({
      platform: 'linux', home, uid: 1000, user: 'walnut', path: '/usr/local/bin:/usr/bin:/bin', stateDir: state, runtimeDir: path.join(dir, 'rt'), run,
      writeConfig: async (file, text) => { fs.writeFileSync(file, text) },
      removeConfig: async (file) => { fs.rmSync(file, { force: true }) },
      readConfig: async (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null),
      inspectConfig: async (file) => ({ present: fs.existsSync(file), owned: true }),
      prepareExecutable: async () => ({ executable: v2, args: ['--service'] }),
      ready: async () => true,
      stay: async () => null,
      // The old daemon prepares and exits; its launcher holds the unprepared switch and starts nothing.
      prepareUpdate: async () => { for (const pid of running('v1')) process.kill(pid, 'SIGTERM') },
      proveBoot: async () => null,
      launcher: L,
      sleep: async (ms) => { await new Promise((r) => setTimeout(r, Math.min(ms, 200))) },
    })
    const result = await manager.update({ scope: 'user' })
    expect(result.ok).toBe(true)
    expect(order).toEqual(['restart with the request not prepared'])
    const log = fs.readFileSync(path.join(state, 'launcher', 'launcher.log'), 'utf8')
    expect(log).not.toMatch(/cut off by the stop|rolling back/)
    expect(fs.readFileSync(path.join(state, 'launcher', 'result'), 'utf8')).toMatch(/outcome=committed/)
    expect(running('v2')).toHaveLength(1)
    expect(running('v1')).toHaveLength(0)
    expect(fs.existsSync(path.join(state, 'launcher', 'bad')) ? fs.readFileSync(path.join(state, 'launcher', 'bad'), 'utf8') : '').toBe('')
  }, 120_000)
})
