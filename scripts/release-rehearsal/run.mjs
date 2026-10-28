#!/usr/bin/env bun
/**
 * Release rehearsal: install the package about to ship the way a user does and
 * make it work, on this machine, without publishing anything.
 *
 *   bun scripts/release-rehearsal/run.mjs --current <B.tgz> [--older <A.tgz>] [--work <dir>] [--keep]
 *   bun scripts/release-rehearsal/run.mjs --packs <dir>/packs.json [--runtime --runtime-packs <dir>/field.json]   (pack.mjs --rehearsal, field-packs.mjs build)
 *   bun scripts/release-rehearsal/run.mjs --runtime --runtime-packs <dir>/field.json   (the archive scenarios alone)
 *   bun scripts/release-rehearsal/run.mjs --field latest --field-packs <dir>/field.json   (field-packs.mjs wrote it)
 *   bun scripts/release-rehearsal/run.mjs --archive <open-walnut-x-<platform>-<arch>.tar.gz>
 *   BUN_BE_BUN=1 <walnut file> scripts/release-rehearsal/run.mjs --binary <walnut file>   (binary.mjs)
 *
 * Scenarios (each isolated: own npm prefix, HOME, data, daemon; mock `claude`):
 *   install    `npm install -g` the tarball with the updater's --allow-scripts list;
 *              `open-walnut --version` names it.
 *   serve      `open-walnut web` answers health, the SPA and /api/v1/status, and
 *              finds the `claude` on PATH.
 *   session    a session started over /api/v1/sessions answers its first message,
 *              then a second one sent to the live CLI. The mock runs as the real
 *              CLI does: one process across turns, a transcript under
 *              ~/.claude/projects that the history is read from.
 *   restart    after the server restarts, the history is still there and a third
 *              message is answered.
 *   update     (--older) an install of A, started, updates itself to B before it
 *              serves (the startup auto-update every npm install runs), from a
 *              local registry whose `latest` is B; an install slower than the
 *              start's 60 s budget lets A serve, and the next start serves B.
 *   field*     (--field latest --field-packs) the update every existing npm
 *              and archive install takes: the releases people run today (npm's
 *              latest and nightly, the newest Node package), installed as they
 *              were (npm, or a release's install.sh), updated by their own
 *              updater (and by hand) to this commit published as a release
 *              publishes it (the launcher and its platform packages), at a
 *              version above them, fresh and in use (field.mjs). --field-from
 *              and --field-only narrow it.
 *   archive*   (--runtime: built as release-archives.yml builds it, from
 *              `open-walnut@<release>` (the launcher and this machine's file
 *              that --runtime-packs names, served by a local registry), then
 *              updated to the one after it; --archive: a built one, alone) the
 *              self-contained archive install.sh puts in place, run with no Node
 *              on PATH (runtime.mjs).
 *
 * CI runs it on Linux and macOS for every push (ci.yml, job `rehearsal`), so the
 * release only ever publishes code whose package has done all of this.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readPackedManifest, startRegistry } from './registry.mjs'
import { rehearseBinary } from './binary.mjs'
import { FIELD_SCENARIOS, rehearseField } from './field.mjs'
import { readFieldJson } from './field-packs.mjs'
import { rehearseRuntime } from './runtime.mjs'
import { IsolatedWalnut } from './walnut.mjs'
import { compareVersions } from './version-order.mjs'
import { allowedScripts } from '../stable-promote.mjs'

function parseArgs(argv) {
  const out = { current: null, older: null, field: null, fieldPacks: null, fieldFrom: null, fieldOnly: null, work: null, keep: false, runtime: false, runtimePacks: null, archive: null, binary: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--packs') {
      const packs = JSON.parse(fs.readFileSync(argv[++i], 'utf8'))
      out.current = path.resolve(packs.current)
      out.older = packs.older ? path.resolve(packs.older) : null
    } else if (a === '--current') out.current = path.resolve(argv[++i])
    else if (a === '--older') out.older = path.resolve(argv[++i])
    else if (a === '--field') out.field = argv[++i]
    else if (a === '--field-packs') out.fieldPacks = path.resolve(argv[++i])
    else if (a === '--field-from') out.fieldFrom = argv[++i].split(',').filter(Boolean)
    else if (a === '--field-only') out.fieldOnly = argv[++i].split(',').filter(Boolean)
    else if (a === '--work') out.work = path.resolve(argv[++i])
    else if (a === '--keep') out.keep = true
    else if (a === '--runtime') out.runtime = true
    else if (a === '--runtime-packs') out.runtimePacks = path.resolve(argv[++i])
    else if (a === '--archive') out.archive = path.resolve(argv[++i])
    else if (a === '--binary') out.binary = path.resolve(argv[++i])
    else throw new Error(`unknown argument ${a}`)
  }
  if (!out.current && !out.archive && !out.binary && !out.fieldPacks && !out.runtime && !out.runtimePacks) throw new Error('usage: run.mjs --current <tarball> [--older <tarball>] [--runtime --runtime-packs <field.json>] [--work <dir>] [--keep] | --runtime --runtime-packs <field.json> | --field latest --field-packs <field.json> | --archive <archive> | --binary <walnut file>')
  // A release's archive holds the launcher and its file (release-archives.yml), never a Node package of this commit.
  if (out.runtime && !out.runtimePacks) throw new Error('--runtime builds the archive from the launcher and platform packages field-packs.mjs builds: pass --runtime-packs <field.json>')
  if (out.runtimePacks && !out.runtime) throw new Error('--runtime-packs needs --runtime')
  // The field update goes to the release as it is published now; a Node package of this commit is not that.
  if (out.field && !out.fieldPacks) throw new Error('--field latest updates to the launcher and platform packages field-packs.mjs builds: pass --field-packs <field.json>')
  if (out.fieldPacks && out.field !== 'latest') throw new Error('--field-packs needs --field latest')
  for (const k of out.fieldOnly ?? []) if (!FIELD_SCENARIOS.includes(k)) throw new Error(`--field-only takes ${FIELD_SCENARIOS.join(', ')}, not ${k}`)
  return out
}

const nonce = () => crypto.randomBytes(4).toString('hex')
/**
 * A message the mock CLI answers as the real one would: it stays alive for the
 * next turn and writes the transcript the history reads. The answer is the
 * text after the mode prefix, matched on the assistant's side of the history.
 */
