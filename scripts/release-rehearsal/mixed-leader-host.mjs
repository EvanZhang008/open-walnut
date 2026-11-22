#!/usr/bin/env bun
/**
 * Mixed-version rehearsal: a leader and a host daemon of different releases, a plugin
 * job's calls between them (plugin-job-probe.mjs says what the job asks).
 *
 *   bun scripts/release-rehearsal/mixed-leader-host.mjs [--older <version>|latest] [--new-src <dir>]
 *       [--work <dir>] [--out <dir>] [--only <pairing>,...] [--keep]
 *
 * The older side is the release people run, `npm install -g open-walnut@<older>` from the
 * real registry (its launcher and its compiled file). The new side is the source tree in
 * --new-src (this checkout by default): its server run by bun from src/cli.ts, its daemon
 * twins from src/providers (daemon-standalone.ts under bun, the JS twin daemon-source.ts
 * under Node, as a host without the compiled daemon runs it).
 *
 * Pairings (each its own HOME, data, daemon dir and port; mock `claude`; no auto-update):
 *   old-leader+old-host         the control: the old release with its own daemon.
 *   old-leader+new-host         A: the new standalone daemon, which names the job in the
 *                               relay frame's `caller` (vouched), under the old leader.
 *   old-leader+new-source-host  A with the new JS twin (names the job, never vouches).
 *   new-leader+new-host         the contrast: the job vouched for, its bypass starts go through.
 *   new-leader+old-host         B: the old daemon names no job; the new leader caps the call.
 *
 * How each daemon becomes the leader's: a leader keeps a daemon that answers the version it
 * expects. The old leader (a compiled file) expects its own file's daemon version, so the new
 * daemon is started first in its daemon dir under that version label (DAEMON_VERSION), as a
 * daemon a newer Walnut on the same machine left running is kept. The new leader (from source)
 * runs the daemon binary WALNUT_DAEMON_BINARIES_DIR names, with its `.version` sidecar: here a
 * shim that runs the chosen daemon. Each run checks afterwards that the daemon serving is the
 * one meant (version file, pid), so a leader that replaced it fails the run.
 *
 * Judged (plugin-job-probe.mjs): A answers each call exactly as the control did, and its
 * leader logs no error line the control did not; B refuses both bypass starts with the
 * ceiling's sentence, as the control did, and logs no error line the new pair did not; the
 * new pair starts both in bypass. Evidence per pairing lands in --out: run.json, the leader's
 * console log, the job's out file, the daemon logs; summary.json for all.
 */
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { IsolatedWalnut } from './walnut.mjs'
import { outsideFetch } from './outside-fetch.mjs'
import { PACKAGE, UPSTREAM } from './registry.mjs'
import { allowedScripts } from '../stable-promote.mjs'
import { realNodeOnPath } from '../outside-node.mjs'
import {
  daemonHeads, errorHeads, installProbePlugin, judgeNewLeaderOldHost, judgeNewPair, judgeOldLeader, newHeads, outcomesOf, readProbeOut, startStatuses,
} from './plugin-job-probe.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const target = `${process.platform}-${process.arch}`
const daemonBinaryName = `daemon-${process.platform}-${process.arch}`

export const PAIRINGS = {
  'old-leader+old-host': { leader: 'old', host: 'old' },
  'old-leader+new-host': { leader: 'old', host: 'new' },
  'old-leader+new-source-host': { leader: 'old', host: 'new-source' },
  'new-leader+new-host': { leader: 'new', host: 'new' },
  'new-leader+old-host': { leader: 'new', host: 'old' },
}

function parseArgs(argv) {
  const out = { older: 'latest', newSrc: repo, work: null, out: null, only: null, keep: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--older') out.older = argv[++i]
    else if (a === '--new-src') out.newSrc = path.resolve(argv[++i])
    else if (a === '--work') out.work = path.resolve(argv[++i])
    else if (a === '--out') out.out = path.resolve(argv[++i])
    else if (a === '--only') out.only = argv[++i].split(',').filter(Boolean)
    else if (a === '--keep') out.keep = true
    else throw new Error(`unknown argument ${a}`)
  }
  for (const p of out.only ?? []) if (!PAIRINGS[p]) throw new Error(`--only takes ${Object.keys(PAIRINGS).join(', ')}, not ${p}`)
  return out
}

