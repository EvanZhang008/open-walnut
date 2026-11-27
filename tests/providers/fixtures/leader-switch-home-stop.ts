/**
 * Run by tests/providers/leader-switch-home-stop-twins-e2e.test.ts with bun, once per daemon twin
 * (argv[3]): `program` (daemon-standalone.ts as a program of its own, `--service`, over its door) or
 * `in-process` (createDaemonRuntime in this process, mode 'service', over runtime.connect()). Both run
 * the same createDaemonRuntime; a service-mode runtime holds cron supervision. Prints one JSON line of
 * what it saw (capability leader-switch-home-stop-v1):
 *   - stop {reason: 'leader_switch'} of a CLI working in the data home: refused without its fence or
 *     its Walnut, refused for another Walnut, then answered once the process group is gone; supervision
 *     is off under the fence (a start without it is refused, with it passes: the rollback's resume);
 *   - a CLI that outlives SIGTERM: an error, and it still runs (no force kill);
 *   - a surviving ACP worker (acp-survive-v1) in the home: the same stop ends it through its strict stop;
 *   - start and acpStart with a working folder in a marked home (both states, a torn marker) are refused
 *     with code HOME_HANDED_OVER, the home, the state and the machine; the neighbour `<home>-c` and an
 *     unmarked home start as before;
 *   - a new runtime on the same dirs, with the keep switch on, adopts the kept CLI and the kept ACP
 *     worker (the control) and nothing of the stopped ones.
 *
 * MACHINE SAFETY: every path is under the temp root argv[2] (HOME, the daemon, streams and state dirs,
 * the data home); the CLIs are this file's stand-in scripts, the ACP agent is the mock. Signals: the
 * runtimes' own stops of their own sessions; SIGTERM to the daemon program this file started (its own
 * stop); at the end SIGKILL only to a pid this file recorded (above 1, still running one of this
 * file's scripts by its command line) that outlived its wait.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'
import { createDaemonRuntime, type DaemonFrame } from '../../../src/providers/daemon-standalone.ts'
import { daemonInstallRoot } from '../../../src/providers/daemon-service-config.ts'
import { acpWorkerBundle } from '../../helpers/acp-worker-bundle.ts'

const root = fs.realpathSync(process.argv[2]!)
const shape = process.argv[3] as 'program' | 'in-process'
if (shape !== 'program' && shape !== 'in-process') throw new Error('shape must be program or in-process')
const STANDALONE = path.resolve(import.meta.dirname, '../../../src/providers/daemon-standalone.ts')
const MOCK_AGENT = path.resolve(import.meta.dirname, '../mock-acp-agent.mjs')
const WORKER = acpWorkerBundle()

const lib = path.join(root, 'lib')
const home = path.join(root, 'h')
const data = path.join(root, 'data')
const neighbour = data + '-c'
const otherWalnut = path.join(root, 'other-walnut')
const daemonDir = path.join(root, 'd')
for (const d of [lib, home, path.join(data, 'sub'), neighbour, otherWalnut]) fs.mkdirSync(d, { recursive: true })
const stateDir = daemonInstallRoot(process.platform === 'darwin' ? 'darwin' : 'linux', home)
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
fs.chmodSync(stateDir, 0o700)

// Stays on its stdin; ends on SIGINT or SIGTERM (or after 60 s).
fs.writeFileSync(path.join(lib, 'cli.cjs'), `
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake' }) + '\\n')
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
process.stdin.on('data', () => {})
setTimeout(() => process.exit(0), 60000).unref()
setInterval(() => {}, 1000)
`)
// Prints its init line and exits at once: a supervised session whose CLI is no longer running.
fs.writeFileSync(path.join(lib, 'brief-cli.cjs'), `
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake' }) + '\\n')
process.exit(0)
`)
// Ignores SIGINT and SIGTERM; ends only when its release file exists (or after 60 s).
fs.writeFileSync(path.join(lib, 'stubborn-cli.cjs'), `
const fs = require('fs')
const release = process.argv[2]
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake' }) + '\\n')
process.on('SIGINT', () => {})
process.on('SIGTERM', () => {})
fs.writeFileSync(release + '.ready', String(process.pid))
process.stdin.on('data', () => {})
setInterval(() => { if (fs.existsSync(release)) process.exit(0) }, 50)
setTimeout(() => process.exit(0), 60000)
`)

const env: Record<string, string | undefined> = {
  ...process.env, SHELL: '/bin/sh', HOME: home, WALNUT_HOME_OVERRIDE: home,
  CLAUDE_CONFIG_DIR: undefined, WALNUT_DAEMON_KEEP_SESSIONS: undefined,
  WALNUT_DEMO_ROOT: undefined, WALNUT_DEMO_GENERATION: undefined, OPEN_WALNUT_HOME: undefined,
  WALNUT_DAEMON_DIR: daemonDir, WALNUT_STREAMS_DIR: daemonDir + '-streams',
  WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(root, 'spawn-journal.jsonl'),
  WALNUT_TASK_DIR_ROOT: path.join(root, 'state', 'tasks'),
  WALNUT_DAEMON_STATE_DIR: stateDir, WALNUT_DAEMON_SHUTDOWN_DRAIN_MS: '3000',
}
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'NVM_DIR', 'FNM_DIR', 'VOLTA_HOME', 'ASDF_DATA_DIR', 'XDG_DATA_HOME', 'WALNUT_DAEMON_PARENT_PID']) delete env[k]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(ok: () => boolean, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms
  while (!ok()) { if (Date.now() > end) return false; await sleep(25) }
  return true
}
/** Alive and not a zombie (Linux: /proc; elsewhere signal 0). */
function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  if (process.platform === 'linux') {
    try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return !/^[ZX]$/.test(st.slice(st.lastIndexOf(')') + 2).split(' ')[0]!) } catch { return false }
  }
  try { process.kill(pid, 0); return true } catch { return false }
}
function groupAlive(pgid: number): boolean {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return false
  try { process.kill(-pgid, 0); return true } catch { return false }
}
const recorded: number[] = []
function runsOurScript(pid: number): boolean {
  const args = spawnSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? ''
  return args.includes(lib) || args.includes(MOCK_AGENT) || args.includes(WORKER) || args.includes('process.exit(0), 30000')
}

