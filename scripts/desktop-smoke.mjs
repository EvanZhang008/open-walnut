#!/usr/bin/env node
/**
 * First launch of Walnut.app on a Mac that has never seen Walnut: the app runs
 * Get Started on its own (WALNUT_DESKTOP_AUTOSETUP=1), installs the
 * self-contained Walnut with the install.sh it carries, starts the server with
 * that copy's Node and nothing else on PATH, and serves the console. Then the
 * app dies, the server goes with it (OPEN_WALNUT_EXIT_ON_ORPHAN), and a second
 * launch starts the installed copy again without downloading anything.
 *
 *   node scripts/desktop-smoke.mjs --app Walnut.app --version 0.7.0          (from the GitHub release)
 *   node scripts/desktop-smoke.mjs --app Walnut.app --archive <archive.tar.gz> (from a local mirror)
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
  if (!out.app || (!out.version && !out.archive)) throw new Error('usage: desktop-smoke.mjs --app <Walnut.app> (--version <x.y.z> | --archive <file>) [--work <dir>] [--keep]')
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

function listener(port) {
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n')[0] || null
  } catch { return null }
}

/**
 * The three steps against one Walnut.app, in `work`. `releaseUrl` is a mirror
 * laid out like GitHub Releases (the rehearsal's); without one, install.sh
 * takes `version` from GitHub. Resolves with the steps' results; rejects on
 * the first failure, after printing the app's logs.
 */
export async function smokeDesktopApp({ app: appBundle, work: made, version, releaseUrl = null }) {
  fs.mkdirSync(made, { recursive: true })
  const work = fs.realpathSync(made)
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
    WALNUT_DESKTOP_AUTOSETUP: '1',
  }
  if (releaseUrl) {
    env.OPEN_WALNUT_RELEASE_BASE_URL = releaseUrl
    env.OPEN_WALNUT_RELEASES_API = `${releaseUrl}/no-api`
  }
  env.OPEN_WALNUT_VERSION = version
  const binary = path.join(appBundle, 'Contents', 'MacOS', 'Walnut')
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
  try {
    await step('first launch installs Walnut and serves the console', async () => {
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
      const command = pid ? execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' }).trim() : ''
      const node = fs.realpathSync(path.join(runtimeDir, 'app', 'runtime', 'bin', 'node'))
      if (!fs.realpathSync(command.split(' ')[0]).startsWith(node)) throw new Error(`the server on ${port} is "${command}", not the installed runtime's Node`)
      return `walnut ${printed}; server: ${command.slice(0, 120)}`
    })
    await step('the server goes when the app does', async () => {
      app.kill('SIGKILL')
      await until(`port ${port} to close`, 60_000, async () => !listener(port))
      app = null
    })
    await step('a second launch starts the installed copy, downloading nothing', async () => {
      const before = (desktopLog().match(/runtime_install_started/g) ?? []).length
      app = launch('app-2.log')
      await until('the console again', 3 * 60_000, () => answers(port))
      const after = (desktopLog().match(/runtime_install_started/g) ?? []).length
      if (after !== before) throw new Error('the second launch ran install.sh again')
    })
  } finally {
    if (app) {
      app.kill('SIGKILL')
      await until(`port ${port} to close`, 60_000, async () => !listener(port)).catch(() => {})
    }
    // The session daemon outlives its server on purpose; this one is ours, in our
    // own dir, and the work dir can go only once it has exited.
    await stopOwnDaemon(env.WALNUT_DAEMON_DIR)
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
    await smokeDesktopApp({ app: opts.app, work, version: opts.version ?? archiveVersion(opts.archive), releaseUrl })
  } finally {
    await releases?.close()
    if (!opts.keep) fs.rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`desktop-smoke: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