/** The registry's manifest of `older` (`latest` resolved through its dist-tags). */
async function olderManifest(older) {
  let version = older
  if (older === 'latest') {
    const res = await outsideFetch(`${UPSTREAM}/${PACKAGE}`, { headers: { accept: 'application/vnd.npm.install-v1+json' } }, { timeoutMs: 60_000 })
    if (!res.ok) throw new Error(`the registry answered HTTP ${res.status} for ${PACKAGE}`)
    version = (await res.json())['dist-tags']?.latest
    if (!version) throw new Error(`the registry names no latest ${PACKAGE}`)
  }
  const res = await outsideFetch(`${UPSTREAM}/${PACKAGE}/${version}`, {}, { timeoutMs: 60_000 })
  if (!res.ok) throw new Error(`the registry answered HTTP ${res.status} for ${PACKAGE}@${version}`)
  return res.json()
}

const COMMON_ENV = { WALNUT_PLUGIN_JOBS_IN_TEST: '1', WALNUT_NO_AUTO_UPDATE: '1' }

/** The older release installed once; every old leader and old daemon runs from it. */
async function installOlder(work, manifest) {
  const w = new IsolatedWalnut({ work, name: 'older-install', extraEnv: COMMON_ENV })
  await w.install(`${PACKAGE}@${manifest.version}`, allowedScripts(manifest))
  const launcher = w.bin
  const file = path.join(w.prefix, 'lib/node_modules', PACKAGE, 'node_modules/@open-walnut', target, 'walnut')
  if (!fs.existsSync(file)) throw new Error(`${PACKAGE}@${manifest.version} left no compiled file at ${file}`)
  const printed = w.version()
  const r = spawnSync(file, ['__daemon', '--version'], { env: w.env, encoding: 'utf8', timeout: 120_000 })
  const daemonVersion = (r.stdout ?? '').trim().split('\n').pop()
  if (r.status !== 0 || !daemonVersion) throw new Error(`${file} __daemon --version exited ${r.status}: ${(r.stderr ?? '').slice(-400)}`)
  return { version: manifest.version, printed, launcher, file, daemonVersion }
}

const sh = (lines) => `#!/bin/sh\n${lines.join('\n')}\n`
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/** The JS twin of the new source, labelled `version`, written to `file`. */
function writeSourceTwin(newSrc, version, file) {
  const r = spawnSync(process.execPath, ['-e', `const { getDaemonSource } = await import(${JSON.stringify(path.join(newSrc, 'src/providers/daemon-source.ts'))}); process.stdout.write(getDaemonSource())`],
    { cwd: newSrc, env: { ...process.env, DAEMON_VERSION: version }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 120_000 })
  if (r.status !== 0 || !r.stdout) throw new Error(`could not build the JS twin: ${(r.stderr ?? '').slice(-600)}`)
  // A source run bakes the hash of its source tree in, over DAEMON_VERSION: relabel that one literal.
  const label = /^const DAEMON_VERSION = '[^']*';$/gm
  if ((r.stdout.match(label) ?? []).length !== 1) throw new Error('the JS twin has no single DAEMON_VERSION literal to label')
  fs.writeFileSync(file, r.stdout.replace(label, () => `const DAEMON_VERSION = ${JSON.stringify(version)};`), { mode: 0o755 })
}

/** Command and args that run a daemon of `kind` ('old', 'new', 'new-source') from its own files. */
function daemonCommand(kind, { older, newSrc, dir, version }) {
  if (kind === 'old') return { cmd: older.file, args: ['__daemon'] }
  if (kind === 'new') return { cmd: process.execPath, args: [path.join(newSrc, 'src/providers/daemon-standalone.ts')] }
  const node = realNodeOnPath(process.env)
  if (!node) throw new Error('the JS twin runs on Node, and there is no Node on PATH')
  const file = path.join(dir, 'daemon-source.cjs')
  writeSourceTwin(newSrc, version, file)
  return { cmd: node, args: [file] }
}

