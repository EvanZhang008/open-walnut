/**
 * The update every existing npm install takes: from a release people run today
 * to the build under test, published the way a release publishes it now (the
 * open-walnut launcher and its @open-walnut/<target> packages, field-packs.mjs),
 * from a local registry whose dist-tags name the build under test (registry.mjs).
 * The old release is installed exactly as a person installed it, `npm install
 * -g` from the real registry, and updated by its own updater or by hand.
 *
 * Start points (startPointsOf): npm's `latest`; its `nightly` (the nightly
 * channel follows that tag); and, when `latest` is no longer one, the newest
 * stable still in the Node form (a full package with dist/ and node_modules), so
 * the step from the Node package to the launcher stays rehearsed after the
 * first launcher release.
 *
 * For each start point:
 *   field       a fresh install, started: its startup update installs the
 *               release and starts as it.
 *   field-work  an install in use (a task, a session whose CLI stays alive,
 *               its history) restarts into the update. Its daemon outlives the
 *               restart, as a person's does (WALNUT_DAEMON_HEARTBEAT_MS holds
 *               the isolated daemon's parent check off), so the release must
 *               replace the old daemon with a session running: the task, the
 *               history and the session (a third message) are there, the old
 *               daemon and its CLI are gone, and the SQLite files the old
 *               release wrote pass an integrity check and take a write under
 *               bun:sqlite.
 *   field-back  going back: the same install in use, updated to the release
 *               (as field-work), then the start point reinstalled with
 *               `npm install -g open-walnut@<start>` (the updater's
 *               --allow-scripts list, as it was installed) while the dist-tags
 *               name the start point again, so it does not update itself
 *               forward. It passes when the old release serves the task and
 *               the session's history on the data the release wrote, or
 *               refuses to start with its own newer-data message (REFUSAL);
 *               either way every SQLite file passes an integrity check. Then
 *               forward again: the dist-tags name the release, the old
 *               install's startup update takes it, and the work and the
 *               SQLite files are still whole.
 *   field-cli   an install in use runs its own `walnut update` while its server
 *               serves; the old server keeps answering; its restart is the
 *               release, with the task, the history and the session.
 *   field-hand  the same with `npm install -g open-walnut@<release>` typed by
 *               hand (the person's npm, no --allow-scripts).
 *   field-lag   the release's file for this machine is not on the registry yet
 *               (npm makes a release visible package by package) when the old
 *               release updates: it keeps serving its own version, and its next
 *               start, once the file is there, is the release.
 *   field-index the registry serves an index of this machine's package that
 *               does not name the release yet (a CDN's copy from before it,
 *               here none at all), while its version's document and tarball
 *               are there: npm leaves the package out, the launcher's
 *               postinstall fetches it by that document, and the old release's
 *               startup update succeeds and serves the release.
 *   field-unscripted  `npm install -g` typed by hand while the release's file
 *               is not on the registry yet, with install scripts off (npm 12
 *               without --allow-scripts runs none): npm installs the launcher
 *               alone; once the file is there, the first start fetches it and
 *               serves.
 *   field-archive  (a stable start point) the self-contained archive its own
 *               GitHub Release ships, installed by that release's install.sh
 *               from a local copy of the release, in use, restarts into the
 *               update: its own Node's npm puts the launcher and this machine's
 *               file into the archive's prefix, `node bin/open-walnut.js` and
 *               `node dist/cli.js` (what the archive and a 0.6.x Mac app start)
 *               both run the file, and the task, history and session are kept.
 * With a `next` release in field.json, field, field-work and field-archive go
 * on: the release's own updater (its `walnut update`, its startup update) takes
 * the one after it, and the session answers a fourth message.
 *
 * Every Walnut is isolated (walnut.mjs), and once its scenario is over only
 * its logs stay (pruneToLogs).
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { allowedScripts } from '../stable-promote.mjs'
import { readFieldJson } from './field-packs.mjs'
import { PACKAGE, UPSTREAM, publishedVersion, startRegistry } from './registry.mjs'
import { ArchiveWalnut, publishLocally, serveReleases } from './runtime.mjs'
import { IsolatedWalnut } from './walnut.mjs'
import { compareVersions } from './version-order.mjs'

const nonce = () => crypto.randomBytes(4).toString('hex')
const ask = (label, mark) => ({ text: `snapshot-clean-turn:answered ${label} ${mark}`, answer: `answered ${label} ${mark}` })
const reports = (printed, version) => printed.split(/\s/)[0] === version
/** Long enough that an isolated daemon outlives every restart of a scenario, as a person's daemon does. */
const PERSISTENT_DAEMON_HEARTBEAT_MS = String(30 * 60_000)

/** Every field scenario, in the order they run (--field-only picks some). */
export const FIELD_SCENARIOS = ['field', 'field-work', 'field-back', 'field-cli', 'field-hand', 'field-lag', 'field-index', 'field-unscripted', 'field-archive']

/** Where a release's GitHub assets are (`<base>/v<version>/<file>`). */
export const RELEASE_DOWNLOADS = 'https://github.com/EvanZhang008/open-walnut/releases/download'

