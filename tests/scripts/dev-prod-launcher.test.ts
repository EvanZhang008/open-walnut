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
import { guardedPath } from '../setup/exec-guard-core.js'

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
    'echo "WALNUT_LAUNCHER_PUTBACK=${WALNUT_LAUNCHER_PUTBACK:-}" >> "$d/server.env"',
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
  const c = spawn('/bin/sh', [run], { stdio: 'ignore', detached: true, env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: os.tmpdir(), ...env } })
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

  it('a put-back start checks the data first: refused (exit 78, no server) only on the check\'s schema refusal; a check that fails otherwise, or passes, starts it', async () => {
    const f = fixture()
    // The serve root's data check and a stub bun that runs it: check.mode = refuse prints the check's schema
    // refusal and fails, broken fails with some other error, anything else passes.
    fs.mkdirSync(path.join(f.dir, 'scripts', 'lib'), { recursive: true })
    fs.writeFileSync(path.join(f.dir, 'scripts', 'lib', 'rollback-data-check.mjs'), '// stub\n')
    const bun = path.join(f.dir, 'bun')
    fs.writeFileSync(bun, `#!/bin/sh\necho "check $*" >> '${f.dir}/checks'\nm=$(cat '${f.dir}/check.mode' 2>/dev/null)\n[ "$m" = refuse ] && { echo "Rollback refused: Task database schema 16 is newer than supported schema 15; use a newer Walnut build." >&2; exit 1; }\n[ "$m" = broken ] && { echo "error: Cannot find module better-sqlite3" >&2; exit 1; }\nexit 0\n`, { mode: 0o755 })
    const run = path.join(f.dir, 'run')
    expect(lib(f, `BUN_BIN='${bun}'; HOME='${f.dir}/h'; svc_write_run '${run}'`, { host: false }).status).toBe(0)
    fs.writeFileSync(path.join(f.dir, 'check.mode'), 'refuse\n')
    const refused = startRun(run, { WALNUT_LAUNCHER_PUTBACK: '1' })
    await until(() => refused.exitCode !== null, 10_000, 'the refused start', f.log)
    expect(refused.exitCode).toBe(78)
    expect(read(path.join(f.dir, 'server.runs'))).toBe('')
    expect(read(path.join(f.dir, 'checks')).trim()).toBe(`check scripts/lib/rollback-data-check.mjs ${f.file} ${f.dir}/h/.open-walnut`)
    expect(read(f.log)).toMatch(/cannot read the data a newer one wrote: not started/)
    // A check that breaks for another reason never keeps the Mac dark: it says so and starts.
    fs.writeFileSync(path.join(f.dir, 'check.mode'), 'broken\n')
    const broken = startRun(run, { WALNUT_LAUNCHER_PUTBACK: '1' })
    await until(() => read(path.join(f.dir, 'server.runs')) !== '', 8_000, 'the start after a broken check', f.log)
    expect(read(f.log)).toMatch(/the data check did not finish \(exit 1\): starting this version anyway/)
    // The put-back mark is not passed on to the server itself.
    expect(read(path.join(f.dir, 'server.env')).trim()).toBe('WALNUT_LAUNCHER_PUTBACK=')
    process.kill(broken.pid!, 'SIGTERM')
    await until(() => broken.exitCode !== null, 8_000, 'the broken-check run to end')
    fs.writeFileSync(path.join(f.dir, 'check.mode'), 'ok\n')
    startRun(run, { WALNUT_LAUNCHER_PUTBACK: '1' })
    await until(() => read(path.join(f.dir, 'server.runs')).trim().split('\n').length >= 2, 8_000, 'the checked start', f.log)
    // An ordinary start (no put-back) runs no check.
    const before = read(path.join(f.dir, 'checks'))
    const plain = path.join(f.dir, 'run2')
    expect(lib(f, `BUN_BIN='${bun}'; svc_write_run '${plain}'`, { host: false }).status).toBe(0)
    startRun(plain)
    await until(() => read(path.join(f.dir, 'server.runs')).trim().split('\n').length >= 3, 8_000, 'the plain start', f.log)
    expect(read(path.join(f.dir, 'checks'))).toBe(before)
  })

  it('tells the stage of a server from its command line, whether the file runs itself or under a runtime', () => {
    const f = fixture()
    const out = lib(f, [
      `svc_stage_of_cmd '/var/t/stage.1/dist-bin/walnut-darwin-arm64 web --port 3456'`,
      `svc_stage_of_cmd '/opt/homebrew/bin/node /var/t/stage.2/dist-bin/cli.js web --port 3456'`,
      `svc_stage_of_cmd '/usr/bin/python3 -m http.server 3456'`,
    ].join('; '), { host: false })
    expect(out.stdout.trim().split('\n')).toEqual(['/var/t/stage.1', '/var/t/stage.2'])
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
    const text = serveLauncherScript(['--state', state, '--seed', `${v1}/run`, '--self', script, '--trial', '10'], { HOME: f.dir, PATH: guardedPath([], '/usr/bin:/bin') })
    fs.writeFileSync(script, text, { mode: 0o700 })
    const launcher = spawn('/bin/sh', [script], { stdio: 'ignore', detached: true, env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: f.dir } })
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

/**
 * The deploy's own half against the real launcher: svc_switch (request, wait, checks) and a put-back,
 * with a stub server (python) that answers like Walnut and writes the launcher's marks.
 */
describe('the deploy\'s switch through the launcher', () => {
  function stubServer(dir: string, name: string, commit: string): string {
    const exe = path.join(dir, name)
    fs.mkdirSync(path.join(dir, `${name}-stage`, 'dist-bin'), { recursive: true })
    const file = path.join(dir, `${name}-stage`, 'dist-bin', 'walnut-stub')
    fs.writeFileSync(file, [
      '#!/usr/bin/env python3',
      'import http.server, json, os, sys, threading, time',
      `d = ${JSON.stringify(dir)}; name = ${JSON.stringify(name)}`,
      'mode = open(os.path.join(d, name + ".mode")).read().strip() if os.path.exists(os.path.join(d, name + ".mode")) else "good"',
      'open(os.path.join(d, "server.runs"), "a").write(name + " " + str(os.getpid()) + "\\n")',
      'if mode == "fail": sys.exit(3)',
      'L = os.environ.get("WALNUT_LAUNCHER_DIR"); pid = os.environ.get("WALNUT_LAUNCHER_SERVICE_PID", str(os.getpid()))',
      'class H(http.server.BaseHTTPRequestHandler):',
      '    def log_message(self, *a): pass',
      '    def do_GET(self):',
      `        body = json.dumps({"build": {"commit": ${JSON.stringify(commit)}}, "processNice": 0}) if self.path == "/api/config" else "<html><script src=\\"assets/index-x.js\\"></script></html>"`,
      '        self.send_response(200); self.end_headers(); self.wfile.write(body.encode())',
      'srv = http.server.HTTPServer(("127.0.0.1", int(sys.argv[sys.argv.index("--port") + 1])), H)',
      'def beat():',
      '    while True:',
      '        if L: open(L + "/hb.t", "w").write("%d 0 %s\\n" % (time.time(), pid)); os.replace(L + "/hb.t", L + "/heartbeat")',
      '        time.sleep(0.5)',
      'threading.Thread(target=beat, daemon=True).start()',
      'if L: open(L + "/ready", "w").write("pid=%s\\n" % pid)',
      'import signal; signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))',
      'srv.serve_forever()',
      '',
    ].join('\n'), { mode: 0o755 })
    return file
  }

  it.skipIf(!hasPerl)('commits a new version that serves and checks out, and a version that dies is put back while the good one serves', async () => {
    const f = fixture()
    const port = 30000 + Math.floor(Math.random() * 20000)
    const state = path.join(f.dir, 'service'); const L = path.join(state, 'launcher')
    fs.mkdirSync(L, { recursive: true, mode: 0o700 })
    const git = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    const v1 = stubServer(f.dir, 'v1', 'aaaaaaa1'); const v2 = stubServer(f.dir, 'v2', git); const v3 = stubServer(f.dir, 'v3', git)
    fs.writeFileSync(path.join(f.dir, 'v3.mode'), 'fail\n')
    // The dev-prod functions the lib calls, as stubs; the rest is the lib itself.
    const prelude = [
      `PORT=${port}; REPO_ROOT='${REPO}'; JS_BIN=$(command -v bun || command -v node); WALNUT_DEVPROD_SKIP_RENDER=1`,
      `SVC_DIR='${state}'; SVC_L='${L}'; SVC_SCRIPT='${state}/walnut-launcher.sh'; SVC_SEED='${state}/lkg-run'`,
      `listener_pids() { lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || ss -ltnpH "sport = :${port}" 2>/dev/null | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p'; }`,
      'clone_copy() { cp -R "$1" "$2"; }',
      'restore_serving_dist() { echo RESTORED; }',
    ].join('\n')
    const write = (file: string, run: string) => `server_argv=(WALNUT_RUNTIME_DIR='${f.dir}/runtime' '${file}'); STAGE_DIR='${path.dirname(path.dirname(file))}'; svc_save_version; echo "$svc_run" > '${run}'`
    const r1 = lib(f, `${prelude}\n${write(v1, `${f.dir}/v1.run`)}`, { host: false })
    expect(r1.status, r1.stderr).toBe(0)
    const run1 = read(`${f.dir}/v1.run`).trim()
    expect(run1).toBe(`${state}/versions/v1-stage/run`)
    fs.writeFileSync(path.join(state, 'walnut-launcher.sh'), serveLauncherScript(['--state', state, '--seed', run1, '--self', path.join(state, 'walnut-launcher.sh'), '--trial', '10'], { HOME: f.dir, PATH: process.env.PATH ?? '/usr/bin:/bin' }), { mode: 0o700 })
    const launcher = spawn('/bin/sh', [path.join(state, 'walnut-launcher.sh')], { stdio: 'ignore', detached: true, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: f.dir } })
    kids.push(launcher)
    const up = lib(f, `${prelude}\nsvc_wait_launcher 10 && echo UP`, { host: false })
    expect(up.stdout).toContain('UP')
    await until(() => spawnSync('curl', ['-sf', `http://127.0.0.1:${port}/api/config`]).status === 0, 10_000, 'v1 serves', path.join(L, 'launcher.log'))

    // A version that serves and reports this deploy's commit: committed, and the checks hold.
    const ok = lib(f, `${prelude}\n${write(v2, `${f.dir}/v2.run`)}\nsvc_switch && echo SWITCHED; echo "OUTCOME=$svc_outcome"`, { host: false })
    expect(ok.stdout + ok.stderr).toContain('SWITCHED')
    expect(read(path.join(L, 'state'))).toContain(`current=${state}/versions/v2-stage/run`)

    // A version that dies at once: the launcher puts v2 back; the deploy says so and fails.
    const bad = lib(f, `${prelude}\n${write(v3, `${f.dir}/v3.run`)}\nif svc_switch; then echo SWITCHED; else echo "FAILED $svc_outcome"; fi`, { host: false })
    expect(bad.stdout).toMatch(/FAILED rolledback/)
    // v2 is still in its probation (not proven): the put-back is v1, the last proven version.
    expect(read(path.join(L, 'state'))).toContain(`current=${state}/versions/v1-stage/run`)
    await until(() => spawnSync('curl', ['-sf', `http://127.0.0.1:${port}/api/config`], { encoding: 'utf8' }).stdout.includes('aaaaaaa1'), 15_000, 'v1 serves again', f.log)

    // A stage the temp dir lost (a reboot) is put back from its clone when the launcher starts it again.
    fs.rmSync(path.join(f.dir, 'v1-stage'), { recursive: true, force: true })
    const svc = Number(read(path.join(L, 'service.pid')).split('\n')[0])
    process.kill(-svc, 'SIGKILL')
    await until(() => fs.existsSync(path.join(f.dir, 'v1-stage', 'dist-bin', 'walnut-stub')) && spawnSync('curl', ['-sf', `http://127.0.0.1:${port}/api/config`]).status === 0, 15_000, 'v1 back from its clone', f.log)
    expect(read(f.log)).toMatch(/the stage is gone .*putting it back/)
    fs.writeFileSync(path.join(state, 'daemon-boot.stop'), 'stop\n')
    const now = Number(read(path.join(L, 'service.pid')).split('\n')[0])
    if (now > 1) { try { process.kill(-now, 'SIGKILL') } catch { /* gone */ } }
  }, 90_000)

  it('waits for a launcher that launchd has not started yet, and never reads a stale pid as it', async () => {
    const f = fixture()
    const state = path.join(f.dir, 'service')
    fs.mkdirSync(state)
    // A pid that is alive but is no launcher (this test process).
    fs.writeFileSync(path.join(state, 'daemon-boot.pid'), `${process.pid}\n`)
    const r = lib(f, `SVC_DIR='${state}'; SVC_SCRIPT='${state}/walnut-launcher.sh'; p=$(svc_launcher_pid); echo "PID=[$p]"; if svc_wait_launcher 1; then echo UP; else echo NOTUP; fi`, { host: false })
    expect(r.stdout).toContain('PID=[]')
    expect(r.stdout).toContain('NOTUP')
  })
})

