/**
 * The cross-machine rehearsal (a) (docs/reference/leader-switch.md, "Rehearsal (a)"): the switch between
 * two machines of remote-world.ts, every process real (servers, daemons, the companion, a host replica),
 * only the Claude CLI mocked. The switch command runs on the machine that leads; the new leader's job runs
 * on its machine, started over the copy link (A's link to B's daemon); every check reads what each machine
 * has on its own disk. One world for the whole run: each scenario starts from "one machine leads, the other
 * holds its standby copy", and each switch that completes turns the roles round for the next.
 *
 * Printed per scenario: one line per check (PASS/FAIL, its evidence in brackets), and the measured times.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import YAML from 'yaml'
import { compareKept, describeKept, snapshotHome } from '../../src/core/home-manifest/home-kept.js'
import { readMayAct, readMarker, type MayActLine } from '../../src/core/leader/switch/records.js'
import { readSwitchState, readTargetState, type SwitchState, type TargetState } from '../../src/core/leader/switch/flow.js'
import { witnessDir } from '../../src/core/leader/switch/witness-route.js'
import { instanceIdAt } from '../../src/core/device-store.js'
import { Checks, KILL_POINTS, checkCarried, checkOneLeader, checkNoOldPaths, cronDoorCalls, seed, serverLog, startLoad, status, waitFor, waitForBatch, writeFiller, type Check, type FillerPlace, type Seeded } from './rehearsal.js'
import { inProcessDaemonLabel, makeRemoteWorld, type InProcessDaemonSetting, type RemoteWorld } from './remote-world.js'
import { REPO, type Machine } from './world.js'
import { parseSwitchSettings } from '../../src/core/leader/switch/settings.js'
import { handOffLine } from '../../src/core/leader/switch/candidate-command.js'
import { machineIdFile } from '../../src/core/machine-id.js'
import { RELAY_BEGIN_PATH, RELAY_JOB_PATH, relayMachine, leaderRelaySocketPath, relayRequest, relaySocketOpener } from '../../src/core/leader/switch/leader-relay.js'
import { RELAY_SOCKET_MAX_BYTES } from '../../src/lib/leader-relay-names.js'
import { newSwitchId } from '../../src/core/leader/switch/ticket.js'
import { retakeAfterRestartMs } from '../../src/core/leader/switch/runtime.js'
import { DEFAULT_PERMIT_PARAMS, type PermitParams } from '../../src/core/leader/permit/types.js'
import { witnessHoldMs } from '../../src/core/leader/permit/rules.js'
import { computeExpectedDaemonVersion } from '../../src/providers/daemon-version-check.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const last = (out: string, n = 3) => out.trim().split('\n').slice(-n).join(' | ')

type Held = { number: number; holder: string; kind: string; to?: string; by?: string; nonce?: string } | null
function recordAt(root: string, walnutId: string, id: string): Held {
  try { return (JSON.parse(fs.readFileSync(path.join(witnessDir(root, walnutId, id), 'permit-record.json'), 'utf8')) as { held: Held }).held } catch { return null }
}

/** Who leads now and who holds its standby copy. */
interface Roles { leader: Machine; other: Machine }

export interface RemoteResult { checks: Checks; times: Record<string, string>; inProcessDaemon: string }

/** The pid of session `sid`'s CLI in a daemon dir's registry (sessions.json), or null. */
function cliPidOf(daemonDir: string, sid: string): number | null {
  let doc: unknown
  try { doc = JSON.parse(fs.readFileSync(path.join(daemonDir, 'sessions.json'), 'utf8')) } catch { return null }
  let found: number | null = null
  const walk = (x: unknown, key?: string): void => {
    if (found !== null || !x || typeof x !== 'object') return
    const o = x as Record<string, unknown>
    if ((o.sid === sid || o.sessionId === sid || o.id === sid || key === sid) && typeof o.pid === 'number') { found = o.pid; return }
    for (const [k, v] of Object.entries(o)) walk(v, Array.isArray(x) ? undefined : k)
  }
  walk(doc)
  return found
}
/**
 * The session identity a switch command carries when an agent runs it (an agent session's id and task dir,
 * CLAUDECODE): the main switch runs with it, and no process the jobs start may inherit it (side.ts cleanStartEnv).
 */
const JOB_SESSION_ENV = { WALNUT_SESSION_ID: 'rehearsal-job-session', WALNUT_TASK_DIR: '/rehearsal/job-task-dir', CLAUDECODE: '1' }
/** A process's env as the kernel holds it (Linux), or null where there is no /proc. */
function envOfPid(pid: number | null | undefined): Record<string, string> | null {
  if (!pid) return null
  try {
    const env: Record<string, string> = {}
    for (const kv of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const i = kv.indexOf('=')
      if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1)
    }
    return env
  } catch { return null }
}
/** The job's session identity found in a process's env: the names, none when clean. */
const jobIdentityIn = (env: Record<string, string>): string[] => Object.keys(JOB_SESSION_ENV).filter((k) => k in env)

/**
 * Which daemon shape the servers of one machine ran, from their own logs (every server and standby of a
 * machine logs into its daemon dir): how many times a server started the daemon in its own process, and how
 * many times one used a daemon program (its `local daemon ready` with a port).
 */
function daemonShapes(daemonDir: string): { inProcess: number; program: number } {
  let inProcess = 0
  let program = 0
  let names: string[] = []
  try { names = fs.readdirSync(daemonDir).filter((f) => /^open-walnut-.*\.log$/.test(f)) } catch { /* none yet */ }
  for (const f of names) {
    for (const line of fs.readFileSync(path.join(daemonDir, f), 'utf8').split('\n')) {
      if (line.includes('"message":"in-process daemon started"')) inProcess++
      else if (line.includes('"message":"local daemon ready"') && /"port":\d+/.test(line)) program++
    }
  }
  return { inProcess, program }
}
const pidAlive = (pid: number | null) => { if (!pid || pid <= 1) return false; try { process.kill(pid, 0); return true } catch { return false } }

/** The switch command on the machine that leads: its own process, with that machine's environment. */
async function switchCmd(w: RemoteWorld, from: Machine, args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string; state: SwitchState | null; target: TargetState | null }> {
  const r = await w.cli(from.home, ['leader', 'switch', ...args], { ...from.env, ...env })
  const state = readSwitchState(from.home)
  // The target's state, read on its own machine's disk (an observer's read: no process of the old machine reads it).
  const target = state ? readTargetState(state.standbyDir, state.id) : null
  return { code: r.code, out: r.out, state, target }
}

/** A machine's `--status`, run there. */
async function statusOn(w: RemoteWorld, m: Machine): Promise<Record<string, any> | null> {
  const r = await w.cli(m.home, ['leader', 'switch', '--status'], m.env)
  try { return JSON.parse(r.out.slice(r.out.indexOf('{'))) } catch { return null }
}

/** The target job's end state, as its machine has it (the command on the old machine returns once it reads the commit). */
async function targetDone(st: SwitchState | null): Promise<TargetState | null> {
  if (!st) return null
  return waitFor('the target job to end', async () => { const t = readTargetState(st.standbyDir, st.id); return t && (t.step === 'done' || t.step === 'rolled-back') ? t : null }, 240_000, 500).catch(() => readTargetState(st.standbyDir, st.id))
}

/** Every daemon link the new leader holds: its hosts (H, the old machine) connected, as its /api/hosts/status says. */
async function hostsConnected(w: RemoteWorld, m: Machine, hosts: string[]): Promise<boolean> {
  const r = await w.api(m, 'GET', '/api/hosts/status').catch(() => null)
  const list = (r?.json?.hosts ?? []) as Array<{ host?: string; alias?: string; key?: string; connected?: boolean; state?: string; phase?: string }>
  return hosts.every((h) => list.some((x) => (x.host ?? x.alias ?? x.key) === h && (x.connected === true || x.state === 'connected' || x.phase === 'connected')))
}

/** The mayAct lines of both machines never overlap: at every instant at most one may act. */
function checkNoOverlap(c: Checks, label: string, a: Machine, b: Machine): void {
  const spans = (lines: MayActLine[]) => {
    const out: Array<[number, number]> = []
    let open: number | null = null
    for (const l of lines.filter((x) => x.event !== 'door')) {
      if (l.mayAct && open === null) open = l.t
      if (!l.mayAct && open !== null) { out.push([open, l.t]); open = null }
    }
    if (open !== null) out.push([open, Infinity])
    return out
  }
  const sa = spans(readMayAct(a.home))
  const sb = spans(readMayAct(b.home))
  const both = sa.flatMap(([x1, x2]) => sb.filter(([y1, y2]) => x1 < y2 && y1 < x2).map(([y1, y2]) => `${a.id} ${iso(x1)}..${iso(x2)} with ${b.id} ${iso(y1)}..${iso(y2)}`))
  c.add(`${label}: never two leaders (the mayAct logs of ${a.id} and ${b.id} never overlap)`, both.length === 0, both.length ? both.slice(0, 3).join('; ') : `${sa.length} span(s) on ${a.id}, ${sb.length} on ${b.id}, none at the same time`)
}
const iso = (t: number) => (Number.isFinite(t) ? new Date(t).toISOString() : 'open')

/** A machine's home started by hand after its handover: a standby naming the leader, acting on nothing, its home unchanged. */
async function checkHandedOverByHand(c: Checks, w: RemoteWorld, m: Machine, leader: string, label: string, offline: boolean): Promise<void> {
  // The witnesses out of reach: every door, and this machine's own (its state dir moved away).
  const own = m === w.a ? w.witnessRoot['w-a'] : w.witnessRoot['w-b']
  if (offline) { for (const id of ['w-a', 'w-b', 'w-k'] as const) w.witnessDown(id, true); fs.renameSync(own, `${own}.off`) }
  const before = await snapshotHome(m.home)
  const t0 = Date.now()
  try {
    // A standby the switch started may run there: stop it, as a person restarting the app would.
    await w.side(m).stopServer(10_000)
    const s = await w.byHand(m, label.replace(/[^a-z0-9]+/gi, '-').toLowerCase())
    try {
      const st = s.ok ? await w.api(m, 'GET', '/api/leader/status').catch(() => null) : null
      const j = st?.json
      c.add(`${label}: starts and stays up as a standby naming ${leader}`, s.ok && st?.status === 200 && j?.standby === true && j?.leader === leader && j?.permit?.mayAct === false,
        s.ok ? JSON.stringify({ leader: j?.leader, state: j?.permit?.state, message: j?.message }) : s.logText().split('\n').slice(-4).join(' | '))
      const write = s.ok ? await w.api(m, 'POST', '/api/tasks', { title: 'written on a standby', project: 'Rehearsal' }).catch(() => null) : null
      c.add(`${label}: a write is answered handed_over`, write?.status === 409 && write.json?.code === 'handed_over', `write ${write?.status} ${JSON.stringify(write?.json)?.slice(0, 160)}`)
      await sleep(16_000)
      const doors = readMayAct(m.home).filter((l) => l.t >= t0)
      c.add(`${label}: it reaches no outward door and fires nothing (no line in its door log for a routine period)`, s.ok && doors.length === 0, `${doors.length} line(s) since its start`)
    } finally {
      await s.stop()
    }
  } finally {
    if (offline) { fs.renameSync(`${own}.off`, own); for (const id of ['w-a', 'w-b', 'w-k'] as const) w.witnessDown(id, false) }
  }
  const kept = compareKept(before, await snapshotHome(m.home))
  c.add(`${label}: its home is as before (leader data and machine data, by the manifest's classes)`, kept.ok, describeKept(kept, 8, m.home))
}