const ask = (label, mark) => ({ text: `snapshot-clean-turn:answered ${label} ${mark}`, answer: `answered ${label} ${mark}` })
/** `open-walnut --version` prints `<version> (<commit> ...)`: compare the version word, not a substring. */
const reports = (printed, version) => printed.split(/\s/)[0] === version
const results = []
const walnuts = []

async function scenario(name, fn) {
  const started = Date.now()
  process.stdout.write(`\n▶ ${name}\n`)
  try {
    const detail = await fn()
    results.push({ name, ok: true, secs: (Date.now() - started) / 1000, detail: detail ?? '' })
    process.stdout.write(`✓ ${name} (${Math.round((Date.now() - started) / 1000)}s) ${detail ?? ''}\n`)
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    results.push({ name, ok: false, secs: (Date.now() - started) / 1000, detail: message })
    process.stdout.write(`✗ ${name}: ${message}\n`)
    return false
  }
}

/** The daemon's own logs in `dir`, newest last (at most two). */
function daemonLogs(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /^daemon.*\.log$/.test(f)).map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs).slice(-2)
  } catch { return [] }
}

// The rehearsal's own polling of a session's history, which would fill the tail.
const POLL_LINE = /GET \/api\/v1\/sessions\/[^ ]+\/history/

function tailOf(file, lines = 80) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter((l) => !POLL_LINE.test(l)).slice(-lines).join('\n') } catch { return '(no log)' }
}

/** The binary's version, or what running it said (mid-install it may not run). */
function safeVersion(w) {
  try { return w.version() } catch (err) { return `nothing (${err instanceof Error ? err.message.split('\n')[0] : String(err)})` }
}

async function installedWithin(w, version, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (reports(safeVersion(w), version)) return true
    await new Promise((r) => setTimeout(r, 5_000))
  }
  return false
}

