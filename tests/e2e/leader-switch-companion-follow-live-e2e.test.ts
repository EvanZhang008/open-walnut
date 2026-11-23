/**
 * The cloud companion and the phone follow a leader switch (docs/reference/leader-switch.md, design
 * b2b-remote-side.md sections 6 and 8 and the lead's Q6), every process real:
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
 * runs on). In both cases B is LATE: past the restart notice, so the companion's backup claims the
 * dev box first. Each case is its own world (own setup and teardown):
 *
 *   1. "a commit lands late anyway": B's data dir is a copy of A's leader data made while A is
 *      stopped, with the promotion record, and B boots as the commit start 6 product minutes after
 *      the stop, with no commit window's end in its environment (a start the window bounds,
 *      WALNUT_LEADER_SWITCH_COMMIT_UNTIL, stops renewing on the handover at that end). Per the design (section 6) B's job starts no commit past the 300 s window, so the
 *      product does not take this path at these times; the case shows what the permit, the hosts and
 *      the companion do if a commit start comes late all the same (a job killed and resumed, a
 *      clock off): B's record stands, the backup steps back, B holds the dev box.
 *   2. "B gives up, A takes back" (the product's path at these times): the handover's lease ran out
 *      and the commit window passed, so B never starts its commit server. The test plays A's source
 *      job rolling back (flow.ts 'cancel' with A stopped, 'restore': the marker removed, then
 *      'start-source': A's server started again): A's earlier handover runs out, A grants, the
 *      backup steps back when A's bridge and heartbeats return, A holds the dev box again.
 *
 * Scaled time (the world's T, tests/helpers/live-twin-mac.ts): the takeover window is 6 s for the
 * product's 60 s, so one test second stands for ten: the commit window (restart notice) 30 s for
 * 300 s, B late 36 s for 6 minutes, and the permit's lease validMs 6 s for 60 s
 * (WALNUT_LEADER_PERMIT_VALID_MS, settings.ts permitParamsFor: renew, margins and back-off scale with
 * it). The lease scaling works only with witnesses this machine opens itself (witness dirs, as here):
 * a witness served by another machine keeps 60 s and refuses a 6 s record (bad-validity). Before
 * 2026-11-23 the lease was not scaled: B's commit (54 s after the handover record, past 6 product
 * minutes) was a renew on a handover still inside its 60 s lease, with 5.6 s to spare, a path the
 * product does not take at those times. The two-minute window of the one-bridge check is real time.
 *
 * Which permit path a late commit takes HERE (asserted, measured 2026-11-23): a witness dir is served
 * by whichever process asks (local-witnesses.ts), and a process that first reads a record counts it
 * as accepted at that read (witness.ts, as a restarted witness does). B's server is a new process:
 * its first read finds the handover and its renew follows at once, inside the lease as B counts it,
 * so the commit is a renew on the handover however late B comes. A witness kept by a long-running
 * service (another machine's) counts from the real acceptance: there a commit after the lease is
 * refused as a renew and stands only as a grant. Case 2's A is the same: its new process waits one
 * lease from its own first read, then grants.
 *
 * Every measurement the report needs is printed as one `FOLLOW-EVIDENCE` JSON line per case, and
 * with LSCF_EVIDENCE_DIR set the servers' and daemons' logs, the may-act logs and the witnesses'
 * record history are copied to <dir>/<case> before the cleanup.
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
import { mayActLog, readMayAct, removeMarker, writeMarker, writePromoted } from '../../src/core/leader/switch/records.js'
import {
  KEEPER, T, api, bootStandby, companionLeads, companionOutwardLog, leaderControl, localDaemonCall, macIsUp, prepareStandby,
  restartPrimary, setupTwinMac, sleep, standingRecord, stopLeaderServer, teardownTwinMac, waitFor, witnessRecords, world,
  type LeaderServer, type WitnessHeld,
} from '../helpers/live-twin-mac.js'

/** One test second stands for SCALE product seconds (T is 6 s for the 60 s takeover window). */
const SCALE = 60_000 / T
const COMMIT_WINDOW_MS = 300_000 / SCALE
const B_LATE_MS = 360_000 / SCALE
/** The permit's lease, scaled with the rest (every permit time follows it: settings.ts permitParamsFor). */
const PERMIT_VALID_MS = 60_000 / SCALE
/** Case 2: A's source job rolls back at the deadline plus the take-back time (the handover's lease). */
const ROLLBACK_AFTER_STOP_MS = COMMIT_WINDOW_MS + PERMIT_VALID_MS
/** Real time, as the design states it. */
const ONE_BRIDGE_WINDOW_MS = 120_000
const RED_WINDOW_MS = 60_000

// ---- what the test watches (one Watch per world) -----------------------------------------------

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
interface Watch {
  name: string
  switchId: string
  samples: Sample[]
  events: Array<{ t: number; what: string }>
  /** Lines of the companion's log the checks read, with when they came. */
  companionLines: Array<{ t: number; line: string }>
  /** Every record each witness dir held, as it changed (read every 200 ms). */
  permitLog: Array<WitnessHeld & { t: number }>
  /** The switch's moments (ms since epoch), filled as it runs. */
  at: Record<string, number>
  facts: Record<string, any>
  authAtStop: string
  stops: Array<() => Promise<void> | void>
}
let w: Watch
const newWatch = (name: string): Watch => ({
  name, switchId: `sw-${name}-${process.pid}`, samples: [], events: [], companionLines: [], permitLog: [], at: {}, facts: {}, authAtStop: '', stops: [],
})
const mark = (what: string) => { w.events.push({ t: Date.now(), what }); process.stdout.write(`[follow ${w.name}] ${new Date().toISOString()} ${what}\n`) }

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

