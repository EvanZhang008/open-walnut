/**
 * The cloud companion and the phone follow a leader switch (docs/reference/leader-switch.md, design
 * b2b-remote-side.md section 8 and the lead's Q6), every process real:
 *
 *   A (the Mac: machine-a, its own local daemon)  ─┐ the write permission on three witness dirs
 *   B (machine-b, its own local daemon)           ─┘ (leader_switch), one leader at a time
 *   devbox: one real remote daemon (session S), followed by whichever leads
 *   companion (WALNUT_CLOUD_MODE=1): trusts one `__local__` bridge (the `bridge-local` token, leader
 *     data), runs the backup leader, answers the phone (a device token paired while A led)
 *
 * The switch as `walnut leader switch` runs it (flow.ts), each step the real code: A's restart notice
 * set to the commit window (host-follow.ts announceSwitchStop), the handed-over marker, A's handover
 * record (POST /api/leader/handover), A's own daemon drops its trigger set and its bridge
 * (host-follow.ts dropOwnDaemonDuties, run inside A's server), A's server stops (TERM; its daemon
 * runs on), B's data dir is a copy of A's leader data made while A is stopped with the promotion
 * record, and B boots as the commit start. B is LATE: it boots past the restart notice, so the
 * companion's backup claims the dev box first and B takes it back.
 *
 * Scaled time (the world's T, tests/helpers/live-twin-mac.ts): the takeover window is 6 s for the
 * product's 60 s, so one test second stands for ten: the commit window (restart notice) 30 s for
 * 300 s, B late 36 s for 6 minutes. The permit's own clocks (validMs 60 s, renew 15 s) are not
 * scaled (they are not configurable), and the two-minute window of the one-bridge check is real time.
 *
 * Every measurement the report needs is printed as one `FOLLOW-EVIDENCE` JSON line at the end, and
 * with LSCF_EVIDENCE_DIR set the servers' and daemons' logs are copied there before the cleanup.
 *
 * The restart notice (measured 2026-11-23): A's heartbeats go through forwardMobileEventToBridge, which
 * a server whose permit no longer lets it act refuses at the outward door `companion-upload`
 * (web/routes/events-v1.ts). Sent at the stop (after the handover record), the notice never left A
 * and the companion claimed after the takeover window alone. So host-follow.ts announceSwitchStop
 * sends it right before the handover record, while A may still act; this test runs that order.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { liveWallsAvailable } from '../helpers/live-isolation.js'
import { daemonCall } from '../helpers/live-daemon.js'
import { homePathClass } from '../../src/core/home-manifest/index.js'
import { writeMarker, writePromoted } from '../../src/core/leader/switch/records.js'
import {
  KEEPER, T, api, bootStandby, companionLeads, companionOutwardLog, leaderControl, localDaemonCall, macIsUp, prepareStandby,
  setupTwinMac, sleep, stopLeaderServer, teardownTwinMac, waitFor, world,
} from '../helpers/live-twin-mac.js'

/** One test second stands for SCALE product seconds (T is 6 s for the 60 s takeover window). */
const SCALE = 60_000 / T
const COMMIT_WINDOW_MS = 300_000 / SCALE
const B_LATE_MS = 360_000 / SCALE
/** Real time, as the design states it. */
const ONE_BRIDGE_WINDOW_MS = 120_000
const RED_WINDOW_MS = 60_000
const SWITCH_ID = `sw-follow-${process.pid}`

// ---- what the test watches ---------------------------------------------------------------------

interface BookRec { home: string; walnutId: string; epoch: number; holder: 'primary' | 'backup'; backup: boolean }
interface Sample {
  t: number
  /** `since` of the companion's `__local__` bridge (null: none registered). */
  local: number | null
  leads: Array<{ host: string; epoch: number }>
  restartingUntil: number | null
  primaryLastSeenAt: number | null
  lastDecision: string | null
  /** The dev box's leader book on disk (tmp/leader), one entry per home it keys. */
  book: BookRec[]
  /** The dev box's leader.witness answer. */
  witness: Array<{ walnutId: string; epoch: number; holder: string; primaryConnected: boolean; primaryHeardAgoMs: number }> | null
  aBridge: boolean | null
  bBridge: boolean | null
  errors: string[]
}
const samples: Sample[] = []
const events: Array<{ t: number; what: string }> = []
const mark = (what: string) => { events.push({ t: Date.now(), what }); process.stdout.write(`[follow] ${new Date().toISOString()} ${what}\n`) }
/** Lines of the companion's log the checks read, with when they came. */
const companionLines: Array<{ t: number; line: string }> = []
let sampling = false
let sampler: Promise<void> | null = null

