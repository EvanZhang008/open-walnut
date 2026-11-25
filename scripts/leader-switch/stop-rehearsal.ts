/**
 * The rehearsal's scenarios of the switch stop and the two jobs (docs/reference/leader-switch.md,
 * "The switch stop" and "Two jobs"): a writer that lands after the old leader's first final batch, a
 * signal during the final batch, the old leader's server killed in it, the old leader's own cancel when
 * no stop comes, a launcher that restarts what it sees stop during a switch, and `--status` on both
 * machines. Real servers (rehearsal-server.ts), the real command, three local witnesses, as rehearsal.ts.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { makeWorld, type Machine, type World } from './world.js'
import { Checks, checkCarried, seed, serverLog, status, waitFor, waitForBatch, type Check } from './rehearsal.js'
import { readSwitchOutcome as readSwitchState, readTargetState } from '../../src/core/leader/switch/flow.js'
import { readFinalStopResult, readMarker } from '../../src/core/leader/switch/records.js'
import { finalMarkName, readSwitchFile, type FinalMark } from '../../src/core/leader/switch/ticket.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
type Ports = { portA: number; portB: number }

/** Where machine B is reached when it leads, as the config names it (the old home's standby shows it). */
const DOOR_B = 'https://machine-b.example.test/walnut'