/** Start the daemon in `w`'s daemon dir ourselves, under `version`; resolves its pid. */
async function preStartDaemon(w, kind, ctx) {
  const { cmd, args } = daemonCommand(kind, { ...ctx, dir: w.dir })
  const log = fs.openSync(path.join(w.dir, 'pre-started-daemon.log'), 'a')
  const child = spawn(cmd, [...args, '--start'], { env: { ...w.env, DAEMON_VERSION: ctx.version }, cwd: ctx.newSrc, detached: true, stdio: ['ignore', log, log] })
  child.unref()
  fs.closeSync(log)
  const files = ['daemon.port', 'daemon.pid', 'agent-gateway.sock'].map((f) => path.join(w.daemonDir, f))
  for (const deadline = Date.now() + 120_000; Date.now() < deadline; await sleep(250)) {
    if (files.every((f) => fs.existsSync(f))) return Number(fs.readFileSync(files[1], 'utf8').trim())
  }
  throw new Error(`the ${kind} daemon wrote no port, pid and gateway socket in ${w.daemonDir} within 120 s (log: ${path.join(w.dir, 'pre-started-daemon.log')})`)
}

/** The new leader's daemon binary slot: a shim that runs a daemon of `kind`, with its version sidecar. */
function daemonSlot(pairingDir, kind, ctx) {
  const dir = path.join(pairingDir, 'daemon-binaries')
  fs.mkdirSync(dir, { recursive: true })
  const { cmd, args } = daemonCommand(kind, { ...ctx, dir })
  fs.writeFileSync(path.join(dir, daemonBinaryName), sh([`DAEMON_VERSION=${q(ctx.version)}; export DAEMON_VERSION`, `exec ${[cmd, ...args].map(q).join(' ')} "$@"`]), { mode: 0o755 })
  fs.writeFileSync(path.join(dir, `${daemonBinaryName}.version`), ctx.version)
  return dir
}

const read = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