/** A turn of a session: started on `on` (default the third host H; `local`: the leader's own daemon), or a message to it. */
async function sessionTurn(w: RemoteWorld, m: Machine, o: { taskId: string; sid?: string; message: string; on?: 'h' | 'local' }): Promise<{ sid: string; ok: boolean; why?: string }> {
  if (!o.sid) {
    const where = o.on === 'local' ? { cwd: path.join(m.dir, 'work') } : { host: w.h.id, cwd: path.join(w.h.dir, 'work') }
    const r = await w.api(m, 'POST', `/api/v1/tasks/${o.taskId}/start`, { ...where, mode: 'bypass', message: o.message })
    if (r.status !== 202) return { sid: '', ok: false, why: `start ${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}` }
    return { sid: r.json.sessionId as string, ok: true }
  }
  const r = await w.api(m, 'POST', `/api/v1/sessions/${o.sid}/messages`, { message: o.message, text: o.message })
  return { sid: o.sid, ok: r.status < 300, ...(r.status < 300 ? {} : { why: `send ${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}` }) }
}

/** Does the CLI transcript of session `sid` on machine `m` (under its HOME's .claude/projects) hold `text`? */
function transcriptHas(m: Machine, sid: string, text: string): boolean {
  const projects = path.join(m.dir, '.claude', 'projects')
  let dirs: string[] = []
  try { dirs = fs.readdirSync(projects) } catch { return false }
  return dirs.some((d) => { try { return fs.readFileSync(path.join(projects, d, `${sid}.jsonl`), 'utf8').includes(text) } catch { return false } })
}

/** How many times each answer of the mock CLI ("echo: <message>") shows in the session's history on `m`. */
async function answersOn(w: RemoteWorld, m: Machine, sid: string): Promise<Map<string, number>> {
  const r = await w.api(m, 'GET', `/api/v1/sessions/${sid}/history`).catch(() => null)
  const counts = new Map<string, number>()
  const walk = (x: unknown): void => {
    if (typeof x === 'string') { for (const hit of x.match(/echo: [A-Za-z0-9 -]+/g) ?? []) counts.set(hit.trim(), (counts.get(hit.trim()) ?? 0) + 1); return }
    if (Array.isArray(x)) { for (const y of x) walk(y); return }
    if (x && typeof x === 'object') for (const v of Object.values(x)) walk(v)
  }
  const msgs = (r?.json?.messages ?? r?.json?.history ?? r?.json ?? []) as unknown[]
  for (const msg of Array.isArray(msgs) ? msgs : []) {
    const m2 = msg as { role?: string; type?: string; content?: unknown; text?: unknown }
    if (m2.role === 'user' || m2.type === 'user') continue
    walk(m2.content ?? m2.text)
  }
  return counts
}

/** The built daemon every machine here runs (remote-world.ts startHostDaemon 'standalone', built) against its source's hash. */
function builtDaemon(): { ok: boolean; why: string } {
  const file = path.join(REPO, 'dist', 'daemon-binaries', `daemon-${process.platform}-${process.arch}.version`)
  const built = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null
  const source = computeExpectedDaemonVersion()
  return { ok: !!built && built === source, why: `built ${built ?? 'none'}, source ${source ?? 'unknown'}${built !== source ? ' (bash scripts/build-daemon.sh)' : ''}` }
}

export async function rehearseRemote(root: string, print: (c: Check) => void, opts: { portA: number; portB: number; fillerGb?: number; filler?: FillerPlace; log?: (s: string) => void; only?: string[]; inProcessDaemon?: InProcessDaemonSetting }): Promise<RemoteResult> {
  const log = opts.log ?? (() => {})
  const c = new Checks(print)
  const times: Record<string, string> = {}
  const setting = opts.inProcessDaemon ?? 'default'
  const inProcessDaemon = inProcessDaemonLabel(setting)
  // A daemon built from older source would rehearse that one: nothing runs on a stale build.
  const daemon = builtDaemon()
  if (!c.add('boot: the built daemon every machine runs is built from this source', daemon.ok, daemon.why)) return { checks: c, times, inProcessDaemon }
  const w = await makeRemoteWorld(root, { portA: opts.portA, portB: opts.portB, log, inProcessDaemon: setting })
  const roles: Roles = { leader: w.a, other: w.b }
  const want = (name: string) => !opts.only?.length || opts.only.includes(name)
  try {
    // A work dir too deep for the leader relay's unix socket: every machine's service refuses to serve the relay (its
    // `.sock.why` says so), and the forwarded scenario fails for that alone (the lead's 2026-11-26 run, 177 bytes).
    const deep = (['a', 'b', 'h'] as const).map((k) => leaderRelaySocketPath(w.daemons[k].dir, 'any')).filter((p) => Buffer.byteLength(p) > RELAY_SOCKET_MAX_BYTES)
    if (!c.add(`boot: the work dir is short enough for the leader relay's socket (${RELAY_SOCKET_MAX_BYTES} bytes at most)`, deep.length === 0,
      deep.length ? `${Buffer.byteLength(deep[0]!)} bytes: ${deep[0]}; use a shorter work dir` : '')) return { checks: c, times, inProcessDaemon }
    if (want('flag-off')) await flagOff(c, w)
    // ---- boot: A leads on the three witnesses (init sets them up as an operator runs it) ----
    const started = await w.side(w.a).startServer('leader', 300_000)
    if (!c.add('boot: A starts (non-ephemeral, its own daemon, its links to B and H through proxies)', started.ok, started.why ?? '')) return { checks: c, times, inProcessDaemon }
    const walnutId = (await instanceIdAt(w.a.home))!
    await w.startServiceB(walnutId)
    const init1 = await w.cli(w.a.home, ['leader', 'witnesses', 'init'], w.a.env)
    log(init1.out)
    const leads = await waitFor('A to lead', async () => (await status(w, w.a))?.mayAct, 120_000).catch(() => false)
    const init2 = await w.cli(w.a.home, ['leader', 'witnesses', 'init'], w.a.env)
    log(init2.out)
    const allThree = await waitFor('the three witnesses to hold A', async () => (['w-a', 'w-b', 'w-k'] as const).every((id) => recordAt(w.witnessRoot[id], walnutId, id)?.holder === w.a.id), 120_000).then(() => true).catch(() => false)
    if (!c.add('boot: init sets up w-a and w-k from nothing, A leads, init again adds w-b over A\'s link to B\'s service; all three hold A', leads === true && init2.code === 0 && allThree,
      `init 1 exit ${init1.code}, init 2 exit ${init2.code}: ${last(init2.out, 4)}`)) return { checks: c, times, inProcessDaemon }
    if (opts.fillerGb) await writeFiller(w.a.home, opts.fillerGb, log, opts.filler)
    const s = await seed(w, w.a, 8)
    c.add('boot: seed on A (tasks, notes, a plugin file, a routine)', s.tasks.length === 8 && !!s.cronId)
    const t0 = Date.now()
    const b1 = await waitForBatch(w.b.standbyDir, t0, opts.fillerGb ? 7_200_000 : 180_000).catch(() => 0)
    times['first standby batch over the copy link'] = `${((Date.now() - t0) / 1000).toFixed(1)} s`
    c.add('boot: A\'s standby batches reach B\'s standby folder over A\'s link to B\'s daemon (standby.host)', b1 > 0, `batch ${b1}; ${w.links.copy.accepted()} connection(s) through the copy link`)

    const ctx: Ctx = { c, w, roles, carried: { tasks: [...s.tasks], notes: [...s.notes], pluginFiles: [...s.pluginFiles] }, times, log }
    // The command run on B while B is no host of A yet (no host service of this Walnut there): refused, naming A.
    if (want('forwarded')) await forwardNoLink(ctx)
    if (want('main')) {
      await mainScenario(c, w, roles, s, times, log, setting)
      await everyWitnessHoldsLeader(ctx, 'main', walnutId)
    }
    for (const [name, run] of SCENARIOS) {
      if (!want(name)) continue
      log(`--- ${name}: ${roles.leader.id} leads, ${roles.other.id} holds its copy`)
      await run(ctx).catch((err: unknown) => { c.add(`${name}: ran to its end`, false, err instanceof Error ? err.stack ?? err.message : String(err)) })
      await everyWitnessHoldsLeader(ctx, name, walnutId)
    }
    return { checks: c, times, inProcessDaemon }
  } catch (err) {
    c.add('the rehearsal ran to its end', false, err instanceof Error ? err.stack ?? err.message : String(err))
    return { checks: c, times, inProcessDaemon }
  } finally {
    await w.stop().catch(() => {})
  }
}

