/**
 * The leader-switch rehearsal's scenarios (scripts/leader-switch-rehearsal.ts runs them and
 * prints one line per check; tests/e2e/leader-switch-real.test.ts asserts them). Real servers
 * (rehearsal-server.ts) on synthetic homes, the real `walnut leader switch` command as its own
 * process, three local witnesses. Only a Claude CLI is absent (no scenario starts an agent).
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import YAML from 'yaml'
import Database from '../../src/lib/sqlite.js'
import { makeWorld, REPO, type Machine, type World } from './world.js'
import { standbyStatus } from '../../src/core/standby/index.js'
import { experimentalEnabled } from '../../src/core/experimental.js'
import { readMayAct, readMarker, type MayActLine } from '../../src/core/leader/switch/records.js'
import { readSwitchState } from '../../src/core/leader/switch/flow.js'

export interface Check { name: string; ok: boolean; detail: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class Checks {
  readonly all: Check[] = []
  constructor(private readonly print: (c: Check) => void = () => {}) {}
  add(name: string, ok: boolean, detail = ''): boolean {
    const c = { name, ok, detail }
    this.all.push(c)
    this.print(c)
    return ok
  }
  get ok(): boolean { return this.all.every((c) => c.ok) }
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 60_000, everyMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v as T
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(everyMs)
  }
}

/** A standby batch taken after `since` (ms) is current at `dir`. */
export async function waitForBatch(dir: string, since: number, timeoutMs = 120_000): Promise<number> {
  return waitFor(`a standby batch at ${dir}`, async () => {
    const s = await standbyStatus(dir).catch(() => null)
    return s?.batch && s.takenAt && Date.parse(s.takenAt) > since ? s.batch : null
  }, timeoutMs, 500)
}

async function status(w: World, m: Machine): Promise<{ mayAct: boolean; state?: string } | null> {
  const r = await w.api(m, 'GET', '/api/leader/status').catch(() => null)
  const p = (r?.json as { permit?: { mayAct?: boolean; state?: string } } | null)?.permit
  return p ? { mayAct: !!p.mayAct, state: p.state } : null
}

export interface Seeded {
  tasks: { id: string; title: string; opId: string }[]
  notes: { rel: string; content: string }[]
  pluginFiles: { rel: string; content: string }[]
  cronId: string | null
}

/** Real data shapes on A: tasks (with op ids), notes, plugin files, a routine. */
export async function seed(w: World, m: Machine, n = 10): Promise<Seeded> {
  const out: Seeded = { tasks: [], notes: [], pluginFiles: [], cronId: null }
  for (let i = 0; i < n; i++) {
    const title = `rehearsal task ${i} é中 ${randomBytes(3).toString('hex')}`
    const opId = `seed-${i}-${randomBytes(4).toString('hex')}`
    const r = await w.api(m, 'POST', '/api/tasks', { title, project: 'Rehearsal', description: `seeded ${i}` }, opId)
    if (r.status < 300) out.tasks.push({ id: r.json.task.id, title, opId })
  }
  for (let i = 0; i < Math.max(3, n / 2); i++) {
    const rel = `rehearsal/note-${i}.md`
    const content = `# Note ${i}\n\nLine with unicode ✓ and ${randomBytes(8).toString('hex')}\n`
    const r = await w.api(m, 'PUT', `/api/notes-v2/content/${rel}`, { content })
    if (r.status < 300) out.notes.push({ rel, content })
  }
  // A plugin's own file, written by its process outside Walnut's write gate.
  const rel = 'plugins/rehearsal-plugin/data/state.json'
  const content = JSON.stringify({ cursor: randomBytes(6).toString('hex'), at: Date.now() })
  fs.mkdirSync(path.join(m.home, path.dirname(rel)), { recursive: true })
  fs.writeFileSync(path.join(m.home, rel), content)
  out.pluginFiles.push({ rel, content })
  // A mail send the old leader claimed and never settled (the mail plugin's ledger shape).
  const mailDb = path.join(m.home, 'plugins', 'mail', 'plugin.sqlite')
  fs.mkdirSync(path.dirname(mailDb), { recursive: true })
  const db = new Database(mailDb)
  db.exec("CREATE TABLE IF NOT EXISTS sends (send_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, account_id TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, approval_kind TEXT, approval_ref TEXT, state TEXT NOT NULL DEFAULT 'pending', provider_message_id TEXT, error TEXT)")
  db.prepare('INSERT OR REPLACE INTO sends (send_id, draft_id, account_id, idempotency_key, state) VALUES (?, ?, ?, ?, ?)').run('s-1', 'd-1', 'acct', 'd-1:3', 'sending')
  db.close()
  const cron = await w.api(m, 'POST', '/api/cron', {
    name: 'Rehearsal routine', schedule: { kind: 'every', everyMs: 15_000 }, sessionTarget: 'main', wakeMode: 'next-cycle',
    payload: { kind: 'systemEvent', text: 'rehearsal routine fired' },
  })
  out.cronId = cron.status < 300 ? (cron.json?.id ?? cron.json?.job?.id ?? null) : null
  return out
}

