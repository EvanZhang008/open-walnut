#!/usr/bin/env bun
/**
 * The Mac app's first launch beside a Walnut server that already owns the data
 * directory, end to end on this Mac (2026-11-03: after a logout the server was
 * busy, the app's 2-second probe missed it, the app started a second server, the
 * data-dir lock refused that one, and the first launch ended on an error screen;
 * the second launch worked).
 *
 *   bun scripts/desktop-first-launch-e2e.mjs --app <Walnut.app> [--source <checkout>] [--work <dir>]
 *                                            [--scenario busy|gone|ended|all] [--video <dir>] [--keep] [--before]
 *
 * Scenarios, each on its own data home:
 *   busy  : a real Walnut server owns the data dir and does not answer (stopped
 *           with SIGSTOP) when the app opens; it answers 20 s later. The app must
 *           wait and open its console, never start a second server or show an error.
 *   gone  : the same, but the busy server dies 6 s in. The app must start its own.
 *   ended : the server answers but says its login session ended (GET /api/config
 *           loginSession). The app must stop it and open the console of a server
 *           it starts itself.
 *
 * Nothing touches the real Walnut: HOME, Application Support and the data dir live
 * under --work, each server gets its own port and daemon dir, and the app opens
 * behind every window without taking focus (WALNUT_DESKTOP_E2E_BACKGROUND).
 * `--video <dir>` writes one MP4 per scenario from the app's own window pixels.
 */
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { accountInfo } from '../src/lib/account.ts'
import { freePort } from './lib/free-port.mjs'
import { startAppWindowVideo, writesOwnSnapshots } from './lib/app-window-video.mjs'

