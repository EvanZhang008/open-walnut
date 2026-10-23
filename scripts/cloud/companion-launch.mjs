#!/usr/bin/env bun
// The cloud companion's launcher. systemd runs it as the service user (the
// launcher.conf drop-in from ensure-harness.sh), and it starts the server from
// one of three trees, in this order:
//   1. a trial build the Mac just installed, at most twice before it is given up;
//   2. the current build, when its directory is ready;
//   3. the base tree this script lives in (root's code tree).
// Builds live in the service user's home and run as that user; root never runs
// them (why: docs/plan/walnut-companion-unified-replica.md, stage 1).
//
// Plain JavaScript with node: builtins only, run by bun: it must run before any
// build is installed. The server runs on the same runtime as the launcher
// (process.execPath), so the drop-in's runtime is the server's too: bun on a
// unit setup.sh writes now, node on a box set up before.
//
// A build the Mac sends is the compiled walnut file with a small dist/cli.js
// that starts it (src/core/companion-build/package.ts): it runs under either
// runtime. A dist build runs only on the runtime it was smoke-booted on, which
// the box wrote to its .runtime file; a dist with none came from a box that
// installed and smoke-booted everything on node. A current build for another
// runtime is skipped (the base tree runs, and the Mac sends a build again); a
// trial for another runtime is given up.
// Knobs: WALNUT_COMPANION_ROOT (default ~/.open-walnut-host),
// WALNUT_COMPANION_BASE (default the tree two levels up),
// WALNUT_COMPANION_TRIAL_DEADLINE_MS (600000), WALNUT_COMPANION_KILL_GRACE_MS
// (20000), WALNUT_COMPANION_TRIAL_POLL_MS (2000).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const log = (msg) => console.log(`[companion-launch] ${msg}`)
const knob = (name, fallback) => {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Same rule as BUILD_ID_RE / validBuildId in src/core/companion-build/wire.ts.
const BUILD_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/
const validBuildId = (id) => BUILD_ID_RE.test(id) && !id.includes('..')

const ROOT = process.env.WALNUT_COMPANION_ROOT || path.join(os.homedir(), '.open-walnut-host')
const STATE = path.join(ROOT, 'companion')
const BASE = process.env.WALNUT_COMPANION_BASE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DEADLINE_MS = knob('WALNUT_COMPANION_TRIAL_DEADLINE_MS', 600_000)
const GRACE_MS = knob('WALNUT_COMPANION_KILL_GRACE_MS', 20_000)
const POLL_MS = knob('WALNUT_COMPANION_TRIAL_POLL_MS', 2_000)
const MAX_TRIAL_STARTS = 2

const statePath = (name) => path.join(STATE, name)
const appDir = (id) => path.join(ROOT, 'app', id)
const exists = (p) => fs.existsSync(p)
const isReady = (dir) => exists(path.join(dir, '.ready')) && exists(path.join(dir, 'dist', 'cli.js'))
const RUNTIME = process.versions.bun ? 'bun' : 'node'

/** What a build needs to run: `file` (either runtime), else the runtime its dist was tried on. */
function buildRuntime(dir) {
  if (exists(path.join(dir, 'walnut'))) return 'file'
  let recorded = ''
  try { recorded = fs.readFileSync(path.join(dir, '.runtime'), 'utf8').trim() } catch { /* none */ }
  return recorded === 'bun' || recorded === 'node' ? recorded : 'node'
}
const runsHere = (dir) => { const r = buildRuntime(dir); return r === 'file' || r === RUNTIME }

function readText(name) {
  try { return fs.readFileSync(statePath(name), 'utf8').trim() } catch { return null }
}
/** A build id from a state file; an invalid one counts as absent. */
function readId(name, quiet = false) {
  const value = readText(name)
  if (value === null) return null
  if (validBuildId(value)) return value
  if (!quiet) log(`${name} holds ${JSON.stringify(value.slice(0, 120))}, not a build id; treated as absent`)
  return null
}
/** tmp + rename, so a crash never leaves half a file for the next start. */
function writeState(name, text) {
  const file = statePath(name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' }
}
function commandLine(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ') } catch { /* not Linux */ }
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 })
  } catch { return '' }
}

// With KillMode=process a launcher that died hard leaves its server running,
// holding the port. Stop it, but only when server.pid still names a server.
async function stopStaleServer() {
  const pid = Number.parseInt(readText('server.pid') ?? '', 10)
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || !alive(pid)) return
  const cmd = commandLine(pid)
  if (!cmd.includes('cli.js') || !cmd.includes(' web')) return
  log(`a server from an earlier start (pid ${pid}) is still running; sending SIGTERM`)
  try { process.kill(pid, 'SIGTERM') } catch { return }
  for (const end = Date.now() + GRACE_MS; Date.now() < end; await sleep(200)) {
    if (!alive(pid)) return
  }
  log(`pid ${pid} did not stop within ${GRACE_MS} ms; sending SIGKILL`)
  try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
}

