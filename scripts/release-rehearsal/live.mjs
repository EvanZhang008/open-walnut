#!/usr/bin/env bun
/**
 * The live update (src/core/self-update/live-update.ts), rehearsed on real
 * compiled files: a server a person started from a terminal installs a newer
 * release while it serves and restarts into it when nobody is using it, on the
 * same port, with its tasks, its sessions and their CLIs kept.
 *
 *   bun scripts/release-rehearsal/live.mjs build --out <dir> [--allow-checkout]
 *        compiles this checkout's file for this machine three times, at nightly-
 *        shaped versions A < B < C above every published one (and package.json),
 *        packs each as a release publishes it (the launcher and its platform
 *        packages, field-packs.mjs), packs a fourth version whose file answers
 *        --version and exits 1 at every start, lays A out as a release install.sh
 *        reads, and writes <dir>/live.json. package.json is put back.
 *   bun scripts/release-rehearsal/run.mjs --live <dir>/live.json [--live-video <dir>]
 *        the scenarios below (--live-video records a browser through live-update,
 *        live-video.mjs).
 *
 * Scenarios (one isolated HOME each, mock `claude`, a local registry whose
 * `nightly` tag names A; WALNUT_UPDATE_IDLE_MS short):
 *   live-install   install.sh puts A into ~/.local/share/open-walnut (versions
 *                  layout); `walnut --version` names it.
 *   live-serve     `walnut web` started as a plain child (a terminal: nothing
 *                  supervises it) becomes the supervisor at once: the server on
 *                  the port is its child before any update. It serves A; a task,
 *                  and a session that answers two messages; GET /api/system/update
 *                  says `live` idle, can install. From here to live-stop the
 *                  started process is watched: it never listens and never opens
 *                  the data files.
 *   live-update    B is published (its platform package; the tag moves); a
 *                  person was active a moment ago; POST /api/system/update/check.
 *                  `live` goes downloading -> installed/waiting -> restarting,
 *                  the same port serves B, the process the terminal started is
 *                  still alive as the parent of the server, the task, the history,
 *                  the daemon and the session's CLI are the same, a third message
 *                  is answered, and bin/walnut runs B.
 *   live-again     POST /api/system/update/restart with nothing new answers 409;
 *                  C is published and the server (now supervised: exit 75 to the
 *                  parent) restarts into it the same way; a fourth message.
 *   live-stop      SIGTERM to the terminal's process ends the chain: it exits,
 *                  the server child is gone and nothing listens on the port. The
 *                  log holds no server work of the started process (no SERVER
 *                  EXIT of its pid, no write to data it handed on, one boot of
 *                  the background jobs per server child).
 *   live-rollback  a fresh install of A takes the broken version: it installs
 *                  (its --version is right), the restart's first start exits 1,
 *                  A is linked back and serves on the same port, the broken
 *                  version is held (bad/<version>, `live.held`) and not installed again.
 *                  Then its server child dies by SIGKILL: the started process exits
 *                  with the child's code (137) and starts nothing.
 */
import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { nextVersion, setManifestVersion } from '../release.mjs'
import { builtName } from '../release-files.mjs'
import { packVersion, publishedTags } from './field-packs.mjs'
import { alive, childrenOf, commandOf, cpuTicks, groupAlive, listenersOf, openPaths, parentOf, startedAt } from './live-proc.mjs'
import { startRegistry } from './registry.mjs'
import { INSTALL_SH, systemPathWithoutNode } from './runtime.mjs'
import { compareVersions } from './version-order.mjs'
import { IsolatedWalnut, runLogged } from './walnut.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nonce = () => crypto.randomBytes(4).toString('hex')
const ask = (label, mark) => ({ text: `snapshot-clean-turn:answered ${label} ${mark}`, answer: `answered ${label} ${mark}` })
const word = (printed) => printed.split(/\s/)[0]
const IDLE_MS = 20_000
const hostTarget = () => `${process.platform}-${process.arch}`

/** A, B, C and the broken one: `<patch above base>-nightly.<yyyymmdd>.900000<n>`. */
export function liveVersions(versions, now = new Date()) {
  const known = versions.filter((v) => v && compareVersions(v, v) !== null)
  const base = known.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b))
  const next = nextVersion(base.replace(/-.*$/, ''), 'patch')
  const day = now.toISOString().slice(0, 10).replace(/-/g, '')
  const v = (n) => `${next}-nightly.${day}.${9000000 + n}`
  return { a: v(1), b: v(2), c: v(3), bad: v(4) }
}