/** This machine in the platform packages' words. */
export const hostTarget = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`

/** A manifest in the Node form: no @open-walnut/<target> optional dependency (a launcher has one per platform). */
export const nodeForm = (manifest) => !Object.keys(manifest?.optionalDependencies ?? {}).some((n) => n.startsWith('@open-walnut/'))

/**
 * The versions existing installs run, from the registry's document for
 * open-walnut: `latest`, `nightly`, and the newest stable in the Node form.
 */
export function startPointsOf(doc) {
  const latest = doc?.['dist-tags']?.latest
  if (!latest || !doc.versions?.[latest]) throw new Error(`the registry's ${PACKAGE} document names no latest version`)
  const nightly = doc['dist-tags'].nightly && doc.versions[doc['dist-tags'].nightly] ? doc['dist-tags'].nightly : null
  const stable = Object.keys(doc.versions).filter((v) => !v.includes('-') && compareVersions(v, latest) <= 0).sort(compareVersions).reverse()
  const lastNode = stable.find((v) => nodeForm(doc.versions[v])) ?? null
  return { latest, nightly, lastNode, points: [...new Set([latest, nightly, lastNode].filter(Boolean))] }
}

export async function fetchStartPoints({ upstream = UPSTREAM, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${upstream}/${PACKAGE}`, { headers: { accept: 'application/vnd.npm.install-v1+json' }, signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`the registry answered HTTP ${res.status} for ${PACKAGE}`)
  return startPointsOf(await res.json())
}

/** The install's daemon dir: the running daemon's version and pid. */
function daemonOf(w) {
  const read = (f) => { try { return fs.readFileSync(path.join(w.daemonDir, f), 'utf8').trim() } catch { return null } }
  return { version: read('daemon.version'), pid: Number(read('daemon.pid')) || null }
}

const alive = (pid) => { if (!pid || pid <= 1) return false; try { process.kill(pid, 0); return true } catch { return false } }
const groupAlive = (pgid) => { if (!pgid || pgid <= 1) return false; try { process.kill(-pgid, 0); return true } catch { return false } }

/** The process groups of the CLIs the daemon spawned (its streams dir records them). */
function cliGroups(w) {
  const streams = `${w.daemonDir}-streams`
  return (fs.existsSync(streams) ? fs.readdirSync(streams) : []).filter((f) => f.endsWith('.pgid'))
    .map((f) => Number(fs.readFileSync(path.join(streams, f), 'utf8').trim())).filter((n) => n > 1).sort((a, b) => a - b)
}

/** Every SQLite file under `dir`, relative to it. */
export function sqliteFiles(dir, base = dir, out = []) {
  for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) sqliteFiles(full, base, out)
    else if (/\.(sqlite|db)$/.test(e.name)) out.push(path.relative(base, full))
  }
  return out.sort()
}

/**
 * Open each SQLite file with bun:sqlite (the compiled file running as bun),
 * run its integrity check, and write to it in a transaction that is rolled
 * back: what the release's SQLite does with a file the Node release wrote.
 */
function checkSqlite(file, dbs, env) {
  const script = `
    const { Database } = require('bun:sqlite')
    const out = {}
    for (const f of JSON.parse(process.argv[process.argv.length - 1])) {
      const db = new Database(f)
      try {
        const check = db.query('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]).join(',')
        const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().length
        db.exec('BEGIN')
        db.exec('CREATE TABLE walnut_rehearsal_probe (x)')
        db.query('INSERT INTO walnut_rehearsal_probe VALUES (?)').run(1)
        const wrote = db.query('SELECT count(*) AS n FROM walnut_rehearsal_probe').get().n
        db.exec('ROLLBACK')
        out[f] = { check, tables, wrote }
      } finally { db.close() }
    }
    console.log(JSON.stringify(out))`
  const res = execFileSync(file, ['-e', script, JSON.stringify(dbs)], { env: { ...env, BUN_BE_BUN: '1' }, encoding: 'utf8', timeout: 120_000 })
  return JSON.parse(res.trim().split('\n').pop())
}

const launcherRoot = (w) => path.join(w.prefix, 'lib/node_modules/open-walnut')
/** install.sh's layout of a self-contained archive: its own Node, and an npm prefix beside it. */
const archiveRuntime = (w) => path.join(w.home, '.local/share/open-walnut/app/runtime')
const archiveRoot = (w) => path.join(archiveRuntime(w), 'lib/node_modules/open-walnut')

/**
 * The install holds the release as a release publishes it (the launcher and
 * this machine's file), and serves it. `archive`: the launcher is in the
 * archive's prefix, and the release updates it there.
 */
async function expectServing(w, version, { archive = false } = {}) {
  const status = await w.api('GET', '/api/v1/status')
  if (status.json?.version !== version) throw new Error(`serving ${status.json?.version ?? status.text.slice(0, 200)}, expected ${version} (log: ${w.logFile})`)
  const printed = w.version()
  if (!reports(printed, version)) throw new Error(`\`walnut --version\` says ${printed}, expected ${version}`)
  const root = archive ? archiveRoot(w) : launcherRoot(w)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  if (manifest.version !== version || nodeForm(manifest)) throw new Error(`${root} holds ${manifest.version}${nodeForm(manifest) ? ' in the Node form' : ''}, not the ${version} launcher`)
  const platforms = fs.existsSync(path.join(root, 'node_modules/@open-walnut')) ? fs.readdirSync(path.join(root, 'node_modules/@open-walnut')) : []
  if (!platforms.includes(hostTarget())) throw new Error(`the launcher has ${platforms.join(', ') || 'no'} platform packages, not ${hostTarget()}`)
  const leftover = ['node_modules/better-sqlite3', 'node_modules/express', 'dist/web'].filter((p) => fs.existsSync(path.join(root, p)))
  if (leftover.length) throw new Error(`the Node package's ${leftover.join(', ')} is still in ${root}`)
  const update = await w.api('GET', '/api/system/update')
  const install = update.json?.install
  if (install?.kind !== 'npm' || install?.manager !== 'npm' || !Array.isArray(install?.relaunch)) {
    throw new Error(`the release sees its install as ${JSON.stringify(install)}, not the npm launcher's`)
  }
  if (archive && (!install.runtimePrefix || install.updateCommand !== 'walnut update')) {
    throw new Error(`the release does not see the archive it runs in: ${JSON.stringify(install)}`)
  }
  return { root, file: path.join(root, 'node_modules/@open-walnut', hostTarget(), 'walnut'), platforms }
}

/** Run `file args` with the install's env to its end; output into the Walnut's dir. */
function runTo(w, label, file, args, env = w.env) {
  return new Promise((resolve) => {
    const out = path.join(w.dir, `${label}.txt`)
    const log = fs.openSync(out, 'w')
    const child = spawn(file, args, { env, cwd: w.project, stdio: ['ignore', log, log] })
    const timer = setTimeout(() => child.kill('SIGTERM'), 15 * 60_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      fs.closeSync(log)
      resolve({ code: code ?? 1, text: fs.readFileSync(out, 'utf8'), out })
    })
  })
}

