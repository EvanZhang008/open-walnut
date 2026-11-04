#!/usr/bin/env bun
/**
 * The Mac app's own update, end to end, on this Mac: an older Walnut.app finds a
 * newer one on a releases page, downloads it (the first try breaks off halfway
 * and is retried), checks it is signed by the same developer, and on "Restart to
 * update" stops its server, quits, is swapped for the new app, and the new app
 * opens and serves the console again (desktop/AppUpdater.swift).
 *
 *   bun scripts/desktop-update-e2e.mjs --old <Walnut.app> --new <Walnut.app> [--source <dir>] [--work <dir>] [--keep]
 *                                      [--read-only-folder] [--auto] [--video <out.mp4>]
 *
 * Both apps must be signed with the same real identity (desktop/build.sh picks
 * one; WALNUT_APP_VERSION sets each one's version), since that is what the
 * updater checks. `--source` is a built checkout (dist/cli.js) the apps run;
 * without it an app that carries its release installs that on its first launch
 * (with no network, as on a person's Mac) and the updated one installs the newer
 * Walnut it carries, which is checked too. mac-app.yml runs it that way, from the
 * previous release's DMG to the one it builds.
 *
 * By default the page's update item is clicked by the app's test hook and
 * `updates.auto` is off, so only the clicks act. `--auto` is the update nobody
 * clicks: `updates.auto` on, no hook; the page downloads by itself, and restarts
 * into it once the server's idle gate says nobody used it for a while
 * (WALNUT_UPDATE_IDLE_MS, short here) and nothing is unsaved.
 *
 * The app always opens behind every window and never takes focus
 * (WALNUT_DESKTOP_E2E_BACKGROUND), so it runs beside a person using the Mac.
 * `--video` films the test app's own window, never the screen (lib/app-window-video.mjs).
 *
 * Nothing touches the real Walnut: HOME, Application Support and the update
 * cache live under --work, the server gets its own port and daemon dir, the
 * releases page is a local server, and the page's own update item is clicked by
 * the app's test hook (WALNUT_DESKTOP_E2E_UPDATE_CLICKS), not by a mouse.
 */
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { accountInfo } from '../src/lib/account.ts'
import { carriedFor, installedVersion, machineArch } from './desktop-smoke.mjs'
import { freePort } from './lib/free-port.mjs'
import { startAppWindowVideo, writesOwnSnapshots } from './lib/app-window-video.mjs'

function parseArgs(argv) {
  const out = { old: null, next: null, source: null, work: null, keep: false, readOnly: false, auto: false, video: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--old') out.old = path.resolve(argv[++i])
    else if (a === '--new') out.next = path.resolve(argv[++i])
    else if (a === '--source') out.source = path.resolve(argv[++i])
    else if (a === '--work') out.work = path.resolve(argv[++i])
    else if (a === '--keep') out.keep = true
    else if (a === '--read-only-folder') out.readOnly = true
    else if (a === '--auto') out.auto = true
    else if (a === '--video') out.video = path.resolve(argv[++i])
    else throw new Error(`unknown argument ${a}`)
  }
  if (!out.old || !out.next || (!out.source && !carriedFor(out.old))) {
    throw new Error('usage: desktop-update-e2e.mjs --old <Walnut.app> --new <Walnut.app> [--source <dir>] [--work <dir>] [--keep] [--auto] [--video <mp4>] (--source unless the old app carries its release)')
  }
  return out
}

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
const plistVersion = (app) => execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim()
const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const answers = async (port) => (await fetch(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(3000) })).ok

/**
 * A releases page shaped like GitHub's: /releases/latest redirects to the tag,
 * the DMG sits under /releases/download/v<version>/. Downloads are paced so the
 * progress has steps to show, and the first one can break off halfway.
 */
function serveFeed({ version, arch, dmg, breakFirstDownload }) {
  const size = fs.statSync(dmg).size
  const asset = `/releases/download/v${version}/Walnut-${arch}.dmg`
  const log = []
  let downloads = 0
  const server = http.createServer((req, res) => {
    log.push(`${req.method} ${req.url}`)
    if (req.url === '/releases/latest') {
      res.writeHead(302, { Location: `/releases/tag/v${version}` })
      res.end()
      return
    }
    if (req.url === asset) {
      res.writeHead(200, { 'Content-Type': 'application/x-apple-diskimage', 'Content-Length': String(size) })
      if (req.method === 'HEAD') { res.end(); return }
      downloads++
      const breakAt = breakFirstDownload && downloads === 1 ? Math.floor(size * 0.3) : Infinity
      const stream = fs.createReadStream(dmg, { highWaterMark: 64 * 1024 })
      let sent = 0
      stream.on('data', (chunk) => {
        stream.pause()
        sent += chunk.length
        if (sent >= breakAt) { req.socket.destroy(); stream.destroy(); return }
        res.write(chunk)
        setTimeout(() => stream.resume(), 40)
      })
      stream.on('end', () => res.end())
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, log, downloads: () => downloads })))
}