async function bridgeUp(s: LeaderServer): Promise<boolean | null> {
  if (!s.daemonDir || !fs.existsSync(path.join(s.daemonDir, 'daemon.port'))) return null
  const r = await localDaemonCall(s, { cmd: 'bridge.status', home: s.data }, 3_000)
  return r.ok === true ? r.connected === true : null
}

async function companionLocal(): Promise<number | null> {
  const local = (((await api(world.companion, '/api/v1/status', { signal: AbortSignal.timeout(3_000) })).json.bridgeHosts ?? []) as Array<{ hostAlias: string; since: number }>).filter((b) => b.hostAlias === '__local__')
  return local[0]?.since ?? null
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
  let on = true
  const loop = (async () => {
    while (on) {
      const started = Date.now()
      w.samples.push(await sampleOnce())
      await sleep(Math.max(0, 1_000 - (Date.now() - started)))
    }
  })()
  w.stops.push(async () => { on = false; await loop.catch(() => {}) })
}

/** The witnesses' records as they change: which permit path each leader took. */
function watchPermit(): void {
  const last = new Map<string, number>()
  const timer = setInterval(() => {
    for (const r of witnessRecords()) if (r && last.get(r.witness) !== r.number) { last.set(r.witness, r.number); w.permitLog.push({ t: Date.now(), ...r }) }
  }, 200)
  w.stops.push(() => clearInterval(timer))
}
/** The first record above `above` a majority of the witness dirs took for `holder` (its kind, number, when first seen). */
function firstRecordOf(holder: string, above: number): (WitnessHeld & { t: number; witnesses: number }) | null {
  const need = Math.floor((world.leaderSwitch?.witnesses.length ?? 3) / 2) + 1
  const seen = w.permitLog.filter((r) => r.holder === holder && r.number > above)
  for (const r of seen) {
    const same = seen.filter((x) => x.number === r.number)
    if (same.length >= need) return { ...r, t: Math.max(...same.map((x) => x.t)), witnesses: same.length }
  }
  return null
}
/** The record numbers and kinds the witnesses held, in order, once each. */
const permitStory = () => [...new Map(w.permitLog.map((r) => [r.number, `${r.number} ${r.kind} by ${r.by}${r.to ? ` to ${r.to}` : ''}`])).entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)

/** Lines of the dev box's own log matching `re`, with their time. */
function devboxLines(re: RegExp): Array<{ t: number; line: string }> {
  return fs.readdirSync(world.devbox.dir).filter((f) => /^daemon-.*\.log$/.test(f))
    .flatMap((f) => fs.readFileSync(path.join(world.devbox.dir, f), 'utf8').split('\n'))
    .filter((l) => re.test(l))
    .map((l) => { let t = 0; try { t = Date.parse(JSON.parse(l).ts) } catch { /* not JSON */ } return { t, line: l.slice(0, 400) } })
}

/** Every file under `dir` with its mtime and size. */
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

const authFile = () => path.join(world.companion.data, 'auth.json')
const readText = (f: string) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }

// ---- the steps both worlds share ---------------------------------------------------------------

async function startWorld(name: string, prefix: string): Promise<void> {
  w = newWatch(name)
  await setupTwinMac(prefix, '', {
    leaderSwitch: true,
    recordCompanionOutward: true,
    macEnv: {
      // The grace of a plain stop, scaled as the commit window (A's switch stop sets the notice itself).
      WALNUT_LEADER_RESTART_GRACE_MS: String(COMMIT_WINDOW_MS),
      // The permit's lease, scaled (A and B serve the witness dirs; every process that does must agree: bad-validity).
      WALNUT_LEADER_PERMIT_VALID_MS: String(PERMIT_VALID_MS),
    },
  })
  watchPermit()
  watchLines(world.companion.proc, w.companionLines, /bridge: |backup leader: |leader: /)
  process.stdout.write(`leader-switch-companion-follow ${name}: world at ${world.base}\n`)
}

async function endWorld(): Promise<void> {
  for (const s of w.stops) await s()
  process.stdout.write(`FOLLOW-EVIDENCE ${JSON.stringify({ case: w.name, summary: w.facts.summary ?? null, at: w.at, facts: w.facts, events: w.events })}\n`)
  const root = process.env.LSCF_EVIDENCE_DIR
  if (root && world.base) {
    const keep = path.join(root, w.name)
    fs.mkdirSync(keep, { recursive: true })
    for (const s of [world.primary, world.standby, world.companion]) if (s.log) fs.writeFileSync(path.join(keep, `${s.name}.log`), s.log)
    for (const d of world.daemons) for (const f of fs.readdirSync(d.dir).filter((x) => /\.log$/.test(x))) fs.copyFileSync(path.join(d.dir, f), path.join(keep, `${d.name}-${f}`))
    for (const s of [world.primary, world.standby]) if (s.data && fs.existsSync(mayActLog(s.data))) fs.copyFileSync(mayActLog(s.data), path.join(keep, `${s.name}-may-act.jsonl`))
    fs.writeFileSync(path.join(keep, 'samples.json'), JSON.stringify(w.samples))
    fs.writeFileSync(path.join(keep, 'permit-log.json'), JSON.stringify(w.permitLog))
    fs.writeFileSync(path.join(keep, 'companion-lines.json'), JSON.stringify(w.companionLines))
    if (fs.existsSync(companionOutwardLog())) fs.copyFileSync(companionOutwardLog(), path.join(keep, 'companion-outward.jsonl'))
  }
  await teardownTwinMac()
}