/** `walnut update` as a person types it; the server it asks about is this install's own (or none). */
async function cliUpdate(w, label) {
  const env = { ...w.env, OPEN_WALNUT_API_URL: w.server ? w.base : 'http://127.0.0.1:9' }
  const r = await runTo(w, `walnut-update-${label}`, w.bin, ['update'], env)
  if (r.code !== 0) throw new Error(`walnut update (${label}) exited ${r.code}: ${r.text.slice(-800)} (${r.out})`)
  return r.text
}

/** `npm install -g open-walnut@<version>` as a person types it: their npm, their config, no --allow-scripts. */
async function handInstall(w, version) {
  const r = await runTo(w, `npm-install-${version}`, w.npm, ['install', '-g', `${PACKAGE}@${version}`])
  if (r.code !== 0) throw new Error(`npm install -g ${PACKAGE}@${version} exited ${r.code}: ${r.text.slice(-800)} (${r.out})`)
  return r.text
}

/** As a person did: the real registry, the updater's own --allow-scripts list. */
async function installStart(w, from, upstream) {
  const local = w.env.npm_config_registry
  w.env.npm_config_registry = `${upstream}/`
  try {
    await w.install(`${PACKAGE}@${from.version}`, allowedScripts(from.doc))
  } finally {
    w.env.npm_config_registry = local
  }
  const printed = w.version()
  if (!reports(printed, from.version)) throw new Error(`installed ${from.version} says ${printed}`)
}

const tags = (version) => ({ latest: version, nightly: version })
const logOf = (w) => (fs.existsSync(w.logFile) ? fs.readFileSync(w.logFile, 'utf8') : '')

/** The old release's startup update said it installed `version` and started it. */
function expectStartupUpdate(w, from, version) {
  const log = logOf(w)
  for (const line of [`Open Walnut ${version} is published (this is ${from}); installing it before starting.`, `Installed Open Walnut ${version}; starting it.`]) {
    if (!log.includes(line)) throw new Error(`the server log never says "${line}" (log: ${w.logFile})`)
  }
}

async function withRegistry(field, from, opts, fn) {
  const tarballs = [...field.release.tarballs, ...(field.next?.tarballs ?? [])].map((file) => ({ file }))
  const registry = await startRegistry({ tarballs, distTags: tags(from.version), upstream: opts.upstream, published: { [from.version]: from.doc } })
  try {
    return await fn(registry)
  } finally {
    await registry.close()
  }
}

function walnutFor(work, name, registry, walnuts, extra = {}) {
  const w = new IsolatedWalnut({ work, name, extraEnv: { npm_config_registry: `${registry.url}/`, WALNUT_UPDATE_REGISTRY_URL: registry.distTagsUrl, ...extra } })
  walnuts.push(w)
  return w
}

async function fresh({ from, field, work, walnuts, opts }) {
  return withRegistry(field, from, opts, async (registry) => {
    registry.setDistTags(tags(field.release.version))
    const w = walnutFor(work, `field-${from.version}`, registry, walnuts)
    await installStart(w, from, opts.upstream)
    await w.start({ timeoutMs: 900_000 })
    expectStartupUpdate(w, from.version, field.release.version)
    const { platforms } = await expectServing(w, field.release.version)
    let after = ''
    if (field.next) {
      // Keep working afterwards: the release's own `walnut update` takes the one after it.
      await w.stop()
      registry.setDistTags(tags(field.next.version))
      const out = await cliUpdate(w, 'release')
      if (!out.includes(`Installed Open Walnut ${field.next.version}.`)) throw new Error(`the release's walnut update says: ${out.slice(-500)}`)
      await w.start({ timeoutMs: 600_000 })
      await expectServing(w, field.next.version)
      after = ` -> ${field.next.version} (its walnut update)`
    }
    await w.shutdown()
    return `${from.version} -> ${field.release.version} (startup update; launcher + ${platforms.join(', ')})${after}`
  })
}

/**
 * The old release in use: a task and a session whose CLI answered two messages.
 * Returns what the checks after the update need.
 */