/** A to B under load, every B2a check with the witnesses and the other side remote, the third host's session, and back. */
async function mainScenario(c: Checks, w: RemoteWorld, roles: Roles, s: Seeded, times: Record<string, string>, log: (s: string) => void, setting: InProcessDaemonSetting): Promise<void> {
  const inProcess = setting !== 'off'
  const A = roles.leader
  const B = roles.other
  // A session on H, started through A: its first answer.
  const task = await w.api(A, 'POST', '/api/tasks', { title: 'Session on the third host', project: 'Rehearsal' })
  const first = await sessionTurn(w, A, { taskId: task.json?.task?.id, message: 'ROUND one on A' })
  const answeredA = first.ok ? await waitFor('the first answer through A', async () => ((await answersOn(w, A, first.sid)).get('echo: ROUND one on A') ?? 0) > 0, 120_000).then(() => true).catch(() => false) : false
  c.add('main: a session on H started through A answers', answeredA, first.why ?? first.sid)
  // A session on A's own daemon: after the switch A is a host of B, and the session is B's on host machine-a.
  const localTask = await w.api(A, 'POST', '/api/tasks', { title: 'Session on the old leader\'s own daemon', project: 'Rehearsal' })
  const own = await sessionTurn(w, A, { taskId: localTask.json?.task?.id, message: 'ROUND own on A', on: 'local' })
  const answeredOwn = own.ok ? await waitFor('the own-daemon answer through A', async () => ((await answersOn(w, A, own.sid)).get('echo: ROUND own on A') ?? 0) > 0, 120_000).then(() => true).catch(() => false) : false
  c.add('main: a session on A\'s own daemon answers', answeredOwn, own.why ?? own.sid)
  // Its CLI, by the registry of A's daemon: the switch stop must neither kill it nor leave it with nobody watching.
  const ownPid = cliPidOf(w.daemons.a.dir, own.sid)
  const leaderStatus = (await w.api(A, 'GET', '/api/leader/status').catch(() => null))?.json as { daemonInProcess?: boolean } | null
  c.add(`main: A's server runs its machine's daemon ${inProcess ? 'in its own process' : 'as a program of its own'}`, leaderStatus?.daemonInProcess === inProcess && !!ownPid,
    `daemonInProcess ${leaderStatus?.daemonInProcess}; the own-daemon session's CLI pid ${ownPid}`)
  const late = { rel: 'plugins/rehearsal-plugin/data/late.json', content: JSON.stringify({ late: randomBytes(4).toString('hex') }) }
  fs.writeFileSync(path.join(A.home, late.rel), late.content)
  await waitForBatch(B.standbyDir, Date.now(), 120_000)
  // The routine fires on A before the switch (each slot once in total is checked across it, below).
  const firedA = await waitFor('a routine slot on A', async () => cronDoorCalls(A.home).some((l) => l.mayAct), 90_000, 500).then(() => true).catch(() => false)
  c.add('main: the routine fires on A before the switch', firedA)
  const load = startLoad(w, A)
  await waitFor('the load acknowledged on A', async () => load.acked.length > 0, 60_000, 100).catch(() => {})
  const sw = await switchCmd(w, A, ['--to', B.id], JOB_SESSION_ENV)
  const acked = await load.stop()
  log(sw.out)
  const tgt = await targetDone(sw.state)
  // From here B leads: A opens no new connection to B's daemon (the copy link) or to H's (B drives H now).
  const fromA = { copy: w.links.copy.accepted(), aToH: w.links.aToH.accepted() }
  if (!c.add('main: switch A -> B completes (the command on A, the target job on B over the copy link)', sw.code === 0 && sw.state?.step === 'done' && tgt?.step === 'done', `exit ${sw.code}; target ${tgt?.step}; ${last(sw.out, 4)}`)) return
  times['downtime A -> B, copy link unslowed'] = `${((tgt?.downtimeMs ?? NaN) / 1000).toFixed(1)} s`
  c.add('main: B leads with the write permission', !!(await status(w, B))?.mayAct)
  c.add('main: the target job ran on B (its state and log in B\'s standby folder, started by B\'s daemon)', !!tgt && fs.existsSync(path.join(B.standbyDir, 'switch', `${tgt.id}.state.json`)))
  await checkCarried(c, w, B, A, { tasks: [...s.tasks, ...acked], notes: [...s.notes, ...load.notes], pluginFiles: [...s.pluginFiles, late] }, 'main A -> B')
  c.add('main: load ran across the switch', acked.length > 0, `${acked.length} tasks acknowledged by A during the switch`)
  checkNoOldPaths(c, B, A, 'main A -> B')
  // Nothing sent twice: A's last ops replayed on B apply none twice; no one-operation door on both machines.
  const before = (await w.api(B, 'GET', '/api/tasks?project=Rehearsal%20load')).json?.tasks?.length ?? -1
  let replayed = 0
  for (const t of acked.slice(-5)) {
    const r = await w.api(B, 'POST', '/api/tasks', { title: t.title, project: 'Rehearsal load' }, t.opId)
    if (r.headers.get('x-walnut-op-replayed') === '1' && r.json?.task?.id === t.id) replayed++
  }
  const after = (await w.api(B, 'GET', '/api/tasks?project=Rehearsal%20load')).json?.tasks?.length ?? -2
  c.add('main: nothing sent twice (A\'s last accepted ops replayed on B apply none twice)', replayed === Math.min(5, acked.length) && before === after, `${replayed} replays; tasks ${before} -> ${after}`)
  checkOneLeader(c, 'main A -> B', A, B, { stoppedAt: tgt?.stoppedAt, startedAt: sw.state?.startedAt })
  // Hosts follow: H and the old machine A connected to B.
  const tHosts = Date.now()
  const followed = await waitFor('every host connected to B', async () => hostsConnected(w, B, [w.h.id, A.id]), 180_000, 1_000).then(() => true).catch(() => false)
  const sinceDone = tgt?.readyAt ? Date.now() - Date.parse(tgt.readyAt) : NaN
  times['every host connected to the new leader after done'] = followed ? `${(sinceDone / 1000).toFixed(1)} s (waited ${((Date.now() - tHosts) / 1000).toFixed(1)} s after the command returned)` : 'not within 180 s'
  c.add('main: every host (H, and the old machine A) is connected to B', followed, JSON.stringify((await w.api(B, 'GET', '/api/hosts/status').catch(() => null))?.json?.hosts?.map((x: any) => ({ h: x.host ?? x.alias ?? x.key, c: x.connected ?? x.state ?? x.phase })) ?? null))
  // A's sessions across the switch stop: the standby of A's home holds the machine's runtime again when A's server
  // held it in process (web/standby-service.ts), so the CLI is the same process and is watched again.
  const standbyA = (await w.api(A, 'GET', '/api/leader/status').catch(() => null))?.json as { standby?: boolean; sessionRuntime?: { held?: string | false; why?: string } | null } | null
  c.add(`main: A's standby ${inProcess ? 'holds A\'s session runtime in its own process' : 'holds no runtime (A\'s daemon program outlived the server)'}`,
    standbyA?.standby === true && (inProcess ? standbyA.sessionRuntime?.held === 'in-process' : standbyA.sessionRuntime?.held === false), JSON.stringify(standbyA?.sessionRuntime ?? null))
  // The standby A's source job started booted with a clean env: the switch command carried an agent's session
  // identity, which the standby's runtime and every CLI it starts must not inherit.
  if (process.platform === 'linux') {
    const sbPid = w.side(A).standbyServer()?.pid
    const sbEnv = envOfPid(sbPid)
    c.add('main: the standby A\'s source job started boots on a clean env (the switch command\'s session identity is not in it; the machine\'s env is)',
      standbyA?.standby === true && !!sbEnv && jobIdentityIn(sbEnv).length === 0 && sbEnv.WALNUT_DAEMON_DIR === w.daemons.a.dir && sbEnv.WALNUT_CAPABILITIES === A.env?.WALNUT_CAPABILITIES,
      `pid ${sbPid}; ${sbEnv ? `job identity found: [${jobIdentityIn(sbEnv).join(', ')}]; WALNUT_DAEMON_DIR ${sbEnv.WALNUT_DAEMON_DIR}` : 'no env read'}`)
  }
  c.add('main: the switch stop did not kill the CLI of the session on A\'s own daemon (the same process, named by A\'s daemon again)',
    pidAlive(ownPid) && cliPidOf(w.daemons.a.dir, own.sid) === ownPid, `pid ${ownPid} alive ${pidAlive(ownPid)}; the registry names ${cliPidOf(w.daemons.a.dir, own.sid)}`)
  // The session on H: its facts on B with no loss and no doubling, and a message right after the switch answered once.
  const onB = await answersOn(w, B, first.sid)
  c.add('main: the session\'s turns made through A are on B once each (no loss, no doubling)', onB.get('echo: ROUND one on A') === 1, JSON.stringify([...onB]))
  const second = await sessionTurn(w, B, { taskId: task.json?.task?.id, sid: first.sid, message: 'ROUND two on B' })
  const answeredB = second.ok ? await waitFor('the answer through B', async () => ((await answersOn(w, B, first.sid)).get('echo: ROUND two on B') ?? 0) > 0, 120_000).then(() => true).catch(() => false) : false
  await sleep(5_000)
  const afterSend = await answersOn(w, B, first.sid)
  c.add('main: a message sent through B right after the switch arrives once', answeredB && afterSend.get('echo: ROUND two on B') === 1 && afterSend.get('echo: ROUND one on A') === 1, `${second.why ?? ''} ${JSON.stringify([...afterSend])}`)
  // The old machine as B's host: the handover's host steps ran on A (its credential, its host service on its own
  // daemon, its daemon's duties dropped), and the session on A's own daemon is B's now, on host machine-a.
  const hostService = (() => { try { return JSON.parse(fs.readFileSync(path.join(A.home, 'local', 'leader-switch', 'host-service.json'), 'utf8')) as { port?: number; hostKey?: string } } catch { return null } })()
  c.add('main: the handover set A up as B\'s host (the host service on A\'s own daemon, recorded beside its home)', !!hostService && hostService.hostKey === A.id && Number.isInteger(hostService.port), JSON.stringify(hostService))
  const adopted = await waitFor('the own-daemon session on B', async () => {
    const r = await w.api(B, 'GET', `/api/v1/sessions/${own.sid}`).catch(() => null)
    const s2 = (r?.json?.session ?? r?.json) as { host?: string | null } | null
    return r?.status === 200 && s2?.host === A.id ? s2 : null
  }, 120_000, 1_000).then(() => true).catch(() => false)
  const ownOnB = await answersOn(w, B, own.sid)
  c.add('main: the session on A\'s own daemon is B\'s now, on host machine-a, its turn there once', adopted && ownOnB.get('echo: ROUND own on A') === 1, JSON.stringify([...ownOnB]))
  const ownSecond = await sessionTurn(w, B, { taskId: localTask.json?.task?.id, sid: own.sid, message: 'ROUND own two on B' })
  const ownAnswered = ownSecond.ok ? await waitFor('the own-daemon answer through B', async () => ((await answersOn(w, B, own.sid)).get('echo: ROUND own two on B') ?? 0) > 0, 120_000).then(() => true).catch(() => false) : false
  await sleep(5_000)
  const ownAfter = await answersOn(w, B, own.sid)
  // Where it ran: the CLI writes the turn into its transcript under its machine's HOME (A's for A's daemon, B's for B's).
  const ran = { a: transcriptHas(A, own.sid, 'ROUND own two on B'), b: transcriptHas(B, own.sid, 'ROUND own two on B') }
  c.add('main: a message to it through B runs on the old machine and arrives once', ownAnswered && ownAfter.get('echo: ROUND own two on B') === 1 && ownAfter.get('echo: ROUND own on A') === 1 && ran.a && !ran.b,
    `${ownSecond.why ?? ''} ${JSON.stringify([...ownAfter])}; the turn in the CLI transcript on machine-a: ${ran.a}, on machine-b: ${ran.b}`)
  // Triggers once: every routine slot through a door on one machine, once.
  await waitFor('a routine slot on B', async () => cronDoorCalls(B.home).some((l) => l.mayAct), 90_000, 500).catch(() => {})
  const slotsA = cronDoorCalls(A.home).filter((l) => l.mayAct).map((l) => l.opId)
  const slotsB = cronDoorCalls(B.home).filter((l) => l.mayAct).map((l) => l.opId)
  const both = slotsA.filter((x) => slotsB.includes(x))
  const dup = [...slotsA, ...slotsB].filter((x, i, all) => all.indexOf(x) !== i)
  c.add('main: the routine fired each slot once in total across the switch', both.length === 0 && dup.length === 0 && slotsA.length > 0 && slotsB.length > 0, `${new Set(slotsA).size} on A, ${new Set(slotsB).size} on B, ${both.length} on both, ${dup.length} repeats`)
  // The companion keeps one primary (`__local__`), for two minutes, held by B's daemon.
  const primaries: string[] = []
  for (let i = 0; i < 24; i++) {
    const r = await fetch(`http://127.0.0.1:${w.companion.port}/api/v1/status`, { headers: { authorization: `Bearer ${w.companion.tokens.mac}` } }).then((x) => x.json()).catch(() => null) as { bridgeHosts?: Array<{ hostAlias: string; since: number }> } | null
    const locals = (r?.bridgeHosts ?? []).filter((x) => x.hostAlias === '__local__')
    primaries.push(locals.map((x) => String(x.since)).join('+') || 'none')
    await sleep(5_000)
  }
  const distinct = [...new Set(primaries)]
  c.add('main: the companion keeps one primary bridge for two minutes after the switch (one __local__, never replaced)', distinct.length === 1 && distinct[0] !== 'none' && !distinct[0]!.includes('+'), `samples of __local__ since: ${distinct.join(', ')}`)
  // The old home started by hand never leads: online, and with every witness out of reach.
  await checkHandedOverByHand(c, w, A, B.id, 'main: A started again by hand after the commit (witnesses online)', false)
  await checkHandedOverByHand(c, w, A, B.id, 'main: A started again by hand with every witness out of reach', true)
  // The switch back carries B's writes: B's copy goes to A over B's link to A's daemon.
  checkIgnoresKept(c, 'main A -> B', B)
  const cfgB = YAML.parse(fs.readFileSync(path.join(B.home, 'config.yaml'), 'utf8')) as { standby?: { dir?: string; host?: string } }
  c.add('main: B\'s standby now goes to A\'s standby folder on A as a host', cfgB.standby?.dir === A.standbyDir && cfgB.standby?.host === A.id, JSON.stringify(cfgB.standby))
  const onBWrites: Seeded['tasks'] = []
  for (let i = 0; i < 5; i++) {
    const title = `written on B ${i} ${randomBytes(3).toString('hex')}`
    const opId = `b-${i}-${randomBytes(4).toString('hex')}`
    const r = await w.api(B, 'POST', '/api/tasks', { title, project: 'Rehearsal' }, opId)
    if (r.status < 300) onBWrites.push({ id: r.json.task.id, title, opId })
  }
  const fromANow = { copy: w.links.copy.accepted(), aToH: w.links.aToH.accepted() }
  c.add('main: once B leads, A opens no new connection to B\'s daemon (the copy link) or to H\'s', fromANow.copy === fromA.copy && fromANow.aToH === fromA.aToH,
    `copy link ${fromA.copy} -> ${fromANow.copy}, A to H ${fromA.aToH} -> ${fromANow.aToH} (from B ready to the switch back)`)
  await w.side(A).startStandby().catch(() => null)
  const batchA = await waitForBatch(A.standbyDir, Date.now(), 180_000).catch(() => 0)
  c.add('main: B\'s batches reach A\'s standby folder over B\'s link to A\'s daemon', batchA > 0, `batch ${batchA}`)
  const back = await switchCmd(w, B, ['--back'])
  log(back.out)
  const tb = await targetDone(back.state)
  if (!c.add('main: switch back B -> A completes', back.code === 0 && back.state?.step === 'done' && tb?.step === 'done', `exit ${back.code}; target ${tb?.step}; ${last(back.out, 4)}`)) return
  times['downtime B -> A (switch back), copy link unslowed'] = `${((tb?.downtimeMs ?? NaN) / 1000).toFixed(1)} s`
  c.add('main: A leads again', !!(await status(w, A))?.mayAct)
  checkIgnoresKept(c, 'main B -> A', A)
  const leaderAgain = (await w.api(A, 'GET', '/api/leader/status').catch(() => null))?.json as { daemonInProcess?: boolean } | null
  c.add(`main: after the switch back A's server runs the daemon ${inProcess ? 'in its own process again' : 'as a program of its own still'}, and the session's CLI is the same process`,
    leaderAgain?.daemonInProcess === inProcess && pidAlive(ownPid) && cliPidOf(w.daemons.a.dir, own.sid) === ownPid, `daemonInProcess ${leaderAgain?.daemonInProcess}; pid ${ownPid} alive ${pidAlive(ownPid)}; the registry names ${cliPidOf(w.daemons.a.dir, own.sid)}`)
  await checkCarried(c, w, A, B, { tasks: [...s.tasks, ...acked, ...onBWrites], notes: s.notes, pluginFiles: [...s.pluginFiles, late] }, 'main B -> A')
  checkOneLeader(c, 'main B -> A', B, A, { stoppedAt: tb?.stoppedAt, startedAt: back.state?.startedAt })
  // What each machine's servers really ran (the target's servers are started by its daemon's job with the
  // machine's env, and read the setting from the home they boot on): the setting of this run, on both machines.
  const shapes = { a: daemonShapes(w.daemons.a.dir), b: daemonShapes(w.daemons.b.dir) }
  c.add(`main: every server of A and of B ran the daemon ${inProcess ? 'in its own process' : 'as a program of its own'} (their logs)`,
    inProcess ? shapes.a.inProcess > 0 && shapes.b.inProcess > 0 && shapes.a.program === 0 && shapes.b.program === 0
      : shapes.a.inProcess === 0 && shapes.b.inProcess === 0 && shapes.a.program > 0 && shapes.b.program > 0, JSON.stringify(shapes))
  c.add('main: A\'s handed-over home is kept beside the new one', fs.existsSync(`${A.home}.before-${back.state!.id}`) && readMarker(`${A.home}.before-${back.state!.id}`)?.state === 'handed-over')
}

