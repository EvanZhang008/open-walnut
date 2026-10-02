#!/usr/bin/env node
/**
 * Release rehearsal: install the package about to ship the way a user does and
 * make it work, on this machine, without publishing anything.
 *
 *   node scripts/release-rehearsal/run.mjs --current <B.tgz> [--older <A.tgz>] [--field latest] [--work <dir>] [--keep]
 *   node scripts/release-rehearsal/run.mjs --packs <dir>/packs.json --field latest   (pack.mjs --rehearsal wrote it)
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
 *              local registry whose `latest` is B.
 *   field      (--field latest) the same, starting from the version on npm today:
 *              the update every existing install will take.
 *
 * CI runs it on Linux and macOS for every push (ci.yml, job `rehearsal`), so the
 * release only ever publishes code whose package has done all of this.
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readPackedManifest, startRegistry } from './registry.mjs'
import { IsolatedWalnut } from './walnut.mjs'
import { compareVersions } from './version-order.mjs'
import { allowedScripts } from '../stable-promote.mjs'

function parseArgs(argv) {
  const out = { current: null, older: null, field: null, work: null, keep: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--packs') {
      const packs = JSON.parse(fs.readFileSync(argv[++i], 'utf8'))
      out.current = path.resolve(packs.current)
      out.older = packs.older ? path.resolve(packs.older) : null
    } else if (a === '--current') out.current = path.resolve(argv[++i])
    else if (a === '--older') out.older = path.resolve(argv[++i])
    else if (a === '--field') out.field = argv[++i]
    else if (a === '--work') out.work = path.resolve(argv[++i])
    else if (a === '--keep') out.keep = true
    else throw new Error(`unknown argument ${a}`)
  }
  if (!out.current) throw new Error('usage: run.mjs --current <tarball> [--older <tarball>] [--field latest] [--work <dir>] [--keep]')
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

function tailOf(file, lines = 80) {
  try { return fs.readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n') } catch { return '(no log)' }
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
    await w.start({ timeoutMs: 600_000 })
    const status = await w.api('GET', '/api/v1/status')
    if (status.json?.version !== to.version) throw new Error(`started ${from.version}, serving ${status.json?.version ?? status.text.slice(0, 200)}, expected ${to.version}`)
    if (!reports(w.version(), to.version)) throw new Error(`after the update the binary reports ${w.version()}`)
    if (!registry.hits.some((h) => h.endsWith('/dist-tags'))) throw new Error('the update check never asked the registry')
    await w.shutdown()
    return `${from.version} -> ${to.version}`
  } finally {
    await registry.close()
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  // Create before resolving: CI names a --work dir that does not exist yet.
  if (opts.work) fs.mkdirSync(opts.work, { recursive: true })
  const work = fs.realpathSync(opts.work ?? fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-rehearsal-')))
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
  if (opts.field === 'latest') {
    await scenario('field', async () => {
      const dir = path.join(work, 'field-pack')
      fs.mkdirSync(dir, { recursive: true })
      // The real registry, whatever the caller's npm config says.
      const out = execFileSync('npm', ['pack', 'open-walnut@latest', '--json', '--pack-destination', dir, '--registry', 'https://registry.npmjs.org/'], { encoding: 'utf8', timeout: 300_000 })
      const packed = JSON.parse(out)
      const entry = Array.isArray(packed) ? packed[0] : Object.values(packed)[0]
      return rehearseUpdate(work, 'field', path.join(dir, entry.filename), opts.current)
    })
  }

  // A scenario that failed half way left its server and daemon running.
  for (const x of walnuts) await x.shutdown().catch(() => {})
  for (const r of results.filter((r) => !r.ok)) {
    for (const x of walnuts) process.stdout.write(`\n── ${x.logFile} (tail, for ${r.name}) ──\n${tailOf(x.logFile)}\n`)
    break
  }
  const table = ['| Scenario | Result | Time | Detail |', '|---|---|---|---|',
    ...results.map((r) => `| ${r.name} | ${r.ok ? 'pass' : '**FAIL**'} | ${Math.round(r.secs)}s | ${String(r.detail).replace(/\|/g, '\\|').slice(0, 200)} |`)]
  process.stdout.write(`\n${table.join('\n')}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Release rehearsal: open-walnut@${current.version} (${process.platform})\n\n${table.join('\n')}\n\n`)
  }
  if (!opts.keep) fs.rmSync(work, { recursive: true, force: true })
  const failed = results.filter((r) => !r.ok).length
  const expected = 4 + (opts.older ? 1 : 0) + (opts.field === 'latest' ? 1 : 0)
  if (failed || results.length < expected) process.exit(1)
}

main().catch(async (err) => {
  process.stderr.write(`rehearsal: ${err instanceof Error ? err.stack : String(err)}\n`)
  for (const w of walnuts) await w.shutdown().catch(() => {})
  process.exit(1)
})