async function putToWork(w, from) {
  await w.start({ timeoutMs: 600_000 })
  const before = await w.api('GET', '/api/v1/status')
  if (before.json?.version !== from.version) throw new Error(`${from.version}, with its dist-tag naming itself, serves ${before.json?.version ?? before.text.slice(0, 200)}`)
  const title = `rehearsal task ${nonce()}`
  const made = await w.api('POST', '/api/v1/tasks', { title })
  const taskId = made.json?.task?.id
  if (made.status !== 201 || !taskId) throw new Error(`POST /api/v1/tasks answered ${made.status} ${made.text.slice(0, 300)}`)
  const marks = [nonce(), nonce(), nonce(), nonce()]
  const one = ask('one', marks[0])
  const res = await w.api('POST', '/api/v1/sessions', { cwd: w.project, message: one.text })
  const sessionId = res.json?.sessionId
  if (res.status !== 201 || !sessionId) throw new Error(`POST /api/v1/sessions answered ${res.status} ${res.text.slice(0, 300)}`)
  await w.waitForAnswer(sessionId, one.answer)
  const two = ask('two', marks[1])
  const send = await w.api('POST', '/api/v1/messages', { to: sessionId, text: two.text })
  if (send.status !== 202) throw new Error(`POST /api/v1/messages answered ${send.status} ${send.text.slice(0, 300)}`)
  await w.waitForAnswer(sessionId, two.answer)
  return { tasks: [[taskId, title]], sessionId, marks, daemon: daemonOf(w), clis: cliGroups(w), dbs: sqliteFiles(w.walnutHome) }
}

/** After the update: every task, the whole history, and the session answers message `n`. */
async function expectWorkKept(w, work, version, n) {
  const listed = await w.api('GET', '/api/v1/tasks')
  for (const [id, title] of work.tasks) {
    const found = (listed.json?.tasks ?? []).find((t) => t.id === id)
    if (!found || found.title !== title) throw new Error(`task "${title}" is not in ${version}'s list (${listed.status} ${listed.text.slice(0, 200)})`)
  }
  const labels = ['one', 'two', 'three', 'four']
  const history = await w.waitForAnswer(work.sessionId, ask(labels[n - 2], work.marks[n - 2]).answer, 120_000)
  for (let i = 0; i < n - 1; i++) {
    const answer = ask(labels[i], work.marks[i]).answer
    if (!history.some((m) => m.role === 'assistant' && m.text?.includes(answer))) throw new Error(`"${answer}" is gone from the history under ${version}`)
  }
  const next = ask(labels[n - 1], work.marks[n - 1])
  const sent = await w.api('POST', '/api/v1/messages', { to: work.sessionId, text: next.text })
  if (sent.status !== 202) throw new Error(`POST /api/v1/messages under ${version} answered ${sent.status} ${sent.text.slice(0, 300)}`)
  await w.waitForAnswer(work.sessionId, next.answer)
}

/** The daemon version a release's file runs (`<file> __daemon --version`), or null. */
function fileDaemonVersion(file, env) {
  const r = spawnSync(file, ['__daemon', '--version'], { env, encoding: 'utf8', timeout: 60_000 })
  const v = (r.stdout ?? '').trim().split('\n').pop()
  return r.status === 0 && v ? v : null
}

/**
 * The daemon after the update, judged from what the rehearsal read: `before` (the start
 * point's daemon and CLI process groups), `now` (the same after the update), `expected`
 * (the daemon version the release's file runs, null when unknown). A release whose daemon
 * code changed replaces the old daemon, and none of its CLIs is left beside the new one's.
 * A release that runs the very daemon the start point runs keeps it, CLIs included: the
 * server reuses a daemon of the version it expects (local-daemon.ts), so a restart would
 * only cost every session its process. 2026-10-28: the first compiled nightly updating to
 * the next commit kept its daemon, and the check, written while every start point was the
 * Node package and so had another daemon, read that as a failure.
 */
export function judgeDaemon({ before, now, expected, alive: isAlive = alive, groupAlive: isGroupAlive = groupAlive }) {
  if (expected && expected === before.version) {
    if (now.pid !== before.pid || !isAlive(before.pid)) throw new Error(`the release runs the same daemon (${expected}), yet pid ${before.pid} became ${now.pid ?? 'none'}: a daemon of the version the server expects is kept`)
    if (now.version !== expected) throw new Error(`the kept daemon (pid ${now.pid}) reports ${now.version}, the release runs ${expected}`)
    const gone = before.clis.filter((g) => !now.clis.includes(g))
    if (gone.length) throw new Error(`the kept daemon lost the CLI process groups ${gone.join(', ')}`)
    return `daemon ${expected} (pid ${now.pid}) kept with its CLI: the release runs the same daemon`
  }
  if (!now.pid || now.pid === before.pid) throw new Error(`the daemon is still pid ${before.pid} (${before.version}) after the update`)
  if (isAlive(before.pid)) throw new Error(`the old daemon (pid ${before.pid}, ${before.version}) still runs beside ${now.version} (pid ${now.pid})`)
  if (now.version === before.version) throw new Error(`the new daemon reports the old version ${before.version}`)
  if (expected && now.version !== expected) throw new Error(`the new daemon reports ${now.version}, the release runs ${expected}`)
  const same = now.clis.join(',') === before.clis.join(',')
  const stray = same ? [] : before.clis.filter((g) => !now.clis.includes(g) && isGroupAlive(g))
  if (stray.length) throw new Error(`the old daemon's CLI process groups ${stray.join(', ')} still run beside the new one's`)
  return `daemon ${before.version} (pid ${before.pid}) -> ${now.version} (pid ${now.pid}), ${same ? 'the same CLI process' : 'a new CLI process'}`
}

/** The daemon after the update of `work`'s install to the release whose file is `file`. */
function expectDaemonUpdated(w, work, file) {
  return judgeDaemon({
    before: { ...work.daemon, clis: work.clis },
    now: { ...daemonOf(w), clis: cliGroups(w) },
    expected: fileDaemonVersion(file, w.env),
  })
}

/**
 * The start point in use (a task, a session, its history) restarts into the
 * update with its daemon still running, and the release writes a task of its
 * own. Shared by field-work and field-back; leaves the release's server running.
 */