// ── build ──

function compileAt(version, target, { reuseWeb, keep }) {
  const pkgFile = path.join(root, 'package.json')
  fs.writeFileSync(pkgFile, setManifestVersion(fs.readFileSync(pkgFile, 'utf8'), version))
  const bun = process.env.BUN || (typeof Bun !== 'undefined' ? process.execPath : 'bun')
  execFileSync(bun, ['scripts/build-binary.mjs', '--target', target, ...(reuseWeb ? ['--reuse-web'] : [])], {
    cwd: root, stdio: 'inherit', env: { ...process.env, WALNUT_VERSION_STAMPED: '1' },
  })
  fs.mkdirSync(keep, { recursive: true })
  const file = path.join(keep, builtName(target))
  fs.copyFileSync(path.join(root, 'dist-bin', builtName(target)), file)
  fs.chmodSync(file, 0o755)
  const env = { ...process.env }
  delete env.BUN_BE_BUN
  const printed = execFileSync(file, ['--version'], { env, encoding: 'utf8', timeout: 120_000 }).trim()
  if (word(printed) !== version) throw new Error(`${builtName(target)} at ${version} prints "${printed}"`)
  return file
}

/** A release's install.sh files: <dir>/v<version>/walnut-<version>-<target>.gz and SHA256SUMS. */
function layOutRelease(dir, version, target, file) {
  const rel = path.join(dir, `v${version}`)
  fs.mkdirSync(rel, { recursive: true })
  const gzName = `walnut-${version}-${target}.gz`
  fs.writeFileSync(path.join(rel, gzName), zlib.gzipSync(fs.readFileSync(file), { level: 6 }))
  const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
  fs.writeFileSync(path.join(rel, 'SHA256SUMS'), `${sha(path.join(rel, gzName))}  ${gzName}\n${sha(file)}  walnut-${version}-${target}\n`)
}

async function build(opts) {
  if (fs.existsSync(path.join(root, '.git')) && !process.env.CI && !opts.allowCheckout) {
    throw new Error('this rebuilds dist-bin/ and rewrites package.json: run it in a copy of the tree, or pass --allow-checkout')
  }
  const target = hostTarget()
  const local = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  const tags = await publishedTags()
  const v = liveVersions([tags.latest, tags.nightly, local])
  process.stdout.write(`live versions: A ${v.a}, B ${v.b}, C ${v.c}, broken ${v.bad} (npm latest ${tags.latest}, nightly ${tags.nightly})\n`)
  const out = opts.out
  fs.mkdirSync(out, { recursive: true })
  const pkgFile = path.join(root, 'package.json')
  const manifest = fs.readFileSync(pkgFile, 'utf8')
  const files = {}
  try {
    files.a = compileAt(v.a, target, { reuseWeb: opts.reuseWeb, keep: path.join(out, `files-${v.a}`) })
    // The web app does not change with the version.
    files.b = compileAt(v.b, target, { reuseWeb: true, keep: path.join(out, `files-${v.b}`) })
    files.c = compileAt(v.c, target, { reuseWeb: true, keep: path.join(out, `files-${v.c}`) })
  } finally {
    fs.writeFileSync(pkgFile, manifest)
  }
  // The broken release: the right --version (so the install's own check passes), then exit 1 at every start.
  const badDir = path.join(out, `files-${v.bad}`)
  fs.mkdirSync(badDir, { recursive: true })
  files.bad = path.join(badDir, builtName(target))
  fs.writeFileSync(files.bad, `#!/bin/sh\nif [ "$1" = --version ]; then echo "${v.bad} (rehearsal: broken at start)"; exit 0; fi\necho "open-walnut ${v.bad}: broken on purpose (live-update rehearsal)" >&2\nexit 1\n`, { mode: 0o755 })
  const tarballs = {}
  for (const k of ['a', 'b', 'c', 'bad']) tarballs[k] = packVersion({ files: { [target]: files[k] }, version: v[k], out }).map((t) => path.relative(out, t))
  layOutRelease(path.join(out, 'release'), v.a, target, files.a)
  const doc = { target, versions: v, tarballs, release: 'release', files: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, path.relative(out, f)])) }
  fs.writeFileSync(path.join(out, 'live.json'), `${JSON.stringify(doc, null, 2)}\n`)
  process.stdout.write(`${path.join(out, 'live.json')}\n`)
}