/** An install of `from` (a tarball served by a local registry) must come up as `to`. */
async function rehearseUpdate(work, label, fromTgz, toTgz) {
  const from = readPackedManifest(fromTgz)
  const to = readPackedManifest(toTgz)
  if (compareVersions(to.version, from.version) <= 0) return `skipped: ${to.version} is not newer than ${from.version}`
  const registry = await startRegistry({ tarballs: [{ file: fromTgz }, { file: toTgz }], distTags: { latest: to.version } })
  try {
    const w = new IsolatedWalnut({
      work, name: label,
      extraEnv: { npm_config_registry: `${registry.url}/`, WALNUT_UPDATE_REGISTRY_URL: registry.distTagsUrl },
    })
    walnuts.push(w)
    await w.install(`open-walnut@${from.version}`, allowedScripts(from))
    if (!reports(w.version(), from.version)) throw new Error(`installed ${from.version} reports ${w.version()}`)
    const logFrom = fs.statSync(w.logFile).size
    await w.start({ timeoutMs: 600_000 })
    let status = await w.api('GET', '/api/v1/status')
    let how = 'updated before it served'
    // The start waits for the install at most STARTUP_UPDATE_BUDGET_MS (60 s); a slower
    // install (a loaded machine) lets the old version serve, goes on, and the next start
    // runs the new one. That is the promise the start prints: hold it to that.
    const said = fs.readFileSync(w.logFile).subarray(logFrom).toString()
    if (status.json?.version === from.version && said.includes(`${to.version} is still installing; starting ${from.version} now`)) {
      if (!(await installedWithin(w, to.version, 10 * 60_000))) throw new Error(`the install the start left running never finished: the binary reports ${safeVersion(w)}`)
      await w.stop()
      await w.start({ timeoutMs: 600_000 })
      status = await w.api('GET', '/api/v1/status')
      how = 'the install outlasted the start budget: the old version served, the next start served the new one'
    }
    if (status.json?.version !== to.version) throw new Error(`started ${from.version}, serving ${status.json?.version ?? status.text.slice(0, 200)}, expected ${to.version}`)
    if (!reports(w.version(), to.version)) throw new Error(`after the update the binary reports ${w.version()}`)
    if (!registry.hits.some((h) => h.endsWith('/dist-tags'))) throw new Error('the update check never asked the registry')
    await w.shutdown()
    return `${from.version} -> ${to.version} (${how})`
  } finally {
    await registry.close()
  }
}