/** Writes through A's API until it stops answering; every write it acknowledged is listed. */
export function startLoad(w: World, m: Machine): { stop(): Promise<Seeded['tasks']>; notes: Seeded['notes'] } {
  const acked: Seeded['tasks'] = []
  const notes: Seeded['notes'] = []
  let running = true
  const loop = (async () => {
    for (let i = 0; running; i++) {
      const title = `load ${i} ${randomBytes(3).toString('hex')}`
      const opId = `load-${i}-${randomBytes(4).toString('hex')}`
      try {
        const r = await w.api(m, 'POST', '/api/tasks', { title, project: 'Rehearsal load' }, opId)
        if (r.status < 300) acked.push({ id: r.json.task.id, title, opId })
        if (i % 3 === 0) {
          const rel = `rehearsal/load-${i}.md`
          const content = `load note ${i}\n`
          const n = await w.api(m, 'PUT', `/api/notes-v2/content/${rel}`, { content })
          if (n.status < 300) notes.push({ rel, content })
        }
      } catch {
        await sleep(100) // stopped or refused: not acknowledged
      }
    }
  })()
  return { notes, async stop() { running = false; await loop; return acked } }
}

export async function checkCarried(c: Checks, w: World, to: Machine, from: Machine, s: { tasks: Seeded['tasks']; notes: Seeded['notes']; pluginFiles: Seeded['pluginFiles'] }, label: string): Promise<void> {
  let bad: string[] = []
  for (const t of s.tasks) {
    const r = await w.api(to, 'GET', `/api/tasks/${t.id}`).catch(() => null)
    const title = r?.json?.task?.title ?? r?.json?.title
    if (r?.status !== 200 || title !== t.title) bad.push(`${t.id} (${r?.status})`)
  }
  c.add(`${label}: every task acknowledged on ${from.id} is on ${to.id}, by content`, bad.length === 0, `${s.tasks.length} tasks${bad.length ? `; missing or changed: ${bad.slice(0, 5).join(', ')}` : ''}`)
  bad = []
  for (const n of s.notes) {
    const r = await w.api(to, 'GET', `/api/notes-v2/content/${n.rel}`).catch(() => null)
    // The server stamps a note's id into its frontmatter when it creates it.
    const body = typeof r?.json?.content === 'string' ? r.json.content.replace(/^---\nid: [^\n]+\n---\n/, '') : null
    if (r?.status !== 200 || body !== n.content) bad.push(n.rel)
  }
  c.add(`${label}: every note acknowledged on ${from.id} is on ${to.id}, by content`, bad.length === 0, `${s.notes.length} notes${bad.length ? `; missing: ${bad.slice(0, 5).join(', ')}` : ''}`)
  bad = []
  for (const f of s.pluginFiles) {
    let got = ''
    try { got = fs.readFileSync(path.join(to.home, f.rel), 'utf8') } catch { /* missing */ }
    if (got !== f.content) bad.push(f.rel)
  }
  c.add(`${label}: plugin files are on ${to.id}, byte for byte`, bad.length === 0, `${s.pluginFiles.length} files`)
}

/** At no instant do both machines act: from the two homes' permission logs and their door calls. */
export function checkOneLeader(c: Checks, label: string, a: Machine, b: Machine, handoverAt: { stoppedAt?: string; commitAt?: string }): void {
  const la = readMayAct(a.home)
  const lb = readMayAct(b.home)
  const lastActA = Math.max(0, ...la.filter((l) => l.mayAct).map((l) => l.t))
  const firstActB = Math.min(Infinity, ...lb.filter((l) => l.mayAct && l.t > (handoverAt.stoppedAt ? Date.parse(handoverAt.stoppedAt) - 60_000 : 0)).map((l) => l.t))
  const stopped = handoverAt.stoppedAt ? Date.parse(handoverAt.stoppedAt) : NaN
  const doorsA = la.filter((l) => l.event === 'door' && l.mayAct)
  const doorsB = lb.filter((l) => l.event === 'door' && l.mayAct)
  const overlap = doorsA.filter((l) => l.t >= firstActB)
  c.add(`${label}: ${a.id} acted only before it stopped, ${b.id} only after the commit`, lastActA <= stopped && firstActB > stopped && overlap.length === 0,
    `${a.id}: last 'may act' at ${iso(lastActA)}, stopped ${handoverAt.stoppedAt}; ${b.id}: first 'may act' at ${iso(firstActB)}; doors allowed ${doorsA.length} on ${a.id}, ${doorsB.length} on ${b.id}`)
  // Kinds whose op id names one operation (a mail, a routine slot, a trigger fire); a periodic
  // upload's op id is a label of its kind, and the time check above covers it.
  const ONE_OPERATION = new Set(['mail-send', 'mail-unsubscribe', 'cron-fire', 'trigger-fire'])
  const ops = new Map<string, Set<string>>()
  for (const l of [...doorsA, ...doorsB]) {
    if (!ONE_OPERATION.has(l.kind ?? '')) continue
    const k = `${l.kind}:${l.opId}`
    ops.set(k, (ops.get(k) ?? new Set()).add(l.machine))
  }
  const both = [...ops].filter(([, s]) => s.size > 1).map(([k]) => k)
  c.add(`${label}: no outward operation went through a door on both machines`, both.length === 0, both.length ? both.slice(0, 5).join(', ') : `${ops.size} operations, each on one machine`)
}