/**
 * `readOnly`: the folder the app is in turns read-only once the download is in
 * (a standard user's /Applications): the install must say so and leave the old
 * app running and serving, never quit into nothing.
 */
export async function runUpdateE2E({ old, next, source, work: made, keep = false, readOnly = false, auto = false, video = null }) {
  fs.mkdirSync(made, { recursive: true })
  const work = fs.realpathSync(made)
  const arch = machineArch()
  const from = plistVersion(old)
  const to = plistVersion(next)
  console.log(`Walnut.app ${from} -> ${to} (${arch}) in ${work}`)

  const apps = path.join(work, 'Apps')
  const target = path.join(apps, 'Walnut.app')
  fs.mkdirSync(apps, { recursive: true })
  execFileSync('/usr/bin/ditto', [old, target])

  const dmgSrc = path.join(work, 'dmg-src')
  fs.mkdirSync(dmgSrc, { recursive: true })
  execFileSync('/usr/bin/ditto', [next, path.join(dmgSrc, 'Walnut.app')])
  const dmg = path.join(work, `Walnut-${arch}.dmg`)
  execFileSync('/usr/bin/hdiutil', ['create', '-volname', 'Walnut', '-srcfolder', dmgSrc, '-ov', '-format', 'UDZO', dmg], { stdio: 'ignore' })
  const feed = await serveFeed({ version: to, arch, dmg, breakFirstDownload: true })

  const home = path.join(work, 'home')
  const support = path.join(home, 'Library', 'Application Support', 'Walnut')
  fs.mkdirSync(support, { recursive: true })
  fs.mkdirSync(path.join(home, '.open-walnut'), { recursive: true })
  // With no source the first launch sets itself up from what the app carries, as a person's does.
  if (source) fs.writeFileSync(path.join(support, 'config.json'), JSON.stringify({ walnutHome: path.join(home, '.open-walnut'), walnutSourceDir: source }))
  // Clicked runs: a page that updates by itself (0.6.25 and later) must not act beside the clicks.
  if (!auto) fs.writeFileSync(path.join(home, '.open-walnut', 'config.yaml'), 'updates:\n  auto: false\n')
  const carriedNew = source ? null : carriedFor(next)?.version ?? null
  const runtimeDir = path.join(home, '.local', 'share', 'open-walnut')
  const port = await freePort()
  // The swap opens the new app with `open`, which would start it with the user's
  // own environment; here it starts with this test's.
  const opener = path.join(work, 'open-app.sh')
  fs.writeFileSync(opener, `#!/bin/sh\nnohup "$1/Contents/MacOS/Walnut" >> "${path.join(work, 'app-2.log')}" 2>&1 &\n`, { mode: 0o755 })
  const env = {
    HOME: home,
    CFFIXED_USER_HOME: home,
    USER: accountInfo().username,
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: 'en_US.UTF-8',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    WALNUT_DAEMON_DIR: path.join(work, 'daemon'),
    WALNUT_DESKTOP_PORTS: String(port),
    WALNUT_UPDATE_FEED_URL: `http://127.0.0.1:${feed.port}/releases`,
    WALNUT_UPDATE_STARTUP_DELAY_MS: '3000',
    WALNUT_UPDATE_POLL_MS: '600000',
    WALNUT_APPLY_UPDATE_OPEN: opener,
    // Opens behind every window and never takes focus from the person at this Mac.
    WALNUT_DESKTOP_E2E_BACKGROUND: '1',
  }
  if (auto) env.WALNUT_UPDATE_IDLE_MS = '20000'
  else env.WALNUT_DESKTOP_E2E_UPDATE_CLICKS = '1'
  if (!source) {
    // Nothing to download Walnut from: what the apps carry is all there is.
    env.OPEN_WALNUT_RELEASE_BASE_URL = 'http://127.0.0.1:9/no-network'
    env.OPEN_WALNUT_RELEASES_API = 'http://127.0.0.1:9/no-network'
  }
  // The page's own lines (the server writes the forwarded browser log into its daemon dir).
  const pageLog = () => {
    try {
      const dir = path.join(work, 'daemon')
      return fs.readdirSync(dir).filter((f) => f.startsWith('open-walnut-') && f.endsWith('.log'))
        .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')
    } catch { return '' }
  }
  const pageSaid = (text) => pageLog().includes(text)
  // What the update item says, each time it changes, as the page itself reports it.
  const pillScript = path.join(work, 'pill-watch.js')
  fs.writeFileSync(pillScript, `(() => {
    let last = null;
    setInterval(() => {
      const el = document.querySelector('.stale-build-pill');
      const text = el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : '';
      if (text !== last) { last = text; console.log('[app-update-e2e] pill: ' + (text || '(none)')); }
    }, 500);
  })();\n`)
  env.WALNUT_DESKTOP_E2E_SCRIPT = pillScript
  const readsPageScript = fs.readFileSync(path.join(old, 'Contents', 'MacOS', 'Walnut')).includes('WALNUT_DESKTOP_E2E_SCRIPT')
  const pillSeen = () => [...pageLog().matchAll(/"time":"([^"]+)"[^\n]*?\[app-update-e2e\] pill: ([^"]*)"/g)].map((m) => `${m[1].slice(11, 19)} ${m[2]}`)
  const desktopLog = () => { try { return fs.readFileSync(path.join(support, 'desktop.log'), 'utf8') } catch { return '' } }
  const events = (name) => desktopLog().split('\n').filter((l) => l.includes(`"${name}"`))
  const results = []
  const step = async (name, fn) => {
    const t0 = Date.now()
    try {
      const detail = await fn()
      results.push({ name, ok: true, secs: (Date.now() - t0) / 1000, detail: detail ?? '' })
      console.log(`  ok  ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)${detail ? ` - ${detail}` : ''}`)
    } catch (err) {
      results.push({ name, ok: false, secs: (Date.now() - t0) / 1000, detail: String(err?.message ?? err) })
      console.log(`  FAIL ${name}: ${err?.message ?? err}`)
      throw err
    }
  }

  const exe = path.join(target, 'Contents', 'MacOS', 'Walnut')
  const snapshots = video ? writesOwnSnapshots(exe) : false
  if (snapshots) env.WALNUT_DESKTOP_E2E_SNAPSHOTS = path.join(work, 'frames')
  let recording = null
  try {
    recording = video ? startAppWindowVideo({ exe, dir: path.join(work, 'frames'), snapshots }) : null
  } catch (err) {
    console.log(`  video: none (${err?.message ?? err})`)
  }
  const appLog = fs.openSync(path.join(work, 'app-1.log'), 'a')
  const app = spawn(path.join(target, 'Contents', 'MacOS', 'Walnut'), [], { env, stdio: ['ignore', appLog, appLog] })
  let exited = false
  app.on('exit', () => { exited = true })
  try {
    await step(`Walnut ${from} starts and serves the console`, async () => {
      await until('the console', 5 * 60_000, () => answers(port))
      const configured = events('app_update_configured').at(-1) ?? ''
      if (!configured.includes('"enabled":"true"')) throw new Error(`updates are off in the old app: ${configured}`)
      return `port ${port}`
    })
    await step(`it finds ${to} on the releases page`, async () => {
      await until('app_update_available', 60_000, async () => events('app_update_available').length > 0)
      return feed.log.filter((l) => l.includes('/releases/')).slice(0, 2).join(', ')
    })
    await step(auto
      ? 'nobody clicks: the page downloads it by itself; the first download breaks off and its own retry completes and verifies'
      : 'the page clicks Download; the first download breaks off and the retry completes and verifies', async () => {
      await until('a failed download', 120_000, async () => events('app_update_download_failed').length > 0)
      // The page tries a failed download again after a minute (app-auto-update.ts).
      await until('app_update_downloaded', 300_000, async () => events('app_update_downloaded').length > 0)
      if (feed.downloads() !== 2) throw new Error(`expected 2 downloads, saw ${feed.downloads()}`)
      if (auto && !pageSaid('downloading the app update by itself')) throw new Error('the page never said it downloaded by itself')
      // The person sees it: the item counted the download up. Only an app that runs a test's
      // page script (WALNUT_DESKTOP_E2E_SCRIPT) reports what the item said.
      const seen = pillSeen()
      if (readsPageScript && !seen.some((l) => /Downloading [1-9]\d?%/.test(l))) throw new Error(`the update item never showed the download's progress: ${seen.join(' | ')}`)
      return events('app_update_download_failed')[0].match(/"message":"([^"]*)"/)?.[1] ?? ''
    })
    if (readOnly) {
      fs.chmodSync(apps, 0o555)
      try {
        await step('Restart to update in a folder it cannot write: says so, keeps running and serving', async () => {
          await until('app_update_install_failed', 60_000, async () => events('app_update_install_failed').length > 0)
          await sleep(3000)
          if (exited) throw new Error('the app quit anyway')
          if (!(await answers(port))) throw new Error('the console stopped answering')
          if (events('app_update_stopping_server').length) throw new Error('the server was stopped before the install could be placed')
          if (plistVersion(target) !== from) throw new Error('the installed app changed')
          return events('app_update_install_failed')[0].match(/"message":"([^"]*)"/)?.[1] ?? ''
        })
      } finally {
        fs.chmodSync(apps, 0o755)
      }
      return results
    }
    await step(auto
      ? 'nobody clicks Restart: once nobody used it for a while and nothing is unsaved, it stops the server, quits and hands the swap over'
      : 'Restart to update stops the server, quits the app and hands the swap over', async () => {
      // The idle gate (20 s here) and the page's next look at it (a minute while it waits).
      await until('app_update_apply_started', auto ? 240_000 : 60_000, async () => events('app_update_apply_started').length > 0)
      // Only the page asks the app to install (its update item, or its own step): with no click hook, its own step.
      if (auto && !events('app_update_installing').length) throw new Error('the app installed without the page asking')
      await until('the old app to quit', 30_000, async () => exited)
      return events('app_update_stopping_server').length ? 'server stopped first' : ''
    })
    await step(`the swap puts Walnut ${to} in place and opens it`, async () => {
      const applyLog = path.join(home, 'Library', 'Caches', 'Walnut', 'Updates', 'apply-update.log')
      await until('apply-update.log to say updated', 60_000, async () => fs.existsSync(applyLog) && fs.readFileSync(applyLog, 'utf8').includes('updated'))
      const now = plistVersion(target)
      if (now !== to) throw new Error(`the app is ${now}, not ${to}`)
      const leftovers = fs.readdirSync(apps).filter((n) => n !== 'Walnut.app')
      if (leftovers.length) throw new Error(`left behind: ${leftovers.join(', ')}`)
      return fs.readFileSync(applyLog, 'utf8').trim().split('\n').at(-1)
    })
    await step(`Walnut ${to} serves the console again, with nothing more to offer`, async () => {
      await until(`app_update_configured from ${to}`, 60_000, async () => events('app_update_configured').some((l) => l.includes(`"version":"${to}"`)))
      await until('the console', 3 * 60_000, () => answers(port))
      // Its first check (3 s after launch) finds itself the newest.
      await sleep(6000)
      const offered = events('app_update_available').filter((l) => l.includes(`"version":"${to}"`)).length
      if (offered !== 1) throw new Error(`the new app was offered ${to} again`)
      return 'up to date'
    })
    if (carriedNew) {
      await step(`it installed the Walnut ${carriedNew} the new app carries`, async () => {
        await until(`the installed Walnut to be ${carriedNew}`, 60_000, async () => installedVersion(runtimeDir) === carriedNew)
        return `${runtimeDir}: ${carriedNew}`
      })
    }
  } finally {
    const newPid = (() => {
      // The relaunched app is the process whose EXECUTABLE is this run's own copy, an exact
      // path in its temp dir. Never `pgrep -f`: a pattern over command lines also matches
      // any shell or agent whose command merely mentions the path.
      const exe = path.join(target, 'Contents', 'MacOS', 'Walnut')
      try {
        const rows = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,comm='], { encoding: 'utf8' }).split('\n')
        for (const row of rows) {
          const m = row.match(/^\s*(\d+)\s+(.*\S)\s*$/)
          if (m && m[2] === exe && Number(m[1]) !== process.pid) return Number(m[1])
        }
      } catch { /* no process table: nothing to stop */ }
      return 0
    })()
    if (!exited) app.kill('SIGTERM')
    if (newPid > 1) process.kill(newPid, 'SIGTERM')
    await until('the apps to quit', 30_000, async () => !pidAlive(newPid) && (exited || !pidAlive(app.pid))).catch(() => {})
    // An isolated daemon is not launchd's: it outlives the server unless stopped.
    try {
      const dpid = Number(fs.readFileSync(path.join(work, 'daemon', 'daemon.pid'), 'utf8').trim())
      if (dpid > 1) process.kill(dpid, 'SIGTERM')
    } catch { /* none started */ }
    feed.server.close()
    console.log(`  the update item said: ${pillSeen().join(' | ') || '(nothing reported)'}`)
    if (recording) {
      const mp4 = await recording.stop(video).catch((err) => { console.log(`  video: ${err.message}`); return null })
      console.log(`  video: ${mp4 ?? 'none'} (${recording.frames()} frames of the app's own window)`)
    }
    if (!keep && results.every((r) => r.ok)) fs.rmSync(work, { recursive: true, force: true })
  }
  return results
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2))
  const work = args.work ?? fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-update-e2e-'))
  runUpdateE2E({ old: args.old, next: args.next, source: args.source, work, keep: args.keep, readOnly: args.readOnly, auto: args.auto, video: args.video })
    .then(() => { console.log('PASS'); process.exit(0) })
    .catch((err) => { console.error(`FAIL: ${err?.message ?? err}\nwork dir kept: ${work}`); process.exit(1) })
}