function serverPid(home: string): number | null {
  try { const p = (JSON.parse(fs.readFileSync(path.join(home, 'server.lock.json'), 'utf8')) as { pid?: number }).pid; return typeof p === 'number' ? p : null } catch { return null }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

/** The switch's command started (not awaited), and the moment its old leader's server sent its first final batch. */
async function switchUntilFirstFinalBatch(w: World, env: Record<string, string>): Promise<{ run: ReturnType<World['cli']>; batch: number; id: string }> {
  const run = w.cli(w.a.home, ['leader', 'switch', '--to', w.b.id], env)
  const id = await waitFor('the switch stop', async () => { const s = readSwitchState(w.a.home); return s && (s.step === 'stop-source' || s.step === 'wait-target') ? s.id : null }, 120_000, 100)
  // The final batch is one after the server's own "the switch stop begins": the last look right before the stop
  // (final-stop route) sends a batch too, and a signal in it is an ordinary stop.
  const begun = await waitFor('the switch stop begins', async () => {
    const l = serverLog(w.a).find((x) => x.switchId === id && /the switch stop begins/.test(String(x.message)))
    return l ? Date.parse(l.time) : null
  }, 120_000, 100)
  const batch = await waitForBatch(w.b.standbyDir, begun, 60_000)
  return { run, batch, id }
}

/**
 * A writer outside Walnut's write gate (a plugin's own process) lands after the old leader's first final
 * batch: the next batch carries it, the final mark names that later batch, and B has the file. Then the
 * old home's standby names B's door, and `--status` reads the switch on both machines.
 */
export async function rehearseLateWriter(root: string, print: (c: Check) => void, ports: Ports): Promise<Checks> {
  const c = new Checks(print)
  const w = makeWorld(root, { ...ports, doorsB: [DOOR_B] })
  const a = w.side(w.a)
  const b = w.side(w.b)
  try {
    if (!c.add('late writer: A starts', (await a.startServer('leader', 300_000)).ok)) return c
    const s = await seed(w, w.a, 3)
    await waitForBatch(w.b.standbyDir, Date.now())
    const { run, batch, id } = await switchUntilFirstFinalBatch(w, { WALNUT_LEADER_SWITCH_PAUSE_AFTER_FIRST_BATCH_MS: '6000' })
    const rel = 'plugins/rehearsal-plugin/data/late.json'
    const content = JSON.stringify({ late: randomBytes(6).toString('hex'), at: Date.now() })
    fs.writeFileSync(path.join(w.a.home, rel), content)
    const r = await run
    const st = readSwitchState(w.a.home)
    if (!c.add('late writer: the switch completes', r.code === 0 && st?.step === 'done', `exit ${r.code}; ${r.out.trim().split('\n').slice(-2).join(' | ')}`)) return c
    const mark = readSwitchFile<FinalMark>(w.b.standbyDir, finalMarkName(id))
    c.add('late writer: the final mark names a batch after the one the writer came after', !!mark && mark.batch > batch, `first final batch ${batch}, mark ${mark?.batch}; result ${JSON.stringify(readFinalStopResult(w.a.home, id))}`)
    let onB = ''
    try { onB = fs.readFileSync(path.join(w.b.home, rel), 'utf8') } catch { /* missing */ }
    c.add('late writer: the file written after the first final batch is on B, byte for byte', onB === content, onB ? `${onB.length} bytes` : 'missing on B')
    await checkCarried(c, w, w.b, w.a, s, 'late writer')
    c.add('late writer: the downtime includes the pause in the final batch', (st?.downtimeMs ?? 0) >= 6_000, `${((st?.downtimeMs ?? 0) / 1000).toFixed(1)} s`)
    // The old home names where B is reached: in its marker, its status, its refusal and its page.
    c.add('leader doors: the old home\'s marker names B\'s door', JSON.stringify(readMarker(w.a.home)?.leaderDoors) === JSON.stringify([DOOR_B]), JSON.stringify(readMarker(w.a.home)))
    const standby = await w.byHand(w.a, 'doors')
    try {
      const sj = standby.ok ? (await w.api(w.a, 'GET', '/api/leader/status')).json : null
      const write = standby.ok ? await w.api(w.a, 'POST', '/api/tasks', { title: 'x', project: 'Rehearsal' }) : null
      const page = standby.ok ? await fetch(`http://127.0.0.1:${w.a.port}/`, { signal: AbortSignal.timeout(10_000) }).then((x) => x.text()).catch(() => '') : ''
      c.add('leader doors: the old home\'s standby names B\'s door in its status, its 409 and its page',
        JSON.stringify(sj?.leaderDoors) === JSON.stringify([DOOR_B]) && JSON.stringify(write?.json?.leaderDoors) === JSON.stringify([DOOR_B]) && page.includes(DOOR_B),
        `status ${JSON.stringify(sj?.leaderDoors)}; 409 ${JSON.stringify(write?.json?.leaderDoors)}; page ${page.includes(DOOR_B) ? 'names it' : 'does not'}`)
      // --status on each machine: its own job, the witnesses as it reads them, both machines' notes.
      const sa = await w.cli(w.a.home, ['leader', 'switch', '--status'])
      const sb = await w.cli(w.b.home, ['leader', 'switch', '--status'], { ...w.b.env as Record<string, string> })
      const ja = parseJson(sa.out)
      const jb = parseJson(sb.out)
      c.add('--status on A: its source job done, the witnesses read, both machines\' notes', sa.code === 0 && ja?.source?.step === 'done' && ja?.source?.id === id && !!ja?.witnesses?.standing && ja?.notes?.[w.a.id]?.step === 'handed-off' && !!ja?.notes?.[w.b.id],
        `exit ${sa.code}; source ${ja?.source?.step}; witnesses ${JSON.stringify(ja?.witnesses)}; notes ${JSON.stringify(Object.fromEntries(Object.entries(ja?.notes ?? {}).map(([k, v]) => [k, (v as { step: string }).step])))}`)
      const tb = (jb?.targets as { id: string; step: string }[] | undefined)?.find((t) => t.id === id)
      c.add('--status on B: its target job done, the witnesses read, both machines\' notes', sb.code === 0 && jb?.machine === w.b.id && tb?.step === 'done' && !!jb?.witnesses?.standing && jb?.notes?.[w.b.id]?.step === 'done' && !!jb?.notes?.[w.a.id],
        `exit ${sb.code}; machine ${jb?.machine}; target ${JSON.stringify(tb)}; witnesses ${JSON.stringify(jb?.witnesses)}; ${sb.code ? sb.out.slice(-300) : ''}`)
    } finally {
      await standby.stop()
    }
    return c
  } finally {
    await a.stopServer().catch(() => {})
    await b.stopServer().catch(() => {})
  }
}

function parseJson(out: string): any {
  const i = out.indexOf('{')
  try { return i >= 0 ? JSON.parse(out.slice(i)) : null } catch { return null }
}

/** After a switch that did not happen: exactly A leads (and B is no leader), and B has no final mark. */
async function oneLeaderA(c: Checks, w: World, label: string, id: string): Promise<void> {
  const sa = await waitFor(`${label}: A leads`, async () => { const x = await status(w, w.a); return x?.mayAct ? x : null }, 240_000).catch(() => null)
  const sb = await status(w, w.b)
  c.add(`${label}: A leads again, B does not`, !!sa?.mayAct && !sb?.mayAct, `A ${JSON.stringify(sa)}, B ${JSON.stringify(sb)}`)
  c.add(`${label}: no final mark reached B`, !readSwitchFile(w.b.standbyDir, finalMarkName(id)), readSwitchFile(w.b.standbyDir, finalMarkName(id)) ? 'a mark is there' : 'none')
  const t = readTargetState(w.b.standbyDir, id)
  c.add(`${label}: B's job rolled back on its own`, t?.step === 'rolled-back', `target ${t?.step}: ${t?.rollbackWhy ?? ''}`)
}

/** A SIGTERM to the old leader's server during its final batch: the batch stops, no mark, the server ends within 60 s, the switch rolls back. */
export async function rehearseSignalInFinalBatch(root: string, print: (c: Check) => void, ports: Ports): Promise<Checks> {
  const c = new Checks(print)
  const w = makeWorld(root, { ...ports })
  const a = w.side(w.a)
  const b = w.side(w.b)
  try {
    if (!c.add('signal in the final batch: A starts', (await a.startServer('leader', 300_000)).ok)) return c
    const s = await seed(w, w.a, 3)
    await waitForBatch(w.b.standbyDir, Date.now())
    const pid = serverPid(w.a.home)
    const { run, id } = await switchUntilFirstFinalBatch(w, { WALNUT_LEADER_SWITCH_PAUSE_AFTER_FIRST_BATCH_MS: '30000' })
    const t0 = Date.now()
    if (pid) process.kill(pid, 'SIGTERM')
    while (pid && alive(pid) && Date.now() - t0 < 90_000) await sleep(100)
    const took = Date.now() - t0
    c.add('signal in the final batch: the old leader\'s server ends within 60 s', !!pid && !alive(pid) && took < 60_000, `${(took / 1000).toFixed(1)} s`)
    const res = readFinalStopResult(w.a.home, id)
    c.add('signal in the final batch: its result says the batch stopped, no mark written', !!res && !res.ok && /signal|SIGTERM/i.test(res.why ?? ''), JSON.stringify(res))
    const r = await run
    const st = readSwitchState(w.a.home)
    c.add('signal in the final batch: the switch rolls back', r.code === 3 && st?.step === 'rolled-back', `exit ${r.code}; ${st?.rollbackWhy}`)
    await oneLeaderA(c, w, 'signal in the final batch', id)
    await checkCarried(c, w, w.a, w.a, s, 'signal in the final batch')
    return c
  } finally {
    await a.stopServer().catch(() => {})
    await b.stopServer().catch(() => {})
  }
}

/** The old leader's server killed (SIGKILL) after its first final batch: no mark, the switch rolls back, A leads. */
export async function rehearseServerKilledInFinalBatch(root: string, print: (c: Check) => void, ports: Ports): Promise<Checks> {
  const c = new Checks(print)
  const w = makeWorld(root, { ...ports })
  const a = w.side(w.a)
  const b = w.side(w.b)
  try {
    if (!c.add('server killed in the final batch: A starts', (await a.startServer('leader', 300_000)).ok)) return c
    const s = await seed(w, w.a, 3)
    await waitForBatch(w.b.standbyDir, Date.now())
    const r = await w.cli(w.a.home, ['leader', 'switch', '--to', w.b.id], { WALNUT_LEADER_SWITCH_KILL_AT: 'server-during-final-batch' })
    const st = readSwitchState(w.a.home)
    c.add('server killed in the final batch: the switch rolls back, saying the old leader died before its final batch ended', r.code === 3 && st?.step === 'rolled-back' && /died before its final batch/.test(st?.rollbackWhy ?? ''), `exit ${r.code}; ${st?.rollbackWhy}`)
    await oneLeaderA(c, w, 'server killed in the final batch', st?.id ?? '?')
    await checkCarried(c, w, w.a, w.a, s, 'server killed in the final batch')
    return c
  } finally {
    await a.stopServer().catch(() => {})
    await b.stopServer().catch(() => {})
  }
}

/**
 * The source job dies right after the handover and nobody resumes it: the old leader's server cancels its own
 * handover after stop_wait_s and leads on, B's job sees it and rolls back; a later `--resume` rolls back too.
 */
export async function rehearseStopWait(root: string, print: (c: Check) => void, ports: Ports): Promise<Checks> {
  const c = new Checks(print)
  const w = makeWorld(root, { ...ports, leaderSwitch: { stop_wait_s: 10 } })
  const a = w.side(w.a)
  const b = w.side(w.b)
  try {
    if (!c.add('stop wait: A starts', (await a.startServer('leader', 300_000)).ok)) return c
    await seed(w, w.a, 3)
    await waitForBatch(w.b.standbyDir, Date.now())
    const first = await w.cli(w.a.home, ['leader', 'switch', '--to', w.b.id], { WALNUT_LEADER_SWITCH_KILL_AT: 'after-handover' })
    const id = readSwitchState(w.a.home)?.id ?? '?'
    c.add('stop wait: the source job died after the handover', first.code === 4, `exit ${first.code}`)
    const t0 = Date.now()
    const back = await waitFor('A leads on after its own cancel', async () => { const x = await status(w, w.a); return x?.mayAct ? x : null }, 120_000).catch(() => null)
    c.add('stop wait: with no switch stop, A cancels its handover and leads on, without a command', !!back, `${((Date.now() - t0) / 1000).toFixed(1)} s after the job died`)
    const t = await waitFor('B gives up', async () => { const x = readTargetState(w.b.standbyDir, id); return x?.step === 'rolled-back' ? x : null }, 120_000).catch(() => null)
    c.add('stop wait: B\'s job sees the take-back and rolls back on its own', !!t, `target ${readTargetState(w.b.standbyDir, id)?.step}: ${t?.rollbackWhy ?? ''}`)
    const resumed = await w.cli(w.a.home, ['leader', 'switch', '--resume'])
    c.add('stop wait: --resume afterwards rolls back (the stop is refused)', resumed.code === 3 && readSwitchState(w.a.home)?.step === 'rolled-back', `exit ${resumed.code}; ${readSwitchState(w.a.home)?.rollbackWhy}`)
    await oneLeaderA(c, w, 'stop wait', id)
    return c
  } finally {
    await a.stopServer().catch(() => {})
    await b.stopServer().catch(() => {})
  }
}

/** A launcher (the Mac app's, a service manager's) that starts a machine's server again whenever it exits. */
function fakeLauncher(m: Machine, log: string): { starts: number[]; stop(): Promise<void>; current(): number | null } {
  const starts: number[] = []
  let running = true
  let child: ReturnType<typeof spawn> | null = null
  const start = () => {
    if (!running) return
    const fd = fs.openSync(log, 'a', 0o600)
    const cmd = m.start!
    child = spawn(cmd[0]!, cmd.slice(1), { env: { ...process.env, ...m.env, OPEN_WALNUT_HOME: m.home }, detached: true, stdio: ['ignore', fd, fd] })
    fs.closeSync(fd)
    starts.push(child.pid!)
    child.on('exit', () => { child = null; if (running) setTimeout(start, 500) })
    child.unref()
  }
  start()
  return {
    starts,
    current: () => child?.pid ?? null,
    async stop() {
      running = false
      const pid = child?.pid
      if (!pid) return
      try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
      for (let i = 0; i < 300 && alive(pid); i++) await sleep(100)
      if (alive(pid)) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    },
  }
}

/**
 * The switch back B -> A while a launcher keeps A's home running (its standby): the switch stops it, the
 * launcher starts it again at once, and that start waits (no port, never leads) while the switch makes the
 * home; the switch's own servers lead. Once the switch's server stops, the waiting start ends and the
 * launcher's next one leads by the usual rules.
 */
export async function rehearseLauncherRace(root: string, print: (c: Check) => void, ports: Ports): Promise<Checks> {
  const c = new Checks(print)
  const w = makeWorld(root, { ...ports })
  const a = w.side(w.a)
  const b = w.side(w.b)
  let launcher: ReturnType<typeof fakeLauncher> | null = null
  try {
    if (!c.add('launcher race: A starts', (await a.startServer('leader', 300_000)).ok)) return c
    const s = await seed(w, w.a, 3)
    await waitForBatch(w.b.standbyDir, Date.now())
    const there = await w.cli(w.a.home, ['leader', 'switch', '--to', w.b.id])
    if (!c.add('launcher race: switch A -> B completes', there.code === 0, `exit ${there.code}; ${there.out.trim().split('\n').slice(-1).join('')}`)) return c
    launcher = fakeLauncher(w.a, path.join(w.a.dir, 'launcher.log'))
    const up = await waitFor('A\'s launcher start as the standby', async () => { const r = await w.api(w.a, 'GET', '/api/leader/status').catch(() => null); return r?.json?.standby === true ? r.json : null }, 120_000).catch(() => null)
    c.add('launcher race: A\'s launcher keeps its handed-over home up as the standby', !!up, JSON.stringify(up?.leader ?? null))
    await waitForBatch(w.a.standbyDir, Date.now())
    const t0 = Date.now()
    const back = await w.cli(w.b.home, ['leader', 'switch', '--back'])
    const st = readSwitchState(w.b.home)
    c.add('launcher race: the switch back completes while the launcher restarts A', back.code === 0 && st?.step === 'done', `exit ${back.code}; ${back.out.trim().split('\n').slice(-2).join(' | ')}`)
    const restarts = launcher.starts.length - 1
    c.add('launcher race: the launcher started A again, and the switch did not fight it (one or two restarts)', restarts >= 1 && restarts <= 2, `${restarts} restart(s): ${launcher.starts.join(', ')}`)
    const leaderPid = serverPid(w.a.home)
    const launcherPids = new Set(launcher.starts)
    c.add('launcher race: A is led by the switch\'s own server, not the launcher\'s', !!leaderPid && !launcherPids.has(leaderPid) && !!(await status(w, w.a))?.mayAct, `leader pid ${leaderPid}; launcher pids ${[...launcherPids].join(', ')}`)
    const waiting = launcher.current()
    const logText = fs.readFileSync(path.join(w.a.dir, 'launcher.log'), 'utf8')
    const waits = logText.match(/Walnut waits[^\n]*/g) ?? []
    c.add('launcher race: each launcher start during the switch waited, taking no port; the one now running still waits', !!waiting && alive(waiting) && waits.length >= restarts,
      `pid ${waiting}; ${waits.length} wait line(s): ${waits[0] ?? 'none'}`)
    // The switch's server stops (a planned stop): the waiting start ends, and the launcher's next start leads.
    await a.stopServer()
    const led = await waitFor('the launcher\'s next start leads', async () => { const x = await status(w, w.a); return x?.mayAct ? x : null }, 180_000).catch(() => null)
    const pid = serverPid(w.a.home)
    c.add('launcher race: once the switch\'s server stops, the launcher\'s next start leads by the usual rules', !!led && !!pid && launcher.starts.includes(pid) && !launcherPids.has(pid), `pid ${pid}; starts ${launcher.starts.join(', ')}`)
    await checkCarried(c, w, w.a, w.b, { tasks: s.tasks, notes: s.notes, pluginFiles: s.pluginFiles }, 'launcher race')
    return c
  } finally {
    await launcher?.stop().catch(() => {})
    await a.stopServer().catch(() => {})
    await b.stopServer().catch(() => {})
  }
}