function iso(t: number): string {
  return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : 'never'
}

export function cronDoorCalls(home: string): MayActLine[] {
  return readMayAct(home).filter((l) => l.event === 'door' && l.kind === 'cron-fire')
}

/** The main scenario: switch under load, every check, the classic mistake, switch back. */
export async function rehearseSwitchAndBack(root: string, print: (c: Check) => void, opts: { portA?: number; portB?: number; fillerGb?: number; noBack?: boolean; log?: (s: string) => void } = {}): Promise<{ checks: Checks; downtimeMs?: number; backDowntimeMs?: number }> {
  const log = opts.log ?? (() => {})
  const c = new Checks(print)
  const w = makeWorld(root, { portA: opts.portA ?? 4731, portB: opts.portB ?? 4732 })
  if (opts.fillerGb) await writeFiller(w.a.home, opts.fillerGb, log)
  const a = w.side(w.a)
  const b = w.side(w.b)
  try {
    const started = await a.startServer('leader', 300_000)
    if (!c.add('A starts as the leader with the write permission', started.ok && !!(await status(w, w.a))?.mayAct, started.why ?? '')) return { checks: c }
    const s = await seed(w, w.a, 10)
    c.add('seed: tasks, notes, a plugin file and a routine on A', s.tasks.length === 10 && s.notes.length >= 3 && !!s.cronId, `${s.tasks.length} tasks, ${s.notes.length} notes, routine ${s.cronId}`)
    const t0 = Date.now()
    await waitForBatch(w.b.standbyDir, t0, (opts.fillerGb ?? 0) > 1 ? 7_200_000 : 120_000)
    log(`first standby batch at B after ${((Date.now() - t0) / 1000).toFixed(1)} s`)
    // The first batch of a large home is old by the time it is complete (its moment is its
    // start): the switch's preflight wants a recent one, as a running standby keeps.
    const t1 = Date.now()
    await waitForBatch(w.b.standbyDir, t1, 1_800_000)
    log(`a current standby batch at B after another ${((Date.now() - t1) / 1000).toFixed(1)} s`)
    // A second plugin write while A runs (outside the gate): the final batch must carry it.
    const late = { rel: 'plugins/rehearsal-plugin/data/late.json', content: JSON.stringify({ late: randomBytes(4).toString('hex') }) }
    fs.writeFileSync(path.join(w.a.home, late.rel), late.content)
    const load = startLoad(w, w.a)
    await sleep(1_500)
    const sw = await w.cli(w.a.home, ['leader', 'switch', '--to', w.b.id])
    const acked = await load.stop()
    log(sw.out)
    const st = readSwitchState(w.a.home)
    if (!c.add('switch A -> B completes', sw.code === 0 && st?.step === 'done', `exit ${sw.code}; ${sw.out.trim().split('\n').slice(-4).join(' | ')}`)) return { checks: c }
    c.add('downtime measured (old leader stopped -> new leader ready)', typeof st?.downtimeMs === 'number', `${((st?.downtimeMs ?? NaN) / 1000).toFixed(1)} s`)
    c.add('B leads with the write permission', !!(await status(w, w.b))?.mayAct)
    c.add('a send A claimed and never settled is listed as outcome unknown, never sent again', (st?.outcomeUnknown ?? []).includes('mail d-1:3 (sending)'), JSON.stringify(st?.outcomeUnknown))
    await checkCarried(c, w, w.b, w.a, { tasks: [...s.tasks, ...acked], notes: [...s.notes, ...load.notes], pluginFiles: [...s.pluginFiles, late] }, 'A -> B')
    c.add('load ran across the switch', acked.length > 0, `${acked.length} tasks acknowledged by A during the switch`)
    // The applied-ops ledger came along under B's home: A's last ops replayed on B apply none twice.
    const before = (await w.api(w.b, 'GET', '/api/tasks?project=Rehearsal%20load')).json?.tasks?.length ?? -1
    const replay = acked.slice(-5)
    let replayed = 0
    for (const t of replay) {
      const r = await w.api(w.b, 'POST', '/api/tasks', { title: t.title, project: 'Rehearsal load' }, t.opId)
      if (r.headers.get('x-walnut-op-replayed') === '1' && r.json?.task?.id === t.id) replayed++
    }
    const after = (await w.api(w.b, 'GET', '/api/tasks?project=Rehearsal%20load')).json?.tasks?.length ?? -2
    c.add("replaying A's last accepted ops on B applies none twice", replayed === replay.length && before === after, `${replayed}/${replay.length} answered as replays; tasks ${before} -> ${after}`)
    checkOneLeader(c, 'A -> B', w.a, w.b, { stoppedAt: st?.stoppedAt })
    // The routine: every slot that went through the door went through it on one machine, once.
    const cronA = cronDoorCalls(w.a.home).filter((l) => l.mayAct)
    await sleep(17_000) // one more period of the 15 s routine, so a slot due during the switch is caught up on B
    const cronB = cronDoorCalls(w.b.home).filter((l) => l.mayAct)
    const slotsA = new Set(cronA.map((l) => l.opId))
    const slotsB = new Set(cronB.map((l) => l.opId))
    const twice = [...slotsA].filter((x) => slotsB.has(x))
    const dupA = cronA.length - slotsA.size
    const dupB = cronB.length - slotsB.size
    c.add('the routine fired each slot exactly once in total across the switch', twice.length === 0 && dupA === 0 && dupB === 0 && slotsB.size > 0,
      `${slotsA.size} slot(s) on A, ${slotsB.size} on B, ${twice.length} on both, repeats A ${dupA} B ${dupB}`)
    // The classic mistake: the old app started again by hand, online...
    const again = await a.startServer('leader', 60_000)
    c.add('A started again by hand after the commit does not lead (witnesses online)', !again.ok && /handed over/.test(again.logTail ?? ''), (again.logTail ?? '').split('\n').filter((l) => /leader/.test(l)).slice(-1).join(''))
    if (again.ok) await a.stopServer()
    // ...and with every witness unreachable.
    for (const x of w.witnesses) fs.renameSync(x.dir, `${x.dir}.off`)
    const offline = await a.startServer('leader', 60_000)
    for (const x of w.witnesses) fs.renameSync(`${x.dir}.off`, x.dir)
    c.add('A started again by hand with all witnesses unreachable does not lead', !offline.ok && /handed over/.test(offline.logTail ?? ''), (offline.logTail ?? '').split('\n').filter((l) => /leader/.test(l)).slice(-1).join(''))
    if (offline.ok) await a.stopServer()
    // Control: the marker is what refuses offline. Without it, A boots with its doors closed.
    const markerPath = path.join(w.a.home, 'local', 'leader-switch', 'handed-over.json')
    const saved = fs.readFileSync(markerPath)
    fs.rmSync(markerPath)
    for (const x of w.witnesses) fs.renameSync(x.dir, `${x.dir}.off`)
    const unmarked = await a.startServer('leader', 60_000)
    const unmarkedStatus = unmarked.ok ? await status(w, w.a) : null
    await a.stopServer()
    for (const x of w.witnesses) fs.renameSync(`${x.dir}.off`, x.dir)
    fs.writeFileSync(markerPath, saved)
    c.add('control: without the marker, A offline boots but acts on nothing (doors closed, waiting)', unmarked.ok && unmarkedStatus?.mayAct === false && unmarkedStatus?.state === 'waiting', JSON.stringify(unmarkedStatus))
    if (opts.noBack) return { checks: c, downtimeMs: st?.downtimeMs }
    // Switch back: B's writes come along.
    const onB: Seeded['tasks'] = []
    for (let i = 0; i < 5; i++) {
      const title = `written on B ${i} ${randomBytes(3).toString('hex')}`
      const opId = `b-${i}-${randomBytes(4).toString('hex')}`
      const r = await w.api(w.b, 'POST', '/api/tasks', { title, project: 'Rehearsal' }, opId)
      if (r.status < 300) onB.push({ id: r.json.task.id, title, opId })
    }
    const noteB = { rel: 'rehearsal/written-on-b.md', content: '# written on B\n' }
    await w.api(w.b, 'PUT', `/api/notes-v2/content/${noteB.rel}`, { content: noteB.content })
    await waitForBatch(w.a.standbyDir, Date.now(), (opts.fillerGb ?? 0) > 1 ? 7_200_000 : 120_000)
    const back = await w.cli(w.b.home, ['leader', 'switch', '--back'])
    log(back.out)
    const sb = readSwitchState(w.b.home)
    if (!c.add('switch back B -> A completes', back.code === 0 && sb?.step === 'done', `exit ${back.code}; ${back.out.trim().split('\n').slice(-3).join(' | ')}`)) return { checks: c, downtimeMs: st?.downtimeMs }
    c.add('A leads again with the write permission', !!(await status(w, w.a))?.mayAct)
    await checkCarried(c, w, w.a, w.b, { tasks: [...s.tasks, ...acked, ...onB], notes: [...s.notes, noteB], pluginFiles: [...s.pluginFiles, late] }, 'B -> A')
    c.add("A's handed-over home is kept beside the new one", fs.existsSync(`${w.a.home}.before-${sb!.id}`) && readMarker(`${w.a.home}.before-${sb!.id}`)?.state === 'handed-over')
    const bAgain = await b.startServer('leader', 60_000)
    c.add('B started again by hand after the switch back does not lead', !bAgain.ok && /handed over/.test(bAgain.logTail ?? ''))
    if (bAgain.ok) await b.stopServer()
    return { checks: c, downtimeMs: st?.downtimeMs, backDowntimeMs: sb?.downtimeMs }
  } finally {
    await a.stopServer().catch(() => {})
    await b.stopServer().catch(() => {})
  }
}