export function readLiveJson(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  const dir = path.dirname(file)
  for (const k of ['a', 'b', 'c', 'bad']) doc.tarballs[k] = doc.tarballs[k].map((t) => path.resolve(dir, t))
  doc.release = path.resolve(dir, doc.release)
  return doc
}

// ── the scenarios ──

/** An install.sh install of `version` in its own HOME; the server runs from ~/.local/bin/walnut. */
async function installA(work, name, live, registry) {
  const w = new IsolatedWalnut({
    work, name,
    extraEnv: {
      WALNUT_UPDATE_REGISTRY_URL: registry.distTagsUrl,
      npm_config_registry: `${registry.url}/`,
      WALNUT_UPDATE_IDLE_MS: String(IDLE_MS),
      // A person's daemon outlives its server (field.mjs does the same).
      WALNUT_DAEMON_HEARTBEAT_MS: String(30 * 60_000),
    },
  })
  const bare = systemPathWithoutNode(path.join(work, 'system-bin'))
  for (const n of ['bun', 'bunx']) fs.rmSync(path.join(bare, n), { force: true })
  w.env.PATH = [w.binDir, path.join(w.home, '.local/bin'), bare].join(path.delimiter)
  const env = { ...w.env, OPEN_WALNUT_RELEASE_BASE_URL: `file://${live.release}`, OPEN_WALNUT_VERSION: live.versions.a, OPEN_WALNUT_MODIFY_PATH: '0' }
  const code = await runLogged('sh', [INSTALL_SH], { env, cwd: w.dir, logFile: w.logFile, timeoutMs: 5 * 60_000 })
  if (code !== 0) throw new Error(`install.sh exited ${code} (log: ${w.logFile})`)
  w.fixedBin = path.join(w.home, '.local/bin/walnut')
  w.installRoot = path.join(w.home, '.local/share/open-walnut')
  return w
}

const linked = (w) => fs.readlinkSync(path.join(w.installRoot, 'bin/walnut'))

/** Poll GET /api/system/update; resolves the states seen (with times) once `until` holds or the server stops answering. */
async function watchLive(w, until, ms) {
  const seen = []
  const t0 = Date.now()
  let lastStatus = null
  while (Date.now() - t0 < ms) {
    let res = null
    try { res = await w.api('GET', '/api/system/update') } catch { res = null }
    if (!res || res.status !== 200) return { seen, gone: true, ms: Date.now() - t0, last: lastStatus }
    lastStatus = res.json
    const s = res.json?.live?.state ?? 'none'
    if (seen[seen.length - 1]?.state !== s) seen.push({ state: s, atMs: Date.now() - t0, version: res.json?.live?.version, error: res.json?.live?.error, idle: res.json?.live?.idle })
    if (until(res.json)) return { seen, gone: false, ms: Date.now() - t0, last: lastStatus }
    await sleep(150)
  }
  throw new Error(`live never got there in ${ms / 1000}s; states: ${seen.map((x) => x.state).join(' -> ')}`)
}

/** Poll /api/v1/status on the same port until it serves `version`; resolves the downtime. */
async function servedAgain(w, version, ms) {
  const t0 = Date.now()
  let last = ''
  while (Date.now() - t0 < ms) {
    try {
      const s = await w.api('GET', '/api/v1/status')
      if (s.json?.version === version) return Date.now() - t0
      last = `${s.status} ${s.json?.version ?? s.text.slice(0, 100)}`
    } catch (e) { last = String(e?.message ?? e) }
    await sleep(250)
  }
  throw new Error(`port ${w.port} did not serve ${version} within ${ms / 1000}s (last: ${last}; log: ${w.logFile})`)
}

