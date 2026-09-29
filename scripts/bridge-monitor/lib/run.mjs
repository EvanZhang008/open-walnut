/**
 * Child-process helpers. Everything is async with a hard timeout: the
 * collector is a long-running process and one wedged `log show` must never
 * stall its 10-second sampling loop.
 *
 * Each child leads its own process group so a timeout kills the whole tree
 * (`/usr/bin/time` forks the real command; killing only the wrapper leaves
 * the grandchild running and holding the output pipe open).
 *
 * The price of `detached`: a child is outside the collector's process group,
 * so neither launchd nor a SIGKILL of the collector takes it down. Three
 * answers: killAllChildren() on every exit path, a registry file of the
 * long-running (`track`) children, and sweepOrphans() at the next start.
 *
 * The sweep signals a group only when it can PROVE the collector spawned it
 * (a pid read off disk proves nothing; a server once SIGTERM'd 20 live CLIs
 * that way): the leader must still be that pid, lead its own group, have
 * started at the recorded second, and run the recorded argv, whole. Anything
 * else, a ps that times out included, drops the entry without a signal.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'

const active = new Set()
const tracked = new Map()
let registryFile = null
const PS = '/bin/ps'
// One start-time format for the capture and the check, whatever the locale.
const C_LOCALE = { ...process.env, LC_ALL: 'C' }
/** A registry entry older than its own timeout plus this is dropped unsignaled. */
export const ORPHAN_MARGIN_MS = 120_000

/** Keep the tracked children's identities in `file` (null turns it off). */
export function setChildRegistry(file) {
  registryFile = file
}