/** A leads on the witnesses with the scaled lease, holds devbox, and its own daemon holds the companion's __local__ bridge. */
async function aLeads(): Promise<void> {
  const { facts, at } = w
  await macIsUp()
  const st = await waitFor(async () => {
    const r = await api(world.primary, '/api/leader/status')
    return r.json.permit?.state === 'leading' ? r.json : null
  }, 120_000, 'A to lead on the witnesses')
  facts.aPermit = { state: st.permit.state, record: st.permit.record?.number ?? null, machine: st.machine, homeOnHosts: st.homeOnHosts }
  // The scaled lease is the one in use: every record at the witnesses says so.
  const standing = await waitFor(() => standingRecord(), 30_000, 'a record standing at the witness dirs')
  facts.aStanding = standing
  expect(standing).toMatchObject({ holder: 'machine-a', validMs: PERMIT_VALID_MS })
  await waitFor(async () => (await bridgeUp(world.primary)) === true, 60_000, 'A\'s daemon bridge up')
  await waitFor(async () => (await companionLocal()) !== null, 60_000, 'the companion to hold __local__')
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
}

/**
 * The source job up to the stop (flow.ts): the marker, the restart notice (sent now, while A may still
 * act), the handover record, A's daemon drops its duties, A's server stops. Returns the handover's number.
 */
async function aHandsOverAndStops(): Promise<number> {
  const { facts, at } = w
  const ls = world.leaderSwitch!
  writeMarker(world.primary.data, { switchId: w.switchId, to: ls.b.id, state: 'switching', at: new Date().toISOString() })
  const notice = await leaderControl(world.primary, `/restart-notice?ms=${COMMIT_WINDOW_MS}`)
  expect(notice.restartingMs).toBe(COMMIT_WINDOW_MS)
  mark('A announced its stop for the commit window')
  const before = (await api(world.primary, '/api/leader/status')).json.permit
  facts.aPermitAtHandover = { state: before?.state ?? null, record: before?.record ?? null }
  const handover = await api(world.primary, '/api/leader/handover', { method: 'POST', body: JSON.stringify({ to: ls.b.id }) })
  expect(handover.status, handover.text).toBe(200)
  at.handover = Date.now()
  const h = Number(handover.json.record)
  facts.handover = h
  writeMarker(world.primary.data, { switchId: w.switchId, to: ls.b.id, state: 'switching', handover: h, at: new Date().toISOString() })
  mark(`A handed over (record ${h})`)
  facts.handoverAtWitnesses = await waitFor(() => { const s = standingRecord(); return s && s.number === h ? s : null }, 10_000, 'the handover standing at the witness dirs')
  expect(facts.handoverAtWitnesses).toMatchObject({ kind: 'handover', from: 'machine-a', to: ls.b.id, validMs: PERMIT_VALID_MS })
  // Before the stop: A's own daemon drops its trigger set and its bridge, inside A's process.
  const dropped = await leaderControl(world.primary, '/drop-duties')
  facts.drop = dropped
  expect(dropped).toMatchObject({ ok: true, triggers: true, bridge: true })
  mark('A dropped its daemon duties')
  await stopLeaderServer(world.primary)
  at.aStop = Date.now()
  w.authAtStop = readText(authFile())
  mark('A stopped (TERM, exit proven); its daemon runs on')
  // The companion holds the notice and A's bridge is gone from it (the drop, before the stop).
  const afterStop = await waitFor(async () => {
    const j = (await api(world.companion, '/api/leader')).json
    return j.restartingUntil && j.primaryLastSeenAt && (await companionLocal()) === null ? j : null
  }, 30_000, 'the companion to hold A\'s restart notice with A\'s bridge gone')
  at.noticeSeen = Date.now()
  facts.companionAfterStop = { restartingUntil: afterStop.restartingUntil, primaryLastSeenAt: afterStop.primaryLastSeenAt, restartNoticeMs: afterStop.restartingUntil - afterStop.primaryLastSeenAt }
  return h
}

/** The backup claims devbox once the restart notice ran out. */
async function backupClaims(): Promise<void> {
  const { facts, at } = w
  await waitFor(async () => (await companionLeads()).some((l) => l.host === KEEPER), COMMIT_WINDOW_MS + 10 * T + 30_000, 'the companion\'s backup to claim devbox')
  at.claim = Date.now()
  facts.aDaemonAfterStop = { bridge: await bridgeUp(world.primary) }
  const leads = await companionLeads()
  facts.claim = { leads, book: readBook(), afterStopMs: at.claim - at.aStop, epoch: leads.find((l) => l.host === KEEPER)?.epoch ?? null }
  mark(`the backup leads devbox ${at.claim - at.aStop} ms after A's stop (epoch ${facts.claim.epoch})`)
}