/**
 * Control for the ledger rewrite: the same switch without it, and A's last ops replayed on B
 * apply again (the ledger is keyed by the home's path). Red here is the expected result.
 */
export async function rehearseLedgerControl(root: string, print: (c: Check) => void, ports: { portA: number; portB: number }): Promise<Checks> {
  const c = new Checks(print)
  const w = makeWorld(root, { ...ports })
  const a = w.side(w.a)
  const b = w.side(w.b)
  try {
    if (!c.add('ledger control: A starts', (await a.startServer('leader', 300_000)).ok)) return c
    const s = await seed(w, w.a, 5)
    await waitForBatch(w.b.standbyDir, Date.now())
    const sw = await w.cli(w.a.home, ['leader', 'switch', '--to', w.b.id], { WALNUT_LEADER_SWITCH_SKIP_LEDGER_REWRITE: '1' })
    if (!c.add('ledger control: switch without the rewrite completes', sw.code === 0)) return c
    let applied = 0
    for (const t of s.tasks) {
      const r = await w.api(w.b, 'POST', '/api/tasks', { title: t.title, project: 'Rehearsal' }, t.opId)
      if (r.headers.get('x-walnut-op-replayed') !== '1') applied++
    }
    c.add('ledger control: without the rewrite, the replayed ops apply a second time on B (the bug the rewrite fixes)', applied === s.tasks.length, `${applied}/${s.tasks.length} applied again`)
    return c
  } finally {
    await a.stopServer().catch(() => {})
    await b.stopServer().catch(() => {})
  }
}