/** One pairing, start to end; resolves what it saw (judged later, against the others). */
async function runPairing(name, pairing, { work, older, newSrc, out }) {
  const started = Date.now()
  const newLabel = `rehearsal-new-${crypto.randomBytes(4).toString('hex')}`
  const daemonVersion = pairing.host === 'old' || pairing.leader === 'old' ? older.daemonVersion : newLabel
  const ctx = { older, newSrc, version: daemonVersion }
  // The new leader's shims go in the pairing's own dir before the walnut that runs them is made.
  const dir = path.join(work, name)
  fs.mkdirSync(dir, { recursive: true })
  const extraEnv = { ...COMMON_ENV }
  let bin = older.launcher
  if (pairing.leader === 'new') {
    bin = path.join(dir, 'new-leader')
    fs.writeFileSync(bin, sh([`exec ${q(process.execPath)} ${q(path.join(newSrc, 'src/cli.ts'))} "$@"`]), { mode: 0o755 })
    extraEnv.WALNUT_DAEMON_BINARIES_DIR = daemonSlot(dir, pairing.host, ctx)
  }
  const w = new IsolatedWalnut({ work, name, extraEnv, bin })
  const jobOut = path.join(w.dir, 'job-out.jsonl')
  installProbePlugin(w.walnutHome, { out: jobOut, cwd: w.project })
  const run = { name, ...pairing, leaderVersion: pairing.leader === 'old' ? older.printed : `source ${newSrc}`, expectedDaemonVersion: daemonVersion, dir: w.dir }
  try {
    if (pairing.leader === 'old' && pairing.host !== 'old') run.preStartedPid = await preStartDaemon(w, pairing.host, ctx)
    await w.start({ timeoutMs: 300_000 })
    let records = []
    for (const deadline = Date.now() + 300_000; Date.now() < deadline; await sleep(1_000)) {
      records = readProbeOut(read(jobOut))
      if (records.some((r) => r.step === 'done')) break
      if (w.server?.exitCode !== null) break
    }
    run.records = records
    run.done = records.some((r) => r.step === 'done')
    run.outcomes = outcomesOf(records)
    // The task each start was for (a refused create names none: found by its title), and the
    // mode of the session it made, if any.
    const listed = await w.api('GET', '/api/tasks').catch(() => null)
    const tasks = Array.isArray(listed?.json) ? listed.json : Array.isArray(listed?.json?.tasks) ? listed.json.tasks : []
    run.tasks = tasks.filter((t) => /^Rehearsal /.test(t.title ?? '')).map((t) => ({ id: t.id, title: t.title, phase: t.phase, project: t.project }))
    run.modes = {}
    for (const step of ['bypass-create', 'bypass-start']) {
      const id = records.find((r) => r.step === step)?.taskId ?? (step === 'bypass-create' ? run.tasks.find((t) => t.title === 'Rehearsal bypass create')?.id : null)
      if (!id) continue
      const s = await w.api('GET', `/api/sessions/task/${id}`).catch(() => null)
      const list = Array.isArray(s?.json) ? s.json : Array.isArray(s?.json?.sessions) ? s.json.sessions : []
      const mode = list.find((x) => !x.archived)?.mode
      if (mode) run.modes[step] = mode
    }
    run.healthAfter = (await w.api('GET', '/api/system/health').catch(() => ({ status: 0 }))).status
    run.leaderAlive = w.server?.exitCode === null
    // The daemon that served is the one meant: its version, and for a pre-started one its pid.
    run.servedDaemon = { version: read(path.join(w.daemonDir, 'daemon.version')).trim(), pid: Number(read(path.join(w.daemonDir, 'daemon.pid')).trim()) || null }
    run.servedDaemon.alive = !!run.servedDaemon.pid && alive(run.servedDaemon.pid)
    run.daemonProblems = []
    if (run.servedDaemon.version !== daemonVersion) run.daemonProblems.push(`the daemon serving reports ${run.servedDaemon.version || 'nothing'}, not ${daemonVersion}`)
    if (run.preStartedPid && run.servedDaemon.pid !== run.preStartedPid) run.daemonProblems.push(`the leader replaced the pre-started daemon ${run.preStartedPid} with ${run.servedDaemon.pid}`)
    if (run.servedDaemon.pid) {
      const cmdline = read(`/proc/${run.servedDaemon.pid}/cmdline`).split('\0').join(' ')
      run.servedDaemon.cmdline = cmdline
      const want = pairing.host === 'old' ? older.file : pairing.host === 'new' ? 'daemon-standalone.ts' : 'daemon-source.cjs'
      if (cmdline && !cmdline.includes(want)) run.daemonProblems.push(`the daemon serving runs "${cmdline}", not ${want}`)
    }
  } catch (err) {
    run.error = err instanceof Error ? err.message : String(err)
  } finally {
    await w.shutdown().catch(() => {})
    run.secs = Math.round((Date.now() - started) / 1000)
    const leaderLog = read(w.logFile)
    run.errorHeads = errorHeads(leaderLog)
    run.startStatuses = startStatuses(leaderLog)
    const daemonLog = (fs.existsSync(w.daemonDir) ? fs.readdirSync(w.daemonDir) : []).filter((f) => /^daemon.*\.log$/.test(f)).map((f) => read(path.join(w.daemonDir, f))).join('\n')
    run.daemonErrorHeads = daemonHeads(daemonLog)
    run.daemonWarnHeads = daemonHeads(daemonLog, ['warn'])
    const dest = path.join(out, name)
    fs.mkdirSync(dest, { recursive: true })
    fs.writeFileSync(path.join(dest, 'leader-console.log'), leaderLog)
    fs.writeFileSync(path.join(dest, 'job-out.jsonl'), read(jobOut))
    for (const f of fs.existsSync(w.daemonDir) ? fs.readdirSync(w.daemonDir) : []) {
      if (/^(daemon.*\.log|open-walnut-.*\.log)$/.test(f)) fs.copyFileSync(path.join(w.daemonDir, f), path.join(dest, f))
    }
    if (fs.existsSync(path.join(w.dir, 'pre-started-daemon.log'))) fs.copyFileSync(path.join(w.dir, 'pre-started-daemon.log'), path.join(dest, 'pre-started-daemon.log'))
    fs.writeFileSync(path.join(dest, 'run.json'), JSON.stringify(run, null, 2))
  }
  return run
}