/** The leader holds devbox, the backup leads nothing, the leader's daemon holds __local__ again. */
async function leaderTakesBack(leader: LeaderServer, who: string): Promise<void> {
  const { at } = w
  await waitFor(async () => (await api(leader, '/api/leader')).json.hosts?.[KEEPER]?.holder === 'primary', 120_000, `${who} to take devbox back`)
  at.tookBack = Date.now()
  mark(`${who} holds devbox`)
  await waitFor(async () => (await companionLeads()).length === 0, 60_000, 'the backup to step back')
  at.released = Date.now()
  mark('the backup leads nothing')
}

async function leaderBridgeBack(leader: LeaderServer, who: string, since: number): Promise<void> {
  const { at } = w
  await waitFor(async () => (await bridgeUp(leader)) === true && (await companionLocal()) !== null, 120_000, `${who}'s daemon to hold __local__`)
  at.bridge = Date.now()
  // When the companion registered the leader's daemon as __local__ (its own clock: the registry's `since`).
  at.registered = w.samples.find((x) => x.t >= since && x.local !== null)?.local ?? at.bridge
  mark(`${who}'s daemon holds __local__`)
}

/** The phone's /api/v1 through the companion reaches the leader, with the token paired while A led. */
async function phoneReaches(leader: LeaderServer, who: string): Promise<void> {
  const { facts, at } = w
  const created = await api(leader, '/api/tasks', { method: 'POST', body: JSON.stringify({ title: `Made on ${who} after the switch ${w.switchId}`, project: 'Acme' }) })
  expect(created.status, created.text).toBe(201)
  const id = created.json.task.id as string
  const t0 = Date.now()
  const phoneGet = async (p: string) => {
    const res = await fetch(`http://127.0.0.1:${world.companion.port}${p}`, { headers: { Authorization: `Bearer ${world.tokens.phone}` }, signal: AbortSignal.timeout(20_000) })
    return { status: res.status, by: res.headers.get('x-walnut-answered-by'), text: await res.text() }
  }
  // A read the companion forwards (policy.ts: a task's sessions are not in its task copy): only the leader knows this task.
  let tries = 0
  const answered = await waitFor(async () => {
    tries++
    const r = await phoneGet(`/api/v1/tasks/${id}/sessions`)
    return r.status === 200 && r.by === 'primary' ? r : null
  }, 60_000, `the phone to get ${who}'s answer through the companion`)
  at.phone200 = Date.now()
  facts.phone = { status: answered.status, by: answered.by, body: answered.text.slice(0, 200), task: id, msAfterCreate: at.phone200 - t0, msAfterTookBack: at.phone200 - at.tookBack, tries }
  // The companion's own task copy (it answers GET /tasks itself): how soon it shows the task.
  facts.phone.taskCopy = await waitFor(async () => { const r = await phoneGet('/api/v1/tasks'); return r.status === 200 && r.text.includes(id) ? r : null }, 60_000, `${who}'s task in the companion's task copy`)
    .then((r) => ({ shown: true, by: r.by, msAfterCreate: Date.now() - t0 })).catch(() => ({ shown: false, msWaited: Date.now() - t0 }))
  expect(answered.status).toBe(200)
  expect(answered.by).toBe('primary')
}

/** Exactly one __local__ bridge, held by the leader's daemon, for two minutes from `from` (sampled every second). */
async function oneBridge(from: number, holder: 'A' | 'B'): Promise<void> {
  const { facts, at } = w
  const end = from + ONE_BRIDGE_WINDOW_MS
  if (Date.now() < end) await sleep(end - Date.now() + 1_500)
  const win = w.samples.filter((s) => s.t >= from && s.t <= end)
  const replaced = w.companionLines.filter((l) => l.t >= from && l.t <= end && /replacing existing connection|superseded/.test(l.line) && l.line.includes('__local__'))
  const sinces = [...new Set(win.map((s) => s.local))]
  const mine = (s: Sample) => holder === 'A' ? s.aBridge : s.bBridge
  const other = (s: Sample) => holder === 'A' ? s.bBridge : s.aBridge
  const bad = win.filter((s) => s.local === null || mine(s) !== true || other(s) === true || s.errors.length > 0)
  facts.oneBridge = {
    holder, samples: win.length, windowMs: ONE_BRIDGE_WINDOW_MS, sinces, replaced: replaced.length, bad: bad.slice(0, 5),
    noLocalAfterStop: w.samples.filter((s) => s.t >= at.aStop && s.t < from && s.local === null).length,
    replacedBeforeStop: w.companionLines.filter((l) => l.t < at.aStop && /replacing existing connection/.test(l.line) && l.line.includes('__local__')).length,
  }
  expect(win.length).toBeGreaterThanOrEqual(ONE_BRIDGE_WINDOW_MS / 1_000 - 10)
  expect(bad, JSON.stringify(bad.slice(0, 3))).toEqual([])
  expect(sinces, 'one registration of __local__ for the whole window').toHaveLength(1)
  expect(replaced.map((l) => l.line)).toEqual([])
}

function noticeHeard(): void {
  const { facts, at } = w
  const n = facts.companionAfterStop as { restartingUntil: number | null; primaryLastSeenAt: number; restartNoticeMs: number | null }
  facts.notice = { heard: n.restartingUntil !== null, noticeMs: n.restartNoticeMs, claimAfterStopMs: at.claim - at.aStop }
  expect(n.restartNoticeMs, 'the restart notice never reached the companion (announceSwitchStop must run before the handover record)').toBe(COMMIT_WINDOW_MS)
  expect(at.claim - n.primaryLastSeenAt).toBeGreaterThanOrEqual(COMMIT_WINDOW_MS)
}