/** A person was here a moment ago (what a window's time heartbeat says): the restart waits IDLE_MS. */
async function personActive(w) {
  const r = await w.api('POST', '/api/time/heartbeats', { samples: [{ ts: new Date(Date.now() - 5_000).toISOString(), durationMs: 5_000, kind: 'chat' }] })
  if (r.status !== 204) throw new Error(`POST /api/time/heartbeats answered ${r.status} ${r.text.slice(0, 200)}`)
}

/** The process tree: the terminal's process is alive and the server on the port is its child. */
function treeOf(w) {
  const parent = w.server?.pid
  const listeners = listenersOf(w.port)
  // A child the server is forking holds the socket too until its exec closes it: the oldest holder is the server.
  const server = listeners.includes(parent) ? parent
    : listeners.filter((p) => parentOf(p) === parent).sort((a, b) => startedAt(a) - startedAt(b))[0] ?? listeners[0] ?? null
  return { parent, parentAlive: alive(parent), listeners, server, serverParent: server ? parentOf(server) : null, serverCmd: server ? commandOf(server) : '' }
}

function daemonOf(w) {
  const read = (f) => { try { return fs.readFileSync(path.join(w.daemonDir, f), 'utf8').trim() } catch { return null } }
  return Number(read('daemon.pid')) || null
}

function cliGroupOf(w, sid) {
  try { return Number(fs.readFileSync(path.join(`${w.daemonDir}-streams`, `${sid}.pgid`), 'utf8').trim()) || null } catch { return null }
}

/**
 * Watch the started process (the supervisor) every 500 ms: it must never listen
 * on the port nor hold a file of the data home (the databases, the instance lock).
 */
function watchParent(w) {
  const pid = w.server.pid
  const violations = []
  let samples = 0
  let cpu = null
  const timer = setInterval(() => {
    if (!alive(pid)) return
    samples++
    cpu = cpuTicks(pid) ?? cpu
    if (listenersOf(w.port).includes(pid)) violations.push(`listened on :${w.port}`)
    for (const p of openPaths(pid)) if (p.startsWith(w.walnutHome + path.sep) && /\.(sqlite|db)(-wal|-shm|-journal)?$|lock/i.test(p)) violations.push(`held ${p}`)
  }, 500)
  return { stop: () => { clearInterval(timer); return { violations: [...new Set(violations)], samples, cpu: cpuTicks(pid) ?? cpu } } }
}

/**
 * What the shared log says of the started process: no SERVER EXIT of its pid, no
 * write refused by a sealed database, and the background jobs booted once per
 * server child (`boots`), so none of them ran in the parent.
 */
function parentLog(w, parent, boots) {
  const text = fs.readFileSync(w.logFile, 'utf8')
  const lines = text.split('\n')
  const exitPids = lines.filter((l) => l.includes('SERVER EXIT')).map((l) => Number((/"pid":(\d+)|pid=(\d+)/.exec(l) ?? [])[1] ?? (/pid=(\d+)/.exec(l) ?? [])[1]))
  for (const f of ['/tmp/open-walnut-exit.log', path.join(w.home, '.cache/open-walnut/exit.log')]) {
    try { for (const l of fs.readFileSync(f, 'utf8').split('\n')) { const m = /"pid":(\d+)|pid=(\d+)/.exec(l); if (m) exitPids.push(Number(m[1] ?? m[2])) } } catch { /* none */ }
  }
  if (exitPids.includes(parent)) throw new Error(`the started process ${parent} wrote a SERVER EXIT`)
  const sealed = lines.filter((l) => l.includes('handed its data'))
  if (sealed.length) throw new Error(`a process wrote to data it handed on: ${sealed[0].slice(0, 200)}`)
  const started = lines.filter((l) => l.includes('host-learning: started')).length
  if (started !== boots) throw new Error(`host-learning started ${started} times for ${boots} server children`)
  const count = (re) => lines.filter((l) => re.test(l)).length
  return `log: SERVER EXIT pids ${[...new Set(exitPids)].join(', ') || 'none'} (never ${parent}); host-learning started ${started}x for ${boots} server children; host-learning/summary/usage/orphan-recovery lines ${count(/host-learning|project-summary|turn-complete-summary|usage collection|orphan recovery/)} in all, 0 sealed-data errors`
}