// ---- the matrix: each scenario from "roles.leader leads, roles.other holds its copy" ----

interface Ctx { c: Checks; w: RemoteWorld; roles: Roles; carried: { tasks: Seeded['tasks']; notes: Seeded['notes']; pluginFiles: Seeded['pluginFiles'] }; times: Record<string, string>; log: (s: string) => void }

/** The kill points in the target job (on the new leader's machine): resumed there by hand; the rest in the source job, resumed with --resume. */
const TARGET_KILLS = new Set<string>(['during-wait-mark', 'during-promote', 'after-promote', 'during-trial', 'after-commit-majority', 'after-commit'])
/** The step each kill point dies in: the target job's state (target-job.ts), or the source job's (source-job.ts). */
const KILL_STEP: Record<typeof KILL_POINTS[number], string> = {
  'during-wait-mark': 'wait-mark', 'after-handover': 'stop-source', 'during-final-batch': 'stop-source', 'during-promote': 'promote',
  'after-promote': 'trial', 'during-trial': 'trial', 'after-commit-majority': 'commit', 'after-commit-seen': 'wait-target', 'after-commit': 'start-target',
}

/** The machine's key in the world, for its links. */
const keyOf = (w: RemoteWorld, m: Machine): 'a' | 'b' => (m === w.a ? 'a' : 'b')
const ownWitness = (w: RemoteWorld, m: Machine): 'w-a' | 'w-b' => (m === w.a ? 'w-a' : 'w-b')
const otherWitness = (w: RemoteWorld, m: Machine): 'w-a' | 'w-b' => (m === w.a ? 'w-b' : 'w-a')

/** A few writes on the leader the next switch must carry; and a fresh batch at the other machine. */
async function writeAndBatch(x: Ctx, label: string, batchWaitMs = 180_000): Promise<void> {
  const { w, roles } = x
  for (let i = 0; i < 3; i++) {
    const title = `${label} ${i} ${randomBytes(3).toString('hex')}`
    const opId = `${label}-${i}-${randomBytes(4).toString('hex')}`.replace(/[^A-Za-z0-9-]/g, '-')
    const r = await w.api(roles.leader, 'POST', '/api/tasks', { title, project: 'Rehearsal' }, opId)
    if (r.status < 300) x.carried.tasks.push({ id: r.json.task.id, title, opId })
  }
  await waitForBatch(roles.other.standbyDir, Date.now(), batchWaitMs)
}

/** The resume a person runs on the new leader's machine for a target job that died there: its own job, its own env. */
async function resumeTargetOn(w: RemoteWorld, m: Machine, st: SwitchState): Promise<{ code: number | null; out: string }> {
  return w.cli(m.home, ['leader', 'switch', '--job', 'target', '--switch', st.id, '--standby-dir', st.standbyDir], m.env)
}

/** A target job that died on its machine (its state there, no job holding its lock), or null within `ms`. */
async function deadTarget(w: RemoteWorld, from: Machine, ms: number): Promise<SwitchState | null> {
  const { targetJobRunning } = await import('../../src/core/leader/switch/target-job.js')
  return waitFor('the target job to die', async () => {
    const st = readSwitchState(from.home)
    if (!st) return null
    const t = readTargetState(st.standbyDir, st.id)
    return t && t.step !== 'done' && t.step !== 'rolled-back' && !targetJobRunning(st.standbyDir, st.id) ? st : null
  }, ms, 500).catch(() => null)
}

/** Exactly one machine may act (waiting up to `ms` for the expected one), and their mayAct logs never overlapped. */
async function oneLeader(x: Ctx, label: string, expected: Machine, ms = 150_000): Promise<boolean> {
  const { c, w } = x
  const ok = await waitFor(`${expected.id} to act`, async () => (await status(w, expected))?.mayAct, ms).then(() => true).catch(() => false)
  const sa = await status(w, w.a)
  const sb = await status(w, w.b)
  const leaders = [sa?.mayAct ? w.a.id : null, sb?.mayAct ? w.b.id : null].filter(Boolean)
  c.add(`${label}: exactly one leader, ${expected.id}`, ok && leaders.length === 1 && leaders[0] === expected.id, `A ${JSON.stringify(sa)}, B ${JSON.stringify(sb)}`)
  checkNoOverlap(c, label, w.a, w.b)
  return ok
}

/** The switch leader -> other: the command on the leader; `during` runs while it runs; roles turn round when it completed. */
async function runSwitch(x: Ctx, label: string, o: { env?: Record<string, string>; during?: (from: Machine, to: Machine) => Promise<void> } = {}): Promise<{ code: number | null; out: string; state: SwitchState | null; target: TargetState | null }> {
  const { w, roles } = x
  const from = roles.leader
  const to = roles.other
  const run = switchCmd(w, from, ['--to', to.id], o.env)
  if (o.during) await o.during(from, to)
  const r = await run
  x.log(`${label}:\n${r.out}`)
  // A source job that died (exit 4) is resumed by the caller at once: waiting for the target job first would
  // outlast the old leader's stop wait, and its server would take the handover back before the resume.
  if (r.code === 4 && !o.during) return r
  const t = await targetDone(r.state)
  r.target = t
  if (r.state?.step === 'done' && t?.step === 'done') { roles.leader = to; roles.other = from }
  return r
}

// ---- the command on the machine that will lead (candidate-command.ts, leader-relay.ts) ----

/** That machine's leader relay socket: its host service of this Walnut listens there (replica/leader-relay-entry.ts). */
const relaySocketOf = (w: RemoteWorld, m: Machine): string => leaderRelaySocketPath(w.daemons[keyOf(w, m)].dir, w.walnutId)

/** The command on the machine that does not lead: `--to` itself, its standby folder, its own environment. */
function candidateCmd(w: RemoteWorld, m: Machine): ReturnType<RemoteWorld['cli']> {
  return w.cli(m.home, ['leader', 'switch', '--to', m.id, '--standby-dir', m.standbyDir], m.env)
}

/** Run on the other machine while it is no host of the leader: refused by name, nothing changes on either machine. */
async function forwardNoLink(x: Ctx): Promise<void> {
  const { c, w, roles } = x
  const L = roles.leader
  const O = roles.other
  const before = readSwitchState(L.home)?.id ?? null
  const r = await candidateCmd(w, O)
  x.log(`forwarded, no link:\n${r.out}`)
  c.add(`forwarded: the command run on ${O.id} with no link to the leader refuses, naming the machine to run it on`,
    r.code === 1 && r.out.includes(`no link to the leader ${L.id}`) && r.out.includes(`run \`walnut leader switch --to ${O.id}\` on ${L.id}`), `exit ${r.code}: ${last(r.out, 2)}`)
  c.add('forwarded: and changes nothing (no switch on the leader, no marker, the leader still leads)',
    (readSwitchState(L.home)?.id ?? null) === before && !readMarker(L.home) && !!(await status(w, L))?.mayAct && !fs.existsSync(relaySocketOf(w, O)))
}