/**
 * Never two primaries on devbox (one home record, primary then backup then primary, epochs +1), the
 * backup stepped back for good, and devbox took the new leader only once its permit record stood.
 */
function onePrimary(leader: LeaderServer, machine: string, leaderSince: number): void {
  const { facts, at } = w
  const books = w.samples.filter((s) => s.t >= at.aStop - 5_000)
  // One record the whole time: in case 1 B's home is the alias of A's there (the declared move), never a Walnut of its own.
  const homesSeen = [...new Set(books.flatMap((s) => s.book.map((b) => b.home)))]
  const seq = changes(books.map((s) => s.book[0]).filter(Boolean), (b) => `${b.holder}:${b.epoch}`).map((b) => ({ holder: b.holder, epoch: b.epoch }))
  const witnessSeq = changes(books.map((s) => s.witness?.[0]).filter(Boolean) as NonNullable<Sample['witness']>[number][], (x) => `${x.holder}:${x.epoch}`).map((x) => ({ holder: x.holder, epoch: x.epoch }))
  const leadsAfter = w.samples.filter((s) => s.t >= at.released).filter((s) => s.leads.length > 0)
  // The leader's first moment it may act (its may-act log), and devbox's "the primary took the lead back".
  const mayAct = readMayAct(leader.data).filter((l) => l.machine === machine && l.t >= leaderSince)
  const lease = mayAct.find((l) => l.mayAct)
  const tookBack = devboxLines(/leader: the primary took the lead back/).filter((l) => l.t >= at.aStop)
  facts.q6 = {
    homesSeen, bookSequence: seq, witnessSequence: witnessSeq, leadsAfterRelease: leadsAfter.length,
    decisions: changes(books.map((s) => s.lastDecision ?? ''), (d) => d),
    leaderMayActFirst: mayAct.slice(0, 3), leaderMayActAt: lease?.t ?? null, leaderMayActRecord: lease?.record ?? null, devboxTookBackAt: tookBack[0]?.t ?? null,
    devboxTookBackAfterMayActMs: lease && tookBack[0] ? tookBack[0].t - lease.t : null,
  }
  expect(books.every((s) => s.book.length <= 1), `homes on devbox: ${JSON.stringify(homesSeen)}`).toBe(true)
  expect(homesSeen).toEqual([world.primary.data])
  expect(seq.map((x) => x.holder)).toEqual(['primary', 'backup', 'primary'])
  for (let i = 1; i < seq.length; i++) expect(seq[i]!.epoch).toBeGreaterThan(seq[i - 1]!.epoch)
  expect(seq[1]!.epoch).toBe(seq[0]!.epoch + 1)
  expect(seq[2]!.epoch).toBe(seq[1]!.epoch + 1)
  expect(leadsAfter).toEqual([])
  expect(lease, 'the new leader\'s may-act log shows it may act').toBeDefined()
  expect(tookBack, 'devbox took the lead back once').toHaveLength(1)
  // The rule "a host follows only the leader whose record stands": the leader's server takes devbox back
  // from the backup (primary-leader.ts configureHostLeader's leader.claim) only once it may act.
  expect(tookBack[0]!.t, `devbox took the new leader back ${lease!.t - tookBack[0]!.t} ms before its permit let it act (${JSON.stringify(mayAct.slice(0, 3))})`).toBeGreaterThanOrEqual(lease!.t)
}

/** The companion sent nothing outward and wrote no leader data while it led devbox (A's stop until the leader's daemon registered). */
function companionQuiet(): void {
  const { facts, at } = w
  const from = at.aStop
  const to = at.registered
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
  const doorLines = w.companionLines.filter((l) => l.t >= from && l.t <= to && /git push|sendMail|mail-send|apns|calendar|plugin.*fetch/i.test(l.line))
  facts.companionOut = { windowMs: to - from, recorded: inWindow.length, distinct, outward: outward.slice(0, 20), doorLines: doorLines.map((l) => l.line.slice(0, 200)) }
  facts.writes = {
    companionLeaderData: leaderData(companionWrites),
    companionLeaderDataBaseline: leaderData(baselineWrites),
    authJsonChangedDevices: authDiff(w.authAtStop, readText(authFile())),
    companion: companionWrites.map((c) => `${c.cls} ${c.rel}`),
    devboxLeaderData: leaderData(devboxWrites),
    devbox: devboxWrites.map((c) => `${c.cls} ${c.rel}`),
  }
  expect(outward, JSON.stringify(outward.slice(0, 10))).toEqual([])
  expect(doorLines.map((l) => l.line)).toEqual([])
  expect(facts.writes.devboxLeaderData).toEqual([])
  // A path of leader-data class the companion writes while A leads too is its follower copy, not the backup's.
  expect(leaderData(companionWrites).filter((r) => !leaderData(baselineWrites).includes(r)), JSON.stringify(facts.writes)).toEqual([])
}

