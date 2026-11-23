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
import YAML from 'yaml'
import { compareKept, describeKept, snapshotHome } from '../../src/core/home-manifest/home-kept.js'
import { readMayAct, readMarker, type MayActLine } from '../../src/core/leader/switch/records.js'
import { readSwitchState, readTargetState, type SwitchState, type TargetState } from '../../src/core/leader/switch/flow.js'
import { witnessDir } from '../../src/core/leader/switch/witness-route.js'
import { instanceIdAt } from '../../src/core/device-store.js'
import { Checks, KILL_POINTS, checkCarried, checkNoOldPaths, cronDoorCalls, seed, startLoad, status, waitFor, waitForBatch, writeFiller, type Check, type Seeded } from './rehearsal.js'
import { makeRemoteWorld, type RemoteWorld } from './remote-world.js'
import type { Machine } from './world.js'
import { parseSwitchSettings } from '../../src/core/leader/switch/settings.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const last = (out: string, n = 3) => out.trim().split('\n').slice(-n).join(' | ')

type Held = { number: number; holder: string; kind: string; to?: string } | null
function recordAt(root: string, walnutId: string, id: string): Held {
  try { return (JSON.parse(fs.readFileSync(path.join(witnessDir(root, walnutId, id), 'permit-record.json'), 'utf8')) as { held: Held }).held } catch { return null }
}

/** Who leads now and who holds its standby copy. */
interface Roles { leader: Machine; other: Machine }

export interface RemoteResult { checks: Checks; times: Record<string, string> }

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
  c.add(`${label}: its home is as before (leader data and machine data, by the manifest's classes)`, kept.ok, describeKept(kept))
}