/** The command run on the machine that will lead: refused forwards over its host link, then the switch it begins there. */
async function forwarded(x: Ctx): Promise<void> {
  const { c, w } = x
  // That machine is a host of the leader once it was the old machine of a switch (its host service follows the new leader).
  if (!fs.existsSync(relaySocketOf(w, x.roles.other))) {
    await writeAndBatch(x, 'fwd-prep')
    const r = await runSwitch(x, 'forwarded: a switch first')
    if (!c.add(`forwarded: a switch first, so ${x.roles.other.id} is the new leader's host`, r.code === 0 && r.target?.step === 'done', `exit ${r.code}: ${last(r.out, 3)}`)) return
  }
  const L = x.roles.leader
  const O = x.roles.other
  const sock = relaySocketOf(w, O)
  const open = relaySocketOpener(sock)
  // The socket is there once the host service follows; it carries a request once the leader's server has linked to
  // that machine's daemon. The relay door's own answers tell it from any other door: its whoami names the leader, and
  // an unknown switch's job is its own 404 (the tunnel port's web server knows neither).
  const up = await waitFor(`${O.id}'s leader relay`, async () => fs.existsSync(sock) && (await relayMachine(open)) === L.id, 120_000, 1_000).then(() => true).catch(() => false)
  const job404 = up ? await relayRequest(open, 'GET', `${RELAY_JOB_PATH}?switchId=none&from=0`, undefined, 5_000).catch(() => null) : null
  if (!c.add(`forwarded: ${O.id}'s host service of this Walnut serves the leader relay (its socket, 0600), and what answers over it is ${L.id}'s relay door`,
    up && (fs.statSync(sock).mode & 0o777) === 0o600 && job404?.status === 404 && /began no switch none for another machine/.test(String((job404.json as { why?: string } | null)?.why)), `${sock}; whoami ${up ? L.id : 'none'}; job ${job404?.status} ${JSON.stringify(job404?.json ?? null)}`)) return
  // Refused forwards over that very link: nothing changes.
  const before = readSwitchState(L.home)?.id ?? null
  const notListed = await relayRequest(open, 'POST', RELAY_BEGIN_PATH, { to: w.h.id, switchId: newSwitchId() }, 60_000).catch((err: Error) => ({ status: 0, json: { why: err.message } }))
  const toLeader = await relayRequest(open, 'POST', RELAY_BEGIN_PATH, { to: L.id, switchId: newSwitchId() }, 60_000).catch((err: Error) => ({ status: 0, json: { why: err.message } }))
  const why = (r: { json: unknown }) => String((r.json as { why?: string } | null)?.why ?? '')
  c.add(`forwarded: ${L.id} refuses a begin over ${O.id}'s link for a machine not in leader_switch.machines`, notListed.status === 403 && /not in leader_switch.machines/.test(why(notListed)), `${notListed.status} ${why(notListed)}`)
  c.add(`forwarded: ${L.id} refuses a begin over ${O.id}'s link to itself (it leads already)`, toLeader.status === 403 && /leads already/.test(why(toLeader)), `${toLeader.status} ${why(toLeader)}`)
  // The trust rule on the real link: the leader's config made to name another host as ${O.id}'s (its host_key), so this
  // link is ${O.id}'s by neither name: not by this leader's key of it, not by the machine id its daemon said in its
  // hello (that account's own id, not the permit's readable name here). A body that claims to be ${O.id} counts for nothing.
  const cfgFile = path.join(L.home, 'config.yaml')
  const saved = fs.readFileSync(cfgFile, 'utf8')
  const cfg = YAML.parse(saved) as { leader_switch: { machines: Array<{ id: string; host_key?: string }> } }
  for (const m of cfg.leader_switch.machines) if (m.id === O.id) m.host_key = `not-${O.id}`
  fs.writeFileSync(cfgFile, YAML.stringify(cfg))
  const notTheirs = await relayRequest(open, 'POST', RELAY_BEGIN_PATH, { to: O.id, switchId: newSwitchId(), from: O.id, machineId: O.id, hostKey: O.id, startedBy: { machine: O.id, via: 'forwarded' } }, 60_000)
    .catch((err: Error) => ({ status: 0, json: { why: err.message } }))
    .finally(() => fs.writeFileSync(cfgFile, saved))
  const helloId = (() => { try { return fs.readFileSync(machineIdFile(O.dir), 'utf8').trim() } catch { return '?' } })()
  c.add(`forwarded: ${L.id} refuses a begin for ${O.id} over a link that is not ${O.id}'s (its key and its hello's machine id, read off the link itself)`,
    notTheirs.status === 403 && why(notTheirs) === `a switch begun from another machine is taken only from the machine it goes to (${O.id}), not from ${helloId} (host ${O.id})`, `${notTheirs.status} ${why(notTheirs)} (hello id ${helloId})`)
  c.add('forwarded: a refused forward changes nothing (no switch on the leader, no marker, it still leads)',
    (readSwitchState(L.home)?.id ?? null) === before && !readMarker(L.home) && !!(await status(w, L))?.mayAct)
  await writeAndBatch(x, 'forwarded')
  const r = await candidateCmd(w, O)
  x.log(`forwarded:\n${r.out}`)
  // The command ends with its own target job; the source job on the old leader's machine ends its hand-off on its own
  // (nothing on this machine follows it once that machine's server stopped): wait for it as the command there would.
  const began = readSwitchState(L.home)
  const st = began && began.id !== before
    ? await waitFor(`the source job on ${L.id}`, async () => { const s = readSwitchState(L.home); return s && (s.step === 'done' || s.step === 'rolled-back') ? s : null }, 120_000, 500).catch(() => readSwitchState(L.home))
    : began
  const t = st && st.id !== before ? await targetDone(st) : null
  const done = r.code === 0 && st?.step === 'done' && t?.step === 'done'
  c.add(`forwarded: the command run on ${O.id} switches to it (its check there, the begin over its host link, the source job started on ${L.id} by its server)`, done, `exit ${r.code}; source ${st?.step}; target ${t?.step}; ${last(r.out, 4)}`)
  c.add(`forwarded: ${L.id} recorded who began it: ${O.id}, forwarded`, st?.startedBy?.machine === O.id && st.startedBy.via === 'forwarded', JSON.stringify(st?.startedBy ?? null))
  const lastLine = r.out.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? ''
  c.add(`forwarded: the command's last line on ${O.id} says ${L.id} still has its hand-off step, and to check it there with --status`, lastLine === handOffLine(L.id), lastLine)
  c.add(`forwarded: the command on ${O.id} printed the source job's lines from ${L.id} while it ran`, r.out.includes(`[on ${L.id}] `), last(r.out.split('\n').filter((l) => l.includes(`[on ${L.id}]`)).join('\n'), 2))
  if (!done) return
  x.roles.leader = O
  x.roles.other = L
  await checkCarried(c, w, O, L, x.carried, `forwarded ${L.id} -> ${O.id}`)
  await oneLeader(x, 'forwarded', O)
}

async function flagOff(c: Checks, w: RemoteWorld): Promise<void> {
  const cfgFile = path.join(w.a.home, 'config.yaml')
  const saved = fs.readFileSync(cfgFile, 'utf8')
  const run = async (label: string, edit: (cfg: any) => void, refusal: RegExp) => {
    const cfg = YAML.parse(saved)
    edit(cfg)
    fs.writeFileSync(cfgFile, YAML.stringify(cfg))
    const s = await w.byHand(w.a, label.replace(/[^a-z0-9]+/gi, '-'))
    try {
      const st = s.ok ? await w.api(w.a, 'GET', '/api/leader/status').catch(() => null) : null
      c.add(`${label}: A boots as before (a real server with its daemon), no leader status route`, s.ok && st?.status === 404, `status ${st?.status}`)
      const t = s.ok ? await w.api(w.a, 'POST', '/api/tasks', { title: `${label} task`, project: 'Rehearsal' }).catch(() => null) : null
      c.add(`${label}: a task is created as before`, (t?.status ?? 500) < 300, `status ${t?.status}`)
      const witnessCall = await w.api(w.a, 'POST', '/host-api/witness/request', { v: 1, walnutId: 'x', witness: 'w-a', request: { type: 'read' } }).catch(() => null)
      const neverHad = await w.api(w.a, 'POST', '/host-api/never-had-this', {}).catch(() => null)
      c.add(`${label}: no witness route answers, as for a path it never had`, !!witnessCall && witnessCall.status === neverHad?.status && witnessCall.status !== 200, `witness ${witnessCall?.status}, never had ${neverHad?.status}`)
      const sw = await switchCmd(w, w.a, ['--to', w.b.id])
      c.add(`${label}: the switch command refuses and changes nothing on either machine`, sw.code === 1 && refusal.test(sw.out) && !fs.existsSync(w.b.home) && !fs.existsSync(path.join(w.b.standbyDir, 'switch')), last(sw.out, 1))
      await sleep(7_000)
      const written = ['may-act.jsonl', 'switch-state.json', 'handed-over.json', 'history.json'].filter((f) => fs.existsSync(path.join(w.a.home, 'local', 'leader-switch', f)))
      c.add(`${label}: nothing of the permit or the switch in A's home`, written.length === 0, written.join(', ') || 'none')
    } finally {
      await s.stop()
    }
  }
  await run('flag off', (cfg) => { cfg.experimental.switchable_leader = false }, /switchable_leader is off/)
  await run('flag on, no witnesses', (cfg) => { delete cfg.leader_switch; delete cfg.standby }, /leader_switch/)
  fs.writeFileSync(cfgFile, saved)
}

/** A net host that misses the member lists after the handover record: the switch waits, then takes its handover back; nothing stopped. */
async function netMiss(x: Ctx): Promise<void> {
  const { c, w, roles } = x
  const L = roles.leader
  const O = roles.other
  await writeAndBatch(x, 'net-miss')
  const missFile = path.join(L.dir, 'rehearsal-retell-miss')
  const pidBefore = w.side(L).runningServer()?.pid ?? null
  const stopFile = path.join(L.home, 'local', 'leader-switch', 'final-stop.json')
  const stopBefore = fs.existsSync(stopFile) ? fs.readFileSync(stopFile, 'utf8') : null
  fs.writeFileSync(missFile, 'box-net-only')
  let r: Awaited<ReturnType<typeof switchCmd>>
  const t0 = Date.now()
  try {
    r = await switchCmd(w, L, ['--to', O.id])
  } finally {
    fs.rmSync(missFile, { force: true })
  }
  const took = Date.now() - t0
  x.times['a net host that misses the lists: the switch waited before it rolled back'] = `${(took / 1000).toFixed(1)} s`
  c.add('a net host misses the lists: the switch waits, then rolls back naming the host', r.code === 3 && r.state?.step === 'rolled-back' && /box-net-only/.test(`${r.state?.rollbackWhy ?? ''} ${r.out}`) && took >= 30_000, `exit ${r.code}; ${(took / 1000).toFixed(0)} s; ${r.state?.rollbackWhy?.slice(0, 200)}`)
  const stopAfter = fs.existsSync(stopFile) ? fs.readFileSync(stopFile, 'utf8') : null
  c.add(`a net host misses the lists: nothing was stopped (${L.id}'s server is the same process, no switch stop ran, no ticket at ${O.id})`, !!pidBefore && w.side(L).runningServer()?.pid === pidBefore && stopAfter === stopBefore && !(r.state && fs.existsSync(path.join(O.standbyDir, 'switch', `${r.state.id}.json`))), `pid ${pidBefore} -> ${w.side(L).runningServer()?.pid}`)
  await oneLeader(x, 'a net host misses the lists', L)
  await checkCarried(c, w, L, L, x.carried, 'a net host misses the lists')
}