/** What the backup claimed with, next to the permit records; and the case's summary line. */
function measure(permit: Record<string, unknown>): void {
  const { facts, at } = w
  const claims = w.companionLines.filter((l) => /backup leader: (leads host|claim)/.test(l.line)).map((l) => l.line.slice(0, 400))
  const refusals = w.companionLines.filter((l) => /backup leader: .*(refus|stale|not_leader|primary_alive)/.test(l.line)).map((l) => l.line.slice(0, 400))
  const kept = (home: string) => { try { return JSON.parse(fs.readFileSync(path.join(home, 'cache', 'leader-permit-number.json'), 'utf8')) } catch { return null } }
  facts.measure = {
    permit, permitStory: permitStory(),
    bookSequence: facts.q6?.bookSequence,
    companionClaims: claims, companionRefusals: refusals,
    devboxLeaderLines: devboxLines(/leader: (the cloud companion leads|the primary took the lead back)|walnut home: |leader book/).map((l) => l.line),
    keptPermitNumber: { a: kept(world.primary.data), b: world.standby.data ? kept(world.standby.data) : null },
    sessionChannel: 'not in this harness: the dev box runs no host service (WALNUT_SESSION_HOST=0), so no fact log holds a permit pair',
  }
  facts.summary = {
    claimAfterStopMs: at.claim - at.aStop, claimEpoch: facts.claim?.epoch,
    permit,
    releasedAfterStopMs: at.released - at.aStop, releasedAfterTookBackMs: at.released - at.tookBack,
    phoneFirst200AfterTookBackMs: facts.phone?.msAfterTookBack ?? null,
    oneBridge: facts.oneBridge ? { holder: facts.oneBridge.holder, samples: facts.oneBridge.samples, sinces: facts.oneBridge.sinces.length, bad: facts.oneBridge.bad.length, replaced: facts.oneBridge.replaced } : null,
    devboxTookBackAfterMayActMs: facts.q6?.devboxTookBackAfterMayActMs ?? null,
  }
  expect(claims.length).toBeGreaterThan(0)
}

// ---- case 1: a commit lands late anyway ---------------------------------------------------------