function choose() {
  const trial = readId('trial')
  if (trial) {
    const raw = readText('attempts')
    const attempts = raw && /^\d+$/.test(raw) ? Number(raw) : 0
    if (!isReady(appDir(trial))) {
      writeState(path.join('failed', trial), 'trial build is not installed (no .ready or dist/cli.js)\n')
      fs.rmSync(statePath('trial'), { force: true })
      fs.rmSync(statePath('attempts'), { force: true })
      log(`trial ${trial} is not installed; given up`)
    } else if (!runsHere(appDir(trial))) {
      const r = buildRuntime(appDir(trial))
      writeState(path.join('failed', trial), `trial build was tried on ${r}, and this box runs its builds on ${RUNTIME}\n`)
      fs.rmSync(statePath('trial'), { force: true })
      fs.rmSync(statePath('attempts'), { force: true })
      log(`trial ${trial} was tried on ${r}, not ${RUNTIME}; given up`)
    } else if (attempts < MAX_TRIAL_STARTS) {
      // Counted before the start, so a start that never comes back still counts.
      writeState('attempts', `${attempts + 1}\n`)
      log(`trial ${trial}: start ${attempts + 1} of ${MAX_TRIAL_STARTS}`)
      return { id: trial, dir: appDir(trial), trial: true }
    } else {
      writeState(path.join('failed', trial), `trial did not confirm after ${MAX_TRIAL_STARTS} starts\n`)
      fs.rmSync(statePath('trial'), { force: true })
      fs.rmSync(statePath('attempts'), { force: true })
      log(`trial ${trial} did not confirm after ${MAX_TRIAL_STARTS} starts; given up`)
    }
  }
  const current = readId('current')
  if (current && isReady(appDir(current)) && runsHere(appDir(current))) {
    log(`running current build ${current}`)
    return { id: current, dir: appDir(current), trial: false }
  }
  if (current && !isReady(appDir(current))) log(`current build ${current} is not ready (no .ready or dist/cli.js); skipped`)
  else if (current) log(`current build ${current} runs on ${buildRuntime(appDir(current))}, and this launcher on ${RUNTIME}; skipped until the Mac sends a build again`)
  log(`running the base tree ${BASE}`)
  return { id: 'base', dir: BASE, trial: false }
}

async function main() {
  await stopStaleServer()
  const choice = choose()
  const env = { ...process.env, WALNUT_COMPANION_LAUNCHER: '1', WALNUT_COMPANION_BUILD: choice.id }
  if (choice.trial) env.WALNUT_COMPANION_TRIAL = '1'
  else delete env.WALNUT_COMPANION_TRIAL

  const child = spawn(process.execPath, [path.join(choice.dir, 'dist', 'cli.js'), ...process.argv.slice(2)], {
    cwd: choice.dir, stdio: 'inherit', env,
  })
  child.on('error', (err) => { log(`could not start the server: ${err.message}`); process.exit(1) })
  if (child.pid) writeState('server.pid', `${child.pid}\n`)

  // systemd signals the launcher alone (KillMode=process), so pass it on.
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => { log(`forwarding ${sig} to the server`); child.kill(sig) })
  }

  let timedOut = false
  if (choice.trial) {
    // The trial server confirms itself: it writes current=<id> and removes trial.
    const confirmed = () => readId('current', true) === choice.id && !exists(statePath('trial'))
    let poll = null
    const deadline = setTimeout(() => {
      clearInterval(poll)
      if (confirmed()) { log(`trial ${choice.id} confirmed`); return }
      timedOut = true
      log(`trial ${choice.id} did not confirm within ${DEADLINE_MS} ms; sending SIGTERM`)
      child.kill('SIGTERM')
      setTimeout(() => { log(`trial ${choice.id} still running; sending SIGKILL`); child.kill('SIGKILL') }, GRACE_MS)
    }, DEADLINE_MS)
    poll = setInterval(() => {
      if (!confirmed()) return
      log(`trial ${choice.id} confirmed`)
      clearInterval(poll)
      clearTimeout(deadline)
    }, POLL_MS)
  }

  child.on('exit', (code, signal) => {
    const status = signal ? 128 + (os.constants.signals[signal] ?? 0) : (code ?? 1)
    log(`server exited (${signal ?? `code ${code}`})`)
    // A trial stopped at its deadline is a failed start; systemd starts us again.
    process.exit(timedOut ? 1 : status)
  })
}

main().catch((err) => { log(`failed: ${err?.stack ?? err}`); process.exit(1) })