async function updateInUse(w, from, field, registry, upstream) {
  await installStart(w, from, upstream)
  const done = await putToWork(w, from)
  // A person's restart: the server goes; the daemon and its CLI stay.
  await w.stop()
  if (!alive(done.daemon.pid)) throw new Error(`${from.version}'s daemon (pid ${done.daemon.pid}) ended with its server: the rehearsal does not keep it as a person's is kept`)
  registry.setDistTags(tags(field.release.version))
  await w.start({ timeoutMs: 900_000 })
  expectStartupUpdate(w, from.version, field.release.version)
  const { file } = await expectServing(w, field.release.version)
  await expectWorkKept(w, done, field.release.version, 3)
  const daemon = expectDaemonUpdated(w, done, file)
  const title = `rehearsal task ${nonce()} (written by ${field.release.version})`
  const made = await w.api('POST', '/api/v1/tasks', { title })
  if (made.status !== 201 || !made.json?.task?.id) throw new Error(`POST /api/v1/tasks under ${field.release.version} answered ${made.status} ${made.text.slice(0, 300)}`)
  done.tasks.push([made.json.task.id, title])
  return { done, file, daemon }
}

async function inUse({ from, field, work, walnuts, opts }) {
  return withRegistry(field, from, opts, async (registry) => {
    const w = walnutFor(work, `field-work-${from.version}`, registry, walnuts, { WALNUT_DAEMON_HEARTBEAT_MS: PERSISTENT_DAEMON_HEARTBEAT_MS })
    const { done, file, daemon } = await updateInUse(w, from, field, registry, opts.upstream)
    await w.stop()
    const sqlite = checkSqlite(file, done.dbs.map((d) => path.join(w.walnutHome, d)), w.env)
    const bad = Object.entries(sqlite).filter(([, r]) => r.check !== 'ok' || r.wrote !== 1)
    if (bad.length) throw new Error(`bun:sqlite on ${from.version}'s files: ${JSON.stringify(bad)}`)
    let after = ''
    if (field.next) {
      // Keep working afterwards: the release's own startup update takes the one after it.
      registry.setDistTags(tags(field.next.version))
      await w.start({ timeoutMs: 900_000 })
      expectStartupUpdate(w, field.release.version, field.next.version)
      await expectServing(w, field.next.version)
      await expectWorkKept(w, done, field.next.version, 4)
      after = ` -> ${field.next.version} (its startup update; both tasks, the history, a fourth message)`
    } else {
      await w.start({ timeoutMs: 600_000 })
      await expectServing(w, field.release.version)
    }
    await w.shutdown()
    return `${from.version} -> ${field.release.version}: task, history, session kept (third message); ${daemon}; ${done.dbs.length} SQLite files of ${from.version} check ok and take a write under bun:sqlite (${done.dbs.join(', ') || 'none'})${after}`
  })
}

/**
 * The one newer-data guard in the start points' published code (0.6.18 and its
 * nightly, dist/web/server.js): the task database refuses a schema above its own.
 * Matched exactly; any other exit before serving is a failure, not a refusal.
 */
export const REFUSAL = /Task database schema \d+ is newer than supported schema \d+; use a newer Walnut build\./

/**
 * Going back: the release has run on the install's data; the start point is
 * reinstalled and started on it. It must serve the work (the task the start
 * point made and the session's history), or refuse to start with its own
 * newer-data message (REFUSAL); and never corrupt the data (an integrity check
 * on every SQLite file, with the bun running this rehearsal, as the release's
 * file is gone with the reinstall). Then forward again, as a person who rolled
 * back later upgrades: the dist-tags name the release, the old install's own
 * startup update takes it, and the work and the SQLite files are still whole.
 */