/** Publish `to`, have a person active, ask for a check, and follow the live update to `to` on the same port. */
async function updateTo(w, registry, to, label) {
  const before = treeOf(w)
  registry.setDistTags({ latest: to, nightly: to })
  await personActive(w)
  const t0 = Date.now()
  const check = await w.api('POST', '/api/system/update/check')
  if (![200, 202].includes(check.status)) throw new Error(`POST /api/system/update/check answered ${check.status} ${check.text.slice(0, 200)}`)
  const followed = await watchLive(w, (s) => s?.current === to, 10 * 60_000)
  const states = followed.seen.map((x) => x.state)
  const at = (s) => followed.seen.find((x) => x.state === s)?.atMs
  const down = await servedAgain(w, to, 180_000)
  const total = Date.now() - t0
  for (const s of ['downloading', 'restarting']) if (!states.includes(s)) throw new Error(`${label}: live never said ${s} (${states.join(' -> ')})`)
  if (!states.includes('installed') && !states.includes('waiting')) throw new Error(`${label}: live never said installed/waiting (${states.join(' -> ')})`)
  const order = ['downloading', states.includes('installed') ? 'installed' : 'waiting', 'restarting'].map((s) => states.indexOf(s))
  if (!(order[0] < order[1] && order[1] < order[2])) throw new Error(`${label}: states out of order: ${states.join(' -> ')}`)
  const after = treeOf(w)
  if (!after.parentAlive || after.parent !== before.parent) throw new Error(`${label}: the terminal's process ${before.parent} is gone`)
  if (!after.server || after.serverParent !== after.parent) throw new Error(`${label}: the server on :${w.port} (pid ${after.server}, parent ${after.serverParent}) is not the child of ${after.parent}`)
  if (after.server === before.server) throw new Error(`${label}: the same server process ${after.server} still listens`)
  if (before.server && before.server !== before.parent && alive(before.server)) throw new Error(`${label}: the old server ${before.server} is still alive`)
  const waitingFor = (at('restarting') ?? 0) - (at('installed') ?? at('waiting') ?? 0)
  return {
    states, before, after, downMs: down, totalMs: total,
    timeline: `downloading at ${at('downloading')}ms, installed/waiting at ${at('installed') ?? at('waiting')}ms, restarting at ${at('restarting')}ms (waited ${Math.round(waitingFor / 1000)}s on the idle gate), ${to} served ${Math.round(total / 1000)}s after the check (port down ${Math.round(down / 1000)}s)`,
  }
}