function watchLines(proc: ChildProcess | null, into: Array<{ t: number; line: string }>, re: RegExp): void {
  let buf = ''
  proc?.stderr?.on('data', (b: Buffer) => {
    buf += b.toString()
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (re.test(line)) into.push({ t: Date.now(), line })
    }
  })
}

function readBook(): BookRec[] {
  const out: BookRec[] = []
  const walk = (d: string, depth: number): void => {
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { if (depth < 4 && e.name !== 'streams') walk(p, depth + 1); continue }
      if (!e.name.endsWith('.json') || !d.split(path.sep).includes('leader')) continue
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'))
        if (j && j.v === 1 && typeof j.home === 'string' && typeof j.epoch === 'number') out.push({ home: j.home, walnutId: j.walnutId, epoch: j.epoch, holder: j.holder, backup: j.backup })
      } catch { /* being replaced */ }
    }
  }
  walk(world.devbox.dir, 0)
  return out.sort((a, b) => a.home.localeCompare(b.home))
}

async function bridgeUp(s: typeof world.primary): Promise<boolean | null> {
  if (!s.daemonDir || !fs.existsSync(path.join(s.daemonDir, 'daemon.port'))) return null
  const r = await localDaemonCall(s, { cmd: 'bridge.status', home: s.data }, 3_000)
  return r.ok === true ? r.connected === true : null
}

async function sampleOnce(): Promise<Sample> {
  const errors: string[] = []
  const soft = async <V>(what: string, fn: () => Promise<V>): Promise<V | null> => { try { return await fn() } catch (err) { errors.push(`${what}: ${String(err).slice(0, 120)}`); return null } }
  const t = Date.now()
  const [status, leader, witness, aBridge, bBridge] = await Promise.all([
    soft('status', () => api(world.companion, '/api/v1/status', { signal: AbortSignal.timeout(3_000) })),
    soft('leader', () => api(world.companion, '/api/leader', { signal: AbortSignal.timeout(3_000) })),
    soft('witness', () => daemonCall(world.devbox, { cmd: 'leader.witness' }, 3_000)),
    soft('a-bridge', () => bridgeUp(world.primary)),
    soft('b-bridge', () => bridgeUp(world.standby)),
  ])
  const local = ((status?.json.bridgeHosts ?? []) as Array<{ hostAlias: string; since: number }>).filter((b) => b.hostAlias === '__local__')
  if (local.length > 1) errors.push(`two __local__ rows: ${JSON.stringify(local)}`)
  return {
    t,
    local: status ? local[0]?.since ?? null : null,
    leads: (leader?.json.leading ?? []) as Sample['leads'],
    restartingUntil: leader?.json.restartingUntil ?? null,
    primaryLastSeenAt: leader?.json.primaryLastSeenAt ?? null,
    lastDecision: leader?.json.lastDecision ?? null,
    book: readBook(),
    witness: witness?.ok === true ? witness.walnuts : null,
    aBridge, bBridge, errors,
  }
}

function startSampling(): void {
  sampling = true
  sampler = (async () => {
    while (sampling) {
      const started = Date.now()
      samples.push(await sampleOnce())
      await sleep(Math.max(0, 1_000 - (Date.now() - started)))
    }
  })()
}