/** Stop what is left, print the table, and fail unless `expected` scenarios ran and passed. */
async function finish(opts, work, title, expected) {
  // A scenario that failed half way left its server and daemon running.
  for (const x of walnuts) await x.shutdown().catch(() => {})
  for (const r of results.filter((r) => !r.ok)) {
    for (const x of walnuts) {
      process.stdout.write(`\n── ${x.logFile} (tail, for ${r.name}) ──\n${tailOf(x.logFile)}\n`)
      // The daemon spawns the sessions: a session that never answers is told here.
      for (const f of daemonLogs(x.daemonDir)) process.stdout.write(`\n── ${f} (tail) ──\n${tailOf(f, 60)}\n`)
    }
    break
  }
  const table = ['| Scenario | Result | Time | Detail |', '|---|---|---|---|',
    ...results.map((r) => `| ${r.name} | ${r.ok ? 'pass' : '**FAIL**'} | ${Math.round(r.secs)}s | ${String(r.detail).replace(/\|/g, '\\|').slice(0, 200)} |`)]
  process.stdout.write(`\n${table.join('\n')}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Release rehearsal: ${title} (${process.platform}-${process.arch})\n\n${table.join('\n')}\n\n`)
  }
  if (!opts.keep) fs.rmSync(work, { recursive: true, force: true })
  const failed = results.filter((r) => !r.ok).length
  if (failed || results.length < expected) process.exit(1)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  // Create before resolving: CI names a --work dir that does not exist yet.
  if (opts.work) fs.mkdirSync(opts.work, { recursive: true })
  const work = fs.realpathSync(opts.work ?? fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-rehearsal-')))
  if (opts.binary) {
    process.stdout.write(`rehearsing ${path.basename(opts.binary)} in ${work}\n`)
    const expected = await rehearseBinary({ work, binary: opts.binary, scenario, walnuts })
    return finish(opts, work, path.basename(opts.binary), expected)
  }
  if (opts.archive) {
    process.stdout.write(`rehearsing ${path.basename(opts.archive)} in ${work}\n`)
    const ran = await rehearseRuntime({ work, archive: opts.archive, scenario, walnuts })
    return finish(opts, work, path.basename(opts.archive), Math.max(ran, 2))
  }
  const launcher = opts.runtimePacks ? readFieldJson(opts.runtimePacks) : null
  const runtimeExpected = launcher ? 2 + (launcher.next ? 1 : 0) + (process.env.WALNUT_REHEARSAL_BREW ? 1 : 0) + (process.env.WALNUT_REHEARSAL_APP ? 1 : 0) : 0
  if (!opts.current && launcher) {
    process.stdout.write(`rehearsing the archive of open-walnut@${launcher.release.version} in ${work}\n`)
    await rehearseRuntime({ work, launcher, scenario, walnuts })
    return finish(opts, work, `archive of open-walnut@${launcher.release.version}`, runtimeExpected)
  }
  const fieldOpts = {
    ...(opts.fieldFrom ? { points: opts.fieldFrom } : {}),
    ...(opts.fieldOnly ? { only: opts.fieldOnly } : {}),
  }
  if (!opts.current) {
    process.stdout.write(`rehearsing the field update to ${opts.fieldPacks} in ${work}\n`)
    const expected = await rehearseField({ work, fieldJson: opts.fieldPacks, scenario, walnuts, opts: fieldOpts })
    return finish(opts, work, 'field update', expected)
  }
  const current = readPackedManifest(opts.current)
  process.stdout.write(`rehearsing open-walnut@${current.version} in ${work}\n`)

  const w = new IsolatedWalnut({ work, name: 'fresh' })
  walnuts.push(w)
  let sessionId = null
  const marks = [nonce(), nonce(), nonce()]

  const installed = await scenario('install', async () => {
    await w.install(opts.current, allowedScripts(current))
    const v = w.version()
    if (!reports(v, current.version)) throw new Error(`--version says "${v}", expected ${current.version}`)
    return v
  })
  const served = installed && await scenario('serve', async () => {
    const health = await w.start()
    if (health.claudeCliAvailable !== true) throw new Error(`health reports claudeCliAvailable=${health.claudeCliAvailable} with claude on PATH`)
    const spa = await fetch(`${w.base}/`)
    const html = await spa.text()
    if (spa.status !== 200 || !/<div id="root"|<html/i.test(html)) throw new Error(`GET / answered ${spa.status}`)
    const status = await w.api('GET', '/api/v1/status')
    if (status.json?.version !== current.version) throw new Error(`/api/v1/status says ${status.json?.version ?? status.text.slice(0, 200)}`)
    return `health ok, SPA ${html.length} bytes`
  })
  const talked = served && await scenario('session', async () => {
    const one = ask('one', marks[0])
    const res = await w.api('POST', '/api/v1/sessions', { cwd: w.project, message: one.text })
    if (res.status !== 201 || !res.json?.sessionId) throw new Error(`POST /api/v1/sessions answered ${res.status} ${res.text.slice(0, 300)}`)
    sessionId = res.json.sessionId
    await w.waitForAnswer(sessionId, one.answer)
    const two = ask('two', marks[1])
    const send = await w.api('POST', '/api/v1/messages', { to: sessionId, text: two.text })
    if (send.status !== 202) throw new Error(`POST /api/v1/messages answered ${send.status} ${send.text.slice(0, 300)}`)
    await w.waitForAnswer(sessionId, two.answer)
    return `session ${sessionId} answered two messages`
  })
  if (talked) {
    await scenario('restart', async () => {
      await w.stop()
      await w.start()
      const messages = await w.waitForAnswer(sessionId, ask('two', marks[1]).answer, 60_000)
      if (!messages.some((m) => m.role === 'assistant' && m.text?.includes(ask('one', marks[0]).answer))) {
        throw new Error('the first turn is gone from the history after a restart')
      }
      const three = ask('three', marks[2])
      const send = await w.api('POST', '/api/v1/messages', { to: sessionId, text: three.text })
      if (send.status !== 202) throw new Error(`POST /api/v1/messages answered ${send.status} ${send.text.slice(0, 300)}`)
      await w.waitForAnswer(sessionId, three.answer)
      return 'history kept, third message answered'
    })
  }
  await w.shutdown()

  if (opts.older) await scenario('update', () => rehearseUpdate(work, 'update', opts.older, opts.current))
  let fieldExpected = 0
  if (opts.fieldPacks) fieldExpected = await rehearseField({ work, fieldJson: opts.fieldPacks, scenario, walnuts, opts: fieldOpts })

  if (launcher) await rehearseRuntime({ work, launcher, scenario, walnuts })

  const expected = 4 + (opts.older ? 1 : 0) + fieldExpected + runtimeExpected
  return finish(opts, work, `open-walnut@${current.version}`, expected)
}

main().catch(async (err) => {
  process.stderr.write(`rehearsal: ${err instanceof Error ? err.stack : String(err)}\n`)
  for (const w of walnuts) await w.shutdown().catch(() => {})
  process.exit(1)
})