export async function rehearseLive({ work, liveJson, scenario, walnuts, video = null }) {
  const live = readLiveJson(liveJson)
  const V = live.versions
  const all = [...live.tarballs.a, ...live.tarballs.b, ...live.tarballs.c, ...live.tarballs.bad].map((file) => ({ file }))
  const registry = await startRegistry({ tarballs: all, distTags: { latest: V.a, nightly: V.a } })
  let w = null
  let recorder = null
  const state = { taskId: null, title: null, sid: null, daemon: null, cli: null, marks: [nonce(), nonce(), nonce(), nonce()] }
  try {
    const installed = await scenario('live-install', async () => {
      w = await installA(work, 'live', live, registry)
      walnuts.push(w)
      const printed = w.version()
      if (word(printed) !== V.a) throw new Error(`--version says "${printed}", expected ${V.a}`)
      return `${printed}; bin/walnut -> ${linked(w)}`
    })
    const serving = installed && await scenario('live-serve', async () => {
      await w.start()
      const status = await w.api('GET', '/api/v1/status')
      if (status.json?.version !== V.a) throw new Error(`serving ${status.json?.version}`)
      state.title = `live task ${nonce()} café`
      const made = await w.api('POST', '/api/v1/tasks', { title: state.title })
      state.taskId = made.json?.task?.id
      if (made.status !== 201 || !state.taskId) throw new Error(`POST /api/v1/tasks answered ${made.status} ${made.text.slice(0, 200)}`)
      const one = ask('one', state.marks[0])
      const res = await w.api('POST', '/api/v1/sessions', { cwd: w.project, message: one.text, taskId: state.taskId })
      if (res.status !== 201 || !res.json?.sessionId) throw new Error(`POST /api/v1/sessions answered ${res.status} ${res.text.slice(0, 300)}`)
      state.sid = res.json.sessionId
      await w.waitForAnswer(state.sid, one.answer)
      const two = ask('two', state.marks[1])
      const send = await w.api('POST', '/api/v1/messages', { to: state.sid, text: two.text })
      if (send.status !== 202) throw new Error(`POST /api/v1/messages answered ${send.status}`)
      await w.waitForAnswer(state.sid, two.answer)
      state.daemon = daemonOf(w)
      state.cli = cliGroupOf(w, state.sid)
      const up = await w.api('GET', '/api/system/update')
      const l = up.json?.live
      if (!l || l.state !== 'idle' || l.canInstall !== true) throw new Error(`live is ${JSON.stringify(l)}, expected idle and canInstall (install ${JSON.stringify(up.json?.install)})`)
      const tree = treeOf(w)
      if (!tree.server || tree.server === tree.parent || tree.serverParent !== tree.parent) throw new Error(`before any update the server on :${w.port} must be the child of the started process ${tree.parent}: ${JSON.stringify(tree)}`)
      state.watch = watchParent(w)
      state.boots = new Set([tree.server])
      if (video) {
        recorder = startRecorder(w.base, video)
        await recorder.ready
      }
      return `A ${V.a} on :${w.port} (started pid ${tree.parent} supervises; server ${tree.server} is its child; install kind ${up.json.install.kind}); task ${state.taskId}; session ${state.sid} answered 2; daemon ${state.daemon}; CLI group ${state.cli}; live ${l.state}, canInstall ${l.canInstall}`
    })
    const updated = serving && await scenario('live-update', async () => {
      const r = await updateTo(w, registry, V.b, 'A -> B')
      state.boots.add(r.after.server)
      const list = await w.api('GET', '/api/v1/tasks')
      if (!(list.json?.tasks ?? []).some((t) => t.id === state.taskId && t.title === state.title)) throw new Error(`task ${state.taskId} is gone under B`)
      const messages = await w.waitForAnswer(state.sid, ask('two', state.marks[1]).answer, 60_000)
      if (!messages.some((m) => m.role === 'assistant' && m.text?.includes(ask('one', state.marks[0]).answer))) throw new Error('the first turn is gone from the history')
      const daemonNow = daemonOf(w)
      if (daemonNow !== state.daemon || !alive(daemonNow)) throw new Error(`the daemon changed: ${state.daemon} -> ${daemonNow} (alive ${alive(daemonNow)})`)
      if (!groupAlive(state.cli)) throw new Error(`the session's CLI group ${state.cli} is gone`)
      const three = ask('three', state.marks[2])
      const send = await w.api('POST', '/api/v1/messages', { to: state.sid, text: three.text })
      if (send.status !== 202) throw new Error(`POST /api/v1/messages answered ${send.status}`)
      await w.waitForAnswer(state.sid, three.answer)
      const cliAfter = cliGroupOf(w, state.sid)
      const printed = w.version()
      if (word(printed) !== V.b) throw new Error(`bin/walnut --version says ${printed}`)
      if (linked(w) !== `../versions/${V.b}/walnut`) throw new Error(`bin/walnut -> ${linked(w)}`)
      if (fs.existsSync(path.join(w.walnutHome, 'local/update-unverified.json'))) throw new Error('update-unverified.json is still there after B served')
      return `${r.states.join(' -> ')}; ${r.timeline}; parent ${r.after.parent} alive, server pid ${r.before.server} -> ${r.after.server} (child of ${r.after.serverParent}: ${r.after.serverCmd.slice(0, 120)}); task kept, history kept, daemon ${daemonNow} same, CLI group ${state.cli} alive${cliAfter !== state.cli ? ` (now ${cliAfter})` : ' (same)'}, third message answered; bin/walnut -> ${linked(w)}`
    })
    if (recorder) {
      // Let the window show "Walnut updated to" for a while, then end the recording.
      await sleep(10_000)
      video.result = await recorder.stop()
      recorder = null
    }
    const again = updated && await scenario('live-again', async () => {
      const no = await w.api('POST', '/api/system/update/restart', {})
      if (no.status !== 409 || no.json?.error !== 'no_update') throw new Error(`POST /api/system/update/restart with nothing new answered ${no.status} ${no.text.slice(0, 200)}`)
      const r = await updateTo(w, registry, V.c, 'B -> C')
      state.boots.add(r.after.server)
      const four = ask('four', state.marks[3])
      const send = await w.api('POST', '/api/v1/messages', { to: state.sid, text: four.text })
      if (send.status !== 202) throw new Error(`POST /api/v1/messages answered ${send.status}`)
      await w.waitForAnswer(state.sid, four.answer)
      if (daemonOf(w) !== state.daemon) throw new Error(`the daemon changed under C: ${daemonOf(w)}`)
      if (word(w.version()) !== V.c) throw new Error(`bin/walnut --version says ${w.version()}`)
      return `restart with nothing new: 409 no_update; ${r.states.join(' -> ')}; ${r.timeline}; parent ${r.after.parent} still the same, server ${r.before.server} -> ${r.after.server}; fourth message answered; daemon ${state.daemon} same`
    })
    if (again) await scenario('live-stop', async () => {
      const tree = treeOf(w)
      const child = tree.server
      const t0 = Date.now()
      const exited = new Promise((r) => w.server.once('exit', (code, signal) => r({ code, signal })))
      w.server.kill('SIGTERM')
      const end = await Promise.race([exited, sleep(30_000).then(() => null)])
      if (!end) throw new Error(`the terminal's process ${tree.parent} did not exit within 30s of SIGTERM`)
      const ms = Date.now() - t0
      w.server = null
      for (let i = 0; i < 40 && (alive(child) || listenersOf(w.port).length); i++) await sleep(250)
      if (alive(child)) throw new Error(`the server child ${child} outlived its parent (${commandOf(child)})`)
      const left = listenersOf(w.port)
      if (left.length) throw new Error(`still listening on :${w.port}: ${left.map((p) => `${p} ${commandOf(p)}`).join('; ')}`)
      const orphans = childrenOf(1).filter((p) => /walnut/.test(commandOf(p)) && commandOf(p).includes(' web'))
      const daemonAlive = alive(state.daemon)
      const watched = state.watch.stop()
      if (watched.violations.length) throw new Error(`the started process ${tree.parent} did server work: ${watched.violations.slice(0, 5).join('; ')}`)
      const said = parentLog(w, tree.parent, state.boots.size)
      return `parent ${tree.parent} exited (code ${end.code}, signal ${end.signal}) in ${ms}ms; child ${child} gone; nothing on :${w.port}; reparented walnut web processes: ${orphans.length}; daemon ${state.daemon} ${daemonAlive ? 'still runs (by design)' : 'gone'}; the started process over ${watched.samples} samples: never listened, never opened a data file, ${watched.cpu} CPU ticks; ${said}`
    })
    if (w) await w.shutdown()

    await scenario('live-rollback', async () => {
      registry.setDistTags({ latest: V.a, nightly: V.a })
      const r = await installA(work, 'live-rollback', live, registry)
      walnuts.push(r)
      await r.start()
      const before = treeOf(r)
      registry.setDistTags({ latest: V.bad, nightly: V.bad })
      await personActive(r)
      const check = await r.api('POST', '/api/system/update/check')
      if (![200, 202].includes(check.status)) throw new Error(`check answered ${check.status}`)
      // B goes in, the gate restarts, B exits 1, A comes back.
      const followed = await watchLive(r, (s) => s?.live?.state === 'restarting', 5 * 60_000)
      const states = followed.seen.map((x) => x.state)
      const t0 = Date.now()
      await sleep(3_000)
      const down = await servedAgain(r, V.a, 180_000)
      const after = treeOf(r)
      if (!after.parentAlive || after.parent !== before.parent) throw new Error('the terminal\'s process is gone')
      if (!after.server || after.serverParent !== after.parent) throw new Error(`the server on :${r.port} is not the parent's child: ${JSON.stringify(after)}`)
      if (linked(r) !== `../versions/${V.a}/walnut`) throw new Error(`bin/walnut -> ${linked(r)}, not A`)
      const badMark = path.join(r.installRoot, 'bad', V.bad)
      if (!fs.existsSync(badMark)) throw new Error(`no ${badMark}`)
      const recheck = await r.api('POST', '/api/system/update/check')
      await sleep(2_000)
      const up = await r.api('GET', '/api/system/update')
      const l = up.json?.live
      if (!l?.held) throw new Error(`live.held is ${l?.held} with ${V.bad} published (check ${recheck.status}): ${JSON.stringify(l)}`)
      if (l.state === 'downloading' || l.state === 'installed' || l.state === 'waiting') throw new Error(`the held version is being installed again: ${l.state}`)
      const said = fs.readFileSync(r.logFile, 'utf8')
      const line = said.split('\n').find((x) => x.includes('going back to')) ?? '(no line)'
      // The child dies with a code of its own: the started process ends with it and starts nothing.
      const now = treeOf(r)
      if (!now.server || now.server <= 1 || now.serverParent !== now.parent || !listenersOf(r.port).includes(now.server)) throw new Error(`no server child to stop: ${JSON.stringify(now)}`)
      const exited = new Promise((res) => r.server.once('exit', (code, signal) => res({ code, signal })))
      process.kill(now.server, 'SIGKILL')
      const end = await Promise.race([exited, sleep(30_000).then(() => null)])
      if (!end) throw new Error(`the started process ${now.parent} outlived its SIGKILLed child ${now.server} by 30s`)
      r.server = null
      if (end.code !== 137) throw new Error(`the child died by SIGKILL (137) and the started process exited ${end.code} (signal ${end.signal})`)
      for (let i = 0; i < 20 && listenersOf(r.port).length; i++) await sleep(250)
      if (listenersOf(r.port).length) throw new Error(`something listens on :${r.port} after the chain ended`)
      await r.shutdown()
      return `${states.join(' -> ')}; A back on :${r.port} ${Math.round((Date.now() - t0 + down) / 1000)}s after restarting (server ${before.server} -> ${after.server}, child of ${after.parent}); bin/walnut -> ${linked(r)}; ${path.relative(r.installRoot, badMark)}: ${fs.readFileSync(badMark, 'utf8').trim()}; after a new check live ${l.state}, held "${l.held.slice(0, 120)}"; log: ${line.trim().slice(0, 200)}; server child ${now.server} SIGKILLed: the started process exited ${end.code}, nothing restarted, port free`
    })
    return 6
  } finally {
    if (recorder) { try { video.result = await recorder.stop() } catch { /* the run failed first */ } }
    await registry.close()
  }
}

