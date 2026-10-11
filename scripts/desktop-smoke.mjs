#!/usr/bin/env node
/**
 * First launch of Walnut.app on a Mac that has never seen Walnut: with no click
 * (a first launch starts by itself, as a user's does), the app installs the
 * self-contained Walnut with the install.sh it carries, starts the server with
 * that copy's Node and nothing else on PATH, and serves the console. Then the
 * app dies, the server goes with it (OPEN_WALNUT_EXIT_ON_ORPHAN), and a second
 * launch starts the installed copy again without downloading anything.
 *
 *   node scripts/desktop-smoke.mjs --app Walnut.app --version 0.7.0          (from the GitHub release)
 *   node scripts/desktop-smoke.mjs --app Walnut.app --archive <archive.tar.gz> (from a local mirror)
 *   node scripts/desktop-smoke.mjs --app Walnut.app                          (the release it carries)
 *
 * An app that carries the release for this Mac (scripts/desktop-carry-release.mjs,
 * one DMG per architecture) must install it with no network: every release URL
 * it is given is dead, and its log must say it installed what it carries.
 *
 * Everything lives under --work (default a temp dir): HOME (so ~/.open-walnut,
 * ~/.local and Application Support), the daemon dir, and a port no one uses.
 * It never touches the real Walnut. .github/workflows/mac-app.yml runs it on
 * the notarized app before attaching it to a release.
 */
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { carryRelease } from './desktop-carry-release.mjs'
import { stopOwnDaemon } from './release-rehearsal/own-daemon.mjs'
import { archiveVersion, publishLocally, serveReleases } from './release-rehearsal/runtime.mjs'