/** Every file under `dir` with its mtime and size. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const [k, v] of mtimes(dir)) out.set(k, `${v.mtime}:${v.size}`)
  return out
}
function mtimes(dir: string): Map<string, { mtime: number; size: number }> {
  const out = new Map<string, { mtime: number; size: number }>()
  const walk = (rel: string): void => {
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(r)
      else if (e.isFile()) { try { const st = fs.statSync(path.join(dir, r)); out.set(r, { mtime: st.mtimeMs, size: st.size }) } catch { /* gone */ } }
    }
  }
  walk('')
  return out
}
/** The files under `dir` last written inside [from, to). */
const writtenIn = (dir: string, from: number, to: number): string[] => [...mtimes(dir)].filter(([, v]) => v.mtime >= from && v.mtime < to).map(([k]) => k).sort()
/** Which device records of an auth.json changed between two of its texts (name: fields that changed). */
function authDiff(before: string, after: string): Record<string, string[]> {
  const devs = (t: string) => { try { return new Map(((JSON.parse(t).devices ?? []) as Array<Record<string, unknown>>).map((d) => [String(d.name), d])) } catch { return new Map() } }
  const a = devs(before)
  const b = devs(after)
  const out: Record<string, string[]> = {}
  for (const [name, d] of b) {
    const old = a.get(name) as Record<string, unknown> | undefined
    const keys = [...new Set([...Object.keys(d), ...Object.keys(old ?? {})])].filter((k) => JSON.stringify(d[k]) !== JSON.stringify(old?.[k]))
    if (!old || keys.length) out[name] = old ? keys : ['(new)']
  }
  return out
}
/** A child the companion started that reaches the network or another machine (a local git read is not one). */
const OUTWARD_CHILD = /\b(git\s+(push|fetch|pull|clone|ls-remote|remote\s+update)|curl|wget|ssh|scp|rsync|sendmail|osascript)\b/

/** Collapse a sequence to its changes. */
function changes<V>(xs: V[], key: (v: V) => string): V[] {
  const out: V[] = []
  let last = ''
  for (const x of xs) { const k = key(x); if (k !== last) { out.push(x); last = k } }
  return out
}

/** The switch's moments (ms since epoch), filled as it runs. */
const at = { aStop: 0, claim: 0, bBoot: 0, bLeads: 0, bTookBack: 0, bBridge: 0, released: 0, bRegistered: 0, baselineFrom: 0, baselineTo: 0 }
const facts: Record<string, any> = {}
let authAtStop = ''
const authFile = () => path.join(world.companion.data, 'auth.json')
const readText = (f: string) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }

describe.skipIf(!liveWallsAvailable())('the companion and the phone follow a leader switch from A to B (real servers, real daemons)', () => {
  beforeAll(async () => {
    await setupTwinMac('lscf-', '', {
      leaderSwitch: true,
      recordCompanionOutward: true,
      // The grace of a plain stop, scaled as the commit window (A's switch stop sets the notice itself).
      macEnv: { WALNUT_LEADER_RESTART_GRACE_MS: String(COMMIT_WINDOW_MS) },
    })
    watchLines(world.companion.proc, companionLines, /bridge: |backup leader: |leader: /)
    process.stdout.write(`leader-switch-companion-follow: world at ${world.base}\n`)
  }, 400_000)
  afterAll(async () => {
    sampling = false
    await sampler?.catch(() => {})
    process.stdout.write(`FOLLOW-EVIDENCE ${JSON.stringify({ at, facts, events })}\n`)
    const keep = process.env.LSCF_EVIDENCE_DIR
    if (keep && world.base) {
      fs.mkdirSync(keep, { recursive: true })
      for (const s of [world.primary, world.standby, world.companion]) if (s.log) fs.writeFileSync(path.join(keep, `${s.name}.log`), s.log)
      for (const d of world.daemons) for (const f of fs.readdirSync(d.dir).filter((x) => /\.log$/.test(x))) fs.copyFileSync(path.join(d.dir, f), path.join(keep, `${d.name}-${f}`))
      fs.writeFileSync(path.join(keep, 'samples.json'), JSON.stringify(samples))
      fs.writeFileSync(path.join(keep, 'companion-lines.json'), JSON.stringify(companionLines))
      if (fs.existsSync(companionOutwardLog())) fs.copyFileSync(companionOutwardLog(), path.join(keep, 'companion-outward.jsonl'))
    }
    await teardownTwinMac()
  }, 600_000)

  it('A leads on the witnesses: it holds the permit, leads devbox, and its own daemon holds the companion\'s __local__ bridge', async () => {
    await macIsUp()
    const st = await waitFor(async () => {
      const r = await api(world.primary, '/api/leader/status')
      return r.json.permit?.state === 'leading' ? r.json : null
    }, 120_000, 'A to lead on the witnesses')
    facts.aPermit = { state: st.permit.state, record: st.permit.record?.number ?? null, machine: st.machine, homeOnHosts: st.homeOnHosts }
    await waitFor(async () => (await bridgeUp(world.primary)) === true, 60_000, 'A\'s daemon bridge up')
    await waitFor(async () => (await sampleOnce()).local !== null, 60_000, 'the companion to hold __local__')
    const hb = await waitFor(async () => { const r = await api(world.companion, '/api/leader'); return r.json.walnutId ? r.json : null }, 60_000, 'the companion to know the Walnut')
    facts.walnutId = hb.walnutId
    facts.bookBefore = readBook()
    expect(facts.bookBefore).toHaveLength(1)
    expect(facts.bookBefore[0]).toMatchObject({ home: world.primary.data, holder: 'primary', backup: true })
    // A's bridge as A's server configured it, for the red case (the state without the drop).
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name === 'bridge.json' ? [path.join(d, e.name)] : [])
    facts.aBridgeConfig = walk(world.primary.daemonDir).map((f) => JSON.parse(fs.readFileSync(f, 'utf8'))).find((c) => c.home === world.primary.data && c.enabled) ?? null
    expect(facts.aBridgeConfig, 'A\'s daemon keeps its bridge config').not.toBeNull()
    startSampling()
    // The baseline of what the companion writes while A leads and the same probes run (the backup window is compared to it).
    at.baselineFrom = Date.now()
    await sleep(45_000)
    at.baselineTo = Date.now()
  }, 400_000)

  it('the switch: A hands over and stops, the backup claims devbox, B boots late and takes it back with a higher epoch', async () => {
    const ls = world.leaderSwitch!
    // The flow's order: the marker, the restart notice (sent now, while A may still act), then the handover record.
    writeMarker(world.primary.data, { switchId: SWITCH_ID, to: ls.b.id, state: 'switching', at: new Date().toISOString() })
    const notice = await leaderControl(world.primary, `/restart-notice?ms=${COMMIT_WINDOW_MS}`)
    expect(notice.restartingMs).toBe(COMMIT_WINDOW_MS)
    mark('A announced its stop for the commit window')
    const before = (await api(world.primary, '/api/leader/status')).json.permit
    facts.aPermitAtHandover = { state: before?.state ?? null, record: before?.record ?? null }
    const handover = await api(world.primary, '/api/leader/handover', { method: 'POST', body: JSON.stringify({ to: ls.b.id }) })
    expect(handover.status, handover.text).toBe(200)
    const h = Number(handover.json.record)
    facts.handover = h
    writeMarker(world.primary.data, { switchId: SWITCH_ID, to: ls.b.id, state: 'switching', handover: h, at: new Date().toISOString() })
    mark(`A handed over (record ${h})`)
    // Before the stop: A's own daemon drops its trigger set and its bridge, inside A's process.
    const dropped = await leaderControl(world.primary, '/drop-duties')
    facts.drop = dropped
    expect(dropped).toMatchObject({ ok: true, triggers: true, bridge: true })
    mark('A dropped its daemon duties')
    await stopLeaderServer(world.primary)
    at.aStop = Date.now()
    authAtStop = readText(authFile())
    mark('A stopped (TERM, exit proven); its daemon runs on')
    await sleep(2_000)
    const afterStop = (await api(world.companion, '/api/leader')).json
    facts.companionAfterStop = { restartingUntil: afterStop.restartingUntil, primaryLastSeenAt: afterStop.primaryLastSeenAt, restartNoticeMs: afterStop.restartingUntil && afterStop.primaryLastSeenAt ? afterStop.restartingUntil - afterStop.primaryLastSeenAt : null }

    facts.copiedFiles = await prepareStandby({ switchId: SWITCH_ID, handover: h })
    mark(`B's data dir: ${facts.copiedFiles} files of A's leader data`)

    // The backup claims devbox while B is late.
    await waitFor(async () => (await companionLeads()).some((l) => l.host === KEEPER), COMMIT_WINDOW_MS + 10 * T + 30_000, 'the companion\'s backup to claim devbox')
    facts.aDaemonAfterStop = { bridge: await bridgeUp(world.primary) }
    at.claim = Date.now()
    facts.claim = { leads: await companionLeads(), book: readBook(), afterStopMs: at.claim - at.aStop }
    mark(`the backup leads devbox ${at.claim - at.aStop} ms after A's stop`)
    const late = at.aStop + B_LATE_MS - Date.now()
    if (late > 0) await sleep(late)
    // Still led by the backup when B comes.
    expect((await companionLeads()).map((l) => l.host)).toContain(KEEPER)

    at.bBoot = Date.now()
    await bootStandby({ commitHandover: h })
    mark(`B booted ${at.bBoot - at.aStop} ms after A's stop`)
    const bst = await waitFor(async () => {
      const r = await api(world.standby, '/api/leader/status')
      return r.json.permit?.state === 'leading' && (r.json.permit.record?.number ?? 0) > h ? r.json : null
    }, 180_000, 'B to commit on the witnesses')
    at.bLeads = Date.now()
    facts.bPermit = { state: bst.permit.state, record: bst.permit.record?.number ?? null, holder: bst.permit.record?.holder ?? null, machine: bst.machine }
    mark(`B leads on the witnesses (record ${facts.bPermit.record})`)
    await waitFor(async () => (await api(world.standby, '/api/leader')).json.hosts?.[KEEPER]?.holder === 'primary', 120_000, 'B to take devbox back')
    at.bTookBack = Date.now()
    mark('B holds devbox')
    await waitFor(async () => (await companionLeads()).length === 0, 60_000, 'the backup to step back')
    at.released = Date.now()
    mark('the backup leads nothing')
    // flow.ts after the commit stood: A's home handed over, B's promotion led.
    writeMarker(world.primary.data, { switchId: SWITCH_ID, to: ls.b.id, state: 'handed-over', handover: h, commit: facts.bPermit.record, at: new Date().toISOString() })
    writePromoted(world.standby.data, { switchId: SWITCH_ID, state: 'led', from: world.primary.data, to: ls.b.id, handover: h, fromHomeOnHosts: world.primary.data, fromFormerHomes: [], at: new Date().toISOString() })
    await waitFor(async () => (await bridgeUp(world.standby)) === true && (await sampleOnce()).local !== null, 120_000, 'B\'s daemon to hold __local__')
    at.bBridge = Date.now()
    // When the companion registered B's daemon as __local__ (its own clock: the registry's `since`).
    at.bRegistered = samples.find((x) => x.t >= at.bBoot && x.local !== null)?.local ?? at.bBridge
    mark('B\'s daemon holds __local__')
    facts.bookAfter = readBook()
  }, 900_000)

  it('the phone\'s /api/v1 through the companion reaches B, with the token paired while A led', async () => {
    const created = await api(world.standby, '/api/tasks', { method: 'POST', body: JSON.stringify({ title: `Made on B after the switch ${SWITCH_ID}`, project: 'Acme' }) })
    expect(created.status, created.text).toBe(201)
    const id = created.json.task.id as string
    const t0 = Date.now()
    const phoneGet = async (p: string) => {
      const res = await fetch(`http://127.0.0.1:${world.companion.port}${p}`, { headers: { Authorization: `Bearer ${world.tokens.phone}` }, signal: AbortSignal.timeout(20_000) })
      return { status: res.status, by: res.headers.get('x-walnut-answered-by'), text: await res.text() }
    }
    // A read the companion forwards (policy.ts: a task's sessions are not in its task copy): only B knows this task.
    let tries = 0
    const answered = await waitFor(async () => {
      tries++
      const r = await phoneGet(`/api/v1/tasks/${id}/sessions`)
      return r.status === 200 && r.by === 'primary' ? r : null
    }, 60_000, 'the phone to get B\'s answer through the companion')
    facts.phone = { status: answered.status, by: answered.by, body: answered.text.slice(0, 200), taskOnB: id, msAfterCreate: Date.now() - t0, msAfterBTookBack: Date.now() - at.bTookBack, tries }
    // The companion's own task copy (it answers GET /tasks itself): how soon it shows B's task.
    const copy = await waitFor(async () => { const r = await phoneGet('/api/v1/tasks'); return r.status === 200 && r.text.includes(id) ? r : null }, 60_000, 'B\'s task in the companion\'s task copy')
      .then((r) => ({ shown: true, by: r.by, msAfterCreate: Date.now() - t0 })).catch(() => ({ shown: false, msWaited: Date.now() - t0 }))
    facts.phone.taskCopy = copy
    expect(answered.status).toBe(200)
    expect(answered.by).toBe('primary')
  }, 180_000)

  it('A brought back: its old home is refused on devbox and moves nothing there, B keeps devbox at its epoch', async () => {
    const before = readBook()
    const asA = { home: world.primary.data, walnutId: facts.walnutId }
    // What A's server's link would send first, from a socket of this test (a link mended).
    const configure = await daemonCall(world.devbox, { cmd: 'leader.configure', ...asA, backup: true }, 10_000)
    const claim = await daemonCall(world.devbox, { cmd: 'leader.claim', home: asA.home }, 10_000)
    const triggers = await daemonCall(world.devbox, { cmd: 'triggers.configure', home: asA.home, config: { version: 1, triggers: [] } }, 10_000)
    facts.aBack = { configure, claim, triggers }
    expect(configure.ok, JSON.stringify(configure)).not.toBe(true)
    expect(claim.ok, JSON.stringify(claim)).not.toBe(true)
    expect(triggers.ok, JSON.stringify(triggers)).not.toBe(true)
    expect(readBook()).toEqual(before)
    expect((await api(world.standby, '/api/leader')).json.hosts?.[KEEPER]).toMatchObject({ holder: 'primary' })
  }, 120_000)

  it('exactly one __local__ bridge, held by B\'s daemon, for two minutes after the switch (sampled every second)', async () => {
    const end = at.bBridge + ONE_BRIDGE_WINDOW_MS
    if (Date.now() < end) await sleep(end - Date.now() + 1_500)
    const win = samples.filter((s) => s.t >= at.bBridge && s.t <= end)
    const replaced = companionLines.filter((l) => l.t >= at.bBridge && l.t <= end && /replacing existing connection|superseded/.test(l.line) && l.line.includes('__local__'))
    const sinces = [...new Set(win.map((s) => s.local))]
    const bad = win.filter((s) => s.local === null || s.bBridge !== true || s.aBridge !== false || s.errors.length > 0)
    const gap = samples.filter((s) => s.t >= at.aStop && s.t < at.bBridge && s.local === null)
    facts.oneBridge = {
      samples: win.length, windowMs: ONE_BRIDGE_WINDOW_MS, sinces, replaced: replaced.length, bad: bad.slice(0, 5),
      noLocalBeforeB: gap.length,
      replacedWhileANotStopped: companionLines.filter((l) => l.t < at.aStop && /replacing existing connection/.test(l.line) && l.line.includes('__local__')).length,
    }
    expect(win.length).toBeGreaterThanOrEqual(ONE_BRIDGE_WINDOW_MS / 1_000 - 10)
    expect(bad, JSON.stringify(bad.slice(0, 3))).toEqual([])
    expect(sinces, 'one registration of __local__ for the whole window').toHaveLength(1)
    expect(replaced.map((l) => l.line)).toEqual([])
  }, ONE_BRIDGE_WINDOW_MS + 120_000)

  it('Q6: the companion heard A\'s restart notice (the commit window) and claimed devbox only after it', () => {
    const n = facts.companionAfterStop as { restartingUntil: number | null; primaryLastSeenAt: number; restartNoticeMs: number | null }
    facts.notice = { heard: n.restartingUntil !== null, noticeMs: n.restartNoticeMs, claimAfterStopMs: at.claim - at.aStop }
    expect(n.restartNoticeMs, 'the restart notice never reached the companion (announceSwitchStop must run before the handover record)').toBe(COMMIT_WINDOW_MS)
    expect(at.claim - n.primaryLastSeenAt).toBeGreaterThanOrEqual(COMMIT_WINDOW_MS)
  })

  it('Q6: never two primaries on devbox, epochs only rise, the backup stepped back', () => {
    const books = samples.filter((s) => s.t >= at.aStop - 5_000)
    // One record the whole time: B's home is the alias of A's there (the declared move), never a Walnut of its own.
    const homesSeen = [...new Set(books.flatMap((s) => s.book.map((b) => b.home)))]
    const seq = changes(books.map((s) => s.book[0]).filter(Boolean), (b) => `${b.holder}:${b.epoch}`).map((b) => ({ holder: b.holder, epoch: b.epoch }))
    const witnessSeq = changes(books.map((s) => s.witness?.[0]).filter(Boolean) as NonNullable<Sample['witness']>[number][], (w) => `${w.holder}:${w.epoch}`).map((w) => ({ holder: w.holder, epoch: w.epoch }))
    const leadsAfter = samples.filter((s) => s.t >= at.released).filter((s) => s.leads.length > 0)
    facts.q6 = { homesSeen, bookSequence: seq, witnessSequence: witnessSeq, leadsAfterRelease: leadsAfter.length, decisions: changes(books.map((s) => s.lastDecision ?? ''), (d) => d) }
    expect(books.every((s) => s.book.length <= 1), `homes on devbox: ${JSON.stringify(homesSeen)}`).toBe(true)
    expect(homesSeen).toEqual([world.primary.data])
    expect(seq.map((x) => x.holder)).toEqual(['primary', 'backup', 'primary'])
    for (let i = 1; i < seq.length; i++) expect(seq[i]!.epoch).toBeGreaterThan(seq[i - 1]!.epoch)
    expect(seq[1]!.epoch).toBe(seq[0]!.epoch + 1)
    expect(seq[2]!.epoch).toBe(seq[1]!.epoch + 1)
    // A was gone before B started: the two never held at once.
    expect(at.aStop).toBeLessThan(at.bBoot)
    expect(leadsAfter).toEqual([])
  })

  it('Q6: the companion sent nothing outward and wrote no leader data while it led devbox', () => {
    // The backup's window: from A's stop until the companion registered B's daemon (after that B leads and writes).
    const from = at.aStop
    const to = at.bRegistered
    const own = new Set([`127.0.0.1:${world.companion.port}`, `localhost:${world.companion.port}`])
    const lines = fs.existsSync(companionOutwardLog()) ? fs.readFileSync(companionOutwardLog(), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { t: number; kind: string; what: string }) : []
    const inWindow = lines.filter((l) => l.t >= from && l.t <= to)
    const distinct = [...new Set(inWindow.map((l) => `${l.kind} ${l.what.replace(/\/api\/[^\s?]*/, (m) => m.split('/').slice(0, 4).join('/'))}`))]
    const outward = inWindow.filter((l) => {
      if (l.kind === 'child') return OUTWARD_CHILD.test(l.what)
      const target = l.kind === 'fetch' ? (/^\w+ \w+:\/\/([^/]+)/.exec(l.what)?.[1] ?? l.what) : l.what
      return !own.has(target) && !target.startsWith('unix:')
    })
    const cls = (rel: string, prefix = '') => ({ rel, cls: homePathClass(prefix + rel) })
    const companionWrites = writtenIn(world.companion.data, from, to).map((r) => cls(r))
    const baselineWrites = writtenIn(world.companion.data, at.baselineFrom, at.baselineTo).map((r) => cls(r))
    const devboxWrites = writtenIn(world.devbox.dir, from, to).map((r) => cls(r, 'tmp/'))
    const leaderData = (xs: Array<{ rel: string; cls: string }>) => xs.filter((x) => x.cls === 'leader-data').map((x) => x.rel)
    const doorLines = companionLines.filter((l) => l.t >= from && l.t <= to && /git push|sendMail|mail-send|apns|calendar|plugin.*fetch/i.test(l.line))
    facts.companionOut = { windowMs: to - from, recorded: inWindow.length, distinct, outward: outward.slice(0, 20), doorLines: doorLines.map((l) => l.line.slice(0, 200)) }
    facts.writes = {
      companionLeaderData: leaderData(companionWrites),
      companionLeaderDataBaseline: leaderData(baselineWrites),
      authJsonChangedDevices: authDiff(authAtStop, readText(authFile())),
      companion: companionWrites.map((c) => `${c.cls} ${c.rel}`),
      devboxLeaderData: leaderData(devboxWrites),
      devbox: devboxWrites.map((c) => `${c.cls} ${c.rel}`),
    }
    expect(outward, JSON.stringify(outward.slice(0, 10))).toEqual([])
    expect(doorLines.map((l) => l.line)).toEqual([])
    expect(facts.writes.devboxLeaderData).toEqual([])
    // A path of leader-data class the companion writes while A leads too is its follower copy, not the backup's.
    expect(leaderData(companionWrites).filter((r) => !leaderData(baselineWrites).includes(r)), JSON.stringify(facts.writes)).toEqual([])
  })

  it('measures what the backup claimed with, next to the permit numbers', () => {
    const claims = companionLines.filter((l) => /backup leader: (leads host|claim)/.test(l.line)).map((l) => l.line.slice(0, 400))
    const refusals = companionLines.filter((l) => /backup leader: .*(refus|stale|not_leader|primary_alive)/.test(l.line)).map((l) => l.line.slice(0, 400))
    const devLog = fs.readdirSync(world.devbox.dir).filter((f) => /^daemon-.*\.log$/.test(f))
      .flatMap((f) => fs.readFileSync(path.join(world.devbox.dir, f), 'utf8').split('\n'))
      .filter((l) => /leader: (the cloud companion leads|the primary took the lead back)|walnut home: |leader book/.test(l)).map((l) => l.slice(0, 400))
    const kept = (home: string) => { try { return JSON.parse(fs.readFileSync(path.join(home, 'cache', 'leader-permit-number.json'), 'utf8')) } catch { return null } }
    facts.measure = {
      permit: { aAtHandover: facts.aPermitAtHandover?.record, handover: facts.handover, b: facts.bPermit?.record },
      bookSequence: facts.q6?.bookSequence,
      companionClaims: claims, companionRefusals: refusals, devboxLeaderLines: devLog,
      keptPermitNumber: { a: kept(world.primary.data), b: kept(world.standby.data) },
      sessionChannel: 'not in this harness: the dev box runs no host service (WALNUT_SESSION_HOST=0), so no fact log holds a permit pair',
    }
    expect(claims.length).toBeGreaterThan(0)
  })

  it('red: A\'s daemon with its bridge on again (no drop) fights B\'s for __local__', async () => {
    const cfg = facts.aBridgeConfig as { url: string; token: string; hostAlias: string }
    const from = Date.now()
    const on = await localDaemonCall(world.primary, { cmd: 'bridge.configure', home: world.primary.data, enabled: true, url: cfg.url, token: cfg.token, hostAlias: cfg.hostAlias })
    expect(on.ok, JSON.stringify(on)).toBe(true)
    mark('red: A\'s daemon bridge on again')
    await sleep(RED_WINDOW_MS)
    const to = Date.now()
    const win = samples.filter((s) => s.t >= from && s.t <= to)
    const replaced = companionLines.filter((l) => l.t >= from && l.t <= to && /replacing existing connection|superseded/.test(l.line) && l.line.includes('__local__'))
    const holders = changes(win.map((s) => `${s.aBridge ? 'A' : ''}${s.bBridge ? 'B' : ''}`), (x) => x)
    // Back as the switch leaves it: A's bridge off; B's daemon holds it again.
    const off = await localDaemonCall(world.primary, { cmd: 'bridge.configure', home: world.primary.data, enabled: false })
    const back = Date.now()
    const recovered = await waitFor(async () => (await bridgeUp(world.standby)) === true && (await bridgeUp(world.primary)) === false && (await sampleOnce()).local !== null, 120_000, 'B\'s daemon to hold __local__ again').then(() => Date.now() - back).catch(() => null)
    facts.red = { windowMs: to - from, replaced: replaced.length, sinces: new Set(win.map((s) => s.local)).size, holderChanges: holders, off: off.ok, recoveredAfterMs: recovered }
    expect(replaced.length + new Set(win.map((s) => s.local)).size - 1, 'the two daemons take turns on __local__').toBeGreaterThan(0)
  }, RED_WINDOW_MS + 240_000)
})