function writeRegistry() {
  if (!registryFile) return
  try {
    const tmp = `${registryFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify([...tracked.values()]), { mode: 0o600 })
    fs.renameSync(tmp, registryFile)
  } catch { /* best effort: the sweep just finds less */ }
}

const oneSpace = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/**
 * The command lines a leader spawned as `argv` can show: `argv` itself, and
 * for `/usr/bin/nice -n N cmd...` also `cmd...`, since nice execs its command
 * in place (same pid, same start time). Compared whole, never as a substring:
 * "/usr/bin/login -fpl" contains "/usr/bin/log".
 */
export function leaderCommandLines(argv) {
  if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === 'string')) return []
  const lines = [argv.join(' ')]
  if (argv[0] === '/usr/bin/nice' && argv[1] === '-n' && argv.length > 3) lines.push(argv.slice(3).join(' '))
  return lines
}

/** `ps -o pid=,pgid=,lstart=,command=` -> Map pid -> {pid, pgid, lstart, command} */
export function parsePsRows(out) {
  const rows = new Map()
  for (const line of String(out ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/.exec(line)
    if (m) rows.set(Number(m[1]), { pid: Number(m[1]), pgid: Number(m[2]), lstart: oneSpace(m[3]), command: m[4] })
  }
  return rows
}

/** ps rows for `pids` plus this process; null when ps cannot be read (error, timeout, no own row). */
export async function readProcesses(pids, { runImpl = run, selfPid = process.pid } = {}) {
  const list = [...new Set([...pids, selfPid])].filter((p) => Number.isInteger(p) && p > 0)
  const res = await runImpl(PS, ['-o', 'pid=,pgid=,lstart=,command=', '-p', list.join(',')], { timeoutMs: 5000, env: C_LOCALE })
  if (res.timedOut || res.error) return null
  const rows = parsePsRows(res.stdout)
  return rows.has(selfPid) ? rows : null
}

/**
 * What to do with each registry entry, given fresh ps rows (`procs`, null
 * when ps could not be read). Pure: returns [{entry, action: 'kill'|'drop', reason}].
 */
export function planSweep(entries, procs, { nowMs = Date.now(), selfPid = process.pid } = {}) {
  const selfPgid = procs?.get(selfPid)?.pgid
  return (Array.isArray(entries) ? entries : []).map((e) => {
    const drop = (reason) => ({ entry: e, action: 'drop', reason })
    const pid = Number(e?.pid)
    const spawnedMs = Date.parse(e?.t)
    if (!Number.isInteger(pid) || e?.pgid !== pid || typeof e?.lstart !== 'string' || !leaderCommandLines(e?.argv).length
      || !Number.isFinite(spawnedMs) || !Number.isFinite(e?.timeoutMs)) return drop('incomplete entry')
    if (pid <= 1 || pid === selfPid || pid === selfPgid) return drop('never signal init or the collector itself')
    if (nowMs - spawnedMs > e.timeoutMs + ORPHAN_MARGIN_MS) return drop('older than its timeout')
    if (!procs) return drop('ps unreadable')
    const p = procs.get(pid)
    if (!p) return drop('gone')
    if (p.pgid !== pid) return drop('pid is no longer a group leader')
    if (p.lstart !== oneSpace(e.lstart)) return drop('pid reused (start time differs)')
    if (!leaderCommandLines(e.argv).includes(p.command)) return drop('pid reused (command line differs)')
    return { entry: e, action: 'kill', reason: 'orphan' }
  })
}

const killGroupNow = (pgid) => process.kill(-pgid, 'SIGKILL')

/** Apply a plan: SIGKILL the proven orphan groups. Returns {killed: [...], dropped: [...]}. */
export function sweepOrphans(entries, procs, { nowMs = Date.now(), selfPid = process.pid, kill = killGroupNow } = {}) {
  const killed = []
  const dropped = []
  const selfPgid = procs?.get(selfPid)?.pgid
  for (const { entry, action, reason } of planSweep(entries, procs, { nowMs, selfPid })) {
    const pgid = Number(entry?.pid)
    const cmd = Array.isArray(entry?.argv) ? entry.argv.join(' ').slice(0, 120) : null
    // The plan already refuses these; the signal call checks again on its own.
    if (action !== 'kill' || pgid <= 1 || pgid === selfPid || pgid === selfPgid) {
      dropped.push({ pid: Number.isInteger(pgid) ? pgid : null, reason: action === 'kill' ? 'refused at the signal' : reason })
      continue
    }
    try { kill(pgid); killed.push({ pgid, cmd }) } catch { dropped.push({ pid: pgid, reason: 'gone meanwhile' }) }
  }
  return { killed, dropped }
}

/** Read the registry left by the last run, kill its proven orphans, clear it. */
export async function sweepRegistry(file, { runImpl = run, kill = killGroupNow, nowMs = Date.now(), selfPid = process.pid } = {}) {
  let entries = []
  try { entries = JSON.parse(fs.readFileSync(file, 'utf-8')) } catch { return { killed: [], dropped: [] } }
  const pids = (Array.isArray(entries) ? entries : []).map((e) => Number(e?.pid)).filter((p) => Number.isInteger(p) && p > 1)
  const procs = pids.length ? await readProcesses(pids, { runImpl, selfPid }) : null
  const out = sweepOrphans(entries, procs, { nowMs, selfPid, kill })
  try { fs.rmSync(file, { force: true }) } catch { /* fine */ }
  return out
}

/** The pgid and start time of a pid, right after spawn; null when ps cannot say. */
export async function processIdentity(pid, { runImpl = run } = {}) {
  const res = await runImpl(PS, ['-o', 'pgid=,lstart=', '-p', String(pid)], { timeoutMs: 5000, env: C_LOCALE })
  const m = res.code === 0 ? /^\s*(\d+)\s+(\S.*\S)\s*$/.exec(res.stdout) : null
  return m ? { pgid: Number(m[1]), lstart: oneSpace(m[2]) } : null
}

function killGroup(pid) {
  // A process-group kill needs a real leader pid: never 0, 1, negative, or our own.
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return
  try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
}

/** Kill every child still running (collector shutdown). */
export function killAllChildren() {
  for (const pid of active) killGroup(pid)
  active.clear()
  if (tracked.size) { tracked.clear(); writeRegistry() }
}

/**
 * Run one command. Resolves (never rejects) with
 * { code, stdout, stderr, ms, timedOut, truncated, error }.
 */
export function run(cmd, args = [], { timeoutMs = 10_000, input = null, maxBytes = 64 * 1024 * 1024, env, track = false } = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    let child
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: env ?? process.env, detached: true })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: '', ms: 0, timedOut: false, truncated: false, error: String(err.message || err) })
      return
    }
    const pid = child.pid
    if (pid) active.add(pid)
    // Registered only once its start time is known: an entry the next start
    // cannot prove is never signaled, so there is no point writing one.
    if (pid && track) {
      void processIdentity(pid).then((id) => {
        if (!id || settled || !active.has(pid)) return
        tracked.set(pid, { pid, pgid: id.pgid, lstart: id.lstart, argv: [cmd, ...args], t: new Date(started).toISOString(), timeoutMs })
        writeRegistry()
      })
    }
    const out = []
    const errOut = []
    let outBytes = 0
    let truncated = false
    let timedOut = false
    let settled = false
    const finish = (code, error = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      active.delete(pid)
      if (tracked.delete(pid)) writeRegistry()
      resolve({
        code, stdout: Buffer.concat(out).toString('utf-8'), stderr: Buffer.concat(errOut).toString('utf-8'),
        ms: Date.now() - started, timedOut, truncated, error,
      })
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(pid)
      // Do not wait for 'close': a stray grandchild could hold the pipe open.
      setTimeout(() => finish(-1, 'timeout'), 1000).unref()
    }, timeoutMs)
    child.stdout.on('data', (b) => {
      if (outBytes + b.length > maxBytes) { truncated = true; return }
      outBytes += b.length
      out.push(b)
    })
    child.stderr.on('data', (b) => { if (errOut.length < 256) errOut.push(b) })
    child.stdin.on('error', () => { /* child exited before reading its input */ })
    child.on('error', (err) => finish(-1, String(err.message || err)))
    child.on('close', (code) => finish(code ?? -1))
    if (input != null) child.stdin.end(input)
    else child.stdin.end()
  })
}

/**
 * Parse the rusage block `/usr/bin/time -l` prints on macOS:
 *   "       61.10 real         5.66 user         3.94 sys"
 *   "  715276288  maximum resident set size"
 */
export function parseTimeL(stderr) {
  const m = /([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys/.exec(stderr)
  if (!m) return null
  const rss = /(\d+)\s+maximum resident set size/.exec(stderr)
  return {
    wallMs: Math.round(Number(m[1]) * 1000),
    cpuMs: Math.round((Number(m[2]) + Number(m[3])) * 1000),
    maxRssMB: rss ? Math.round(Number(rss[1]) / (1024 * 1024)) : null,
  }
}

/**
 * Run a heavy command at lowered CPU priority and measure what it cost:
 * `/usr/bin/nice -n 10 /usr/bin/time -l <cmd>`. (Not `taskpolicy -b`: that
 * also throttles disk IO, and `log show` then crawls for minutes on a busy
 * Mac.)
 */
export async function runMeasured(cmd, args, opts = {}) {
  const res = await run('/usr/bin/nice', ['-n', '10', '/usr/bin/time', '-l', cmd, ...args], opts)
  return { ...res, cost: parseTimeL(res.stderr) }
}