describe.skipIf(!liveWallsAvailable())('a late commit lands anyway: the companion and the phone follow from A to B (real servers, real daemons)', () => {
  beforeAll(() => startWorld('late-commit', 'lscf-'), 400_000)
  afterAll(() => endWorld(), 600_000)

  it('A leads on the witnesses (the scaled lease): it holds the permit, leads devbox, and its own daemon holds the companion\'s __local__ bridge', () => aLeads(), 400_000)

  it('the switch: A hands over and stops, the backup claims devbox, B boots late and takes it back with a higher epoch', async () => {
    const { facts, at } = w
    const ls = world.leaderSwitch!
    const h = await aHandsOverAndStops()
    facts.copiedFiles = await prepareStandby({ switchId: w.switchId, handover: h })
    mark(`B's data dir: ${facts.copiedFiles} files of A's leader data`)
    await backupClaims()
    const late = at.aStop + B_LATE_MS - Date.now()
    if (late > 0) await sleep(late)
    // Still led by the backup when B comes.
    expect((await companionLeads()).map((l) => l.host)).toContain(KEEPER)

    at.bBoot = Date.now()
    // As the switch starts it, but with no commit window's end: a start the window bounds stops
    // renewing on the handover at that end (WALNUT_LEADER_SWITCH_COMMIT_UNTIL), so it would not commit.
    await bootStandby({ commitHandover: h, switchId: w.switchId })
    mark(`B booted ${at.bBoot - at.aStop} ms after A's stop`)
    const bst = await waitFor(async () => {
      const r = await api(world.standby, '/api/leader/status')
      return r.json.permit?.state === 'leading' && (r.json.permit.record?.number ?? 0) > h ? r.json : null
    }, 180_000, 'B to commit on the witnesses')
    at.bLeads = Date.now()
    facts.bPermit = { state: bst.permit.state, record: bst.permit.record?.number ?? null, kind: bst.permit.record?.kind ?? null, holder: bst.permit.record?.holder ?? null, machine: bst.machine }
    mark(`B leads on the witnesses (record ${facts.bPermit.record})`)
    await leaderTakesBack(world.standby, 'B')
    // flow.ts after the commit stood: A's home handed over, B's promotion led.
    writeMarker(world.primary.data, { switchId: w.switchId, to: ls.b.id, state: 'handed-over', handover: h, commit: facts.bPermit.record, at: new Date().toISOString() })
    writePromoted(world.standby.data, { switchId: w.switchId, state: 'led', from: world.primary.data, to: ls.b.id, handover: h, fromHomeOnHosts: world.primary.data, fromFormerHomes: [], at: new Date().toISOString() })
    await leaderBridgeBack(world.standby, 'B', at.bBoot)
    facts.bookAfter = readBook()
  }, 900_000)

  it('the permit path B took: its commit on the handover (a renew: B\'s new process counts the handover from its own first read)', () => {
    const { facts, at } = w
    const h = facts.handover as number
    const commit = firstRecordOf('machine-b', h)
    const bMayAct = readMayAct(world.standby.data).find((l) => l.machine === 'machine-b' && l.t >= at.bBoot && l.mayAct)
    facts.bPath = {
      handover: { number: h, kind: facts.handoverAtWitnesses?.kind, validMs: facts.handoverAtWitnesses?.validMs },
      commit, commitAfterHandoverMs: commit ? commit.t - at.handover : null, commitAfterBBootMs: commit ? commit.t - at.bBoot : null,
      handoverLeaseMs: PERMIT_VALID_MS, bMayAct: bMayAct ?? null,
      story: permitStory(),
    }
    expect(commit, JSON.stringify(permitStory())).not.toBeNull()
    expect(facts.bPermit.record).toBeGreaterThanOrEqual(commit!.number)
    expect(commit!.validMs).toBe(PERMIT_VALID_MS)
    // B came long after the handover's lease (6 s here) ran out as A and the witnesses counted it...
    expect(commit!.t - at.handover).toBeGreaterThan(PERMIT_VALID_MS * 3)
    // ...and still its commit is the renew on the handover: the witness dirs count from B's own first read (the header).
    expect(commit!.kind).toBe('renew')
    // Every record any witness held in this world carries the scaled lease.
    expect([...new Set(w.permitLog.map((r) => r.validMs))]).toEqual([PERMIT_VALID_MS])
  })

  it('the phone\'s /api/v1 through the companion reaches B, with the token paired while A led', () => phoneReaches(world.standby, 'B'), 180_000)

  it('A brought back: its old home is refused on devbox and moves nothing there, B keeps devbox at its epoch', async () => {
    const before = readBook()
    const asA = { home: world.primary.data, walnutId: w.facts.walnutId }
    // What A's server's link would send first, from a socket of this test (a link mended).
    const configure = await daemonCall(world.devbox, { cmd: 'leader.configure', ...asA, backup: true }, 10_000)
    const claim = await daemonCall(world.devbox, { cmd: 'leader.claim', home: asA.home }, 10_000)
    const triggers = await daemonCall(world.devbox, { cmd: 'triggers.configure', home: asA.home, config: { version: 1, triggers: [] } }, 10_000)
    w.facts.aBack = { configure, claim, triggers }
    for (const r of [configure, claim, triggers]) expect(r, JSON.stringify(r)).toMatchObject({ ok: false, errorKind: 'walnut_home_busy' })
    expect(readBook()).toEqual(before)
    expect((await api(world.standby, '/api/leader')).json.hosts?.[KEEPER]).toMatchObject({ holder: 'primary' })
  }, 120_000)

  it('exactly one __local__ bridge, held by B\'s daemon, for two minutes after the switch (sampled every second)', () => oneBridge(w.at.bridge, 'B'), ONE_BRIDGE_WINDOW_MS + 120_000)

  it('Q6: the companion heard A\'s restart notice (the commit window) and claimed devbox only after it', () => noticeHeard())

  it('Q6: never two primaries on devbox, epochs only rise, the backup stepped back, devbox took B only once B\'s record stood', () => {
    // A was gone before B started: the two never held at once.
    expect(w.at.aStop).toBeLessThan(w.at.bBoot)
    onePrimary(world.standby, 'machine-b', w.at.bBoot)
  })

  it('Q6: the companion sent nothing outward and wrote no leader data while it led devbox', () => companionQuiet())

  it('measures what the backup claimed with, next to the permit numbers', () => {
    const f = w.facts
    measure({ aAtHandover: f.aPermitAtHandover?.record, handover: f.handover, b: { number: f.bPath?.commit?.number, kind: f.bPath?.commit?.kind, afterHandoverMs: f.bPath?.commitAfterHandoverMs } })
  })

  it('red: A\'s daemon with its bridge on again (no drop) fights B\'s for __local__', async () => {
    const cfg = w.facts.aBridgeConfig as { url: string; token: string; hostAlias: string }
    const from = Date.now()
    const on = await localDaemonCall(world.primary, { cmd: 'bridge.configure', home: world.primary.data, enabled: true, url: cfg.url, token: cfg.token, hostAlias: cfg.hostAlias })
    expect(on.ok, JSON.stringify(on)).toBe(true)
    mark('red: A\'s daemon bridge on again')
    await sleep(RED_WINDOW_MS)
    const to = Date.now()
    const win = w.samples.filter((s) => s.t >= from && s.t <= to)
    const replaced = w.companionLines.filter((l) => l.t >= from && l.t <= to && /replacing existing connection|superseded/.test(l.line) && l.line.includes('__local__'))
    const holders = changes(win.map((s) => `${s.aBridge ? 'A' : ''}${s.bBridge ? 'B' : ''}`), (x) => x)
    // Back as the switch leaves it: A's bridge off; B's daemon holds it again.
    const off = await localDaemonCall(world.primary, { cmd: 'bridge.configure', home: world.primary.data, enabled: false })
    const back = Date.now()
    const recovered = await waitFor(async () => (await bridgeUp(world.standby)) === true && (await bridgeUp(world.primary)) === false && (await companionLocal()) !== null, 120_000, 'B\'s daemon to hold __local__ again').then(() => Date.now() - back).catch(() => null)
    w.facts.red = { windowMs: to - from, replaced: replaced.length, sinces: new Set(win.map((s) => s.local)).size, holderChanges: holders, off: off.ok, recoveredAfterMs: recovered }
    expect(replaced.length + new Set(win.map((s) => s.local)).size - 1, 'the two daemons take turns on __local__').toBeGreaterThan(0)
  }, RED_WINDOW_MS + 240_000)
})

// ---- case 2: B gives up past the window, A takes back (the product's path) -----------------------