export const KILL_POINTS = ['after-handover', 'during-final-batch', 'during-promote', 'after-promote', 'during-trial', 'after-commit-majority', 'after-commit'] as const

/** Kill the switch command at one point, rerun it with --resume: one consistent leader results. */
export async function rehearseKill(root: string, point: typeof KILL_POINTS[number], print: (c: Check) => void, ports: { portA: number; portB: number }): Promise<Checks> {
  const c = new Checks(print)
  const w = makeWorld(root, { ...ports })
  const a = w.side(w.a)
  const b = w.side(w.b)
  try {
    if (!c.add(`kill ${point}: A starts`, (await a.startServer('leader', 300_000)).ok)) return c
    const s = await seed(w, w.a, 5)
    await waitForBatch(w.b.standbyDir, Date.now())
    const first = await w.cli(w.a.home, ['leader', 'switch', '--to', w.b.id], { WALNUT_LEADER_SWITCH_KILL_AT: point })
    c.add(`kill ${point}: the switch command died there`, first.signal === 'SIGKILL', `exit ${first.code} signal ${first.signal}; step ${readSwitchState(w.a.home)?.step}`)
    const resumed = await w.cli(w.a.home, ['leader', 'switch', '--resume'])
    const st = readSwitchState(w.a.home)
    const finished = st?.step === 'done' || st?.step === 'rolled-back'
    c.add(`kill ${point}: --resume finishes or rolls back`, finished && (resumed.code === 0 || resumed.code === 3 || /no switch from this home is under way/.test(resumed.out)), `step ${st?.step}; exit ${resumed.code}; ${resumed.out.trim().split('\n').slice(-2).join(' | ')}`)
    const sa = await status(w, w.a)
    const sbb = await status(w, w.b)
    const leaders = [sa?.mayAct ? 'A' : null, sbb?.mayAct ? 'B' : null].filter(Boolean)
    c.add(`kill ${point}: exactly one leader`, leaders.length === 1, `leaders: ${leaders.join(', ') || 'none'} (A ${JSON.stringify(sa)}, B ${JSON.stringify(sbb)})`)
    const leader = st?.step === 'done' ? w.b : w.a
    await checkCarried(c, w, leader, w.a, { tasks: s.tasks, notes: s.notes, pluginFiles: s.pluginFiles }, `kill ${point}`)
    return c
  } finally {
    await a.stopServer().catch(() => {})
    await b.stopServer().catch(() => {})
  }
}

/**
 * A switch killed after its commit stood (between the majority and the marker), then
 * cancelled by hand: a committed switch only goes forward, so the cancel finishes it, B leads.
 */
export async function rehearseCancelAfterCommit(root: string, print: (c: Check) => void, ports: { portA: number; portB: number }): Promise<Checks> {
  const c = new Checks(print)
  const w = makeWorld(root, { ...ports })
  const a = w.side(w.a)
  const b = w.side(w.b)
  try {
    if (!c.add('cancel after commit: A starts', (await a.startServer('leader', 300_000)).ok)) return c
    const s = await seed(w, w.a, 3)
    await waitForBatch(w.b.standbyDir, Date.now())
    const first = await w.cli(w.a.home, ['leader', 'switch', '--to', w.b.id], { WALNUT_LEADER_SWITCH_KILL_AT: 'after-commit-majority' })
    c.add('cancel after commit: the command died after the commit stood', first.signal === 'SIGKILL')
    const cancel = await w.cli(w.a.home, ['leader', 'switch', '--cancel'])
    const st = readSwitchState(w.a.home)
    c.add('cancel after commit: --cancel finishes the switch instead', st?.step === 'done' && cancel.code === 0, `step ${st?.step}; exit ${cancel.code}; ${cancel.out.trim().split('\n').slice(-2).join(' | ')}`)
    const sa = await status(w, w.a)
    const sbb = await status(w, w.b)
    c.add('cancel after commit: B leads, A does not', !!sbb?.mayAct && !sa?.mayAct, `A ${JSON.stringify(sa)}, B ${JSON.stringify(sbb)}`)
    await checkCarried(c, w, w.b, w.a, { tasks: s.tasks, notes: s.notes, pluginFiles: s.pluginFiles }, 'cancel after commit')
    return c
  } finally {
    await a.stopServer().catch(() => {})
    await b.stopServer().catch(() => {})
  }
}