describe('the deploy goes through the launcher only where it should', () => {
  it('sources the lib, leaves the old stop out of the launcher path, and installs it after the old stop', () => {
    expect(DEV_PROD).toContain('source "$REPO_ROOT/scripts/lib/devprod-launcher.sh"')
    const skip = DEV_PROD.indexOf('if [[ "$SVC_MODE" != "launcher" ]]; then\n')
    const stop = DEV_PROD.indexOf('STOP_STARTED=1\nuse_launchd=0')
    const sweep = DEV_PROD.indexOf('stray_pids="$(pgrep')
    const end = DEV_PROD.indexOf('fi # the old stop, not under the launcher\n')
    const drain = DEV_PROD.search(/^drain_active_turns\nwrite_planned_restart\nwrite_deploy_switch\n/m)
    expect(drain).toBeGreaterThan(-1)
    // The old stop and the stray sweep (which would end the launcher's own server) run only off the launcher.
    expect(skip).toBeGreaterThan(drain)
    expect(stop).toBeGreaterThan(skip)
    expect(sweep).toBeGreaterThan(stop)
    expect(end).toBeGreaterThan(sweep)
    const deploy = DEV_PROD.indexOf('  svc_deploy\n')
    const first = DEV_PROD.indexOf('svc_first_start || SVC_MODE=plain')
    expect(deploy).toBeGreaterThan(end)
    expect(first).toBeGreaterThan(deploy)
    expect(DEV_PROD.indexOf('launch_server "$SERVER_FILE"\n', first)).toBeGreaterThan(first)
    // The sweep never removes a version the launcher names.
    expect(DEV_PROD).toMatch(/if svc_keeps_stage "\$old_stage"; then\n\s+continue/)
  })

  // 2026-11-22 rehearsal: svc_finish called snapshot_lkg before bash had read its definition
  // ("snapshot_lkg: command not found"). Every dev-prod.sh function the lib calls is defined
  // above each place dev-prod.sh enters the lib.
  it('every dev-prod.sh function the lib calls is defined before dev-prod.sh calls into the lib', () => {
    const lib = fs.readFileSync(path.join(REPO, 'scripts/lib/devprod-launcher.sh'), 'utf8')
    const own = new Set([...lib.matchAll(/^([a-z_][a-z0-9_]*)\(\) \{/gm)].map((m) => m[1]!))
    const defs = new Map([...DEV_PROD.matchAll(/^([a-z_][a-z0-9_]*)\(\) \{/gm)].map((m) => [m[1]!, m.index!] as const))
    const used = [...new Set([...lib.matchAll(/\b([a-z_][a-z0-9_]*)\b/g)].map((m) => m[1]!))].filter((n) => defs.has(n) && !own.has(n))
    expect(used.length).toBeGreaterThan(5)
    const sourced = DEV_PROD.indexOf('source "$REPO_ROOT/scripts/lib/devprod-launcher.sh"')
    const entries = [...DEV_PROD.matchAll(/^\s*(?:if |elif )?!?\s*(svc_[a-z_]+)\b/gm)]
      .filter((m) => m.index! > sourced && !['svc_init', 'svc_keeps_stage'].includes(m[1]!)).map((m) => [m[1]!, m.index!] as const)
    expect(entries.map(([n]) => n)).toEqual(expect.arrayContaining(['svc_deploy', 'svc_first_start', 'svc_unmark']))
    const late = entries.flatMap(([entry, at]) => used.filter((n) => defs.get(n)! > at).map((n) => `${entry} at ${at} calls ${n}, defined at ${defs.get(n)}`))
    expect(late).toEqual([])
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