/** Each pairing's problems, judged against the control and the new pair. */
export function judgeAll(runs) {
  const by = Object.fromEntries(runs.map((r) => [r.name, r]))
  const control = by['old-leader+old-host']
  const newPair = by['new-leader+new-host']
  const verdicts = {}
  for (const r of runs) {
    const problems = [...(r.error ? [`run failed: ${r.error}`] : []), ...(r.daemonProblems ?? [])]
    if (!r.error) {
      if (r.name === 'old-leader+old-host') problems.push(...judgeOldLeader(r, r))
      else if (r.leader === 'old') problems.push(...(control && !control.error ? judgeOldLeader(r, control) : ['no control run to compare with']))
      else if (r.name === 'new-leader+new-host') problems.push(...judgeNewPair(r))
      else problems.push(...judgeNewLeaderOldHost(r, { oldBaseline: control?.error ? null : control, newBaseline: newPair?.error ? null : newPair }))
    }
    // A daemon's errors under a leader of the other release that the same daemon did not log
    // under its own release's leader: the new daemon's against the new pair, the old one's against the control.
    const own = r.host === 'old' ? control : r.host === 'new' ? newPair : null
    if (!r.error && own && own !== r && !own.error && r.leader !== (r.host === 'old' ? 'old' : 'new')) {
      for (const h of newHeads(r.daemonErrorHeads ?? [], own.daemonErrorHeads ?? [])) problems.push(`daemon error line its own release's leader did not cause: ${h}`)
    }
    verdicts[r.name] = { ok: problems.length === 0, problems }
  }
  return verdicts
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const work = opts.work ?? fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-mixed-'))
  // A daemon's gateway is a unix socket in its dir: past about 100 bytes the JS twin cannot bind it.
  const sock = path.join(work, Object.keys(PAIRINGS).sort((a, b) => b.length - a.length)[0], 'daemon', 'agent-gateway.sock')
  if (Buffer.byteLength(sock) > 100) throw new Error(`--work ${work} is too deep: a daemon's socket there (${sock}) passes the unix socket path limit; pick a shorter one`)
  const out = opts.out ?? path.join(work, 'evidence')
  fs.mkdirSync(out, { recursive: true })
  const manifest = await olderManifest(opts.older)
  process.stdout.write(`older: ${PACKAGE}@${manifest.version}; new: ${opts.newSrc}; work: ${work}\n`)
  const older = await installOlder(work, manifest)
  process.stdout.write(`older install: ${older.printed}; its daemon: ${older.daemonVersion}\n`)
  const names = opts.only ?? Object.keys(PAIRINGS)
  const runs = []
  for (const name of names) {
    process.stdout.write(`\n▶ ${name}\n`)
    const run = await runPairing(name, PAIRINGS[name], { work, older, newSrc: opts.newSrc, out })
    runs.push(run)
    process.stdout.write(`  ${run.error ? `error: ${run.error}` : `done=${run.done} outcomes=${JSON.stringify(run.outcomes)} modes=${JSON.stringify(run.modes)}`} (${run.secs}s)\n`)
  }
  const verdicts = judgeAll(runs)
  const summary = { older: { version: older.version, printed: older.printed, daemonVersion: older.daemonVersion }, newSrc: opts.newSrc, at: new Date().toISOString(), verdicts, runs: runs.map(({ records, ...r }) => r) }
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2))
  process.stdout.write('\n')
  for (const [name, v] of Object.entries(verdicts)) process.stdout.write(`${v.ok ? '✓' : '✗'} ${name}${v.ok ? '' : `\n    ${v.problems.join('\n    ')}`}\n`)
  process.stdout.write(`evidence: ${out}\n`)
  if (!opts.keep && !opts.work) fs.rmSync(work, { recursive: true, force: true })
  process.exit(Object.values(verdicts).every((v) => v.ok) ? 0 : 1)
}

if (import.meta.main) await main()