async function goneBack({ from, field, work, walnuts, opts }) {
  return withRegistry(field, from, opts, async (registry) => {
    const w = walnutFor(work, `field-back-${from.version}`, registry, walnuts, { WALNUT_DAEMON_HEARTBEAT_MS: PERSISTENT_DAEMON_HEARTBEAT_MS })
    const { done } = await updateInUse(w, from, field, registry, opts.upstream)
    await w.stop()
    // The way back: the dist-tags name the start point again (the release is
    // pulled), so its startup update does not take the release forward again.
    registry.setDistTags(tags(from.version))
    await installStart(w, from, opts.upstream)
    let outcome
    try {
      await w.start({ timeoutMs: 600_000 })
      const status = await w.api('GET', '/api/v1/status')
      if (status.json?.version !== from.version) throw new Error(`gone back to ${from.version}, serving ${status.json?.version ?? status.text.slice(0, 200)} (log: ${w.logFile})`)
      const listed = await w.api('GET', '/api/v1/tasks')
      const [taskId, title] = done.tasks[0]
      if (!(listed.json?.tasks ?? []).some((t) => t.id === taskId && t.title === title)) throw new Error(`task "${title}" is not in ${from.version}'s list after going back (${listed.status} ${listed.text.slice(0, 200)})`)
      const releaseTask = (listed.json?.tasks ?? []).some((t) => t.id === done.tasks[1][0])
      const history = await w.waitForAnswer(done.sessionId, ask('three', done.marks[2]).answer, 120_000)
      for (const [label, mark] of [['one', done.marks[0]], ['two', done.marks[1]]]) {
        if (!history.some((m) => m.role === 'assistant' && m.text?.includes(ask(label, mark).answer))) throw new Error(`"${ask(label, mark).answer}" is gone from the history after going back to ${from.version}`)
      }
      outcome = `${from.version} serves the task and the history (three answers) on the release's data; the release's own task ${releaseTask ? 'is listed too' : 'is not listed'}`
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const tail = logOf(w).split('\n').slice(-60).join('\n')
      // Only the start point's own newer-data guard, as it exits before serving, is a refusal.
      if (!/exited \d+ before serving/.test(message) || !REFUSAL.test(tail)) throw new Error(`${message}\n${tail.slice(-3000)}`)
      outcome = `${from.version} refuses to start on the release's data: ${tail.match(REFUSAL)[0]}`
    }
    await w.stop()
    const back = checkSqlite(process.execPath, sqliteFiles(w.walnutHome).map((d) => path.join(w.walnutHome, d)), w.env)
    const badBack = Object.entries(back).filter(([, r]) => r.check !== 'ok')
    if (badBack.length) throw new Error(`after going back to ${from.version}, SQLite files fail the integrity check: ${JSON.stringify(badBack)}`)
    // Forward again: the old install's own startup update takes the release once more.
    registry.setDistTags(tags(field.release.version))
    const mark = logOf(w).length
    await w.start({ timeoutMs: 900_000 })
    const since = logOf(w).slice(mark)
    for (const line of [`Open Walnut ${field.release.version} is published (this is ${from.version}); installing it before starting.`, `Installed Open Walnut ${field.release.version}; starting it.`]) {
      if (!since.includes(line)) throw new Error(`going forward again, the server log never says "${line}" (log: ${w.logFile})`)
    }
    const { file } = await expectServing(w, field.release.version)
    const listedAgain = await w.api('GET', '/api/v1/tasks')
    for (const [id, title] of done.tasks) {
      if (!(listedAgain.json?.tasks ?? []).some((t) => t.id === id && t.title === title)) throw new Error(`task "${title}" is not in ${field.release.version}'s list after going back and forward (${listedAgain.status} ${listedAgain.text.slice(0, 200)})`)
    }
    const historyAgain = await w.waitForAnswer(done.sessionId, ask('three', done.marks[2]).answer, 120_000)
    for (const [label, mark2] of [['one', done.marks[0]], ['two', done.marks[1]]]) {
      if (!historyAgain.some((m) => m.role === 'assistant' && m.text?.includes(ask(label, mark2).answer))) throw new Error(`"${ask(label, mark2).answer}" is gone from the history after going back and forward`)
    }
    await w.stop()
    const again = checkSqlite(file, sqliteFiles(w.walnutHome).map((d) => path.join(w.walnutHome, d)), w.env)
    const badAgain = Object.entries(again).filter(([, r]) => r.check !== 'ok' || r.wrote !== 1)
    if (badAgain.length) throw new Error(`after going forward again, bun:sqlite on the SQLite files: ${JSON.stringify(badAgain)}`)
    await w.shutdown()
    return `${from.version} -> ${field.release.version} -> ${from.version} -> ${field.release.version}: ${outcome}; ${Object.keys(back).length} SQLite files check ok after going back; forward again by its startup update, both tasks and the history kept, ${Object.keys(again).length} SQLite files check ok and take a write`
  })
}

/** An install in use, updated while its server serves (by `how`), then restarted. */
async function updatedWhileServing({ from, field, work, walnuts, opts, how }) {
  return withRegistry(field, from, opts, async (registry) => {
    const w = walnutFor(work, `field-${how}-${from.version}`, registry, walnuts)
    await installStart(w, from, opts.upstream)
    const done = await putToWork(w, from)
    registry.setDistTags(tags(field.release.version))
    if (how === 'cli') {
      const out = await cliUpdate(w, 'old')
      if (!out.includes(`${from.version} → ${field.release.version}`)) throw new Error(`${from.version}'s walnut update says: ${out.slice(-500)}`)
    } else {
      await handInstall(w, field.release.version)
    }
    if (!reports(w.version(), field.release.version)) throw new Error(`after the install, walnut --version says ${w.version()}`)
    // The old server, its package replaced under it, still answers until it restarts.
    const still = await w.api('GET', '/api/v1/status')
    if (still.json?.version !== from.version) throw new Error(`the running ${from.version} server answers ${still.status} ${still.text.slice(0, 200)} once its package is replaced`)
    const listed = await w.api('GET', '/api/v1/tasks')
    if (listed.status !== 200) throw new Error(`the running ${from.version} server lists tasks with ${listed.status} once its package is replaced`)
    await w.stop()
    await w.start({ timeoutMs: 600_000 })
    if (logOf(w).includes(`installing it before starting`)) throw new Error('the restart installed again')
    await expectServing(w, field.release.version)
    await expectWorkKept(w, done, field.release.version, 3)
    await w.shutdown()
    const by = how === 'cli' ? `${from.version}'s walnut update` : `npm install -g ${PACKAGE}@${field.release.version} by hand`
    return `${from.version} -> ${field.release.version} by ${by} while it served (it kept answering), then a restart: task, history, session kept`
  })
}

/** The release's platform package for this machine: the one its launcher needs here. */
const hostPackage = () => `@open-walnut/${hostTarget()}`