/** The copy link cut right after the handover (the source job stopped there by its kill point): the final batch cannot reach the other machine. */
async function splitAfterHandover(x: Ctx): Promise<void> {
  const { c, w, roles } = x
  const L = roles.leader
  const O = roles.other
  const copy = L === w.a ? w.links.copy : w.links.bToA
  await writeAndBatch(x, 'split-handover')
  const before = fs.existsSync(O.home) ? await snapshotHome(O.home) : null
  const first = await switchCmd(w, L, ['--to', O.id], { WALNUT_LEADER_SWITCH_KILL_AT: 'after-handover' })
  c.add('split after the handover: the source job stopped right after the handover', first.code === 4, `exit ${first.code}; ${last(first.out, 1)}`)
  copy.setMode('drop-hold')
  try {
    const resumed = await switchCmd(w, L, ['--resume'])
    const t = await targetDone(resumed.state)
    c.add('split after the handover: the switch rolls back on both machines (no final mark reached the new one)', resumed.state?.step === 'rolled-back' && t?.step !== 'done', `source ${resumed.state?.step} (${resumed.state?.rollbackWhy?.slice(0, 160)}); target ${t?.step} (${t?.rollbackWhy?.slice(0, 160)})`)
  } finally {
    copy.setMode('pass')
  }
  await oneLeader(x, 'split after the handover', L)
  const after = fs.existsSync(O.home) ? await snapshotHome(O.home) : null
  const kept = before && after ? compareKept(before, after) : null
  c.add(`split after the handover: ${O.id} changed nothing (its home as before)`, before ? !!kept?.ok : !fs.existsSync(O.home), kept ? describeKept(kept, 8, O.home) : (fs.existsSync(O.home) ? 'a home appeared' : 'no home made'))
  await checkCarried(c, w, L, L, x.carried, 'split after the handover')
}

/** Cut after the stop: the final mark is on the new machine; the copy link, and the old machine's way to the new one's witness, go. */
async function splitAfterStop(x: Ctx): Promise<void> {
  const { c, w, roles } = x
  await writeAndBatch(x, 'split-stop')
  const L = roles.leader
  let cutAt = ''
  const cut = () => {
    if (L === w.a) { w.links.copy.setMode('severed'); w.links.doorB.setMode('drop-hold'); w.links.aToBService.setMode('drop-hold') } else { w.links.bToA.setMode('severed'); w.links.doorA.setMode('drop-hold') }
  }
  const mend = () => { for (const p of [w.links.copy, w.links.bToA, w.links.doorA, w.links.doorB, w.links.aToBService]) p.setMode('pass') }
  try {
    const r = await runSwitch(x, 'split after the stop', {
      during: async (from) => {
        const st = await waitFor('the old leader\'s stop', async () => { const s = readSwitchState(from.home); return s && ['wait-target', 'hand-off', 'done'].includes(s.step) ? s : null }, 300_000, 50).catch(() => null)
        if (st) { cut(); cutAt = st.step }
      },
    })
    c.add('split after the stop: the new leader commits on its own ways, the old machine reads the commit and hands off', r.state?.step === 'done' && r.target?.step === 'done', `cut at ${cutAt || 'never'}; source ${r.state?.step}; target ${r.target?.step} ${r.target?.rollbackWhy ?? ''}`)
  } finally {
    mend()
  }
  await oneLeader(x, 'split after the stop', roles.leader)
  await checkCarried(c, w, roles.leader, roles.other, x.carried, 'split after the stop')
}

/** Between the majority and the role swap: the new leader's job dies there, then every link of that machine goes. */
async function splitBeforeRole(x: Ctx): Promise<void> {
  const { c, w, roles } = x
  await writeAndBatch(x, 'split-role')
  const L = roles.leader
  const O = roles.other
  const params = readCfgParams(L)
  let window = { from: 0, to: 0, mayActFalseAfterMs: NaN, leaderSeen: '' }
  const doors = [w.links.doorA, w.links.doorB, w.links.doorK, w.links.aToBService]
  const r = await runSwitch(x, 'split between the majority and the role swap', {
    env: { WALNUT_LEADER_SWITCH_KILL_AT: 'after-commit-majority' },
    during: async (from, to) => {
      const st = await deadTarget(w, from, 300_000)
      if (!st) return
      // Every link of the new leader's machine, and so every door (a door is one proxy for every machine): no majority anywhere.
      w.cutMachine(keyOf(w, to), 'drop-hold')
      for (const p of doors) p.setMode('drop-hold')
      window.from = Date.now()
      const lost = await waitFor(`${to.id} to stop acting`, async () => (await status(w, to))?.mayAct === false, params.validMs + 30_000, 250).then(() => true).catch(() => false)
      window.mayActFalseAfterMs = lost ? Date.now() - window.from : NaN
      // A while with nobody holding a majority: neither acts.
      for (let i = 0; i < 10; i++) { const sf = await status(w, from); const st2 = await status(w, to); if (sf?.mayAct || st2?.mayAct) window.leaderSeen += `${sf?.mayAct ? from.id : ''}${st2?.mayAct ? to.id : ''};`; await sleep(1_000) }
      window.to = Date.now()
      w.cutMachine(keyOf(w, to), 'pass')
      for (const p of doors) p.setMode('pass')
      await resumeTargetOn(w, to, st)
    },
  })
  const acts = readMayAct(O.home).filter((l) => l.event === 'door' && l.mayAct && l.t >= window.from + Math.max(window.mayActFalseAfterMs || 0, 0) && l.t <= window.to)
  c.add(`split between the majority and the role swap: ${O.id} stops acting within the lease once it lost its majority (lease ${params.validMs} ms)`, Number.isFinite(window.mayActFalseAfterMs) && window.mayActFalseAfterMs <= params.validMs + 5_000, `mayAct false ${window.mayActFalseAfterMs} ms after the cut`)
  c.add('split between the majority and the role swap: nobody acts while no side has a majority, nothing through a door', window.leaderSeen === '' && acts.length === 0, `${window.leaderSeen || 'no machine acted'}; ${acts.length} door line(s)`)
  c.add('split between the majority and the role swap: after the links return the switch finishes (the target job resumed on its machine)', r.state?.step === 'done' && r.target?.step === 'done', `source ${r.state?.step}; target ${r.target?.step} ${r.target?.rollbackWhy ?? ''}`)
  c.add(`split between the majority and the role swap: ${L.id} never led again (its marker held it)`, !(readMayAct(L.home).some((l) => l.mayAct && l.t > (r.state?.stoppedAt ? Date.parse(r.state.stoppedAt) : Infinity))), readMarker(L.home)?.state ?? 'no marker')
  await oneLeader(x, 'split between the majority and the role swap', roles.leader)
  await checkCarried(c, w, roles.leader, roles.other, x.carried, 'split between the majority and the role swap')
}

function readCfgParams(m: Machine): { validMs: number } {
  const cfg = YAML.parse(fs.readFileSync(path.join(m.home, 'config.yaml'), 'utf8')) as { leader_switch?: unknown }
  return { validMs: (parseCfg(cfg.leader_switch)?.params.validMs) ?? 15_000 }
}
const parseCfg = (raw: unknown) => parseSwitchSettings(raw).settings
/** The permit clocks a machine's server runs on, read as it reads them (remote witnesses: the default ones). */
function readPermitParams(m: Machine): PermitParams {
  const cfg = YAML.parse(fs.readFileSync(path.join(m.home, 'config.yaml'), 'utf8')) as { leader_switch?: unknown }
  return parseCfg(cfg.leader_switch)?.params ?? DEFAULT_PERMIT_PARAMS
}

/** One witness down before the switch (the old leader's own door: the candidate reaches its own and the companion), and one during it (the companion). */
async function witnessDown(x: Ctx): Promise<void> {
  const { c, w, roles } = x
  await writeAndBatch(x, 'witness-before')
  const before = ownWitness(w, roles.leader)
  w.witnessDown(before, true)
  try {
    const r = await runSwitch(x, 'one witness down before the switch')
    c.add(`one witness down before the switch (${before}): the switch completes on the other two`, r.state?.step === 'done' && r.target?.step === 'done', `source ${r.state?.step}; target ${r.target?.step}; ${last(r.out, 2)}`)
  } finally {
    w.witnessDown(before, false)
  }
  await oneLeader(x, `one witness down before the switch (${before})`, roles.leader)
  await checkCarried(c, w, roles.leader, roles.other, x.carried, 'one witness down before the switch')
  await writeAndBatch(x, 'witness-during')
  let downAt = ''
  try {
    const r = await runSwitch(x, 'one witness down during the switch', {
      during: async (from) => {
        const st = await waitFor('the handover', async () => { const s = readSwitchState(from.home); return s && s.step !== 'preflight' && s.step !== 'handover' ? s : null }, 120_000, 50).catch(() => null)
        if (st) { w.witnessDown('w-k', true); downAt = st.step }
      },
    })
    c.add('one witness down during the switch (w-k, the companion, after the handover): the switch completes on the other two', r.state?.step === 'done' && r.target?.step === 'done', `down at ${downAt || 'never'}; source ${r.state?.step}; target ${r.target?.step} ${r.target?.rollbackWhy ?? ''}`)
  } finally {
    w.witnessDown('w-k', false)
  }
  await oneLeader(x, 'one witness down during the switch', roles.leader)
  await checkCarried(c, w, roles.leader, roles.other, x.carried, 'one witness down during the switch')
}

/**
 * Two witnesses down: the preflight refuses, and nothing changes on either machine. Each home is compared by
 * the manifest's classes (home-kept) over the refused switch, less what it changed by itself over a control
 * interval just before (the leader's routine slot; on the other machine, a session it started while it led,
 * still running in its old home on its own daemon) and the files a running server always writes.
 */
async function twoDown(x: Ctx): Promise<void> {
  const { c, w, roles } = x
  const L = roles.leader
  const O = roles.other
  await waitForBatch(O.standbyDir, Date.now(), 180_000)
  const down = ['w-k', otherWitness(w, L)] as const
  const homes = [L, ...(fs.existsSync(O.home) ? [O] : [])]
  const switchFiles = () => { try { return fs.readdirSync(path.join(O.standbyDir, 'switch')).sort() } catch { return [] } }
  const filesBefore = switchFiles()
  const stateBefore = readSwitchState(L.home)?.id ?? null
  const snap = async () => Promise.all(homes.map((m) => snapshotHome(m.home)))
  const paths = (a: Awaited<ReturnType<typeof snapshotHome>>, b: Awaited<ReturnType<typeof snapshotHome>>) => new Set(compareKept(a, b).changed.map((ch) => ch.path))
  const s0 = await snap()
  for (const id of down) w.witnessDown(id, true)
  let sw: Awaited<ReturnType<typeof switchCmd>> | null = null
  let control: Set<string>[] = []
  let changed: Set<string>[] = []
  try {
    // The control interval first, over more than a routine's minute (its slot writes the cron state, the Main
    // task's message queue and a notification).
    await sleep(75_000)
    const s1 = await snap()
    control = s0.map((a, i) => paths(a, s1[i]!))
    sw = await switchCmd(w, L, ['--to', O.id])
    const s2 = await snap()
    changed = s1.map((a, i) => paths(a, s2[i]!))
  } finally {
    for (const id of down) w.witnessDown(id, false)
  }
  c.add(`two witnesses down (${down.join(', ')}): the preflight refuses, naming what it lacks`, sw?.code === 1 && /witnesses answered|majority/.test(sw.out), last(sw?.out ?? '', 2))
  // What a running server writes by itself whether or not a switch was asked (the same list as the no-link e2e's).
  const live = /^(local\/leader-switch\/(may-act|server-leader\.log)|local\/health-monitor\/|logs\/|cache\/|tmp\/|sync\/|\.git\/|.*\.(sqlite|db)-(wal|shm)$|.*\.log$)/
  const bySwitch = (i: number) => [...(changed[i] ?? [])].filter((p) => !control[i]!.has(p) && !live.test(p))
  const alone = (i: number) => [...(control[i] ?? [])].slice(0, 5).join(', ') || 'none'
  c.add(`two witnesses down: nothing changed on ${L.id} (no switch state, no marker, its home by the manifest's classes)`, (readSwitchState(L.home)?.id ?? null) === stateBefore && !readMarker(L.home) && bySwitch(0).length === 0, `changed by the refused switch: ${bySwitch(0).slice(0, 8).join(', ') || 'none'}; by the leader alone: ${alone(0)}`)
  const onO = homes.length > 1 ? bySwitch(1) : []
  c.add(`two witnesses down: nothing changed on ${O.id} (no switch file, its home by the manifest's classes)`, JSON.stringify(switchFiles()) === JSON.stringify(filesBefore) && onO.length === 0 && (homes.length > 1 || !fs.existsSync(O.home)), `${homes.length > 1 ? `changed by the refused switch: ${onO.slice(0, 8).join(', ') || 'none'}; by itself: ${alone(1)}` : 'no home, none made'}; switch files ${switchFiles().length - filesBefore.length} new`)
  // The leader keeps leading once a majority answers again.
  await oneLeader(x, 'two witnesses down, after they return', L)
}

