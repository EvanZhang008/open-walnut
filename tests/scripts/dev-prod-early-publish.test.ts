/**
 * scripts/dev-prod.sh: the checkout's dist holds the new build BEFORE the old
 * server stops, and a rollback puts the previous one back.
 *
 * 2026-11-21: Walnut.app was relaunched inside a deploy's stop window and started
 * its own server from the checkout's dist (`bun <checkout>/dist/cli.js web`).
 * From then on the app restarted that server a second after every deploy stopped
 * it, before the deploy's own server could take the instance lock. The dist was
 * published only at the end of the deploy, so the app's server always ran the
 * build before, and every deploy ended with "production serves <the build
 * before>". Whoever starts the next server must find this deploy's build there.
 *
 * The order is pinned on the script's text; the two helpers run in bash with
 * stubbed probes (no port, no launchd, no real app). The only process signalled
 * is a `sleep` this test starts itself.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const SCRIPT = path.join(import.meta.dirname, '..', '..', 'scripts', 'dev-prod.sh')
const script = fs.readFileSync(SCRIPT, 'utf-8')

function fn(name: string): string {
  const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, 'm').exec(script)
  expect(m, `function ${name} in dev-prod.sh`).not.toBeNull()
  return m![0]
}

const APP = '/Applications/Walnut.app/Contents/MacOS/Walnut'
const HOST = `${APP} --session-host -- /stage/walnut web --port 3456`

describe('dev-prod.sh publishes the serving dist before the stop', () => {
  it('every publish of the new build comes before the old server is stopped and the new one launched', () => {
    const stop = script.indexOf('kill -15 $existing_pids')
    const drain = script.search(/^drain_active_turns$/m)
    const launch = script.search(/^launch_server "\$SERVER_FILE"$/m)
    expect(stop).toBeGreaterThan(-1)
    expect(drain).toBeGreaterThan(-1)
    expect(launch).toBeGreaterThan(stop)
    // Each call that publishes this deploy's dist ($publish_from), wherever a new one is added.
    const calls = [...script.matchAll(/publish-serve-root-dist\.mjs" "\$publish_from"/g)].map((m) => m.index!)
    expect(calls.length).toBeGreaterThan(0)
    for (const at of calls) {
      expect(at, 'a publish of the new dist after the drain/stop lets a restarted server run the old one').toBeLessThan(drain)
    }
  })

  it('keeps the replaced dist and the rollback and the refused start put it back', () => {
    expect(script).toMatch(/clone_copy "\$publish_to" "\$SERVE_DIST_PREV"/)
    expect(fn('rollback_to_lkg')).toMatch(/^ {2}restore_serving_dist$/m)
    const refused = script.indexOf('Existing server did not stop; refusing to start a competing process.')
    expect(script.slice(refused, refused + 200)).toMatch(/restore_serving_dist/)
    // The kept copy leaves with the deploy, whatever way it exits.
    const traps = [...script.matchAll(/^trap '([^']*)' EXIT$/gm)]
    expect(traps.at(-1)![1]).toMatch(/serve_dist_exit/)
    expect(fn('serve_dist_exit')).toMatch(/^  serve_dist_prev_cleanup$/m)
  })
})

interface Proc { ppid: string; command: string }

function prelude(listener: string, procs: Record<string, Proc>): string {
  return [
    'set -euo pipefail',
    'SERVE_ROOT=/srv/walnut',
    `STUB_LISTENER='${listener}'`,
    'listener_pids() { if [[ -n "$STUB_LISTENER" ]]; then echo "$STUB_LISTENER"; fi; }',
    ...Object.entries(procs).flatMap(([pid, p]) => [`STUB_PPID_${pid}='${p.ppid}'`, `STUB_CMD_${pid}='${p.command}'`]),
    'ps() {',
    '  local field="$2" pid="$4" v',
    '  if [[ "$field" == ppid= ]]; then v="STUB_PPID_$pid"; echo "${!v:-1}"; return 0; fi',
    '  v="STUB_CMD_$pid"; echo "${!v:-/bin/sleep 30}"',
    '}',
    fn('app_spawned_listener'),
  ].join('\n')
}

function appListener(listener: string, procs: Record<string, Proc>): string {
  const r = spawnSync('bash', ['-c', `${prelude(listener, procs)}\napp_spawned_listener || echo NONE`], { encoding: 'utf-8' })
  expect(r.stderr).toBe('')
  return r.stdout.trim()
}

describe('the deploy\'s own servers never pass for the Mac app\'s', () => {
  // src/core/deploy-switch.ts lets only WALNUT_LAUNCHER=mac-app without a launchd label wait; a
  // nohup server inherits the deploy shell's environment, which can carry the app's mark.
  it('both launch paths drop WALNUT_LAUNCHER', () => {
    expect(fn('launchd_job_argv')).toMatch(/^\s+-u WALNUT_LAUNCHER$/m)
    const nohup = script.slice(script.indexOf("nohup /bin/sh -c 'cd \"$1\" && shift && exec \"$@\"' open-walnut"))
    expect(nohup.slice(0, nohup.indexOf('web --port'))).toContain('-u WALNUT_LAUNCHER')
  })
})

describe('only an awake Mac stops its server', () => {
  // 2026-11-21: a deploy ran on in a dark wake, stopped the server, and the Mac slept again:
  // :3456 stayed dark for 20 minutes until the lid opened.
  function wake(states: string[], extra = ''): { status: number | null; stderr: string; polls: number } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-'))
    try {
      fs.writeFileSync(path.join(dir, 'states'), states.join('\n') + '\n')
      const body = [
        'set -euo pipefail', `D='${dir}'`,
        'uname() { echo Darwin; }',
        // Each call answers the next state; the last one repeats.
        'pmset() { local n s; n=$(cat "$D/polls" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "$D/polls"; s=$(sed -n "${n}p" "$D/states"); [[ -n "$s" ]] || s=$(tail -n 1 "$D/states"); [[ "$s" == none ]] && return 1; echo "Current System Capabilities are: $s"; }',
        `WALNUT_DEVPROD_WAKE_POLL_SECS=0 ${extra}`,
        fn('full_wake'), fn('wait_for_full_wake'), 'wait_for_full_wake; echo STOPS >&2',
      ].join('\n')
      const r = spawnSync('bash', ['-c', body], { encoding: 'utf-8', timeout: 20_000 })
      const polls = Number(fs.existsSync(path.join(dir, 'polls')) ? fs.readFileSync(path.join(dir, 'polls'), 'utf8') : 0)
      return { status: r.status, stderr: r.stderr, polls }
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  }

  it('goes on at once when awake, or when the probe cannot answer', () => {
    expect(wake(['CPU Graphics Audio Network'])).toMatchObject({ status: 0, polls: 1 })
    expect(wake(['none']).stderr).toContain('STOPS')
  })

  it('waits through a dark wake and goes on once the Mac is awake', () => {
    const r = wake(['CPU Network', 'CPU Network', 'CPU Graphics Audio Network'])
    expect(r.status).toBe(0)
    expect(r.polls).toBe(3)
    expect(r.stderr).toMatch(/asleep \(a dark wake\)[\s\S]*awake: the deploy goes on[\s\S]*STOPS/)
  })

  it('ends the deploy before the stop when the Mac stays asleep', () => {
    const r = wake(['CPU Network'], 'WALNUT_DEVPROD_WAKE_WAIT_SECS=0')
    expect(r.status).toBe(1)
    expect(r.stderr).not.toContain('STOPS')
  })

  it('runs before the dist is published and before the drain and the stop', () => {
    const at = script.search(/^wait_for_full_wake$/m)
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(script.indexOf('CLI_NOT_PUBLISHED=""'))
    expect(at).toBeLessThan(script.search(/^drain_active_turns$/m))
    expect(at).toBeLessThan(script.indexOf('kill -15 $existing_pids'))
  })
})

describe('app_spawned_listener', () => {
  const appServer = { 4242: { ppid: '900', command: 'bun /srv/walnut/dist/cli.js web --port 3456' }, 900: { ppid: '1', command: APP } }

  it('names a server the Mac app started itself from the checkout dist (the 2026-11-21 shape)', () => {
    expect(appListener('4242', appServer)).toBe('4242')
  })

  it('names nothing for the session host, another parent, another dist, or no listener', () => {
    expect(appListener('4242', { ...appServer, 900: { ppid: '1', command: HOST } })).toBe('NONE')
    expect(appListener('4242', { ...appServer, 900: { ppid: '1', command: '/bin/launchd' } })).toBe('NONE')
    expect(appListener('4242', { ...appServer, 4242: { ppid: '900', command: '/stage/walnut web --port 3456' } })).toBe('NONE')
    expect(appListener('4242', { ...appServer, 4242: { ppid: '900', command: 'bun /other/dist/cli.js web --port 3456' } })).toBe('NONE')
    expect(appListener('4242', { 4242: { ppid: '1', command: 'bun /srv/walnut/dist/cli.js web --port 3456' } })).toBe('NONE')
    expect(appListener('', appServer)).toBe('NONE')
  })
})

describe('started_by_mac_app (the stray sweep leaves the app\'s waiting server alone)', () => {
  function startedByApp(procs: Record<string, Proc>, pid: string): boolean {
    const r = spawnSync('bash', ['-c', `${prelude('', procs)}\n${fn('started_by_mac_app')}\nstarted_by_mac_app ${pid} && echo YES || echo NO`], { encoding: 'utf-8' })
    return r.stdout.trim() === 'YES'
  }
  it('is the app\'s own child, never the session host\'s or launchd\'s', () => {
    expect(startedByApp({ 77: { ppid: '900', command: 'bun /srv/walnut/dist/cli.js web' }, 900: { ppid: '1', command: APP } }, '77')).toBe(true)
    expect(startedByApp({ 77: { ppid: '900', command: '/stage/walnut web' }, 900: { ppid: '1', command: HOST } }, '77')).toBe(false)
    expect(startedByApp({ 77: { ppid: '1', command: 'bun /srv/walnut/dist/cli.js web' } }, '77')).toBe(false)
  })
  it('is asked inside the sweep, before its kill', () => {
    const sweep = script.slice(script.indexOf('stray_pids="$(pgrep'))
    expect(sweep.indexOf('if started_by_mac_app "$spid"; then continue; fi')).toBeGreaterThan(-1)
    expect(sweep.indexOf('if started_by_mac_app "$spid"; then continue; fi')).toBeLessThan(sweep.indexOf('kill -15 "$spid"'))
  })
})

describe('restore_serving_dist', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => { while (cleanups.length) cleanups.pop()!() })

  function setup(): { dir: string; publishLog: string; js: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'early-publish-'))
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
    fs.mkdirSync(path.join(dir, 'prev'))
    fs.writeFileSync(path.join(dir, 'prev', 'cli.js'), 'old\n')
    const publishLog = path.join(dir, 'publish.log')
    // A stand-in for `bun publish-serve-root-dist.mjs <from> <to>`: it records the call.
    const js = path.join(dir, 'js')
    fs.writeFileSync(js, `#!/bin/bash\necho "$2 $3" >> '${publishLog}'\n`, { mode: 0o755 })
    return { dir, publishLog, js }
  }

  function restore(o: { dir: string; js: string; listener: string; procs: Record<string, Proc>; prev?: string }) {
    const body = [
      prelude(o.listener, o.procs),
      `REPO_ROOT='${o.dir}'`,
      `JS_BIN='${o.js}'`,
      `SERVE_DIST_PREV='${o.prev ?? path.join(o.dir, 'prev')}'`,
      `publish_to='${path.join(o.dir, 'dist')}'`,
      fn('restore_serving_dist'),
      'restore_serving_dist; echo DONE',
    ].join('\n')
    return spawnSync('bash', ['-c', body], { encoding: 'utf-8', timeout: 30_000 })
  }

  it('puts the previous dist back and stops the Mac app server running the new one', async () => {
    const s = setup()
    const child = spawn('sleep', ['30'], { stdio: 'ignore' })
    cleanups.push(() => { try { child.kill('SIGKILL') } catch { /* gone */ } })
    const pid = String(child.pid)
    const exited = new Promise<NodeJS.Signals | null>((res) => child.on('exit', (_c, sig) => res(sig)))
    const r = restore({ ...s, listener: pid, procs: { [pid]: { ppid: '900', command: 'bun /srv/walnut/dist/cli.js web --port 3456' }, 900: { ppid: '1', command: APP } } })
    expect(r.stdout).toContain('DONE')
    expect(fs.readFileSync(s.publishLog, 'utf-8').trim()).toBe(`${path.join(s.dir, 'prev')} ${path.join(s.dir, 'dist')}`)
    expect(r.stderr).toMatch(/Put the previous build back/)
    expect(r.stderr).toMatch(new RegExp(`Mac app's own server \\(PID ${pid}\\)`))
    expect(await exited).toBe('SIGTERM')
  })

  it('restores the dist but stops nothing when its own server (or anything else) serves', () => {
    const s = setup()
    const r = restore({ ...s, listener: '4242', procs: { 4242: { ppid: '700', command: '/stage/walnut web --port 3456' }, 700: { ppid: '1', command: HOST } } })
    expect(r.stdout).toContain('DONE')
    expect(fs.existsSync(s.publishLog)).toBe(true)
    expect(r.stderr).not.toMatch(/stopping it/)
  })

  it('an exit before the stop puts the previous dist back; one after it leaves that to the rollback', () => {
    for (const stopStarted of [0, 1]) {
      const s = setup()
      const body = [
        `REPO_ROOT='${s.dir}'`, `JS_BIN='${s.js}'`,
        `SERVE_DIST_PREV='${path.join(s.dir, 'prev')}'`, `publish_to='${path.join(s.dir, 'dist')}'`,
        `STOP_STARTED=${stopStarted}`,
        fn('serve_dist_prev_cleanup'), fn('serve_dist_exit'),
        'set -euo pipefail', 'serve_dist_exit; echo DONE',
      ].join('\n')
      const r = spawnSync('bash', ['-c', body], { encoding: 'utf-8' })
      expect(r.stdout).toContain('DONE')
      expect(fs.existsSync(s.publishLog), `STOP_STARTED=${stopStarted}`).toBe(stopStarted === 0)
      // The kept copy goes either way.
      expect(fs.existsSync(path.join(s.dir, 'prev'))).toBe(false)
    }
    // The flag is set right before the first stop (the launchd bootout).
    const flag = script.search(/^STOP_STARTED=1$/m)
    expect(flag).toBeGreaterThan(script.search(/^write_deploy_switch$/m))
    expect(flag).toBeLessThan(script.indexOf('if ! remove_launchd_job; then'))
  })

  it('does nothing without a kept copy (first deploy into this checkout, or the copy failed)', () => {
    const s = setup()
    const r = restore({ ...s, listener: '', procs: {}, prev: '' })
    expect(r.stdout).toContain('DONE')
    expect(fs.existsSync(s.publishLog)).toBe(false)
  })
})