async function lagging({ from, field, work, walnuts, opts }) {
  return withRegistry(field, from, opts, async (registry) => {
    const w = walnutFor(work, `field-lag-${from.version}`, registry, walnuts)
    await installStart(w, from, opts.upstream)
    // The launcher is out; this machine's file is still on its way.
    registry.setDistTags(tags(field.release.version))
    registry.setWithheld([hostPackage()])
    await w.start({ timeoutMs: 900_000 })
    const served = await w.api('GET', '/api/v1/status')
    if (served.json?.version !== from.version) throw new Error(`with ${hostPackage()}@${field.release.version} not on the registry, the start serves ${served.json?.version ?? served.text.slice(0, 200)}, not ${from.version}`)
    const kept = JSON.parse(fs.readFileSync(path.join(launcherRoot(w), 'package.json'), 'utf8')).version
    if (kept !== from.version || !reports(w.version(), from.version)) throw new Error(`the failed update left ${kept} installed (walnut --version: ${w.version()})`)
    if (!logOf(w).includes(`starting ${from.version} as it is`)) throw new Error(`the server log never says it starts ${from.version} as it is (log: ${w.logFile})`)
    await w.stop()
    // Visible now: the next start takes it.
    registry.setWithheld([])
    await w.start({ timeoutMs: 900_000 })
    expectStartupUpdate(w, from.version, field.release.version)
    await expectServing(w, field.release.version)
    await w.shutdown()
    return `${hostPackage()} not served yet: ${from.version}'s update failed and rolled back, ${from.version} served; served later: ${from.version} -> ${field.release.version}`
  })
}

async function indexBehind({ from, field, work, walnuts, opts }) {
  return withRegistry(field, from, opts, async (registry) => {
    const w = walnutFor(work, `field-index-${from.version}`, registry, walnuts)
    await installStart(w, from, opts.upstream)
    registry.setDistTags(tags(field.release.version))
    registry.setIndexWithheld([hostPackage()])
    await w.start({ timeoutMs: 900_000 })
    expectStartupUpdate(w, from.version, field.release.version)
    await expectServing(w, field.release.version)
    const file = path.join(launcherRoot(w), 'node_modules', hostPackage(), 'walnut')
    if (!fs.existsSync(file)) throw new Error(`${file} is not there after the update`)
    // npm found no index for it (so left it out), and the postinstall read its version's document.
    if (!registry.hits.includes(`withheld-index /${hostPackage()}`)) throw new Error(`npm never asked for ${hostPackage()}'s index`)
    if (!registry.hits.includes(`/${hostPackage()}/${field.release.version}`)) throw new Error(`nothing read ${hostPackage()}@${field.release.version}'s own document: npm installed it some other way`)
    await w.shutdown()
    return `${hostPackage()}'s index did not name ${field.release.version}: npm left it out, the postinstall fetched it by its version's document, and ${from.version}'s startup update served ${field.release.version}`
  })
}

async function unscripted({ from, field, work, walnuts, opts }) {
  return withRegistry(field, from, opts, async (registry) => {
    const w = walnutFor(work, `field-unscripted-${from.version}`, registry, walnuts)
    await installStart(w, from, opts.upstream)
    registry.setDistTags(tags(field.release.version))
    registry.setWithheld([hostPackage()])
    const r = await runTo(w, 'npm-install-unscripted', w.npm, ['install', '-g', `${PACKAGE}@${field.release.version}`, '--ignore-scripts'])
    if (r.code !== 0) throw new Error(`npm install --ignore-scripts exited ${r.code}: ${r.text.slice(-800)}`)
    if (fs.existsSync(path.join(launcherRoot(w), 'node_modules', hostPackage()))) throw new Error(`npm installed ${hostPackage()} while the registry did not serve it`)
    registry.setWithheld([])
    await w.start({ timeoutMs: 900_000 })
    await expectServing(w, field.release.version)
    if (!logOf(w).includes(`fetching ${hostPackage()}@${field.release.version}`)) throw new Error(`the launcher never says it fetched ${hostPackage()} (log: ${w.logFile})`)
    await w.shutdown()
    return `npm install --ignore-scripts while ${hostPackage()} was not served installed the launcher alone; once served, the first start fetched it and served ${field.release.version}`
  })
}

/** GET with three tries: one dropped connection to GitHub must not fail a rehearsal. */
async function download(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600_000) })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`GET ${url} answered HTTP ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (err) {
      if (attempt >= 3) throw err
      await new Promise((r) => setTimeout(r, attempt * 5000))
    }
  }
}

/**
 * The start point's own install.sh and this machine's archive from its GitHub
 * Release, checked against the release's SHA256SUMS, into `dir`; null when the
 * release ships no archive for this machine.
 */
export async function releaseArchive(version, dir, { base = RELEASE_DOWNLOADS, get = download } = {}) {
  const name = `open-walnut-${version}-${process.platform}-${process.arch}.tar.gz`
  const sums = await get(`${base}/v${version}/SHA256SUMS`)
  const line = sums && sums.toString('utf8').split('\n').find((l) => l.trim().endsWith(`  ${name}`))
  if (!line) return null
  const bytes = await get(`${base}/v${version}/${name}`)
  const script = await get(`${base}/v${version}/install.sh`)
  if (!bytes || !script) throw new Error(`v${version} lists ${name} but does not serve it and its install.sh`)
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== line.trim().split(/\s+/)[0]) throw new Error(`${name} does not match v${version}'s SHA256SUMS`)
  fs.mkdirSync(dir, { recursive: true })
  const archive = path.join(dir, name)
  fs.writeFileSync(archive, bytes)
  const installSh = path.join(dir, 'install.sh')
  fs.writeFileSync(installSh, script)
  return { archive, installSh }
}