/** The new leader cut from every other witness after the commit: its mayAct goes false within the lease, then comes back; nothing sent meanwhile. */
async function cutAfterCommit(x: Ctx): Promise<void> {
  const { c, w, roles } = x
  const N = roles.leader
  const params = readCfgParams(N)
  const cuts = N === w.a ? [w.links.doorB, w.links.aToBService, w.links.doorK] : [w.links.doorA, w.links.doorK]
  const t0 = Date.now()
  for (const p of cuts) p.setMode('drop-hold')
  let falseAfter = NaN
  let trueAfter = NaN
  try {
    falseAfter = await waitFor('the leader to stop acting', async () => ((await status(w, N))?.mayAct === false ? Date.now() - t0 : null), params.validMs + 30_000, 200).catch(() => NaN)
    await sleep(10_000)
  } finally {
    for (const p of cuts) p.setMode('pass')
  }
  const t1 = Date.now()
  // What the permit says meanwhile (its state and why, each change), the evidence when it does not come back.
  const seen: string[] = []
  const permitNow = async () => ((await w.api(N, 'GET', '/api/leader/status').catch(() => null))?.json as { permit?: { mayAct?: boolean; state?: string; why?: string } } | null)?.permit ?? null
  trueAfter = await waitFor('the leader to act again', async () => {
    const p = await permitNow()
    const line = `${p?.state}: ${p?.why ?? ''}`
    if (seen[seen.length - 1]?.endsWith(line) !== true) seen.push(`+${((Date.now() - t1) / 1000).toFixed(0)}s ${line}`)
    return p?.mayAct === true ? Date.now() - t1 : null
  }, 300_000, 500).catch(() => NaN)
  x.log(`cut after the commit, the permit after the links returned: ${seen.join(' | ')}`)
  const doors = readMayAct(N.home).filter((l) => l.event === 'door' && l.mayAct && l.t > t0 + (falseAfter || 0) && l.t < t1)
  x.times['new leader cut from the other witnesses: mayAct false after'] = `${falseAfter} ms (lease ${params.validMs} ms)`
  x.times['and true again after the links returned'] = `${trueAfter} ms`
  c.add(`cut after the commit: ${N.id}'s mayAct goes false within the lease (${params.validMs} ms) once it reaches only its own witness`, Number.isFinite(falseAfter) && falseAfter <= params.validMs + 5_000, `${falseAfter} ms`)
  c.add(`cut after the commit: it comes back once the witnesses answer, and nothing went through a door meanwhile`, Number.isFinite(trueAfter) && doors.length === 0, `true again after ${trueAfter} ms; ${doors.length} door line(s) while it could not act; ${seen.slice(-4).join(' | ')}`)
}

/** A kill at each step of either job, resumed (on the machine whose job died): one leader, everything carried. */
async function kills(x: Ctx): Promise<void> {
  const { c, w, roles } = x
  for (const point of KILL_POINTS) {
    await writeAndBatch(x, `kill-${point}`)
    const L = roles.leader
    const target = TARGET_KILLS.has(point)
    let resumedOn = ''
    let diedAt = ''
    const r = await runSwitch(x, `kill ${point}`, {
      env: { WALNUT_LEADER_SWITCH_KILL_AT: point },
      during: target ? async (from, to) => {
        const st = await deadTarget(w, from, 300_000)
        if (!st) return
        diedAt = readTargetState(st.standbyDir, st.id)?.step ?? ''
        const res = await resumeTargetOn(w, to, st)
        resumedOn = `${to.id} (exit ${res.code})`
      } : undefined,
    })
    let final = r
    if (!target && r.code === 4) {
      final = await switchCmd(w, L, ['--resume'])
      final.target = await targetDone(final.state)
      resumedOn = `${L.id} (exit ${final.code})`
      if (final.state?.step === 'done' && final.target?.step === 'done') { roles.leader = roles.other; roles.other = L }
    }
    // The kill happened where it was asked: the source job died in that step (exit 4, the command naming it), or the
    // target job was found dead in it and resumed.
    if (!target) diedAt = /died at step (\S+)/.exec(r.out)?.[1] ?? ''
    const killed = (target ? resumedOn !== '' : r.code === 4) && diedAt === KILL_STEP[point]
    c.add(`kill ${point}: the ${target ? 'target' : 'source'} job died in its step ${KILL_STEP[point]}`, killed, `first exit ${r.code}; died at ${diedAt || 'no step'}; ${last(r.out, 1)}`)
    // Resumed at once, every kill point finishes the switch (as on one machine, rehearsal.ts rehearseKill):
    // a roll back here is a bug of the resume, never an allowed answer.
    const done = final.state?.step === 'done' && final.target?.step === 'done'
    c.add(`kill ${point}: the resumed switch finishes, both jobs done, no roll back`, done && !final.state?.rollbackWhy && !final.target?.rollbackWhy, `first exit ${r.code}; resumed on ${resumedOn || 'none'}; source ${final.state?.step}; target ${final.target?.step}; ${(final.state?.rollbackWhy ?? final.target?.rollbackWhy)?.slice(0, 160) ?? 'no roll back'}`)
    await oneLeader(x, `kill ${point}`, roles.leader)
    // The stricter check too (the old leader acted only before it stopped, the new one only after): the switch finished.
    if (done) checkOneLeader(c, `kill ${point}`, L, roles.leader, { stoppedAt: final.state?.stoppedAt, startedAt: final.state?.startedAt })
    await checkCarried(c, w, roles.leader, L, x.carried, `kill ${point}`)
  }
}

/** The trial finds a broken copy on the new machine (a database corrupted after the promotion): both sides roll back, the old leader leads with everything. */
async function trialFails(x: Ctx): Promise<void> {
  const { c, w, roles } = x
  await writeAndBatch(x, 'trial-fails')
  const L = roles.leader
  const O = roles.other
  const r = await runSwitch(x, 'failed trial', {
    env: { WALNUT_LEADER_SWITCH_KILL_AT: 'after-promote' },
    during: async (from, to) => {
      const st = await deadTarget(w, from, 300_000)
      if (!st) return
      const db = path.join(to.home, 'tasks', 'tasks.sqlite')
      fs.chmodSync(db, 0o600)
      const fd = fs.openSync(db, 'r+')
      fs.writeSync(fd, randomBytes(8192), 0, 8192, 4096)
      fs.closeSync(fd)
      await resumeTargetOn(w, to, st)
    },
  })
  c.add('failed trial: both sides roll back (the new machine demotes, the old leader takes the lead back)', r.state?.step === 'rolled-back' && r.target?.step === 'rolled-back', `source ${r.state?.step} (${r.state?.rollbackWhy?.slice(0, 140)}); target ${r.target?.step} (${r.target?.rollbackWhy?.slice(0, 140)})`)
  await oneLeader(x, 'failed trial', L)
  // The old leader leads again within its bound (runtime.ts retakeAfterRestartMs), counted from its restarted server's
  // boot: its handover runs out at the two witnesses it reaches (its own counts it from that boot; the failed machine's
  // is out of reach, its door closed with its server), then one round. Before the grant rule took a grant on its own
  // process's live record, the two could stay on two grants of that process for many minutes (review round 3, B2b step 4).
  const startedAt = Date.parse(r.state?.log.find((l) => l.step === 'start-source')?.at ?? '')
  const lines = readMayAct(L.home).filter((l) => l.t >= startedAt)
  const boot = lines.find((l) => l.event === 'boot')
  const led = boot ? lines.find((l) => l.event === 'lease' && l.mayAct && l.t >= boot.t) : undefined
  const bound = retakeAfterRestartMs(readPermitParams(L))
  const took = boot && led ? led.t - boot.t : NaN
  x.times['failed trial: the old leader leads again after its server booted'] = Number.isFinite(took) ? `${(took / 1000).toFixed(1)} s (bound ${(bound / 1000).toFixed(1)} s)` : `not seen (boot ${boot?.at ?? 'none'})`
  c.add(`failed trial: ${L.id} leads again within ${(bound / 1000).toFixed(1)} s of its server's boot (its handover's hold, then one round)`, took <= bound, `${Number.isFinite(took) ? `${(took / 1000).toFixed(1)} s` : 'no lead seen'}; boot ${boot?.at ?? 'none'} (${boot?.why ?? ''}); lead ${led?.at ?? 'none'}`)
  c.add(`failed trial: ${O.id} runs no leader and its tried home is kept aside`, !w.side(O).runningServer() && fs.readdirSync(path.dirname(O.home)).some((n) => n.startsWith(`${path.basename(O.home)}.trial-failed-`)))
  await checkCarried(c, w, L, L, x.carried, 'failed trial')
}

/**
 * The 2026-11-24 bug: after "the switch stop begins" the old leader's own git still committed (a tick, its large-file
 * lane), so its final batch found the home changing. Its log from that line to the final batch's end has no git line
 * that writes the data repo.
 */
function checkNoOwnWritesInStop(c: Checks, label: string, m: Machine, switchId: string | undefined): void {
  const lines = serverLog(m)
  const from = lines.findIndex((l) => l.switchId === switchId && /the switch stop begins/.test(String(l.message)))
  const to = lines.findIndex((l, i) => i > from && l.switchId === switchId && /final batch sent and marked|no final mark/.test(String(l.message)))
  const inStop = from >= 0 ? lines.slice(from, to >= 0 ? to + 1 : undefined) : []
  const writes = inStop.filter((l) => l.subsystem === 'git' && /commit|large files|lane|gc|repack|compaction/i.test(String(l.message)) && !/ended for the final batch/.test(String(l.message)))
  const settled = inStop.find((l) => /writers of the home are stopped for the final batch/.test(String(l.message)))
  c.add(`${label}: no git of the old leader writes the data repo once its switch stop began; its writers are stopped before the final batch`, from >= 0 && writes.length === 0 && !!settled,
    from < 0 ? 'no switch stop line' : `${writes.length} git line(s) in the stop${writes.length ? `: ${writes.slice(0, 2).map((l) => `${l.time} ${l.message}`).join('; ')}` : ''}; settle: ${settled ? JSON.stringify({ late: settled.late, ms: settled.ms }) : 'none'}`)
}

/**
 * The 2026-11-24 bug: the standby leaves the .gitignore out (rebuildable) and copies `.git`, so the promoted home
 * booted an existing repo with no ignore list, and its auto-commit took in tmp/ (the standby's own spool) and
 * /voice-archive/. The new leader has its .gitignore as committed, and git tracks nothing under either.
 */