/** A session on H through the leader `m`: start it with `message` (or send to it), and the answers it shows. */
async function sessionTurn(w: RemoteWorld, m: Machine, o: { taskId: string; sid?: string; message: string }): Promise<{ sid: string; ok: boolean; why?: string }> {
  if (!o.sid) {
    const r = await w.api(m, 'POST', `/api/v1/tasks/${o.taskId}/start`, { host: w.h.id, cwd: path.join(w.h.dir, 'work'), mode: 'bypass', message: o.message })
    if (r.status !== 202) return { sid: '', ok: false, why: `start ${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}` }
    return { sid: r.json.sessionId as string, ok: true }
  }
  const r = await w.api(m, 'POST', `/api/v1/sessions/${o.sid}/messages`, { message: o.message, text: o.message })
  return { sid: o.sid, ok: r.status < 300, ...(r.status < 300 ? {} : { why: `send ${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}` }) }
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

export async function rehearseRemote(root: string, print: (c: Check) => void, opts: { portA: number; portB: number; fillerGb?: number; log?: (s: string) => void; only?: string[] }): Promise<RemoteResult> {
  const log = opts.log ?? (() => {})
  const c = new Checks(print)
  const times: Record<string, string> = {}
  const w = await makeRemoteWorld(root, { portA: opts.portA, portB: opts.portB, log })
  const roles: Roles = { leader: w.a, other: w.b }
  const want = (name: string) => !opts.only?.length || opts.only.includes(name)
  try {
    if (want('flag-off')) await flagOff(c, w)
    // ---- boot: A leads on the three witnesses (init sets them up as an operator runs it) ----
    const started = await w.side(w.a).startServer('leader', 300_000)
    if (!c.add('boot: A starts (non-ephemeral, its own daemon, its links to B and H through proxies)', started.ok, started.why ?? '')) return { checks: c, times }
    const walnutId = (await instanceIdAt(w.a.home))!
    await w.startServiceB(walnutId)
    const init1 = await w.cli(w.a.home, ['leader', 'witnesses', 'init'], w.a.env)
    log(init1.out)
    const leads = await waitFor('A to lead', async () => (await status(w, w.a))?.mayAct, 120_000).catch(() => false)
    const init2 = await w.cli(w.a.home, ['leader', 'witnesses', 'init'], w.a.env)
    log(init2.out)
    const allThree = await waitFor('the three witnesses to hold A', async () => (['w-a', 'w-b', 'w-k'] as const).every((id) => recordAt(w.witnessRoot[id], walnutId, id)?.holder === w.a.id), 120_000).then(() => true).catch(() => false)
    if (!c.add('boot: init sets up w-a and w-k from nothing, A leads, init again adds w-b over A\'s link to B\'s service; all three hold A', leads === true && init2.code === 0 && allThree,
      `init 1 exit ${init1.code}, init 2 exit ${init2.code}: ${last(init2.out, 4)}`)) return { checks: c, times }
    if (opts.fillerGb) await writeFiller(w.a.home, opts.fillerGb, log)
    const s = await seed(w, w.a, 8)
    c.add('boot: seed on A (tasks, notes, a plugin file, a routine)', s.tasks.length === 8 && !!s.cronId)
    const t0 = Date.now()
    const b1 = await waitForBatch(w.b.standbyDir, t0, opts.fillerGb ? 7_200_000 : 180_000).catch(() => 0)
    times['first standby batch over the copy link'] = `${((Date.now() - t0) / 1000).toFixed(1)} s`
    c.add('boot: A\'s standby batches reach B\'s standby folder over A\'s link to B\'s daemon (standby.host)', b1 > 0, `batch ${b1}; ${w.links.copy.accepted()} connection(s) through the copy link`)

    const ctx: Ctx = { c, w, roles, carried: { tasks: [...s.tasks], notes: [...s.notes], pluginFiles: [...s.pluginFiles] }, times, log }
    if (want('main')) await mainScenario(c, w, roles, s, times, log)
    for (const [name, run] of SCENARIOS) {
      if (!want(name)) continue
      log(`--- ${name}: ${roles.leader.id} leads, ${roles.other.id} holds its copy`)
      await run(ctx).catch((err: unknown) => { c.add(`${name}: ran to its end`, false, err instanceof Error ? err.stack ?? err.message : String(err)) })
    }
    return { checks: c, times }
  } catch (err) {
    c.add('the rehearsal ran to its end', false, err instanceof Error ? err.stack ?? err.message : String(err))
    return { checks: c, times }
  } finally {
    await w.stop().catch(() => {})
  }
}

/** A to B under load, every B2a check with the witnesses and the other side remote, the third host's session, and back. */
async function mainScenario(c: Checks, w: RemoteWorld, roles: Roles, s: Seeded, times: Record<string, string>, log: (s: string) => void): Promise<void> {
  const A = roles.leader
  const B = roles.other
  // A session on H, started through A: its first answer.
  const task = await w.api(A, 'POST', '/api/tasks', { title: 'Session on the third host', project: 'Rehearsal' })
  const first = await sessionTurn(w, A, { taskId: task.json?.task?.id, message: 'ROUND one on A' })
  const answeredA = first.ok ? await waitFor('the first answer through A', async () => ((await answersOn(w, A, first.sid)).get('echo: ROUND one on A') ?? 0) > 0, 120_000).then(() => true).catch(() => false) : false
  c.add('main: a session on H started through A answers', answeredA, first.why ?? first.sid)
  const late = { rel: 'plugins/rehearsal-plugin/data/late.json', content: JSON.stringify({ late: randomBytes(4).toString('hex') }) }
  fs.writeFileSync(path.join(A.home, late.rel), late.content)
  await waitForBatch(B.standbyDir, Date.now(), 120_000)
  const load = startLoad(w, A)
  await sleep(1_500)
  const sw = await switchCmd(w, A, ['--to', B.id])
  const acked = await load.stop()
  log(sw.out)
  const tgt = await targetDone(sw.state)
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
  checkNoOverlap(c, 'main A -> B', A, B)
  // Hosts follow: H and the old machine A connected to B.
  const tHosts = Date.now()
  const followed = await waitFor('every host connected to B', async () => hostsConnected(w, B, [w.h.id, A.id]), 180_000, 1_000).then(() => true).catch(() => false)
  const sinceDone = tgt?.readyAt ? Date.now() - Date.parse(tgt.readyAt) : NaN
  times['every host connected to the new leader after done'] = followed ? `${(sinceDone / 1000).toFixed(1)} s (waited ${((Date.now() - tHosts) / 1000).toFixed(1)} s after the command returned)` : 'not within 180 s'
  c.add('main: every host (H, and the old machine A) is connected to B', followed, JSON.stringify((await w.api(B, 'GET', '/api/hosts/status').catch(() => null))?.json?.hosts?.map((x: any) => ({ h: x.host ?? x.alias ?? x.key, c: x.connected ?? x.state ?? x.phase })) ?? null))
  // The session on H: its facts on B with no loss and no doubling, and a message right after the switch answered once.
  const onB = await answersOn(w, B, first.sid)
  c.add('main: the session\'s turns made through A are on B once each (no loss, no doubling)', onB.get('echo: ROUND one on A') === 1, JSON.stringify([...onB]))
  const second = await sessionTurn(w, B, { taskId: task.json?.task?.id, sid: first.sid, message: 'ROUND two on B' })
  const answeredB = second.ok ? await waitFor('the answer through B', async () => ((await answersOn(w, B, first.sid)).get('echo: ROUND two on B') ?? 0) > 0, 120_000).then(() => true).catch(() => false) : false
  await sleep(5_000)
  const afterSend = await answersOn(w, B, first.sid)
  c.add('main: a message sent through B right after the switch arrives once', answeredB && afterSend.get('echo: ROUND two on B') === 1 && afterSend.get('echo: ROUND one on A') === 1, `${second.why ?? ''} ${JSON.stringify([...afterSend])}`)
  // Triggers once: every routine slot through a door on one machine, once.
  await sleep(17_000)
  const slotsA = cronDoorCalls(A.home).filter((l) => l.mayAct).map((l) => l.opId)
  const slotsB = cronDoorCalls(B.home).filter((l) => l.mayAct).map((l) => l.opId)
  const both = slotsA.filter((x) => slotsB.includes(x))
  const dup = [...slotsA, ...slotsB].filter((x, i, all) => all.indexOf(x) !== i)
  c.add('main: the routine fired each slot once in total across the switch', both.length === 0 && dup.length === 0 && slotsB.length > 0, `${new Set(slotsA).size} on A, ${new Set(slotsB).size} on B, ${both.length} on both, ${dup.length} repeats`)
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
  const cfgB = YAML.parse(fs.readFileSync(path.join(B.home, 'config.yaml'), 'utf8')) as { standby?: { dir?: string; host?: string } }
  c.add('main: B\'s standby now goes to A\'s standby folder on A as a host', cfgB.standby?.dir === A.standbyDir && cfgB.standby?.host === A.id, JSON.stringify(cfgB.standby))
  const onBWrites: Seeded['tasks'] = []
  for (let i = 0; i < 5; i++) {
    const title = `written on B ${i} ${randomBytes(3).toString('hex')}`
    const opId = `b-${i}-${randomBytes(4).toString('hex')}`
    const r = await w.api(B, 'POST', '/api/tasks', { title, project: 'Rehearsal' }, opId)
    if (r.status < 300) onBWrites.push({ id: r.json.task.id, title, opId })
  }
  await w.side(A).startStandby().catch(() => null)
  const batchA = await waitForBatch(A.standbyDir, Date.now(), 180_000).catch(() => 0)
  c.add('main: B\'s batches reach A\'s standby folder over B\'s link to A\'s daemon', batchA > 0, `batch ${batchA}`)
  const back = await switchCmd(w, B, ['--back'])
  log(back.out)
  const tb = await targetDone(back.state)
  if (!c.add('main: switch back B -> A completes', back.code === 0 && back.state?.step === 'done' && tb?.step === 'done', `exit ${back.code}; target ${tb?.step}; ${last(back.out, 4)}`)) return
  times['downtime B -> A (switch back), copy link unslowed'] = `${((tb?.downtimeMs ?? NaN) / 1000).toFixed(1)} s`
  c.add('main: A leads again', !!(await status(w, A))?.mayAct)
  await checkCarried(c, w, A, B, { tasks: [...s.tasks, ...acked, ...onBWrites], notes: s.notes, pluginFiles: [...s.pluginFiles, late] }, 'main B -> A')
  checkNoOverlap(c, 'main B -> A', A, B)
  c.add('main: A\'s handed-over home is kept beside the new one', fs.existsSync(`${A.home}.before-${back.state!.id}`) && readMarker(`${A.home}.before-${back.state!.id}`)?.state === 'handed-over')
}

// ---- the matrix: each scenario from "roles.leader leads, roles.other holds its copy" ----

interface Ctx { c: Checks; w: RemoteWorld; roles: Roles; carried: { tasks: Seeded['tasks']; notes: Seeded['notes']; pluginFiles: Seeded['pluginFiles'] }; times: Record<string, string>; log: (s: string) => void }

/** The kill points in the target job (on the new leader's machine): resumed there by hand; the rest in the source job, resumed with --resume. */
const TARGET_KILLS = new Set<string>(['during-wait-mark', 'during-promote', 'after-promote', 'during-trial', 'after-commit-majority', 'after-commit'])

/** The machine's key in the world, for its links. */
const keyOf = (w: RemoteWorld, m: Machine): 'a' | 'b' => (m === w.a ? 'a' : 'b')
const ownWitness = (w: RemoteWorld, m: Machine): 'w-a' | 'w-b' => (m === w.a ? 'w-a' : 'w-b')
const otherWitness = (w: RemoteWorld, m: Machine): 'w-a' | 'w-b' => (m === w.a ? 'w-b' : 'w-a')

/** A few writes on the leader the next switch must carry; and a fresh batch at the other machine. */
async function writeAndBatch(x: Ctx, label: string): Promise<void> {
  const { w, roles } = x
  for (let i = 0; i < 3; i++) {
    const title = `${label} ${i} ${randomBytes(3).toString('hex')}`
    const opId = `${label}-${i}-${randomBytes(4).toString('hex')}`.replace(/[^A-Za-z0-9-]/g, '-')
    const r = await w.api(roles.leader, 'POST', '/api/tasks', { title, project: 'Rehearsal' }, opId)
    if (r.status < 300) x.carried.tasks.push({ id: r.json.task.id, title, opId })
  }
  await waitForBatch(roles.other.standbyDir, Date.now(), 180_000)
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
  const t = await targetDone(r.state)
  r.target = t
  if (r.state?.step === 'done' && t?.step === 'done') { roles.leader = to; roles.other = from }
  return r
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
  c.add(`split after the handover: ${O.id} changed nothing (its home as before)`, before ? !!kept?.ok : !fs.existsSync(O.home), kept ? describeKept(kept) : (fs.existsSync(O.home) ? 'a home appeared' : 'no home made'))
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

/** Two witnesses down: the preflight refuses, and nothing changes on either machine (the homes by the manifest's classes). */
async function twoDown(x: Ctx): Promise<void> {
  const { c, w, roles } = x
  const L = roles.leader
  const O = roles.other
  await waitForBatch(O.standbyDir, Date.now(), 180_000)
  const down = ['w-k', otherWitness(w, L)] as const
  const homeO = fs.existsSync(O.home)
  const switchFiles = () => { try { return fs.readdirSync(path.join(O.standbyDir, 'switch')).sort() } catch { return [] } }
  const filesBefore = switchFiles()
  const stateBefore = readSwitchState(L.home)?.id ?? null
  const s0 = await snapshotHome(L.home)
  const o0 = homeO ? await snapshotHome(O.home) : null
  for (const id of down) w.witnessDown(id, true)
  let sw: Awaited<ReturnType<typeof switchCmd>> | null = null
  let control = new Set<string>()
  let changed = new Set<string>()
  try {
    // The control interval first: what the leader's home changes by itself with two witnesses gone, over a switch's time.
    const t0 = Date.now()
    await sleep(8_000)
    const s1 = await snapshotHome(L.home)
    control = new Set(compareKept(s0, s1).changed.map((ch) => ch.path))
    sw = await switchCmd(w, L, ['--to', O.id])
    await sleep(Math.max(0, 8_000 - (Date.now() - t0) / 2))
    changed = new Set(compareKept(s1, await snapshotHome(L.home)).changed.map((ch) => ch.path))
  } finally {
    for (const id of down) w.witnessDown(id, false)
  }
  c.add(`two witnesses down (${down.join(', ')}): the preflight refuses, naming what it lacks`, sw?.code === 1 && /witnesses answered|majority/.test(sw.out), last(sw?.out ?? '', 2))
  const byTheSwitch = [...changed].filter((p) => !control.has(p) && !/^(local\/leader-switch\/(may-act|server-leader\.log|source-job)|logs\/|local\/health-monitor\/)/.test(p))
  c.add(`two witnesses down: nothing changed on ${L.id} (no switch state, no marker, its home by the manifest's classes but what it changes by itself)`, readSwitchState(L.home)?.id === stateBefore && !readMarker(L.home) && byTheSwitch.length === 0, `changed by the refused switch: ${byTheSwitch.slice(0, 8).join(', ') || 'none'}; by the leader alone: ${[...control].slice(0, 5).join(', ') || 'none'}`)
  const o1 = homeO ? await snapshotHome(O.home) : null
  const keptO = o0 && o1 ? compareKept(o0, o1) : null
  c.add(`two witnesses down: nothing changed on ${O.id} (no switch file, its home as before)`, JSON.stringify(switchFiles()) === JSON.stringify(filesBefore) && (homeO ? !!keptO?.ok : !fs.existsSync(O.home)), `${keptO ? describeKept(keptO) : homeO ? '' : 'no home'}; switch files ${switchFiles().length - filesBefore.length} new`)
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
  trueAfter = await waitFor('the leader to act again', async () => ((await status(w, N))?.mayAct === true ? Date.now() - t1 : null), 120_000, 200).catch(() => NaN)
  const doors = readMayAct(N.home).filter((l) => l.event === 'door' && l.mayAct && l.t > t0 + (falseAfter || 0) && l.t < t1)
  x.times['new leader cut from the other witnesses: mayAct false after'] = `${falseAfter} ms (lease ${params.validMs} ms)`
  x.times['and true again after the links returned'] = `${trueAfter} ms`
  c.add(`cut after the commit: ${N.id}'s mayAct goes false within the lease (${params.validMs} ms) once it reaches only its own witness`, Number.isFinite(falseAfter) && falseAfter <= params.validMs + 5_000, `${falseAfter} ms`)
  c.add(`cut after the commit: it comes back once the witnesses answer, and nothing went through a door meanwhile`, Number.isFinite(trueAfter) && doors.length === 0, `true again after ${trueAfter} ms; ${doors.length} door line(s) while it could not act`)
}

/** A kill at each step of either job, resumed (on the machine whose job died): one leader, everything carried. */
async function kills(x: Ctx): Promise<void> {
  const { c, w, roles } = x
  for (const point of KILL_POINTS) {
    await writeAndBatch(x, `kill-${point}`)
    const L = roles.leader
    const target = TARGET_KILLS.has(point)
    let resumedOn = ''
    const r = await runSwitch(x, `kill ${point}`, {
      env: { WALNUT_LEADER_SWITCH_KILL_AT: point },
      during: target ? async (from, to) => {
        const st = await deadTarget(w, from, 300_000)
        if (!st) return
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
    const done = final.state?.step === 'done' && final.target?.step === 'done'
    const rolledBack = final.state?.step === 'rolled-back'
    c.add(`kill ${point}: the switch finishes or rolls back`, done || rolledBack, `first exit ${r.code}; resumed on ${resumedOn || 'none'}; source ${final.state?.step}; target ${final.target?.step}; ${final.state?.rollbackWhy?.slice(0, 120) ?? ''}`)
    await oneLeader(x, `kill ${point}`, roles.leader)
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
  c.add(`failed trial: ${O.id} runs no leader and its tried home is kept aside`, !w.side(O).runningServer() && fs.readdirSync(path.dirname(O.home)).some((n) => n.startsWith(`${path.basename(O.home)}.trial-failed-`)))
  await checkCarried(c, w, L, L, x.carried, 'failed trial')
}

/** The downtime over the copy link unslowed and at 20 Mbit/s (`slow {bytesPerSec: 2_500_000}`), and the time until every host is connected. */
async function measure(x: Ctx): Promise<void> {
  const { c, w, roles, times } = x
  for (const slow of [false, true]) {
    await writeAndBatch(x, slow ? 'measure-slow' : 'measure')
    const from = roles.leader
    const copy = from === w.a ? w.links.copy : w.links.bToA
    if (slow) copy.setMode('slow', { delayMs: 0, bytesPerSec: 2_500_000 })
    let r: Awaited<ReturnType<typeof runSwitch>>
    try {
      r = await runSwitch(x, slow ? 'measure at 20 Mbit/s' : 'measure unslowed')
    } finally {
      copy.setMode('pass')
    }
    const label = `${from.id} -> ${r.state?.to}, copy link ${slow ? 'at 20 Mbit/s' : 'unslowed'}`
    c.add(`measure: switch ${label} completes`, r.state?.step === 'done' && r.target?.step === 'done', `source ${r.state?.step}; target ${r.target?.step}`)
    times[`downtime ${label}`] = `${((r.target?.downtimeMs ?? NaN) / 1000).toFixed(1)} s`
    const N = roles.leader
    const t0 = Date.now()
    const followed = await waitFor('every host connected', async () => hostsConnected(w, N, [w.h.id, roles.other.id]), 180_000, 500).then(() => true).catch(() => false)
    const since = r.target?.readyAt ? Date.now() - Date.parse(r.target.readyAt) : NaN
    times[`every host connected to the new leader after done (${label})`] = followed ? `${(since / 1000).toFixed(1)} s` : `not within ${((Date.now() - t0) / 1000).toFixed(0)} s`
  }
}

const SCENARIOS: Array<[string, (x: Ctx) => Promise<void>]> = [
  ['split-after-handover', splitAfterHandover],
  ['split-after-stop', splitAfterStop],
  ['split-before-role', splitBeforeRole],
  ['witness-down', witnessDown],
  ['two-down', twoDown],
  ['cut-after-commit', cutAfterCommit],
  ['trial-fails', trialFails],
  ['kills', kills],
  ['measure', measure],
]