async function archived({ from, field, work, walnuts, opts }) {
  const dl = path.join(work, `release-${from.version}`)
  const got = await releaseArchive(from.version, dl, { base: opts.releases })
  if (!got) return `v${from.version} ships no archive for ${hostTarget()}: nothing to update`
  return withRegistry(field, from, opts, async (registry) => {
    const releases = path.join(dl, 'releases')
    publishLocally(releases, from.version, got.archive)
    const server = await serveReleases(releases)
    try {
      const w = new ArchiveWalnut({
        work, name: `field-archive-${from.version}`,
        extraEnv: { npm_config_registry: `${registry.url}/`, WALNUT_UPDATE_REGISTRY_URL: registry.distTagsUrl, WALNUT_DAEMON_HEARTBEAT_MS: PERSISTENT_DAEMON_HEARTBEAT_MS },
      })
      walnuts.push(w)
      // As a person did: that release's own install.sh, against (a copy of) its release.
      await w.installFrom(got.installSh, server.url)
      fs.rmSync(dl, { recursive: true, force: true })
      if (!reports(w.version(), from.version)) throw new Error(`install.sh of v${from.version} installed ${w.version()}`)
      const done = await putToWork(w, from)
      await w.stop()
      registry.setDistTags(tags(field.release.version))
      await w.start({ timeoutMs: 900_000 })
      expectStartupUpdate(w, from.version, field.release.version)
      const { root, file } = await expectServing(w, field.release.version, { archive: true })
      // What starts it: the archive's own entry, and a 0.6.x Mac app's `node <package>/dist/cli.js`.
      const node = path.join(archiveRuntime(w), 'bin/node')
      for (const entry of ['bin/open-walnut.js', 'dist/cli.js']) {
        const r = spawnSync(node, [path.join(root, entry), '--version'], { env: w.env, encoding: 'utf8', timeout: 120_000 })
        if (!reports((r.stdout ?? '').trim(), field.release.version)) throw new Error(`the archive's node ${entry} --version says ${(r.stdout ?? '').trim()} ${(r.stderr ?? '').trim().slice(0, 300)}`)
      }
      await expectWorkKept(w, done, field.release.version, 3)
      const daemon = expectDaemonUpdated(w, done, file)
      let after = ''
      if (field.next) {
        // Keep working afterwards: the release's `walnut update`, through the archive's own npm.
        await w.stop()
        registry.setDistTags(tags(field.next.version))
        const out = await cliUpdate(w, 'release')
        if (!out.includes(`Installed Open Walnut ${field.next.version}.`)) throw new Error(`the release's walnut update in the archive says: ${out.slice(-500)}`)
        await w.start({ timeoutMs: 600_000 })
        await expectServing(w, field.next.version, { archive: true })
        await expectWorkKept(w, done, field.next.version, 4)
        after = ` -> ${field.next.version} (its walnut update; a fourth message)`
      }
      await w.shutdown()
      return `v${from.version}'s archive by its install.sh -> ${field.release.version} through its own npm into its prefix; bin/open-walnut.js and dist/cli.js run the file; task, history, session kept; ${daemon}${after}`
    } finally {
      await server.close()
      fs.rmSync(dl, { recursive: true, force: true })
    }
  })
}

/**
 * What a run keeps of an install once its scenario is over: its logs (the
 * Walnut's own, the commands' output, the daemon's), never the install, so a
 * run holds one install at a time on a runner's or a laptop's disk.
 */
export function pruneToLogs(dir) {
  for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const full = path.join(dir, e.name)
    if (e.isFile() && /\.(txt|log)$/.test(e.name)) continue
    if (e.isDirectory() && e.name === 'daemon') pruneToLogs(full)
    else fs.rmSync(full, { recursive: true, force: true })
  }
}

/**
 * Run the field scenarios. `fieldJson` is field-packs.mjs's field.json; `opts`:
 * `upstream` (the real registry), `releases` (where GitHub Releases' assets
 * are), `points` (start versions instead of the registry's), `only` (scenario
 * names). Returns how many were expected.
 */
export async function rehearseField({ work, fieldJson, scenario, walnuts, opts = {} }) {
  const o = { upstream: UPSTREAM, releases: RELEASE_DOWNLOADS, only: null, ...opts }
  const field = readFieldJson(fieldJson)
  let points = null
  await scenario('field-start', async () => {
    const found = await fetchStartPoints({ upstream: o.upstream })
    points = o.points ?? found.points
    for (const p of points) if (compareVersions(field.release.version, p) <= 0) throw new Error(`the release ${field.release.version} is not newer than ${p}: field-packs.mjs builds one that is`)
    return `from ${points.join(', ')} (npm latest ${found.latest}, nightly ${found.nightly}, newest Node form ${found.lastNode}) to ${field.release.version}${field.next ? `, then ${field.next.version}` : ''}`
  })
  if (!points) return 1
  const kinds = {
    field: fresh,
    'field-work': inUse,
    'field-back': goneBack,
    'field-cli': (a) => updatedWhileServing({ ...a, how: 'cli' }),
    'field-hand': (a) => updatedWhileServing({ ...a, how: 'hand' }),
    'field-lag': lagging,
    'field-index': indexBehind,
    'field-unscripted': unscripted,
    'field-archive': archived,
  }
  const names = FIELD_SCENARIOS.filter((k) => !o.only || o.only.includes(k))
  // A prerelease has no GitHub Release, so no archive.
  const namesFor = (version) => names.filter((k) => k !== 'field-archive' || !version.includes('-'))
  let expected = 1
  for (const version of points) {
    const from = { version, doc: await publishedVersion(version, { upstream: o.upstream }) }
    const suffix = points.length > 1 ? ` (${version})` : ''
    expected += namesFor(version).length
    for (const name of namesFor(version)) {
      const mine = walnuts.length
      await scenario(`${name}${suffix}`, () => kinds[name]({ from, field, work, walnuts, opts: o }))
      // Passed or not: its server and daemon go, and its logs are all that stays.
      for (const w of walnuts.slice(mine)) {
        await w.shutdown().catch(() => {})
        pruneToLogs(w.dir)
      }
    }
  }
  return expected
}