// ── One client of one runtime, the same calls for both twins ──
interface Client { rpc(cmd: string, params?: Record<string, unknown>, ms?: number): Promise<DaemonFrame>; stop(): Promise<void> }
let nextId = 1

async function openProgram(extra: Record<string, string> = {}): Promise<Client> {
  const proc: ChildProcess = spawn(process.execPath, [STANDALONE, '--service'], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  proc.stderr?.on('data', (c) => { stderr += String(c) })
  const port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('daemon program did not start: ' + stderr.slice(-2000))), 60_000)
    proc.stdout?.on('data', (c) => { const m = String(c).trim().match(/^\d+$/m); if (m) { clearTimeout(t); resolve(Number(m[0])) } })
    proc.once('exit', (code) => { clearTimeout(t); reject(new Error(`daemon program exited ${code}: ${stderr.slice(-2000)}`)) })
  })
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s)); s.on('error', reject)
  })
  return {
    rpc: (cmd, params = {}, ms = 45_000) => new Promise((resolve, reject) => {
      const id = nextId++
      const t = setTimeout(() => reject(new Error('rpc timeout: ' + cmd)), ms)
      const on = (raw: Buffer) => {
        let f: DaemonFrame
        try { f = JSON.parse(String(raw)) } catch { return }
        if (f.id !== id || f.ev !== undefined) return
        clearTimeout(t); ws.off('message', on); resolve(f)
      }
      ws.on('message', on)
      ws.send(JSON.stringify({ ...params, id, cmd }))
    }),
    stop: async () => {
      try { ws.close() } catch { /* closed */ }
      if (proc.exitCode !== null || proc.signalCode !== null) return
      const exited = new Promise<void>((r) => { const t = setTimeout(r, 30_000); proc.once('exit', () => { clearTimeout(t); r() }) })
      proc.kill('SIGTERM')
      await exited
      if (proc.exitCode === null && proc.signalCode === null) throw new Error('daemon program did not exit on its own stop')
    },
  }
}