describe.skipIf(!liveWallsAvailable())('past the commit window B gives up and A takes back: the companion and the phone follow A again (real servers, real daemons)', () => {
  beforeAll(() => startWorld('give-up', 'lscg-'), 400_000)
  afterAll(() => endWorld(), 600_000)

  it('A leads on the witnesses (the scaled lease): it holds the permit, leads devbox, and its own daemon holds the companion\'s __local__ bridge', () => aLeads(), 400_000)

  it('the switch: A hands over and stops, the backup claims devbox, no commit by the deadline, A\'s job rolls back and A takes devbox back', async () => {
    const { facts, at } = w
    const h = await aHandsOverAndStops()
    await backupClaims()
    // B's job starts no commit past the window (design section 6): B never starts. A's job waits out
    // the deadline plus the take-back time, then rolls back.
    const wait = at.aStop + ROLLBACK_AFTER_STOP_MS - Date.now()
    if (wait > 0) await sleep(wait)
    expect((await companionLeads()).map((l) => l.host)).toContain(KEEPER)
    // flow.ts 'cancel' with A stopped: nobody committed, the handover is what stands ("the old leader takes the permission back once it runs out").
    facts.standingAtRollback = standingRecord()
    expect(facts.standingAtRollback).toMatchObject({ number: h, kind: 'handover', from: 'machine-a' })
    // 'restore': the marker goes (no tried home on B to demote: B never promoted); 'start-source': A's server again.
    removeMarker(world.primary.data)
    at.aBoot = Date.now()
    mark(`A's job rolls back ${at.aBoot - at.aStop} ms after A's stop: A's server starts again`)
    await restartPrimary()
    at.aUp = Date.now()
    mark(`A's server answers (${at.aUp - at.aBoot} ms)`)
    const ast = await waitFor(async () => {
      const r = await api(world.primary, '/api/leader/status')
      return r.json.permit?.state === 'leading' && (r.json.permit.record?.number ?? 0) > h ? r.json : null
    }, 180_000, 'A to lead on the witnesses again')
    at.aLeads = Date.now()
    facts.aPermitBack = { state: ast.permit.state, record: ast.permit.record?.number ?? null, kind: ast.permit.record?.kind ?? null, holder: ast.permit.record?.holder ?? null }
    mark(`A leads on the witnesses again (record ${facts.aPermitBack.record})`)
    await leaderTakesBack(world.primary, 'A')
    await leaderBridgeBack(world.primary, 'A', at.aBoot)
    facts.bookAfter = readBook()
  }, 900_000)

  it('the permit path A took back: its earlier handover ran out, then a grant', () => {
    const { facts, at } = w
    const h = facts.handover as number
    const grant = firstRecordOf('machine-a', h)
    const aMayAct = readMayAct(world.primary.data).find((l) => l.machine === 'machine-a' && l.t >= at.aBoot && l.mayAct)
    facts.aPath = {
      handover: { number: h, kind: facts.handoverAtWitnesses?.kind, validMs: facts.handoverAtWitnesses?.validMs },
      grant, grantAfterHandoverMs: grant ? grant.t - at.handover : null, grantAfterABootMs: grant ? grant.t - at.aBoot : null,
      handoverLeaseMs: PERMIT_VALID_MS, aMayAct: aMayAct ?? null,
      bRecords: w.permitLog.filter((r) => r.by === 'machine-b').length,
      story: permitStory(),
    }
    expect(grant, JSON.stringify(permitStory())).not.toBeNull()
    expect(grant!.kind).toBe('grant')
    expect(grant!.validMs).toBe(PERMIT_VALID_MS)
    expect(facts.aPermitBack.record).toBeGreaterThanOrEqual(grant!.number)
    // B never wrote a record: no commit start past the window.
    expect(facts.aPath.bRecords).toBe(0)
    expect([...new Set(w.permitLog.map((r) => r.validMs))]).toEqual([PERMIT_VALID_MS])
  })

  it('a commit start of B that came now anyway is refused by what the witnesses hold (A\'s record), before it sends anything', async () => {
    const { wantFor } = await import('../../src/core/leader/switch/runtime.js')
    const standing = standingRecord()
    expect(standing).toMatchObject({ holder: 'machine-a' })
    // The first thing B's commit start decides (runtime.ts acquire), on the record a majority holds now.
    const record = { ...standing!, nonce: 'other', list: [], cfg: '', epoch: 0 } as unknown as Parameters<typeof wantFor>[0]
    const decision = wantFor(record, 'machine-b', 'b-late', w.facts.handover)
    w.facts.bLate = { standing, decision }
    expect(decision).toMatchObject({ want: 'none', refuse: true, leader: 'machine-a' })
    expect((await api(world.primary, '/api/leader')).json.hosts?.[KEEPER]).toMatchObject({ holder: 'primary' })
  })

  it('the phone\'s /api/v1 through the companion reaches A again, with the token paired before the switch', () => phoneReaches(world.primary, 'A'), 180_000)

  it('exactly one __local__ bridge, held by A\'s daemon, for two minutes after the take-back (sampled every second)', () => oneBridge(w.at.bridge, 'A'), ONE_BRIDGE_WINDOW_MS + 120_000)

  it('Q6: the companion heard A\'s restart notice (the commit window) and claimed devbox only after it', () => noticeHeard())

  it('Q6: never two primaries on devbox, epochs only rise, the backup stepped back, devbox took A only once A\'s grant stood', () => onePrimary(world.primary, 'machine-a', w.at.aBoot))

  it('Q6: the companion sent nothing outward and wrote no leader data while it led devbox', () => companionQuiet())

  it('measures what the backup claimed with, next to the permit numbers', () => {
    const f = w.facts
    measure({ aAtHandover: f.aPermitAtHandover?.record, handover: f.handover, aBack: { number: f.aPath?.grant?.number, kind: f.aPath?.grant?.kind, afterHandoverMs: f.aPath?.grantAfterHandoverMs, afterABootMs: f.aPath?.grantAfterABootMs } })
  })
})