/**
 * A switch cut off right after its handover record, then cancelled by hand while the old
 * leader still runs: the cancel stands, the old leader takes its permission back by itself.
 */
export async function rehearseCancel(root: string, print: (c: Check) => void, ports: { portA: number; portB: number }): Promise<Checks> {
  const c = new Checks(print)
  const w = makeWorld(root, { ...ports })
  const a = w.side(w.a)
  const b = w.side(w.b)
  try {
    if (!c.add('cancel: A starts', (await a.startServer('leader', 300_000)).ok)) return c
    const s = await seed(w, w.a, 3)
    await waitForBatch(w.b.standbyDir, Date.now())
    const first = await w.cli(w.a.home, ['leader', 'switch', '--to', w.b.id], { WALNUT_LEADER_SWITCH_KILL_AT: 'after-handover' })
    c.add('cancel: the command died after the handover record, A still running', first.signal === 'SIGKILL' && !!a.runningServer())
    const lost = await waitFor('A to see the handover', async () => (await status(w, w.a))?.mayAct === false, 40_000).catch(() => false)
    c.add('cancel: A stops acting once the handover stands', lost === true)
    const cancel = await w.cli(w.a.home, ['leader', 'switch', '--cancel'])
    c.add('cancel: --cancel rolls back', cancel.code === 3 && readSwitchState(w.a.home)?.step === 'rolled-back', cancel.out.trim().split('\n').slice(-1).join(''))
    const back = await waitFor('A to act again', async () => (await status(w, w.a))?.mayAct === true, 60_000).catch(() => false)
    c.add('cancel: A takes its permission back by itself, without a restart', back === true)
    await checkCarried(c, w, w.a, w.a, { tasks: s.tasks, notes: s.notes, pluginFiles: s.pluginFiles }, 'cancel')
    return c
  } finally {
    await a.stopServer().catch(() => {})
    await b.stopServer().catch(() => {})
  }
}

export const TRIAL_FAILURES = ['corrupt-database', 'missing-file', 'old-version'] as const

/** The trial finds a broken copy: the switch cancels and A leads again with everything. */
export async function rehearseTrialFailure(root: string, kind: typeof TRIAL_FAILURES[number], print: (c: Check) => void, ports: { portA: number; portB: number }): Promise<Checks> {
  const c = new Checks(print)
  const w = makeWorld(root, { ...ports })
  const a = w.side(w.a)
  const b = w.side(w.b)
  try {
    if (!c.add(`trial ${kind}: A starts`, (await a.startServer('leader', 300_000)).ok)) return c
    const s = await seed(w, w.a, 5)
    await waitForBatch(w.b.standbyDir, Date.now())
    const first = await w.cli(w.a.home, ['leader', 'switch', '--to', w.b.id], { WALNUT_LEADER_SWITCH_KILL_AT: 'after-promote' })
    c.add(`trial ${kind}: stopped after the copy became B's home`, first.signal === 'SIGKILL' && fs.existsSync(w.b.home))
    if (kind === 'corrupt-database') {
      const db = path.join(w.b.home, 'tasks', 'tasks.sqlite')
      const fd = fs.openSync(db, 'r+')
      fs.writeSync(fd, randomBytes(8192), 0, 8192, 4096)
      fs.closeSync(fd)
    } else if (kind === 'missing-file') {
      fs.rmSync(path.join(w.b.home, 'notes', s.notes[0]!.rel))
    } else {
      const cfgFile = path.join(w.a.home, 'config.yaml')
      const cfg = YAML.parse(fs.readFileSync(cfgFile, 'utf8'))
      cfg.leader_switch.machines[1].env.WALNUT_LEADER_SWITCH_FAKE_VERSION = '0.0.1'
      fs.writeFileSync(cfgFile, YAML.stringify(cfg))
    }
    const resumed = await w.cli(w.a.home, ['leader', 'switch', '--resume'])
    const st = readSwitchState(w.a.home)
    c.add(`trial ${kind}: the switch rolled back`, st?.step === 'rolled-back' && resumed.code === 3, `exit ${resumed.code}; why: ${st?.rollbackWhy?.slice(0, 200)}`)
    c.add(`trial ${kind}: A leads again`, !!(await status(w, w.a))?.mayAct)
    c.add(`trial ${kind}: no marker left on A, B not running`, !readMarker(w.a.home) && !b.runningServer())
    await checkCarried(c, w, w.a, w.a, { tasks: s.tasks, notes: s.notes, pluginFiles: s.pluginFiles }, `trial ${kind}`)
    return c
  } finally {
    await a.stopServer().catch(() => {})
    await b.stopServer().catch(() => {})
  }
}

