/**
 * scripts/lib/devprod-launcher.sh: the Mac's production server kept by the service launcher.
 *
 * A version's run script (svc_write_run) leads its own process group, passes its pid down as
 * WALNUT_LAUNCHER_SERVICE_PID (the server's marks name it: under Walnut.app's session host the
 * server is two processes below the launcher's child), forwards a TERM, falls back to running the
 * file as its own program when the host refuses it (exit 125), and ends only once the server did.
 * The last case runs the real launcher (service-launcher-script.ts) over two such run scripts with a
 * stub host and a stub server, so a switch commits on the server's ready mark through the host.
 *
 * Everything runs under bash with stubs in a temp dir: never launchd, never a deploy.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { serveLauncherScript } from '../../src/providers/serve-launcher-script-cli.js'

const REPO = path.join(import.meta.dirname, '..', '..')
const LIB = path.join(REPO, 'scripts', 'lib', 'devprod-launcher.sh')
const DEV_PROD = fs.readFileSync(path.join(REPO, 'scripts', 'dev-prod.sh'), 'utf8')

const dirs: string[] = []
const kids: ChildProcess[] = []
afterEach(() => {
  for (const k of kids.splice(0)) {
    if (k.pid && k.pid > 1) { try { process.kill(-k.pid, 'SIGKILL') } catch { /* gone */ } }
    try { k.kill('SIGKILL') } catch { /* gone */ }
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const read = (f: string): string => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(test: () => boolean, ms: number, what: string, log = ''): Promise<void> {
  const end = Date.now() + ms
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}\n${log ? read(log) : ''}`)
    await sleep(50)
  }
}
const alive = (pid: number): boolean => {
  if (!(pid > 1)) return false
  const st = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
  return st !== '' && !st.startsWith('Z')
}
const pgid = (pid: number) => spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()

/** A temp dir with a stub session host and a stub server file. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devprod-launcher-'))
  dirs.push(dir)
  // The host: `--session-host -- <file> args`, runs the file as its child and passes a TERM on, as
  // Walnut.app's does; `host.mode` = refuse makes it exit 125 at once (a command it does not approve).
  const host = path.join(dir, 'Walnut')
  fs.writeFileSync(host, [
    '#!/bin/sh',
    `[ "$(cat '${dir}/host.mode' 2>/dev/null)" = refuse ] && exit 125`,
    'shift 2',
    '"$@" & c=$!',
    'trap \'kill -TERM "$c" 2>/dev/null\' TERM',
    'while :; do wait "$c"; r=$?; kill -0 "$c" 2>/dev/null || exit $r; done',
    '',
  ].join('\n'), { mode: 0o755 })
  // The server: says who it is, writes the launcher's marks with the pid it was given, ends on TERM.
  const file = path.join(dir, 'walnut-stub')
  fs.writeFileSync(file, [
    '#!/bin/sh',
    `d='${dir}'`,
    'echo "$$ $(ps -o pgid= -p $$ | tr -d " ") $PPID ${WALNUT_LAUNCHER_SERVICE_PID:-none} $WALNUT_RUNTIME_DIR $*" >> "$d/server.runs"',
    'trap \'echo "$$ term" >> "$d/server.events"; exit 0\' TERM',
    'p=${WALNUT_LAUNCHER_SERVICE_PID:-$$}',
    'if [ -n "${WALNUT_LAUNCHER_DIR:-}" ]; then printf "pid=%s\\n" "$p" > "$WALNUT_LAUNCHER_DIR/ready"; fi',
    'while [ -d "$d" ]; do',
    '  [ -n "${WALNUT_LAUNCHER_DIR:-}" ] && echo "$(date +%s) 0 $p" > "$WALNUT_LAUNCHER_DIR/hb.$$" && mv -f "$WALNUT_LAUNCHER_DIR/hb.$$" "$WALNUT_LAUNCHER_DIR/heartbeat"',
    '  sleep 0.2',
    'done',
    '',
  ].join('\n'), { mode: 0o755 })
  return { dir, host, file, log: path.join(dir, 'server.log') }
}

/** Source the lib with the dev-prod globals it reads, then run `body` (bash -c). */
function lib(f: ReturnType<typeof fixture>, body: string, opts: { host?: boolean } = {}): { status: number | null; stdout: string; stderr: string } {
  const prefix = opts.host === false ? '' : `host_prefix=('${f.host}' --session-host --)`
  const r = spawnSync('bash', ['-c', [
    'set -euo pipefail',
    `PORT=39999; SERVER_LOG='${f.log}'; SERVE_ROOT='${f.dir}'; LAUNCH_LABEL=com.example.test; REHEARSAL=0`,
    `source '${LIB}'`,
    `server_argv=(WALNUT_RUNTIME_DIR='${f.dir}/runtime' '${f.file}')`,
    prefix || 'host_prefix=()',
    body,
  ].join('\n')], { encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

function startRun(run: string, env: Record<string, string> = {}): ChildProcess {
  const c = spawn('/bin/sh', [run], { stdio: 'ignore', detached: true, env: { PATH: '/usr/bin:/bin', HOME: os.tmpdir(), ...env } })
  kids.push(c)
  return c
}

const hasPerl = fs.existsSync('/usr/bin/perl')

describe('a version\'s run script', () => {
  it.skipIf(!hasPerl)('leads its own group, passes its pid down through the host, and a TERM ends the server and then itself', async () => {
    const f = fixture()
    const run = path.join(f.dir, 'run')
    expect(lib(f, `svc_write_run '${run}'`).status).toBe(0)
    const c = startRun(run)
    await until(() => read(path.join(f.dir, 'server.runs')) !== '', 5_000, 'the server start', f.log)
    const [serverPid, serverGroup, serverParent, passed, runtime, ...args] = read(path.join(f.dir, 'server.runs')).trim().split(' ')
    expect(passed).toBe(String(c.pid))
    // The run script is the group's leader, the host and the server are in it.
    expect(pgid(c.pid!)).toBe(String(c.pid))
    expect(serverGroup).toBe(String(c.pid))
    // Under the host, not the run script itself.
    expect(serverParent).not.toBe(String(c.pid))
    expect(runtime).toBe(`${f.dir}/runtime`)
    expect(args.join(' ')).toBe('web --port 39999')
    process.kill(c.pid!, 'SIGTERM')
    await until(() => !alive(c.pid!), 8_000, 'the run script to end')
    expect(read(path.join(f.dir, 'server.events'))).toContain(`${serverPid} term`)
    expect(alive(Number(serverPid))).toBe(false)
  })

  it('runs the file as its own program when the session host refuses it (exit 125)', async () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.dir, 'host.mode'), 'refuse\n')
    const run = path.join(f.dir, 'run')
    expect(lib(f, `svc_write_run '${run}'`).status).toBe(0)
    const c = startRun(run)
    await until(() => read(path.join(f.dir, 'server.runs')) !== '', 5_000, 'the server start', f.log)
    const [, , parent, passed] = read(path.join(f.dir, 'server.runs')).trim().split(' ')
    expect(parent).toBe(String(c.pid))
    expect(passed).toBe(String(c.pid))
    expect(read(f.log)).toMatch(/session host refused the server \(exit 125\): running the file as its own program/)
  })

  it('with no session host, runs the file straight away; its environment is the server\'s, the launcher\'s own taken out', async () => {
    const f = fixture()
    const run = path.join(f.dir, 'run')
    expect(lib(f, `svc_write_run '${run}'`, { host: false }).status).toBe(0)
    const text = read(run)
    expect(text).not.toContain('125')
    for (const v of ['OPEN_WALNUT_EPHEMERAL', 'WALNUT_DAEMON_DIR', 'WALNUT_DAEMON_STATE_DIR', 'WALNUT_DAEMON_SUPERVISOR', 'WALNUT_LAUNCHER', 'WALNUT_LAUNCHD_LABEL', 'BUN_BE_BUN', 'L_LOCKED']) {
      expect(text).toContain(`-u ${v} `)
    }
    const c = startRun(run, { WALNUT_DAEMON_DIR: '/elsewhere', WALNUT_LAUNCHD_LABEL: 'x' })
    await until(() => read(path.join(f.dir, 'server.runs')) !== '', 5_000, 'the server start', f.log)
    expect(read(path.join(f.dir, 'server.runs')).split(' ')[2]).toBe(String(c.pid))
  })
})

describe('the launcher keeps a server under the session host', () => {
  it.skipIf(!hasPerl)('switches to a new version on the ready mark the server wrote with the run script\'s pid, and the sweep keeps both versions', async () => {
    const f = fixture()
    const state = path.join(f.dir, 'service')
    fs.mkdirSync(path.join(state, 'launcher'), { recursive: true, mode: 0o700 })
    const v1 = path.join(f.dir, 'v1'); const v2 = path.join(f.dir, 'v2')
    for (const v of [v1, v2]) fs.mkdirSync(v)
    expect(lib(f, `svc_write_run '${v1}/run'; svc_write_run '${v2}/run'`).status).toBe(0)
    const script = path.join(state, 'walnut-launcher.sh')
    const text = serveLauncherScript(['--state', state, '--seed', `${v1}/run`, '--self', script, '--trial', '10'], { HOME: f.dir, PATH: '/usr/bin:/bin' })
    fs.writeFileSync(script, text, { mode: 0o700 })
    const launcher = spawn('/bin/sh', [script], { stdio: 'ignore', detached: true, env: { PATH: '/usr/bin:/bin', HOME: f.dir } })
    kids.push(launcher)
    const L = path.join(state, 'launcher')
    await until(() => read(path.join(L, 'state')).includes('phase=committed') && read(path.join(f.dir, 'server.runs')) !== '', 8_000, 'v1 up', path.join(L, 'launcher.log'))
    // Ask for the switch the way the deploy does.
    const r = lib(f, `SVC_L='${L}'; svc_request switch '${v2}/run' abc123; printf '%s' "$svc_id"`)
    expect(r.status).toBe(0)
    const id = r.stdout.trim()
    await until(() => read(path.join(L, 'result')).includes(`id=${id}`), 15_000, 'the switch answer', path.join(L, 'launcher.log'))
    expect(read(path.join(L, 'result'))).toContain('outcome=committed')
    expect(read(path.join(L, 'state'))).toMatch(new RegExp(`current=${v2}/run\\n`))
    expect(read(path.join(L, 'state'))).toMatch(new RegExp(`good=${v1}/run\\n`))
    const keeps = lib(f, `SVC_L='${L}'; for s in '${v1}' '${v2}' '${f.dir}/v3'; do if svc_keeps_stage "$s"; then echo keep; else echo drop; fi; done`)
    expect(keeps.stdout.trim().split('\n')).toEqual(['keep', 'keep', 'drop'])
    // The old version's server ended before the new one started (one at a time).
    const runs = read(path.join(f.dir, 'server.runs')).trim().split('\n')
    expect(runs.length).toBe(2)
    expect(read(path.join(f.dir, 'server.events'))).toContain(`${runs[0]!.split(' ')[0]} term`)
    fs.writeFileSync(path.join(state, 'daemon-boot.stop'), 'stop\n')
  }, 40_000)
})

describe('the deploy goes through the launcher only where it should', () => {
  it('sources the lib, switches through the launcher before the old stop, and installs it after the old stop', () => {
    expect(DEV_PROD).toContain('source "$REPO_ROOT/scripts/lib/devprod-launcher.sh"')
    const deploy = DEV_PROD.indexOf('  svc_deploy\n')
    const stop = DEV_PROD.indexOf('STOP_STARTED=1\nuse_launchd=0')
    const drain = DEV_PROD.search(/^drain_active_turns\nwrite_planned_restart\nwrite_deploy_switch\n/m)
    expect(drain).toBeGreaterThan(-1)
    expect(deploy).toBeGreaterThan(drain)
    expect(stop).toBeGreaterThan(deploy)
    const first = DEV_PROD.indexOf('svc_first_start || SVC_MODE=plain')
    expect(first).toBeGreaterThan(stop)
    expect(DEV_PROD.indexOf('launch_server "$SERVER_FILE"\n', first)).toBeGreaterThan(first)
    // The sweep never removes a version the launcher names.
    expect(DEV_PROD).toMatch(/if svc_keeps_stage "\$old_stage"; then\n\s+continue/)
  })

  it('is the old deploy off macOS and with no launcher installed', () => {
    const f = fixture()
    const off = lib(f, 'uname() { echo Linux; }; svc_init; echo "$SVC_MODE"')
    expect(off.stdout.trim()).toBe('plain')
    const home = path.join(f.dir, 'h')
    const none = lib(f, `uname() { echo Darwin; }; launchctl() { :; }; HOME='${home}'; WALNUT_DEVPROD_LAUNCHER=0; svc_init; echo "$SVC_MODE"`)
    expect(none.stdout.trim()).toBe('plain')
    const ask = lib(f, `uname() { echo Darwin; }; launchctl() { :; }; HOME='${home}'; WALNUT_DEVPROD_LAUNCHER=1; svc_init; echo "$SVC_MODE $SVC_PLIST"`)
    expect(ask.stdout.trim()).toBe(`install ${home}/Library/LaunchAgents/com.example.test.plist`)
    fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true })
    fs.writeFileSync(path.join(home, 'Library', 'LaunchAgents', 'com.example.test.plist'), '<string>/x/walnut-launcher.sh</string>')
    expect(lib(f, `uname() { echo Darwin; }; launchctl() { :; }; HOME='${home}'; svc_init; echo "$SVC_MODE"`).stdout.trim()).toBe('launcher')
    expect(lib(f, `uname() { echo Darwin; }; launchctl() { :; }; HOME='${home}'; WALNUT_DEVPROD_LAUNCHER=0; svc_init; echo "$SVC_MODE"`).stdout.trim()).toBe('remove')
  })
})