async function openInProcess(extra: Record<string, string> = {}): Promise<Client> {
  const runtime = await createDaemonRuntime({ env: { ...env, ...extra } as NodeJS.ProcessEnv, mode: 'service', listen: false, exit: () => {} })
  await runtime.start()
  const waiting = new Map<number, (f: DaemonFrame) => void>()
  const client = runtime.connect((f) => {
    if (typeof f.id !== 'number' || f.ev !== undefined) return
    const w = waiting.get(f.id)
    if (w) { waiting.delete(f.id); w(f) }
  })
  return {
    rpc: (cmd, params = {}, ms = 45_000) => new Promise((resolve, reject) => {
      const id = nextId++
      const t = setTimeout(() => reject(new Error('rpc timeout: ' + cmd)), ms)
      waiting.set(id, (f) => { clearTimeout(t); resolve(f) })
      client.send({ ...params, id, cmd })
    }),
    stop: async () => { client.close(); await runtime.stop() },
  }
}

const open = (extra?: Record<string, string>) => (shape === 'program' ? openProgram(extra) : openInProcess(extra))

const sid = (n: number) => `5e5e5e5e-0000-4000-8000-${String(n).padStart(12, '0')}`
const fence = (n: number) => `fe0ce000-0000-4000-8000-${String(n).padStart(12, '0')}`
/** `unrecorded`: a start whose argv names no session and whose origin names no Walnut: the spawn journal has no owner for it. */
function start(c: Client, s: string, cwd: string, opts: { script?: string; lead?: string[]; resume?: boolean; stopFence?: string; unrecorded?: boolean } = {}) {
  const sh = `exec ${[process.execPath, path.join(lib, opts.script ?? 'cli.cjs'), ...(opts.lead ?? [])].map((a) => JSON.stringify(a)).join(' ')} "$@"`
  return c.rpc('start', {
    sid: s, cwd, message: '', resume: !!opts.resume, mode: 'default', args: ['/bin/sh', '-c', sh, 'sh', ...(opts.unrecorded ? [] : ['--session-id', s])],
    ...(opts.unrecorded ? {} : { origin: { home: data } }), ...(opts.stopFence ? { stopFence: opts.stopFence } : {}),
  })
}
/** `unrecorded`: no ownerHome, so no record of whose worker it is (as a start before owner records, or one whose record write failed). */
const acpStart = (c: Client, s: string, cwd: string, agentEnv: Record<string, string> = {}, opts: { unrecorded?: boolean } = {}) => c.rpc('acpStart', {
  sid: s, cwd, workerCmd: [process.execPath, WORKER], adapterCmd: [process.execPath, MOCK_AGENT], env: agentEnv, survive: true, ...(opts.unrecorded ? {} : { ownerHome: data }),
})
const lsStop = (c: Client, s: string, n: number, home = data) => c.rpc('stop', { sid: s, reason: 'leader_switch', stopRequestId: fence(n), home })
/** A cron supervision record on disk before the runtime starts (daemon-cron-store.ts): a session supervision watches. */
function seedSupervised(s: string) {
  const dir = path.join(stateDir, 'supervision')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  const record = {
    sid: s, generation: 1, enabled: true, state: 'checking', process: null, attempts: [], retryAt: null, reason: null, updatedAt: Date.now(),
    launch: { cwd: data, args: ['/bin/sh', '-c', 'exit 0'], mode: 'default', cliVersion: '2.1.258', hooksHash: null },
  }
  fs.writeFileSync(path.join(dir, `${s}.json`), JSON.stringify({ version: 1, record }), { mode: 0o600 })
}
/** The members of process group `pgid` (pid and command line), read with ps. */
function groupMembers(pgid: number): Array<{ pid: number; args: string }> {
  const rows = spawnSync('ps', ['-A', '-ww', '-o', 'pid=', '-o', 'pgid=', '-o', 'args='], { encoding: 'utf8', maxBuffer: 64 << 20 }).stdout ?? ''
  return rows.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m && Number(m[2]) === pgid)
    .map((m) => ({ pid: Number(m[1]), args: m[3]! }))
}
const marker = path.join(data, 'local', 'leader-switch', 'handed-over.json')
function mark(text: string | null) {
  if (text === null) { fs.rmSync(marker, { force: true }); return }
  fs.mkdirSync(path.dirname(marker), { recursive: true })
  fs.writeFileSync(marker, text)
}
const pick = (f: DaemonFrame, ...keys: string[]) => Object.fromEntries(keys.filter((k) => f[k] !== undefined).map((k) => [k, f[k]]))
const refusal = (f: DaemonFrame) => pick(f, 'ok', 'errorKind', 'code', 'reason', 'home', 'state', 'to')
const acpRows = () => { try { return Object.keys(JSON.parse(fs.readFileSync(path.join(daemonDir, 'acp-workers.json'), 'utf8'))) } catch { return [] } }