/**
 * Restarts of the leader with witnesses set up: a planned one (SIGTERM: the server releases its
 * permission) closes the outward doors for seconds; a crash (SIGKILL: no release) until the
 * dead process's record runs out at the witnesses. A routine slot due while the doors were
 * closed fires once after they open, never twice.
 */
export async function rehearseRestart(root: string, print: (c: Check) => void, ports: { portA: number; portB: number }): Promise<Checks & { plannedMs?: number; crashMs?: number }> {
  const c = new Checks(print) as Checks & { plannedMs?: number; crashMs?: number }
  const w = makeWorld(root, { ...ports })
  const a = w.side(w.a)
  const firstActAfter = (t: number) => readMayAct(w.a.home).find((l) => l.t > t && l.mayAct && l.event !== 'door')?.t
  try {
    if (!c.add('restart: A starts as the leader', (await a.startServer('leader', 300_000)).ok)) return c
    await seed(w, w.a, 2)
    await sleep(16_000) // one routine slot fires before the restarts
    // Planned: SIGTERM, the server's stop releases the permission.
    await a.stopServer()
    const released = readMayAct(w.a.home).filter((l) => l.why === 'released (planned stop)').at(-1)
    c.add('restart: the planned stop released the permission', !!released)
    const startedP = await a.startServer('leader', 120_000)
    const okP = await waitFor('A to act after the planned restart', async () => (await status(w, w.a))?.mayAct === true, 120_000).then(() => true).catch(() => false)
    const openP = released ? firstActAfter(released.t) : undefined
    c.plannedMs = released && openP ? openP - released.t : undefined
    c.add('restart: after a planned restart the doors are closed under 5 s', startedP.ok && okP && c.plannedMs !== undefined && c.plannedMs < 5_000, `closed ${c.plannedMs ?? '?'} ms (release to the new process acting, its boot included)`)
    // Crash: SIGKILL, no release.
    const pid = a.runningServer()?.pid
    const killedAt = Date.now()
    if (pid) process.kill(pid, 'SIGKILL')
    await waitFor('A to be gone', async () => !a.runningServer(), 10_000).catch(() => null)
    const startedC = await a.startServer('leader', 120_000)
    const okC = await waitFor('A to act after the crash', async () => (await status(w, w.a))?.mayAct === true, 180_000).then(() => true).catch(() => false)
    const openC = firstActAfter(killedAt)
    c.crashMs = openC ? openC - killedAt : undefined
    c.add('restart: after a crash the doors open again once the dead process\'s record ran out', startedC.ok && okC && c.crashMs !== undefined, `closed ${c.crashMs ?? '?'} ms`)
    // The routine: a 15 s slot came due while the doors were closed; it fires once after they open.
    await sleep(20_000)
    const calls = cronDoorCalls(w.a.home).filter((l) => l.mayAct)
    const ids = calls.map((l) => l.opId)
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i)
    const afterCrash = calls.filter((l) => openC !== undefined && l.t >= openC)
    const duringClosed = calls.filter((l) => l.t > killedAt && openC !== undefined && l.t < openC)
    c.add('restart: no routine slot fired twice, none while the doors were closed, and the one due fired after they opened',
      dup.length === 0 && duringClosed.length === 0 && afterCrash.length >= 1, `${calls.length} fires, duplicates ${dup.join(',') || 'none'}, ${afterCrash.length} after the reopen`)
    return c
  } finally {
    await a.stopServer().catch(() => {})
  }
}

/** When the routine last ran, from the cron state (cron-state.json): null while it never did. */
function cronLastRun(home: string, id: string | null | undefined): number | null {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(home, 'cron-state.json'), 'utf8')) as { states?: Record<string, { lastRunAtMs?: number }> }
    return (id && state.states?.[id]?.lastRunAtMs) || null
  } catch { return null }
}

/**
 * The experiment on and no witnesses set up (its own switch on, and "every experiment on" too,
 * the worst case: since 0a42505506 "every experiment on" alone no longer turns this one on): the server boots, takes writes and fires a routine as before, and loads
 * no module of the permit or the switch but doors.ts (each door's call site imports it; it
 * imports nothing and does nothing while no checker is registered).
 */