function checkIgnoresKept(c: Checks, label: string, m: Machine): void {
  const label2 = `${label}: the new leader ${m.id} has its .gitignore as committed, and git tracks nothing of tmp/ or voice-archive/`
  try {
    // No optional locks: a status of the live leader's repo must not take its index lock from its auto-commit.
    const g = (...args: string[]) => execFileSync('git', ['--no-optional-locks', '-C', m.home, ...args], { encoding: 'utf8' }).trim()
    const has = fs.existsSync(path.join(m.home, '.gitignore'))
    const changed = has ? g('status', '--porcelain', '--', '.gitignore') : 'missing'
    const tracked = g('ls-files', '--', 'tmp', 'voice-archive').split('\n').filter(Boolean)
    c.add(label2, has && changed === '' && tracked.length === 0,
      `.gitignore ${has ? (changed ? `changed (${changed})` : 'as committed') : 'missing'}; ${tracked.length} tracked under tmp/ or voice-archive/${tracked.length ? ` (${tracked.slice(0, 2).join(', ')})` : ''}`)
  } catch (err) {
    c.add(label2, false, `git failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
  }
}

/** The leader's catch-up lines (routes/leader-switch.ts /switch/catch-up) since `since`: each attempt's batches. */
function catchUps(m: Machine, since: number): string[] {
  return serverLog(m).filter((l) => Date.parse(l.time) >= since && /leader switch: the standby (caught up|did not catch up)/.test(String(l.message)))
    .map((l) => `${String(l.message).replace('leader switch: the standby ', '')} in ${((Number(l.ms) || 0) / 1000).toFixed(1)} s (${(l.batches as Array<{ ok: boolean; ms: number; sentBytes: number }> | undefined)?.map((b) => `${(b.ms / 1000).toFixed(1)} s/${(b.sentBytes / 1_048_576).toFixed(1)} MB${b.ok ? '' : ' void'}`).join(', ') ?? ''})`)
}

/**
 * A switch the catch-up refuses (the standby not caught up yet: a large home's leader still writes its git objects,
 * or the copy link is slow) is a refusal with nothing stopped: tried again a minute later, up to `tries` times.
 */
async function switchWhenCaughtUp(x: Ctx, label: string, tries = 10): Promise<{ r: Awaited<ReturnType<typeof runSwitch>>; refused: number }> {
  let refused = 0
  for (;;) {
    const r = await runSwitch(x, label)
    if (r.code !== 1 || !/not caught up/.test(r.out) || refused + 1 >= tries) return { r, refused }
    refused++
    x.log(`${label}: refused (not caught up), trying again in 60 s`)
    await sleep(60_000)
  }
}

/**
 * After a scenario, every witness holds the leader's own record again (one record number, give or take one, of one
 * process of the leader, no handover) within a record's hold and two renew periods. A witness the leader's records
 * missed (it refused the grant while it still held a live record, as the old leader's own witness does after a failed
 * trial: it restarts with the server and counts the handover's hold from then; or it was out of reach) takes no renew
 * once that record ran out, only the holder's grant (client.ts `behind`). Without that grant the leader ran on two
 * witnesses of three from then on: the 2026-11-26 standby-behind red, caused by trial-fails and seen only in
 * standby-behind, three scenarios later. Checked here, the scenario that leaves a witness behind is the one that fails.
 */
async function everyWitnessHoldsLeader(x: Ctx, scenario: string, walnutId: string): Promise<void> {
  const { c, w, roles } = x
  const L = roles.leader
  const ids = ['w-a', 'w-b', 'w-k'] as const
  const read = () => ids.map((id) => recordAt(w.witnessRoot[id], walnutId, id))
  const same = (held: Held[]) => held.every((h) => h?.holder === L.id && h.kind !== 'handover' && h.nonce === held[0]?.nonce)
    && Math.max(...held.map((h) => h!.number)) - Math.min(...held.map((h) => h!.number)) <= 1
  // A witness back with a live record of another process of the leader (a restart, a failed trial) takes the grant only
  // once that record ran out there: up to its hold, then a renew round or two.
  const params = readPermitParams(L)
  const within = witnessHoldMs(params) + 2 * params.renewEveryMs + 10_000
  const ok = await waitFor(`every witness to hold ${L.id}`, async () => same(read()), within, 1_000).then(() => true).catch(() => false)
  const held = read()
  c.add(`${scenario}: afterwards every witness holds ${L.id}'s own record (one process, within ${(within / 1000).toFixed(0)} s)`, ok,
    held.map((h, i) => `${ids[i]} #${h?.number} ${h?.kind} of ${h?.holder} by ${h?.by}/${h?.nonce}`).join('; '))
}

/** The downtime over the copy link unslowed and at 20 Mbit/s (`slow {bytesPerSec: 2_500_000}`), and the time until every host is connected. */
async function measure(x: Ctx): Promise<void> {
  const { c, w, roles, times } = x
  for (const slow of [false, true]) {
    // After a switch the copy goes the other way: its first batch there is the whole home.
    await writeAndBatch(x, slow ? 'measure-slow' : 'measure', 3 * 3600_000)
    const from = roles.leader
    const to = roles.other
    const copy = from === w.a ? w.links.copy : w.links.bToA
    if (slow) copy.setMode('slow', { delayMs: 0, bytesPerSec: 2_500_000 })
    const began = Date.now()
    let r: Awaited<ReturnType<typeof runSwitch>>
    let refused = 0
    try {
      ({ r, refused } = await switchWhenCaughtUp(x, slow ? 'measure at 20 Mbit/s' : 'measure unslowed'))
    } finally {
      copy.setMode('pass')
    }
    const label = `${from.id} -> ${r.state?.to ?? to.id}, copy link ${slow ? 'at 20 Mbit/s' : 'unslowed'}`
    c.add(`measure: switch ${label} completes`, r.state?.step === 'done' && r.target?.step === 'done', `source ${r.state?.step}; target ${r.target?.step}; ${refused} refusal(s) before (not caught up); ${(r.state?.rollbackWhy ?? '').slice(0, 300)}`)
    times[`downtime ${label}`] = `${((r.target?.downtimeMs ?? NaN) / 1000).toFixed(1)} s`
    times[`catch-up before ${label}`] = catchUps(from, began).join(' | ') || 'none logged'
    checkNoOwnWritesInStop(c, `measure ${label}`, from, r.state?.id)
    const N = roles.leader
    const t0 = Date.now()
    const followed = await waitFor('every host connected', async () => hostsConnected(w, N, [w.h.id, roles.other.id]), 180_000, 500).then(() => true).catch(() => false)
    const since = r.target?.readyAt ? Date.now() - Date.parse(r.target.readyAt) : NaN
    times[`every host connected to the new leader after done (${label})`] = followed ? `${(since / 1000).toFixed(1)} s` : `not within ${((Date.now() - t0) / 1000).toFixed(0)} s`
    checkIgnoresKept(c, `measure ${label}`, N)
  }
}

/**
 * A standby behind (the 2026-11-24 rehearsal: 1.35 GB in the batch before a handover over a 20 Mbit/s link): about
 * 1.2 GB of new leader data just before the switch, the copy link at 20 Mbit/s (about 2.5 MB/s, so about 8 min for
 * it). The catch-up refuses at the preflight, before any handover: the old leader never stops (its permission sampled
 * every second, its mayAct log, its doors, its server process, the witnesses' record).
 */
async function standbyBehind(x: Ctx): Promise<void> {
  const { c, w, roles, times } = x
  await writeAndBatch(x, 'standby-behind')
  const L = roles.leader
  const O = roles.other
  const copy = L === w.a ? w.links.copy : w.links.bToA
  const dir = path.join(L.home, 'voice-archive', 'rehearsal-behind')
  fs.mkdirSync(dir, { recursive: true })
  copy.setMode('slow', { delayMs: 0, bytesPerSec: 2_500_000 })
  const pid = w.side(L).runningServer()?.pid
  const t0 = Date.now()
  const samples: boolean[] = []
  let sampling = true
  const sampler = (async () => { while (sampling) { samples.push(!!(await status(w, L).catch(() => null))?.mayAct); await sleep(1_000) } })()
  let r: Awaited<ReturnType<typeof switchCmd>>
  try {
    // Leader data git does not take (no commit of it adds to the backlog), every MiB different.
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, `recording-${i}.bin`), randomBytes(100 * 1_048_576))
    // The standby's periodic batch takes it on at once (every 5 s here): the catch-up finds it under way.
    await sleep(8_000)
    r = await switchCmd(w, L, ['--to', O.id])
  } finally {
    sampling = false
    await sampler
    copy.setMode('pass')
  }
  const t1 = Date.now()
  x.log(`standby behind:\n${r.out}`)
  c.add('standby behind: refused at its preflight because the standby is not caught up (the final batch would not fit in the commit window)', r.code === 1 && /not caught up/.test(r.out), `exit ${r.code}; ${last(r.out, 2).slice(0, 400)}`)
  const lines = readMayAct(L.home).filter((l) => l.t >= t0 && l.t <= t1)
  const off = lines.filter((l) => !l.mayAct)
  const doors = lines.filter((l) => l.event === 'door')
  c.add(`standby behind: ${L.id} never stopped acting (its permission true at each of ${samples.length} samples a second apart, no "may not act" line, its server the same process)`,
    samples.length >= 30 && samples.every(Boolean) && off.length === 0 && w.side(L).runningServer()?.pid === pid,
    `${samples.filter((s) => !s).length} false sample(s); ${off.length} false line(s); pid ${pid} -> ${w.side(L).runningServer()?.pid}`)
  c.add(`standby behind: ${L.id}'s doors stayed open through it (every door line allowed, its routine fired)`, doors.length > 0 && doors.every((l) => l.mayAct), `${doors.length} door line(s), ${doors.filter((l) => !l.mayAct).length} refused`)
  const walnutId = (await instanceIdAt(L.home))!
  const held = (['w-a', 'w-b', 'w-k'] as const).map((id) => recordAt(w.witnessRoot[id], walnutId, id))
  c.add(`standby behind: no handover record: every witness still holds ${L.id}`, held.every((h) => h?.holder === L.id && h.kind !== 'handover'), JSON.stringify(held))
  // The leader's catch-up line, once its log is written out (it is written as the route answers).
  const caught = await waitFor('the catch-up line', async () => catchUps(L, t0).join(' | ') || null, 15_000, 500).catch(() => 'no catch-up logged')
  times['standby behind: the refusal came after'] = `${((t1 - t0) / 1000).toFixed(1)} s (${caught})`
  // The backlog goes once the link is fast again; then it is removed, and the standby holds the home as it is.
  await waitForBatch(O.standbyDir, Date.now(), 600_000).catch(() => 0)
  fs.rmSync(dir, { recursive: true, force: true })
  await waitForBatch(O.standbyDir, Date.now(), 600_000).catch(() => 0)
}

const SCENARIOS: Array<[string, (x: Ctx) => Promise<void>]> = [
  ['forwarded', forwarded],
  ['net-miss', netMiss],
  ['split-after-handover', splitAfterHandover],
  ['split-after-stop', splitAfterStop],
  ['split-before-role', splitBeforeRole],
  ['witness-down', witnessDown],
  ['two-down', twoDown],
  ['cut-after-commit', cutAfterCommit],
  ['trial-fails', trialFails],
  ['kills', kills],
  ['standby-behind', standbyBehind],
  ['measure', measure],
]