function parseArgs(argv) {
  const out = { app: null, version: null, archive: null, work: null, keep: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--app') out.app = path.resolve(argv[++i])
    else if (a === '--version') out.version = argv[++i]
    else if (a === '--archive') out.archive = path.resolve(argv[++i])
    else if (a === '--work') out.work = path.resolve(argv[++i])
    else if (a === '--keep') out.keep = true
    else throw new Error(`unknown argument ${a}`)
  }
  if (!out.app) throw new Error('usage: desktop-smoke.mjs --app <Walnut.app> [--version <x.y.z> | --archive <file>] [--work <dir>] [--keep]')
  return out
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }).on('error', reject)
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(what, ms, probe) {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await probe().catch(() => null)
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timed out after ${Math.round(ms / 1000)}s waiting for ${what}`)
    await sleep(1000)
  }
}

const answers = async (port) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(3000) })
  return res.ok
}

const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function listener(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n')[0] || null
  } catch { return null }
}

/** This Mac's architecture in install.sh's words, also under Rosetta (BundledRuntime.machineArch). */
export function machineArch() {
  try {
    return execFileSync('sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8' }).trim() === '1' ? 'arm64' : 'x64'
  } catch {
    return 'x64' // the key exists only on Apple silicon
  }
}

/**
 * The release `app` carries for a Mac of `arch` (Contents/Resources/release,
 * BundledRuntime.carriedRelease), as `{ version }`, or null: an app without one
 * downloads the release's archive on its first launch.
 */
export function carriedFor(app, arch = machineArch()) {
  const root = path.join(app, 'Contents', 'Resources', 'release')
  let dirs = []
  try { dirs = fs.readdirSync(root).filter((d) => /^v\d/.test(d)) } catch { return null }
  for (const d of dirs) {
    const version = d.slice(1)
    const files = fs.readdirSync(path.join(root, d))
    if (files.includes('SHA256SUMS') && files.includes(`open-walnut-${version}-darwin-${arch}.tar.gz`)) return { version }
  }
  return null
}

/**
 * Whether the app at `binary` still asks for its setup choice on a first launch:
 * an app built before the no-click first launch (797b3ec9, so 0.6.8 and older)
 * shows it and starts unattended only with WALNUT_DESKTOP_AUTOSETUP=1, which it
 * reads by name. mac-app.yml runs this harness from main against the app of the
 * release it builds, which may be days older (0.6.8 waited 20 minutes for a click).
 */
export function readsAutosetupKnob(binary) {
  return fs.readFileSync(binary).includes('WALNUT_DESKTOP_AUTOSETUP')
}

/**
 * The three steps against one Walnut.app, in `work`. `releaseUrl` is a mirror
 * laid out like GitHub Releases (the rehearsal's); without one, install.sh
 * takes `version` from GitHub. Resolves with the steps' results; rejects on
 * the first failure, after printing the app's logs.
 */
export async function smokeDesktopApp({ app: given, work: made, version, releaseUrl = null, carry = null }) {
  fs.mkdirSync(made, { recursive: true })
  const work = fs.realpathSync(made)
  // `carry` ({ archive, sums }): a copy of the app, carrying that release, signed
  // again as the dev build is (ad-hoc), the way a release build carries its own.
  let appBundle = given
  if (carry) {
    appBundle = path.join(work, 'carried', 'Walnut.app')
    fs.mkdirSync(path.dirname(appBundle), { recursive: true })
    execFileSync('ditto', [given, appBundle])
    carryRelease({ app: appBundle, ...carry })
    execFileSync('codesign', ['--force', '--sign', '-', appBundle], { stdio: 'ignore' })
  }
  const carried = carriedFor(appBundle)
  if (carried && version && carried.version !== version) throw new Error(`the app carries ${carried.version}, not ${version}`)
  version = version ?? carried?.version
  if (!version) throw new Error('the app carries no release for this Mac: name the one it installs (--version or --archive)')
  const home = path.join(work, 'home')
  fs.mkdirSync(home, { recursive: true })
  const support = path.join(home, 'Library', 'Application Support', 'Walnut')
  const port = await freePort()
  const env = {
    HOME: home,
    // NSHomeDirectory() and Application Support follow this, not HOME.
    CFFIXED_USER_HOME: home,
    USER: os.userInfo().username,
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: 'en_US.UTF-8',
    // The system's tools and nothing else: no Node, no npm, no git.
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    WALNUT_DAEMON_DIR: path.join(work, 'daemon'),
    WALNUT_DESKTOP_PORTS: String(port),
  }
  if (carried) {
    // Nothing to download from: what it carries is all there is.
    env.OPEN_WALNUT_RELEASE_BASE_URL = 'http://127.0.0.1:9/no-network'
    env.OPEN_WALNUT_RELEASES_API = 'http://127.0.0.1:9/no-network'
  } else {
    if (releaseUrl) {
      env.OPEN_WALNUT_RELEASE_BASE_URL = releaseUrl
      env.OPEN_WALNUT_RELEASES_API = `${releaseUrl}/no-api`
    }
    env.OPEN_WALNUT_VERSION = version
  }
  const binary = path.join(appBundle, 'Contents', 'MacOS', 'Walnut')
  // A newer app starts by itself and has to show that here, with no knob.
  if (readsAutosetupKnob(binary)) env.WALNUT_DESKTOP_AUTOSETUP = '1'
  const results = []
  const step = async (name, fn) => {
    const t0 = Date.now()
    try {
      const detail = await fn()
      results.push({ name, ok: true, secs: (Date.now() - t0) / 1000, detail: detail ?? '' })
    } catch (err) {
      results.push({ name, ok: false, secs: (Date.now() - t0) / 1000, detail: err instanceof Error ? err.message : String(err) })
      throw err
    }
  }
  const launch = (logName) => {
    const log = fs.openSync(path.join(work, logName), 'a')
    return spawn(binary, [], { env, stdio: ['ignore', log, log] })
  }
  const desktopLog = () => { try { return fs.readFileSync(path.join(support, 'desktop.log'), 'utf8') } catch { return '' } }

  let app = null
  // The server writes its log into the daemon dir until it exits, which is
  // after its port closes: wait for the process, not the port (2026-10-07: the
  // work dir was removed under a server still shutting down, rmdir ENOTEMPTY).
  let serverPid = null
  const appGone = async () => {
    app.kill('SIGKILL')
    await until(`port ${port} to close and the server to exit`, 60_000, async () => !listener(port) && !pidAlive(serverPid))
    app = null
  }
  try {
    await step(`first launch installs Walnut ${carried ? 'from the app, with no network,' : 'from the release'} and serves the console`, async () => {
      app = launch('app-1.log')
      await until('the console on the app\'s port', 20 * 60_000, () => answers(port))
      const config = JSON.parse(fs.readFileSync(path.join(support, 'config.json'), 'utf8'))
      const runtimeDir = path.join(home, '.local', 'share', 'open-walnut')
      // macOS writes /tmp for /private/tmp: compare where the paths lead.
      const same = (a, b) => typeof a === 'string' && fs.existsSync(a) && fs.realpathSync(a) === fs.realpathSync(b)
      if (!same(config.runtimeDir, runtimeDir)) throw new Error(`config.json names runtimeDir ${config.runtimeDir}, expected ${runtimeDir}`)
      if (!same(config.walnutHome, path.join(home, '.open-walnut'))) throw new Error(`config.json names walnutHome ${config.walnutHome}`)
      const printed = execFileSync(path.join(home, '.local', 'bin', 'walnut'), ['--version'], { env, encoding: 'utf8' }).trim()
      if (printed.split(/\s/)[0] !== version) throw new Error(`~/.local/bin/walnut reports "${printed}", expected ${version}`)
      const pid = listener(port)
      serverPid = Number(pid)
      const command = pid ? execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' }).trim() : ''
      const node = fs.realpathSync(path.join(runtimeDir, 'app', 'runtime', 'bin', 'node'))
      if (!fs.realpathSync(command.split(' ')[0]).startsWith(node)) throw new Error(`the server on ${port} is "${command}", not the installed runtime's Node`)
      const started = desktopLog().split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } })
        .filter((r) => r?.event === 'runtime_install_started')
      const from = started.at(-1)?.from
      const want = carried ? `carried ${version}` : 'download'
      if (from !== undefined && from !== want) throw new Error(`the app installed from "${from}", expected "${want}"`)
      if (carried && from === undefined) throw new Error('the app never said where it installed from')
      return `walnut ${printed}; server: ${command.slice(0, 120)}`
    })
    await step('the server goes when the app does', appGone)
    await step('a second launch starts the installed copy, downloading nothing', async () => {
      const before = (desktopLog().match(/runtime_install_started/g) ?? []).length
      app = launch('app-2.log')
      await until('the console again', 3 * 60_000, () => answers(port))
      serverPid = Number(listener(port))
      const after = (desktopLog().match(/runtime_install_started/g) ?? []).length
      if (after !== before) throw new Error('the second launch ran install.sh again')
    })
  } finally {
    if (app) await appGone().catch(() => {})
    // The session daemon outlives its server on purpose; this one is ours, in our
    // own dir, and the work dir can go only once it has exited.
    await stopOwnDaemon(env.WALNUT_DAEMON_DIR)
    await stopHolders(work)
    const table = ['| Step | Result | Time | Detail |', '|---|---|---|---|',
      ...results.map((r) => `| ${r.name} | ${r.ok ? 'pass' : '**FAIL**'} | ${Math.round(r.secs)}s | ${String(r.detail).replace(/\|/g, '\\|').slice(0, 200)} |`)]
    process.stdout.write(`\n${table.join('\n')}\n`)
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Walnut.app first launch (${version})\n\n${table.join('\n')}\n\n`)
    if (results.some((r) => !r.ok)) {
      for (const f of ['app-1.log', 'app-2.log']) {
        const p = path.join(work, f)
        if (fs.existsSync(p)) process.stdout.write(`\n── ${f} (tail) ──\n${fs.readFileSync(p, 'utf8').split('\n').slice(-40).join('\n')}\n`)
      }
      process.stdout.write(`\n── desktop.log (tail) ──\n${desktopLog().split('\n').slice(-40).join('\n')}\n`)
      const boot = path.join(support, 'bootstrap.log')
      if (fs.existsSync(boot)) process.stdout.write(`\n── bootstrap.log (tail) ──\n${fs.readFileSync(boot, 'utf8').split('\n').slice(-40).join('\n')}\n`)
    }
  }
  return results
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const work = opts.work ?? fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-desktop-smoke-'))
  let releases = null
  try {
    let releaseUrl = null
    if (opts.archive) {
      const root = path.join(work, 'releases')
      publishLocally(root, archiveVersion(opts.archive), opts.archive)
      releases = await serveReleases(root)
      releaseUrl = releases.url
    }
    await smokeDesktopApp({ app: opts.app, work, version: opts.version ?? (opts.archive ? archiveVersion(opts.archive) : undefined), releaseUrl })
  } finally {
    await releases?.close()
    if (!opts.keep) removeWorkDir(work)
  }
}

/**
 * Whatever still holds a file open in the work dir (a daemon an earlier launch
 * started and its pid file no longer names, a CLI it spawned) was started by this
 * smoke: say which, stop it, and wait, so the dir can be removed.
 */
async function stopHolders(work) {
  // Open files only, not a working directory: a shell that merely sits in the
  // dir (the one that ran this smoke) is not a writer. Never this process or its parent.
  const own = new Set([process.pid, process.ppid])
  const holders = () => {
    let out = ''
    try {
      out = execFileSync('lsof', ['-t', '-a', '-d', '^cwd', '+D', work], { encoding: 'utf8', timeout: 30_000 })
    } catch (e) {
      out = String(e?.stdout ?? '') // lsof exits 1 when nothing holds a file there
    }
    return out.split('\n').map(Number).filter((pid) => pid > 1 && !own.has(pid))
  }
  const left = [...new Set(holders())]
  if (left.length === 0) return
  for (const pid of left) {
    let command = ''
    try { command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim() } catch { /* gone */ }
    process.stdout.write(`desktop-smoke: stopping ${pid} (${command.slice(0, 160)}), still holding files in the work dir\n`)
    try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
  }
  await until('the processes holding the work dir to exit', 15_000, async () => left.every((pid) => !pidAlive(pid)))
    .catch(() => { for (const pid of left) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } })
}

/** Remove the work dir; when something still writes there, name it before failing. */
function removeWorkDir(work) {
  try {
    fs.rmSync(work, { recursive: true, force: true })
  } catch (err) {
    let holders = ''
    try {
      holders = execFileSync('lsof', ['+D', work], { encoding: 'utf8', timeout: 30_000 })
    } catch (e) {
      holders = String(e?.stdout ?? '')
    }
    process.stderr.write(`desktop-smoke: ${work} is still in use${holders ? `:\n${holders.slice(0, 4000)}` : ' (lsof names no process)'}\n`)
    throw err
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`desktop-smoke: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