const out: Record<string, unknown> = { shape }
const sup1 = sid(20)
const sup2 = sid(21)
seedSupervised(sup1)
seedSupervised(sup2)
let c = await open()
try {
  const hello = await c.rpc('hello')
  out.capability = (hello.capabilities as string[] | undefined)?.includes('leader-switch-home-stop-v1') ?? false

  // ── 1. No marker: a CLI starts in the data home as before; the leader switch stop ends it ──
  const s1 = sid(1)
  const started = await start(c, s1, data)
  out.unmarkedStart = pick(started, 'ok')
  const pid1 = started.pid as number
  recorded.push(pid1)
  out.noFence = pick(await c.rpc('stop', { sid: s1, reason: 'leader_switch', home: data }), 'ok', 'error')
  out.noHome = pick(await c.rpc('stop', { sid: s1, reason: 'leader_switch', stopRequestId: fence(1) }), 'ok', 'error')
  out.otherWalnut = pick(await c.rpc('stop', { sid: s1, reason: 'leader_switch', stopRequestId: fence(1), home: otherWalnut }), 'ok', 'stopped', 'held', 'reason', 'detail', 'kind')
  out.aliveAfterRefusals = alive(pid1)
  const stopped = await lsStop(c, s1, 1)
  out.stopped = pick(stopped, 'ok', 'stopped', 'kind', 'supervision', 'error')
  // Read at once: the answer came after the group was gone.
  out.goneAtAnswer = !alive(pid1) && !groupAlive(pid1)
  // Not supervised: the stop left no record and no fence, so the rollback's resume (no fence: never user-stopped) starts.
  out.supervision = (await c.rpc('cron.supervision', { sid: s1 })).cronSupervision ?? null
  const resumed = await start(c, s1, data, { resume: true })
  out.startNoFence = pick(resumed, 'ok', 'reason')
  if (typeof resumed.pid === 'number') recorded.push(resumed.pid)
  out.stopAgain = pick(await lsStop(c, s1, 2), 'ok', 'stopped', 'supervision')
  out.goneAgain = typeof resumed.pid === 'number' && !alive(resumed.pid)

  // ── 1b. A supervised session: supervision off with no fence; the rollback turns it on with none, no fence is left ──
  const supStarted = await start(c, sup1, data)
  if (typeof supStarted.pid === 'number') recorded.push(supStarted.pid)
  out.supOn = (await c.rpc('cron.supervision', { sid: sup1 })).cronSupervision
  out.supStopped = pick(await lsStop(c, sup1, 20), 'ok', 'stopped', 'kind', 'supervision')
  out.supOff = (await c.rpc('cron.supervision', { sid: sup1 })).cronSupervision
  out.supReenable = pick(await c.rpc('cron.supervision', { sid: sup1, enabled: true }), 'ok', 'error')
  out.supAfterReenable = (await c.rpc('cron.supervision', { sid: sup1 })).cronSupervision
  const supResumed = await start(c, sup1, data, { resume: true })
  out.supResume = pick(supResumed, 'ok', 'reason')
  if (typeof supResumed.pid === 'number') recorded.push(supResumed.pid)
  out.supStopAgain = pick(await lsStop(c, sup1, 22), 'ok', 'stopped', 'supervision')
  // Supervised, its CLI no longer running: the stop answers noop and turns supervision off.
  const brief = await start(c, sup2, data, { script: 'brief-cli.cjs' })
  if (typeof brief.pid === 'number') { recorded.push(brief.pid); await waitFor(() => !alive(brief.pid as number)) }
  out.briefStopped = pick(await lsStop(c, sup2, 21), 'ok', 'stopped', 'noop', 'kind', 'supervision')
  out.briefOff = (await c.rpc('cron.supervision', { sid: sup2 })).cronSupervision

  // ── 1c. A user stop keeps its fence; a later leader switch stop leaves it as it was ──
  const s9 = sid(9)
  const userStarted = await start(c, s9, data)
  if (typeof userStarted.pid === 'number') recorded.push(userStarted.pid)
  out.userStop = pick(await c.rpc('stop', { sid: s9, reason: 'user', stopRequestId: fence(90), home: data }), 'ok', 'stopped')
  out.userStartNoFence = pick(await start(c, s9, data, { resume: true }), 'ok', 'reason')
  out.userStartOtherFence = pick(await start(c, s9, data, { resume: true, stopFence: fence(91) }), 'ok', 'reason')
  out.userReenableOtherFence = pick(await c.rpc('cron.supervision', { sid: s9, enabled: true, stopFence: fence(91) }), 'ok', 'error')
  const userResumed = await start(c, s9, data, { resume: true, stopFence: fence(90) })
  out.userStartWithFence = pick(userResumed, 'ok')
  if (typeof userResumed.pid === 'number') recorded.push(userResumed.pid)
  out.userThenSwitch = pick(await lsStop(c, s9, 92), 'ok', 'stopped', 'supervision')
  out.userFenceKeptNoFence = pick(await start(c, s9, data, { resume: true }), 'ok', 'reason')
  const userAgain = await start(c, s9, data, { resume: true, stopFence: fence(90) })
  out.userFenceKeptOldFence = pick(userAgain, 'ok')
  if (typeof userAgain.pid === 'number') recorded.push(userAgain.pid)
  out.userFinalStop = pick(await lsStop(c, s9, 93), 'ok', 'stopped')

  // ── 1d. A refusal says whether the daemon holds something: no owner record for a live CLI or worker is a failure ──
  out.nothingHeld = pick(await lsStop(c, sid(99), 99), 'ok', 'stopped', 'held', 'reason', 'detail', 'kind')
  const anon = sid(30)
  const anonStarted = await start(c, anon, data, { unrecorded: true })
  const anonPid = anonStarted.pid as number
  recorded.push(anonPid)
  const anonRefused = await lsStop(c, anon, 30)
  out.claudeHeldNoOwner = pick(anonRefused, 'ok', 'stopped', 'held', 'reason', 'detail', 'kind')
  out.claudeHeldPid = anonRefused.pid === anonPid
  out.claudeHeldStillRuns = alive(anonPid)
  out.claudeHeldUserStop = pick(await c.rpc('stop', { sid: anon, reason: 'user', initiator: 'human' }), 'ok', 'stopped')
  const anonAcp = sid(31)
  out.acpUnrecordedStart = pick(await acpStart(c, anonAcp, data, {}, { unrecorded: true }), 'ok', 'error')
  const anonAcpPid = (JSON.parse(fs.readFileSync(path.join(daemonDir, 'acp-workers.json'), 'utf8')) as Record<string, { pid: number }>)[anonAcp]?.pid ?? 0
  if (anonAcpPid) recorded.push(anonAcpPid)
  const acpRefused = await lsStop(c, anonAcp, 31)
  out.acpHeldNoOwner = pick(acpRefused, 'ok', 'stopped', 'held', 'reason', 'detail', 'kind')
  out.acpHeldPid = acpRefused.pid === anonAcpPid
  out.acpHeldStillRuns = groupAlive(anonAcpPid)
  await c.rpc('acpStop', { sid: anonAcp })
  out.acpHeldEndsOnPlainStop = await waitFor(() => !groupAlive(anonAcpPid), 15_000)

  // ── 2. A CLI that outlives SIGTERM: an error, and it still runs (no force kill) ──
  const s2 = sid(2)
  const release = path.join(root, 'stubborn.release')
  const stubborn = await start(c, s2, path.join(data, 'sub'), { script: 'stubborn-cli.cjs', lead: [release] })
  const pid2 = stubborn.pid as number
  recorded.push(pid2)
  // Its handlers are on before the stop's SIGINT can reach it.
  out.stubbornReady = await waitFor(() => fs.existsSync(release + '.ready'))
  const t0 = Date.now()
  out.stubborn = pick(await c.rpc('stop', { sid: s2, reason: 'leader_switch', stopRequestId: fence(3), home: data }), 'ok', 'stopped', 'error')
  out.stubbornMs = Date.now() - t0
  out.stubbornStillAlive = alive(pid2)
  fs.writeFileSync(release, '')
  out.stubbornEndsOnRelease = await waitFor(() => !alive(pid2))

  // ── 3. A surviving ACP worker in the home: the same stop, through its strict stop ──
  const r1 = sid(11)
  out.acpStart = pick(await acpStart(c, r1, data), 'ok', 'error')
  const acpPid = (JSON.parse(fs.readFileSync(path.join(daemonDir, 'acp-workers.json'), 'utf8')) as Record<string, { pid: number; survive?: boolean }>)[r1]
  out.acpSurvive = acpPid?.survive === true
  if (acpPid) recorded.push(acpPid.pid)
  out.acpOtherWalnut = pick(await c.rpc('stop', { sid: r1, reason: 'leader_switch', stopRequestId: fence(11), home: otherWalnut }), 'ok', 'stopped', 'held', 'reason', 'detail', 'kind')
  out.acpAliveAfterRefusal = !!acpPid && groupAlive(acpPid.pid)
  out.acpStopped = pick(await c.rpc('stop', { sid: r1, reason: 'leader_switch', stopRequestId: fence(11), home: data }), 'ok', 'stopped', 'kind', 'error')
  out.acpGoneAtAnswer = !!acpPid && !groupAlive(acpPid.pid)
  out.acpRowGone = !acpRows().includes(r1)
  out.acpSurviveFilesGone = await waitFor(() => !fs.existsSync(path.join(daemonDir + '-streams', `${r1}.acp-in`)), 5_000)
  out.acpStopAgain = pick(await c.rpc('stop', { sid: r1, reason: 'leader_switch', stopRequestId: fence(11), home: data }), 'ok', 'stopped', 'noop', 'reason')

  // ── 3b. A tool the worker's graceful shutdown leaves running: the strict stop asks its group with SIGTERM ──
  const r2 = sid(15)
  out.acpToolStart = pick(await acpStart(c, r2, data, { MOCK_ACP_STATUS_TOOL_MS: '30000' }), 'ok', 'error')
  const toolPgid = (JSON.parse(fs.readFileSync(path.join(daemonDir, 'acp-workers.json'), 'utf8')) as Record<string, { pid: number }>)[r2]?.pid ?? 0
  if (toolPgid) recorded.push(toolPgid)
  void c.rpc('acpSend', { sid: r2, commandId: 'acp-prompt:t-1', walnutMessageId: 't-1', text: 'status-slow-tool' }, 60_000).catch(() => null)
  const toolOf = () => groupMembers(toolPgid).find((m) => m.args.includes('process.exit(0), 30000'))
  out.toolRunning = await waitFor(() => !!toolOf())
  const tool = toolOf()
  if (tool) recorded.push(tool.pid)
  const t1 = Date.now()
  out.acpToolStopped = pick(await c.rpc('stop', { sid: r2, reason: 'leader_switch', stopRequestId: fence(15), home: data }), 'ok', 'stopped', 'kind', 'error')
  out.acpToolStopMs = Date.now() - t1
  out.acpToolGroupGone = !groupAlive(toolPgid)

  // ── 4. A marked home: no CLI, no ACP worker starts in it or under it, whatever the state ──
  // A live CLI in the home takes no message as a live adopt either (a start with resume and a message).
  const live = sid(8)
  const liveStarted = await start(c, live, data)
  const livePid = liveStarted.pid as number
  recorded.push(livePid)
  mark(JSON.stringify({ switchId: 'sw-1', to: 'machine-b', state: 'switching', at: new Date().toISOString() }))
  out.markedSwitching = refusal(await start(c, sid(3), path.join(data, 'sub')))
  out.markedResume = refusal(await start(c, s1, data, { resume: true, stopFence: fence(2) }))
  out.markedLiveAdopt = refusal(await c.rpc('start', {
    sid: live, cwd: data, message: 'hello', resume: true, mode: 'default', origin: { home: data },
    args: ['/bin/sh', '-c', 'exit 0', 'sh', '--session-id', live],
  }))
  out.liveStillRuns = alive(livePid)
  out.markedAcp = refusal(await acpStart(c, sid(12), data))
  mark(JSON.stringify({ switchId: 'sw-1', to: 'machine-b', state: 'handed-over', at: new Date().toISOString(), commit: 7 }))
  out.markedHandedOver = refusal(await start(c, sid(4), data))
  out.markedHandedOverAcp = refusal(await acpStart(c, sid(13), path.join(data, 'sub')))
  mark('{"state":"swi')
  out.markedTorn = refusal(await start(c, sid(5), data))
  out.noSessionStarted = [sid(3), sid(4), sid(5)].every((s) => !fs.existsSync(path.join(daemonDir + '-streams', `${s}.pgid`)))
  out.noWorkerStarted = !acpRows().includes(sid(12)) && !acpRows().includes(sid(13))
  // The neighbour folder `<home>-c` is not in the home: it starts as before, marker or not.
  const n = await start(c, sid(6), neighbour)
  out.neighbourStart = pick(n, 'ok')
  if (typeof n.pid === 'number') recorded.push(n.pid)
  out.neighbourStop = pick(await c.rpc('stop', { sid: sid(6), reason: 'user', home: data }), 'ok', 'stopped')
  mark(null)
  out.liveStop = pick(await c.rpc('stop', { sid: live, reason: 'leader_switch', stopRequestId: fence(8), home: data }), 'ok', 'stopped')

  // ── 5. A new runtime on the same dirs (the keep switch on) adopts the kept ones and nothing of the stopped ──
  await c.stop()
  c = await open({ WALNUT_DAEMON_KEEP_SESSIONS: '1' })
  const keep = sid(7)
  const kept = await start(c, keep, data)
  const keepPid = kept.pid as number
  recorded.push(keepPid)
  const keepAcp = sid(14)
  out.keepAcpStart = pick(await acpStart(c, keepAcp, data), 'ok', 'error')
  const keepAcpPid = (JSON.parse(fs.readFileSync(path.join(daemonDir, 'acp-workers.json'), 'utf8')) as Record<string, { pid: number }>)[keepAcp]?.pid
  if (keepAcpPid) recorded.push(keepAcpPid)
  await c.stop()
  out.keptAliveAcrossStop = alive(keepPid) && !!keepAcpPid && groupAlive(keepAcpPid)
  c = await open({ WALNUT_DAEMON_KEEP_SESSIONS: '1' })
  const list = (await c.rpc('list')).sessions as Array<{ sid: string; alive: boolean }>
  out.adoptedAlive = list.filter((r) => r.alive).map((r) => r.sid).sort()
  out.stoppedStatus = pick(await c.rpc('status', { sid: s1 }), 'exists', 'alive')
  out.acpKeptState = pick(await c.rpc('acpState', { sid: keepAcp }), 'ok', 'errorKind')
  out.acpStoppedState = pick(await c.rpc('acpState', { sid: r1 }), 'ok', 'errorKind')
  out.acpRowsAfterRestart = acpRows().sort()
  // A tick of supervision after the restart starts nothing (the stopped session's record stays off).
  await sleep(500)
  out.supervisionAfterRestart = (await c.rpc('cron.supervision', { sid: s1 })).cronSupervision ?? null
  // The kept ones end through the same stop.
  out.keepStop = pick(await c.rpc('stop', { sid: keep, reason: 'leader_switch', stopRequestId: fence(7), home: data }), 'ok', 'stopped')
  out.keepAcpStop = pick(await c.rpc('stop', { sid: keepAcp, reason: 'leader_switch', stopRequestId: fence(14), home: data }), 'ok', 'stopped', 'kind')
  out.keptGone = !alive(keepPid) && !!keepAcpPid && !groupAlive(keepAcpPid)
} catch (err) {
  out.error = (err as Error).stack ?? String(err)
} finally {
  try { await c.stop() } catch (err) { out.stopError = String(err) }
  const left: number[] = []
  for (const pid of recorded) {
    if (await waitFor(() => !alive(pid), 5_000)) continue
    left.push(pid)
    if (runsOurScript(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  }
  out.leftover = left
}
process.stdout.write(JSON.stringify(out) + '\n')
process.exit(0)