/** live-video.mjs on Node, open on `base`; ready once the page has loaded, stop() resolves its timeline. */
function startRecorder(base, video) {
  const node = process.env.WALNUT_REHEARSAL_NODE || 'node'
  const extra = video.collapsed ? ['--collapsed'] : []
  const child = spawn(node, [path.join(root, 'scripts/release-rehearsal/live-video.mjs'), '--url', base, '--out', video.dir, ...extra], { cwd: root, stdio: ['pipe', 'pipe', 'inherit'] })
  const lines = []
  let markReady
  const ready = new Promise((r) => { markReady = r })
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d.toString()
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      try { lines.push(JSON.parse(line)) } catch { continue }
      process.stdout.write(`  [video] ${line}\n`)
      if (lines.length === 1) setTimeout(markReady, 4_000)
    }
  })
  const exited = new Promise((r) => child.on('exit', (code) => r(code)))
  child.on('exit', () => markReady())
  return {
    ready,
    stop: async () => {
      child.stdin.write('stop\n')
      const code = await Promise.race([exited, sleep(120_000).then(() => 'timeout')])
      // Our own recorder, still there after its deadline: it must not hold the run open.
      if (code === 'timeout' && child.exitCode === null) child.kill('SIGTERM')
      return { code, lines }
    },
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2)
  const opts = { out: null, allowCheckout: false, reuseWeb: false }
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--out') opts.out = path.resolve(rest[++i])
    else if (rest[i] === '--allow-checkout') opts.allowCheckout = true
    else if (rest[i] === '--reuse-web') opts.reuseWeb = true
    else { process.stderr.write(`unknown argument ${rest[i]}\n`); process.exit(2) }
  }
  if (cmd !== 'build' || !opts.out) { process.stderr.write('usage: live.mjs build --out <dir> [--allow-checkout] [--reuse-web]\n'); process.exit(2) }
  build(opts).catch((err) => { process.stderr.write(`live: ${err instanceof Error ? err.stack : String(err)}\n`); process.exit(1) })
}