const args = process.argv.slice(2)
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1] }
const app = opt('--app')
const source = path.resolve(opt('--source') ?? path.join(import.meta.dirname, '..'))
const work = path.resolve(opt('--work') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-first-launch-')))
const scenarioArg = opt('--scenario') ?? 'all'
const videoDir = opt('--video')
const keep = args.includes('--keep')
// --before: the app is a build from before the fix; the busy scenario then passes when
// the old failure shows (a second server, refused by the lock, and the error screen).
const before = args.includes('--before')
if (!app || !fs.existsSync(path.join(app, 'Contents', 'MacOS', 'Walnut'))) {
  console.error('usage: --app <Walnut.app> (a test copy; never the one in /Applications)')
  process.exit(2)
}
if (!fs.existsSync(path.join(source, 'dist', 'cli.js'))) {
  console.error(`no built checkout at ${source} (dist/cli.js)`)
  process.exit(2)
}
const BUN = [process.execPath, path.join(os.homedir(), '.bun', 'bin', 'bun')].find((p) => p && fs.existsSync(p) && /bun$/.test(p)) ?? 'bun'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(what, ms, probe) {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await probe().catch(() => null)
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timed out after ${Math.round(ms / 1000)}s waiting for ${what}`)
    await sleep(500)
  }
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const answers = async (port) => (await fetch(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(3000) })).ok
const listener = (port) => {
  try { return Number(execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n')[0]) || null } catch { return null }
}

/** A fake Walnut server: holds the data dir's lock, serves a page, and reports an ended login session. */
const FAKE = `
import fs from 'node:fs'
import http from 'node:http'
const [port, lock] = [Number(process.argv[4]), process.argv[5]]
fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }))
const srv = http.createServer((req, res) => {
  if (req.url.startsWith('/api/config')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ config: {}, loginSession: { ok: false, problems: ['user_lookup', 'dns_config'], checkedAt: new Date().toISOString() } }))
  }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>stale server in an ended login session</h1>')
}).listen(port, '127.0.0.1')
const bye = () => { try { fs.unlinkSync(lock) } catch {} ; process.exit(0) }
process.on('SIGTERM', bye); process.on('SIGINT', bye)
`

async function runScenario(name) {
  const dir = path.join(work, name)
  const home = path.join(dir, 'home')
  const support = path.join(home, 'Library', 'Application Support', 'Walnut')
  const data = path.join(home, '.open-walnut')
  fs.mkdirSync(support, { recursive: true })
  fs.mkdirSync(data, { recursive: true })
  fs.writeFileSync(path.join(support, 'config.json'), JSON.stringify({ walnutHome: data, walnutSourceDir: source }))
  fs.writeFileSync(path.join(data, 'config.yaml'), 'updates:\n  auto: false\n')
  const port = await freePort()
  const env = {
    HOME: home, CFFIXED_USER_HOME: home, USER: accountInfo().username, TMPDIR: process.env.TMPDIR ?? '/tmp', LANG: 'en_US.UTF-8',
    PATH: `${path.dirname(BUN)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    WALNUT_DAEMON_DIR: path.join(dir, 'daemon'), WALNUT_DESKTOP_PORTS: String(port), WALNUT_DESKTOP_E2E_BACKGROUND: '1',
    WALNUT_ORG_AUTOSTART: '0',
  }
  const desktopLog = () => { try { return fs.readFileSync(path.join(support, 'desktop.log'), 'utf8') } catch { return '' } }
  const events = (e) => desktopLog().split('\n').filter((l) => l.includes(`"event":"${e}"`))
  const cleanup = []
  const result = { name, ok: false, steps: [], video: null }
  const step = (what) => { result.steps.push(what); console.log(`  [${name}] ${what}`) }

  // The server that owns the data dir before the app opens.
  let owner
  if (name === 'ended') {
    const fakeDir = path.join(dir, 'fake-bin')
    fs.mkdirSync(fakeDir, { recursive: true })
    // Named like the compiled Walnut file, so `ps` reads it as a Walnut server.
    fs.symlinkSync(BUN, path.join(fakeDir, 'walnut'))
    fs.writeFileSync(path.join(dir, 'fake-server.mjs'), FAKE)
    owner = spawn(path.join(fakeDir, 'walnut'), [path.join(dir, 'fake-server.mjs'), 'web', '--port', String(port), path.join(data, 'server.lock.json')],
      { env, cwd: dir, stdio: 'ignore' })
  } else {
    const log = fs.openSync(path.join(dir, 'owner-server.log'), 'a')
    owner = spawn(BUN, [path.join(source, 'dist', 'cli.js'), 'web', '--port', String(port)],
      { env: { ...env, OPEN_WALNUT_HOME: data }, cwd: source, stdio: ['ignore', log, log] })
  }
  cleanup.push(() => { try { process.kill(owner.pid, 'SIGCONT') } catch {} ; try { process.kill(owner.pid, 'SIGTERM') } catch {} })
  await until('the owner server', 5 * 60_000, () => answers(port))
  step(`a Walnut server (pid ${owner.pid}) owns ${data} on port ${port}`)
  if (name !== 'ended') {
    process.kill(owner.pid, 'SIGSTOP')
    step('it stops answering (SIGSTOP), as a server busy after a log-in')
  }

  const target = path.join(dir, 'Apps', 'Walnut.app')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  execFileSync('/usr/bin/ditto', [app, target])
  const exe = path.join(target, 'Contents', 'MacOS', 'Walnut')
  const snapshots = videoDir && !args.includes('--window-capture') ? writesOwnSnapshots(exe) : false
  if (snapshots) env.WALNUT_DESKTOP_E2E_SNAPSHOTS = path.join(dir, 'frames')
  const rec = videoDir ? startAppWindowVideo({ exe, dir: path.join(dir, 'frames'), snapshots }) : null
  const appLog = fs.openSync(path.join(dir, 'app.log'), 'a')
  const t0 = Date.now()
  const proc = spawn(exe, [], { env, stdio: ['ignore', appLog, appLog] })
  cleanup.push(() => { try { process.kill(proc.pid, 'SIGTERM') } catch {} })
  step('the app opens for the first time')

  try {
    if (name === 'busy' && before) {
      await until('the second server to be refused', 5 * 60_000, async () => events('server_process_exited').length > 0)
      step('the app started a second server, the data-dir lock refused it, and the app shows the error screen')
      await sleep(10_000)
      result.ok = true
      return result
    }
    if (name === 'busy') {
      await sleep(20_000)
      if (events('server_spawn_attempted').length) throw new Error('the app started a second server while the owner was busy')
      if (!events('running_server_wait_started').length) throw new Error(`the app is not waiting for the owner: ${desktopLog().slice(-800)}`)
      step('20 s later: the app waits for the owner, no second server, no error screen')
      process.kill(owner.pid, 'SIGCONT')
      step('the owner answers again (SIGCONT)')
      await until('the app to attach', 60_000, async () => events('existing_server_attached').length > 0)
      if (listener(port) !== owner.pid) throw new Error('the port is served by another process than the owner')
    } else if (name === 'gone') {
      await sleep(6_000)
      process.kill(owner.pid, 'SIGKILL')
      step('the busy owner dies (SIGKILL; its lock stays behind)')
      await until('the app to start its own server', 60_000, async () => events('server_port_confirmed').length > 0)
    } else {
      await until('the app to replace the ended-session server', 60_000, async () => events('ended_session_server_replaced').length > 0)
      await until('the old server to stop', 30_000, async () => !pidAlive(owner.pid))
      step('the app stops the server of the ended session')
      await until('the app to start its own server', 5 * 60_000, async () => events('server_port_confirmed').length > 0)
      if (listener(port) === owner.pid) throw new Error('the old server still serves')
    }
    await until('the console to load in the app', 3 * 60_000, async () => answers(port))
    // The console page finished loading in the app's web view.
    await until('the page', 60_000, async () => events('console_loaded').length > 0)
    await sleep(6_000)
    if (/showError|startup_failure/.test(desktopLog()) && events('server_auto_restart_exhausted').length) throw new Error('an error screen was shown')
    step(`the console opened ${((Date.now() - t0) / 1000).toFixed(0)} s after the launch, first time`)
    result.ok = true
  } catch (err) {
    step(`FAIL: ${err?.message ?? err}`)
  } finally {
    if (rec) {
      try { result.video = await rec.stop(path.join(videoDir, `first-launch-${name}.mp4`)) } catch (err) { step(`video: ${err.message}`) }
    }
    for (const c of cleanup.reverse()) c()
    await sleep(3_000)
    // The app's own server, if it started one.
    const left = listener(port)
    if (left) { try { process.kill(left, 'SIGTERM') } catch {} }
    result.log = desktopLog().split('\n').filter((l) => /running_server|existing_server|server_spawn|server_port_confirmed|ended_session|startup_failure|server_process_exited/.test(l))
  }
  return result
}

if (videoDir) fs.mkdirSync(videoDir, { recursive: true })
const scenarios = scenarioArg === 'all' ? ['busy', 'gone', 'ended'] : [scenarioArg]
const results = []
for (const s of scenarios) results.push(await runScenario(s))
fs.writeFileSync(path.join(work, 'results.json'), JSON.stringify(results, null, 2))
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.video ? `  video ${r.video}` : ''}`)
if (!keep && results.every((r) => r.ok)) for (const s of scenarios) fs.rmSync(path.join(work, s, 'home'), { recursive: true, force: true })
process.exit(results.every((r) => r.ok) ? 0 : 1)