export async function rehearseNoWitnesses(root: string, print: (c: Check) => void, ports: { portA: number; portB: number }): Promise<Checks> {
  const c = new Checks(print)
  const w = makeWorld(root, { ...ports })
  const cfgFile = path.join(w.a.home, 'config.yaml')
  const cfg = YAML.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.experimental.switchable_leader = true
  cfg.experimental.every_experiment = true
  delete cfg.leader_switch
  delete cfg.standby
  fs.writeFileSync(cfgFile, YAML.stringify(cfg))
  const trap = path.join(root, 'loaded-leader-modules.txt')
  fs.writeFileSync(trap, '')
  w.a.env = { ...w.a.env, WALNUT_REHEARSAL_LOAD_TRAP: trap }
  const a = w.side(w.a)
  try {
    c.add('no witnesses: A starts as before', (await a.startServer('leader', 300_000)).ok)
    const on = YAML.parse(fs.readFileSync(cfgFile, 'utf8')).experimental as Record<string, boolean>
    c.add('no witnesses: the experiment reads on (its own switch and every_experiment)', experimentalEnabled(on, 'switchable_leader') && on.every_experiment === true, JSON.stringify(on))
    const r = await w.api(w.a, 'GET', '/api/leader/status')
    c.add('no witnesses: no leader status route', r.status === 404, `status ${r.status}`)
    const s = await seed(w, w.a, 3)
    const fired = await waitFor('the routine to fire', async () => cronLastRun(w.a.home, s.cronId) !== null, 90_000).then(() => true).catch(() => false)
    c.add('no witnesses: a task is created and the routine fires', s.tasks.length === 3 && fired, `${s.tasks.length} tasks, routine last ran ${cronLastRun(w.a.home, s.cronId)}`)
    const written = ['may-act.jsonl', 'switch-state.json', 'handed-over.json', 'history.json', 'promoted.json'].filter((f) => fs.existsSync(path.join(w.a.home, 'local', 'leader-switch', f)))
    c.add('no witnesses: the server wrote nothing of the permit or the switch in its home', written.length === 0, written.join(', '))
    const loaded = [...new Set(fs.readFileSync(trap, 'utf8').split('\n').filter(Boolean).map((p) => path.relative(REPO, p)))].sort()
    c.add('no witnesses: no module of the permit or the switch was loaded but doors.ts', loaded.every((p) => p === path.join('src', 'core', 'leader', 'switch', 'doors.ts')), loaded.join(', ') || 'none')
    const witnessFiles = w.witnesses.map((x) => fs.readFileSync(path.join(x.dir, 'permit-record.json'), 'utf8'))
    c.add('no witnesses: the witnesses were never asked', witnessFiles.every((t) => JSON.parse(t).held === null))
    const sw = await w.cli(w.a.home, ['leader', 'switch', '--to', w.b.id])
    c.add('no witnesses: the switch command refuses and changes nothing', sw.code === 1 && /leader_switch/.test(sw.out) && !fs.existsSync(w.b.home), sw.out.trim().split('\n').slice(-1).join(''))
    return c
  } finally {
    await a.stopServer().catch(() => {})
  }
}

/** The experiment off: the boot path, the doors and the CLI as before. */
export async function rehearseFlagOff(root: string, print: (c: Check) => void, ports: { portA: number; portB: number }): Promise<Checks> {
  const c = new Checks(print)
  const w = makeWorld(root, { ...ports })
  const cfgFile = path.join(w.a.home, 'config.yaml')
  const cfg = YAML.parse(fs.readFileSync(cfgFile, 'utf8'))
  cfg.experimental.switchable_leader = false
  fs.writeFileSync(cfgFile, YAML.stringify(cfg))
  const a = w.side(w.a)
  try {
    c.add('flag off: A starts as before', (await a.startServer('leader', 300_000)).ok)
    const r = await w.api(w.a, 'GET', '/api/leader/status')
    c.add('flag off: no leader status route', r.status === 404, `status ${r.status}`)
    await seed(w, w.a, 2)
    // (local/leader-switch/server-leader.log is the rehearsal's own: its LocalSide started the server.)
    const written = ['may-act.jsonl', 'switch-state.json', 'handed-over.json', 'history.json'].filter((f) => fs.existsSync(path.join(w.a.home, 'local', 'leader-switch', f)))
    c.add('flag off: the server wrote nothing of the permit or the switch in its home', written.length === 0, written.join(', '))
    const sw = await w.cli(w.a.home, ['leader', 'switch', '--to', w.b.id])
    c.add('flag off: the switch command refuses and changes nothing', sw.code === 1 && /switchable_leader is off/.test(sw.out) && !fs.existsSync(w.b.home), sw.out.trim().split('\n').slice(-1).join(''))
    const witnessFiles = w.witnesses.map((x) => fs.readFileSync(path.join(x.dir, 'permit-record.json'), 'utf8'))
    c.add('flag off: the witnesses were never asked', witnessFiles.every((t) => JSON.parse(t).held === null))
    return c
  } finally {
    await a.stopServer().catch(() => {})
  }
}

/** Incompressible filler in a leader-data folder, so the home has a real size. */
export async function writeFiller(home: string, gb: number, log: (s: string) => void): Promise<void> {
  const dir = path.join(home, 'artifacts', 'rehearsal-filler')
  fs.mkdirSync(dir, { recursive: true })
  const fileMb = 256
  const files = Math.ceil((gb * 1024) / fileMb)
  const block = randomBytes(1024 * 1024)
  for (let i = 0; i < files; i++) {
    const fd = fs.openSync(path.join(dir, `blob-${i}.bin`), 'w')
    for (let j = 0; j < fileMb; j++) {
      block.writeUInt32LE(i * fileMb + j, 0) // every MiB differs, so no chunk dedupes
      fs.writeSync(fd, block)
    }
    fs.closeSync(fd)
    if (i % 10 === 0) log(`filler ${i + 1}/${files}`)
  }
  // Many small files too: a real home's notes and session files.
  const small = path.join(home, 'artifacts', 'rehearsal-small')
  for (let i = 0; i < 20_000; i++) {
    const d = path.join(small, String(i % 200))
    if (i < 200) fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, `f-${i}.md`), `small file ${i}\n`)
  }
}
