/**
 * The source job: the old leader's half of a switch, run on its machine (flow.ts has the whole
 * shape). It talks only to its own server (loopback) and reads the witnesses; everything that
 * crosses to the new leader's machine goes over that server's copy link (peer.ts), until the
 * server's switch stop ends it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { getVersion } from '../../version.js'
import { majorityOf, type PermitRecord } from '../permit/types.js'
import { readFinalStopResult, readHistory, readMarker, removeMarker, summarize, takeSwitchLock, writeDurableJson, writeMarker } from './records.js'
import { olderVersion } from './self-check.js'
import { LocalSide, type SwitchSide } from './side.js'
import { isRemoteWitness, machineByHome, machineById, readHomeSwitchConfig, type LeaderSwitchSettings } from './settings.js'
import { makeWitnessReader, type WitnessReading } from './witness-reader.js'
import { alive, processStartMark, sameProcess } from '../../trial-start/process.js'
import {
  SOURCE_FINAL, StepFailed, SwitchRefused, committedRecord, handoverStanding, killPoint, readSwitchState, sourceCancelFile, stepLogger, switchStateFile, takeBackMs, waitDoorsOpen,
  type SourceStep, type StartedBy, type SwitchState, type TargetState,
} from './flow.js'
import { notesAccessOf, readSwitchNotes, writeSwitchNote, type NotesAccess } from './switch-notes.js'
import { applyServiceRole, writeSwitchPointer, type SetServiceRole } from './service-role.js'
import { instanceIdAt } from '../../device-store.js'
import type { CheckReport } from './ticket.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface SourceJobOptions {
  home: string
  to?: string
  back?: boolean
  resume?: boolean
  env?: NodeJS.ProcessEnv
  out?: (line: string) => void
  startedBy?: StartedBy
  /** This machine (default LocalSide of the home's machine). */
  side?: SwitchSide
  /** Tests: the witnesses, the notes, the service role, where it dies (a test kill point), how long the new leader may take to say it saw the handover. */
  readWitnesses?: () => Promise<WitnessReading>
  notes?: NotesAccess | null
  setServiceRole?: SetServiceRole
  diesAt?: (name: string) => void
  targetReadyMs?: number
}

const PRE_COMMIT = new Set<SourceStep>(['preflight', 'handover', 'stop-source', 'wait-target'])

/** How long past the commit deadline a stopping server may still run its stop (its bail is the commit window and a minute). */
const STOP_OUTLIVES_MS = 2 * 60_000

/**
 * Whether the server asked for the switch stop is still that process: the same pid with the same start
 * (processStartMark). Its start could not be read when it was asked (no /proc, no ps): its pid alone, and only
 * while a stop could still run (the commit deadline and STOP_OUTLIVES_MS).
 */
export async function stopStillRunning(p: { pid: number; start: string | null }, o: { now: number; commitDeadline?: string }): Promise<boolean> {
  if (p.start !== null) return sameProcess(p)
  const until = o.commitDeadline ? Date.parse(o.commitDeadline) + STOP_OUTLIVES_MS : NaN
  return Number.isFinite(until) && o.now < until && alive(p.pid)
}

export async function runSourceJob(o: SourceJobOptions): Promise<SwitchState> {
  const env = o.env ?? process.env
  const out = o.out ?? (() => {})
  const home = path.resolve(o.home)
  const cfg = readHomeSwitchConfig(home)
  if (!cfg.flag) throw new SwitchRefused('the experiment switchable_leader is off in this Walnut (Settings > Experimental)')
  if (!cfg.settings) throw new SwitchRefused(cfg.problem ?? 'config.yaml has no leader_switch section')
  let release: () => void
  try { release = takeSwitchLock(home) } catch (err) { throw new SwitchRefused((err as Error).message) }
  try {
    return await runLocked(o, env, out, home, cfg.settings)
  } finally {
    release()
  }
}

function newState(home: string, settings: LeaderSwitchSettings, o: SourceJobOptions, env: NodeJS.ProcessEnv): SwitchState {
  const source = machineByHome(settings, home)
  if (!source) throw new SwitchRefused(`this home (${home}) is not the home of any machine in leader_switch.machines`)
  let to = o.to
  if (o.back) {
    const last = readHistory(home).at(-1)
    if (!last) throw new SwitchRefused('this Walnut has not been switched here: there is nothing to switch back to')
    if (Date.now() - Date.parse(last.committedAt) > settings.backWindowHours * 3_600_000) {
      throw new SwitchRefused(`the switch here was ${Math.round((Date.now() - Date.parse(last.committedAt)) / 3_600_000)} h ago, past back_window_hours (${settings.backWindowHours}); use --to ${last.from}`)
    }
    to = last.from
  }
  if (!to) throw new SwitchRefused('name the machine: --to <machine id>, or --back')
  const target = machineById(settings, to)
  if (!target) throw new SwitchRefused(`machine ${to} is not in leader_switch.machines (${settings.machines.map((m) => m.id).join(', ')})`)
  if (target.id === source.id) throw new SwitchRefused(`${to} leads already`)
  return {
    id: `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`,
    from: source.id, to: target.id, sourceHome: source.home, targetHome: target.home,
    ...(source.accountHome ? { sourceAccountHome: source.accountHome } : {}),
    ...(target.accountHome ? { targetAccountHome: target.accountHome } : {}),
    standbyDir: target.standbyDir, reverseStandbyDir: source.standbyDir,
    sourceVersion: env.WALNUT_LEADER_SWITCH_SOURCE_VERSION || getVersion(),
    sourceWasRunning: false, step: 'preflight', log: [], startedAt: new Date().toISOString(),
    ...(o.startedBy ? { startedBy: o.startedBy } : {}),
  }
}

async function runLocked(o: SourceJobOptions, env: NodeJS.ProcessEnv, out: (line: string) => void, home: string, settings: LeaderSwitchSettings): Promise<SwitchState> {
  let st = readSwitchState(home)
  const open = st && !SOURCE_FINAL.has(st.step)
  if (o.resume) {
    if (!st || !open) throw new SwitchRefused('no switch from this home is under way')
    out(`resuming switch ${st.id} at ${st.step}`)
  } else {
    if (open) throw new SwitchRefused(`switch ${st!.id} to ${st!.to} is under way (step ${st!.step}): finish it with --resume, or --cancel it`)
    st = newState(home, settings, o, env)
    try { fs.unlinkSync(sourceCancelFile(home)) } catch { /* none */ }
  }
  const s = st!
  const self = machineById(settings, s.from)
  const target = machineById(settings, s.to)
  if (!self || !target) throw new SwitchRefused(`machine ${!self ? s.from : s.to} is not in leader_switch.machines`)
  const side = o.side ?? new LocalSide(self)
  const killAt = env.WALNUT_LEADER_SWITCH_KILL_AT
  // Tests only: where a job or server dies, the ledger control, a pause in the final batch (a writer lands in it).
  const pause = Number(env.WALNUT_LEADER_SWITCH_PAUSE_AFTER_FIRST_BATCH_MS)
  const handoverTest = { ...(killAt ? { killAt } : {}), ...(env.WALNUT_LEADER_SWITCH_SKIP_LEDGER_REWRITE === '1' ? { skipLedgerRewrite: true } : {}) }
  const stopTest = { ...(killAt ? { killAt } : {}), ...(pause > 0 ? { pauseAfterFirstBatchMs: pause } : {}) }
  const diesAt = o.diesAt ?? ((name: string) => killPoint(killAt, name))
  // A new switch writes nothing until its preflight passed: a refusal changes nothing on disk.
  let persisted = !!o.resume
  const save = stepLogger(s, (x) => { if (persisted || x.step !== 'preflight') { persisted = true; writeDurableJson(switchStateFile(home), x) } }, out)
  const notes = o.notes !== undefined ? o.notes : await notesAccessOf(home, env).catch(() => null)
  const note = (step: string, why?: string) => notes ? writeSwitchNote(notes, { switchId: s.id, machine: s.from, step, ...(why ? { why } : {}) }).catch(() => 0) : Promise.resolve(0)
  const theirs = async () => notes ? (await readSwitchNotes(notes, s.id).catch(() => new Map())).get(s.to) ?? null : null
  // The witnesses: through this machine's server while it runs (its links), else by this machine's own ways a and b.
  const read = o.readWitnesses ?? makeWitnessReader(`${s.from}-source-job`, settings, () => (side.runningServer() ? [{ api: (m: string, p: string) => side.api(m, p) }] : []), async () => {
    const r = await side.reachWitnesses(home).catch(() => null)
    return r?.majority ? { standing: r.standing, answered: r.answered } : null
  })
  const readStanding = async (): Promise<PermitRecord | null | undefined> => (await read().catch(() => ({ standing: undefined, answered: 0 }))).standing
  const fail = (why: string): never => { throw new StepFailed(why) }
  /**
   * The server asked for the stop, still in it with its lock gone (its final batch): until it ends, its result is not
   * known. Once it is seen ended (or its pid is another process now), it is forgotten, so a reused pid never holds a
   * resume back.
   */
  const stopping = async () => {
    if (!s.stopServer || side.runningServer()) return false
    if (await stopStillRunning(s.stopServer, { now: Date.now(), ...(s.commitDeadline ? { commitDeadline: s.commitDeadline } : {}) })) return true
    s.stopServer = undefined
    writeDurableJson(switchStateFile(home), s)
    return false
  }
  /** Waits for that stop to end, as long as the stop-source step would (the commit window and a minute). */
  const stopEnded = async () => {
    const until = Date.parse(s.commitDeadline ?? new Date(Date.now() + settings.commitWindowMs).toISOString()) + 60_000
    if (await stopping()) out('the old leader\'s server is in its switch stop; waiting for it to end')
    while (await stopping() && Date.now() < until) await sleep(200)
    return !(await stopping())
  }
  const cancelAsked = () => { try { return (JSON.parse(fs.readFileSync(sourceCancelFile(home), 'utf8')) as { switchId?: string }).switchId === s.id } catch { return false } }
  /** The old machine keeps a witness of the list: its home runs again as the handed-over standby, which keeps that witness's door up. */
  const keepWitnessDoor = async (): Promise<string> => {
    if (!settings.witnesses.some((w) => isRemoteWitness(w) && w.machine === s.from)) return ''
    const r = await side.startStandby()
    if (r.ok) return '; its home runs as the standby, its witness door up'
    out(`the old home did not start as the standby (${r.why}): its witness is not reached until it does`)
    return `; its standby did not start (${r.why})`
  }
  if (!o.resume) save('preflight')

  for (;;) {
    try {
      if (cancelAsked() && PRE_COMMIT.has(s.step) && s.step !== 'preflight') { s.rollbackWhy ??= 'cancelled by hand'; save('cancel', 'cancelled by hand'); continue }
      switch (s.step) {
        case 'preflight': {
          await preflight(s, settings, side, read)
          save('handover', `checks passed; handing over to ${s.to}`)
          break
        }
        case 'handover': {
          writeMarker(s.sourceHome, { switchId: s.id, to: s.to, state: 'switching', at: new Date().toISOString(), ...(s.handover ? { handover: s.handover } : {}) })
          // An unknown outcome (no majority of answers in one read: a busy machine, a slow door) is read again; only
          // what a majority says stops the handover.
          let standing = await readStanding()
          for (const until = Date.now() + 20_000; standing === undefined && Date.now() < until;) { await sleep(500); standing = await readStanding() }
          if (committedRecord(standing, s) && s.handover) { save('hand-off', `already committed (record ${standing!.number})`); break }
          if (!standing || !(handoverStanding(standing, s) || standing.holder === s.from)) fail(`the witnesses do not name ${s.from} as the holder (${JSON.stringify(summarize(standing))})`)
          if (!side.runningServer()) fail('the old leader\'s server is not running: only the process that holds the permission can hand it over')
          // The server writes the handover record, then the ticket and the start of the target job over its copy link.
          const r = await side.api('POST', '/api/leader/handover', {
            to: s.to, switchId: s.id,
            ...(Object.keys(handoverTest).length ? { test: handoverTest } : {}),
            // The route's host steps, the record, the retell (a minute at most) and the target side over the copy link.
          }, 150_000).catch((err) => ({ status: 0, json: { why: (err as Error).message } }))
          const j = r.json as { ok?: boolean; record?: number; commitDeadline?: string; why?: string } | null
          if (!j?.ok || !j.record) fail(`the old leader did not hand over: ${j?.why ?? `status ${r.status}`}`)
          s.handover = j!.record!
          s.commitDeadline = j!.commitDeadline
          writeMarker(s.sourceHome, { switchId: s.id, to: s.to, state: 'switching', handover: s.handover, at: new Date().toISOString() })
          await note('handed-over')
          // The new leader's job says it sees the handover at a majority it reaches, before this server stops.
          const until = Date.now() + (o.targetReadyMs ?? 30_000)
          for (;;) {
            const t = await side.api('GET', `/api/leader/switch/target?switchId=${encodeURIComponent(s.id)}`).catch(() => null)
            const ts = (t?.json as { state?: TargetState | null } | null)?.state
            // A target that gave up after it saw the handover is not ready: its giving up is read first.
            if (ts?.step === 'rolled-back' || ts?.step === 'cancel' || ts?.step === 'restore') fail(`${s.to} gave up: ${ts.rollbackWhy ?? ts.step}`)
            const n = await theirs()
            if (n?.step === 'gave-up') fail(`${s.to} gave up: ${n.why ?? 'no reason given'}`)
            if (ts?.handoverSeen) break
            if (n?.step === 'waiting-mark') break
            if (Date.now() > until) fail(`${s.to}'s switch job did not say it sees the handover within ${Math.round((o.targetReadyMs ?? 30_000) / 1000)} s`)
            await sleep(300)
          }
          save('stop-source', `handover record ${s.handover} at a majority; ${s.to} waits for the final batch`)
          diesAt('after-handover')
          break
        }
        case 'stop-source': {
          // The server by its lock, or the one asked for the stop before (in its final batch its lock is gone already).
          const running = side.runningServer() ?? (await stopping() ? { pid: s.stopServer!.pid, port: null } : null)
          if (running && !readFinalStopResult(s.sourceHome, s.id)) {
            if (s.stopServer?.pid !== running.pid) { s.stopServer = { pid: running.pid, start: await processStartMark(running.pid) }; writeDurableJson(switchStateFile(home), s) }
            const r = await side.api('POST', '/api/leader/switch/final-stop', { switchId: s.id, ...(Object.keys(stopTest).length ? { test: stopTest } : {}) }).catch((err) => ({ status: 0, json: { why: (err as Error).message } }))
            const j = r.json as { ok?: boolean; why?: string } | null
            // A resume while the server is in its stop already (it answers so, or its HTTP is closed): wait for it.
            const inStop = j?.why === 'this server is in its switch stop already' || (r.status === 0 && alive(running.pid))
            if (!j?.ok && !inStop) fail(`the old leader's server did not take the switch stop: ${j?.why ?? `status ${r.status}`}`)
            if (inStop) out('the old leader\'s server is in its switch stop already; waiting for it to end')
            diesAt('during-final-batch')
          }
          if (running) {
            const until = Date.parse(s.commitDeadline ?? new Date(Date.now() + settings.commitWindowMs).toISOString()) + 60_000
            while (alive(running.pid) && Date.now() < until) await sleep(200)
            if (alive(running.pid)) fail('the old leader\'s server did not end its switch stop before the commit window ended')
          }
          const res = readFinalStopResult(s.sourceHome, s.id)
          if (!res) fail('the old leader died before its final batch')
          if (!res!.ok) fail(`the old leader's final batch: ${res!.why ?? 'failed'}`)
          s.finalBatch = res!.batch
          s.stoppedAt ??= res!.stoppedAt
          const door = await keepWitnessDoor()
          save('wait-target', `the old leader stopped after its final batch ${res!.batch} (unchanged)${door}`)
          await note('stopped')
          break
        }
        case 'wait-target': {
          const until = Date.parse(s.commitDeadline ?? s.stoppedAt ?? s.startedAt) + takeBackMs(settings)
          let told = ''
          for (;;) {
            const standing = await readStanding()
            if (committedRecord(standing, s)) { s.commit = standing!.number; break }
            if (standing && !handoverStanding(standing, s)) fail(`the handover is not standing at the witnesses any more (${JSON.stringify(summarize(standing))})`)
            const n = await theirs()
            if (n?.step === 'gave-up') fail(`${s.to} gave up: ${n.why ?? 'no reason given'}`)
            const line = n ? `waiting for ${s.to} (its last note: ${n.step}, ${Math.round((Date.now() - Date.parse(n.at)) / 1000)} s ago)` : `waiting for ${s.to}`
            if (n?.step !== told) { out(line); told = n?.step ?? '' }
            if (cancelAsked()) fail('cancelled by hand')
            if (Date.now() > until) fail(`${s.to} did not commit before its deadline (${s.commitDeadline}) and the take-back time`)
            await sleep(500)
          }
          diesAt('after-commit-seen')
          save('hand-off', `record ${s.commit}: ${s.to} leads`)
          break
        }
        case 'hand-off': {
          const c = s.commit ?? (await readStanding())?.number
          writeMarker(s.sourceHome, { switchId: s.id, to: s.to, state: 'handed-over', handover: s.handover, ...(c ? { commit: c } : {}), ...(target.doors?.length ? { leaderDoors: target.doors } : {}), at: new Date().toISOString() })
          // Records first (the marker), mode second: this machine's service follows the new leader as
          // its replica (the mode's home: the Walnut it follows, the new leader's data dir). The pointer
          // lets the service's start hook find this record when a kill fell between the two.
          writeSwitchPointer({ switchId: s.id, side: 'source', stateFile: switchStateFile(home) }, env)
          const walnutId = await instanceIdAt(s.sourceHome).catch(() => null) ?? ''
          const r = await applyServiceRole({ want: { role: 'replica', home: s.targetHome, walnutId }, switchId: s.id, current: s.serviceRole, set: o.setServiceRole, record: (x) => { s.serviceRole = x; writeDurableJson(switchStateFile(home), s) } })
          try { fs.unlinkSync(sourceCancelFile(home)) } catch { /* none */ }
          save('done', `${s.to} leads; this home is handed over${r.set ? '; service role: replica' : `; service role not set (${r.why})`}`)
          await note('handed-off')
          return s
        }
        case 'cancel': {
          // A server still in its switch stop decides by its result: never cancel or start around it.
          if (!(await stopEnded())) throw new SwitchRefused('the old leader\'s server did not end its switch stop before the commit window ended: this side stays as it is; rerun with --resume')
          const standingNow = await readStanding()
          if (committedRecord(standingNow, s)) { out('cancel: the commit stood first; finishing the switch instead'); save('hand-off', 'committed before the cancel'); break }
          // The old leader ended with its final mark: the new leader may be promoting on it now. Rolling back
          // here would start the old home beside it, so unless a person cancels, the new leader gave up, or
          // the window and the take-back time passed, wait for its commit instead.
          const fin = readFinalStopResult(s.sourceHome, s.id)
          const until = Date.parse(s.commitDeadline ?? '') + takeBackMs(settings)
          if (fin?.ok && !side.runningServer() && handoverStanding(standingNow, s) && !cancelAsked() && (await theirs())?.step !== 'gave-up' && Date.now() < until) {
            out('cancel: the old leader ended with its final mark and the handover stands; waiting for the new leader instead')
            s.rollbackWhy = undefined
            save('wait-target', 'the final mark is out: the new leader decides')
            break
          }
          if (side.runningServer()) {
            // The old leader still runs: its own process takes the handover back and leads at once.
            const r = await side.api('POST', '/api/leader/cancel').catch((err) => ({ status: 0, json: { why: (err as Error).message } }))
            const j = r.json as { ok?: boolean; why?: string } | null
            if (!j?.ok && j?.why === 'committed before the cancel') { save('hand-off', 'committed before the cancel'); break }
            if (!j?.ok) throw new SwitchRefused(`the old leader could not cancel the handover (${j?.why ?? `status ${r.status}`}): rerun with --cancel (no witness majority, no leader)`)
            save('restore', 'the old leader cancelled the handover and leads again')
            break
          }
          const standing = await readStanding()
          if (standing === undefined) throw new SwitchRefused('no majority of the witnesses answers, so it is not known whether the new leader committed: this side stays stopped; rerun with --cancel (no witness majority, no leader)')
          save('restore', handoverStanding(standing, s)
            ? `the old leader's server stopped, so nobody can cancel its handover (record ${standing!.number}): the old leader takes the permission back once it runs out at the witnesses`
            : 'no handover stands')
          break
        }
        case 'restore': {
          if (readMarker(s.sourceHome)?.switchId === s.id) removeMarker(s.sourceHome)
          save('start-source', 'the marker is removed')
          break
        }
        case 'start-source': {
          if (!(await stopEnded())) throw new SwitchRefused('the old leader\'s server did not end its switch stop before the commit window ended: it is not started beside it; rerun with --resume')
          if (s.sourceWasRunning && !side.runningServer()) {
            const started = await side.startServer('leader')
            if (!started.ok) {
              // It came up as a standby: the new leader committed after all (its record is the truth).
              if (committedRecord(await readStanding(), s)) { out('the new leader committed after all; finishing the switch'); save('hand-off', 'committed while this side rolled back'); break }
              throw new SwitchRefused(`rolled back, but the old leader did not start again: ${started.why}\n${started.logTail ?? ''}`)
            }
          }
          // A restarted old leader holds again only once its handover ran out (up to a minute).
          const leads = s.sourceWasRunning ? await waitDoorsOpen(side, takeBackMs(settings)) : true
          try { fs.unlinkSync(sourceCancelFile(home)) } catch { /* none */ }
          save('rolled-back', `${s.rollbackWhy ?? ''}${leads ? '' : ` (${s.from} has not taken the permission back yet; it keeps asking)`}`)
          await note('rolled-back', s.rollbackWhy)
          return s
        }
        case 'done':
        case 'rolled-back':
          return s
      }
    } catch (caught) {
      const preCommit = PRE_COMMIT.has(s.step)
      if (!(caught instanceof StepFailed) && !preCommit) throw caught
      if (!preCommit) throw new SwitchRefused(`${s.step}: ${(caught as Error).message}; rerun with --resume`)
      const why = caught instanceof StepFailed ? caught.message : `${s.step}: ${(caught as Error)?.message ?? String(caught)}`
      if (s.step === 'preflight') {
        s.rollbackWhy = why
        if (persisted) save('rolled-back', `refused: ${why}`)
        else out(`refused: ${why}`)
        throw new SwitchRefused(why)
      }
      s.rollbackWhy = why
      save('cancel', why)
    }
  }
}

async function preflight(st: SwitchState, settings: LeaderSwitchSettings, src: SwitchSide, read: () => Promise<WitnessReading>): Promise<void> {
  const problems: string[] = []
  const running = src.runningServer()
  st.sourceWasRunning = !!running
  if (!running) problems.push(`the old leader's server is not running on ${st.sourceHome}: start it first (only the process that holds the permission can hand it over)`)
  else {
    const s = await src.api('GET', '/api/leader/status').catch(() => null)
    const j = s?.json as { version?: string; permit?: { mayAct?: boolean; state?: string }; homeOnHosts?: SwitchState['sourceHomeOnHosts'] } | null
    if (typeof j?.homeOnHosts?.home === 'string' && j.homeOnHosts.home) st.sourceHomeOnHosts = { home: j.homeOnHosts.home, formerHomes: Array.isArray(j.homeOnHosts.formerHomes) ? j.homeOnHosts.formerHomes : [] }
    else if (j?.permit) problems.push('the old leader does not say which data dir its hosts know it by (a program older than this switch): its hosts could not follow the new leader')
    if (!j?.permit) problems.push('the old leader runs without the write permission wired (start it with the experiment on and leader_switch set)')
    else if (!j.permit.mayAct) problems.push(`the old leader may not act now (${j.permit.state})`)
    if (j?.version) st.sourceVersion = j.version
  }
  const { standing, answered } = await read().catch((err: Error) => { problems.push(err.message); return { standing: undefined, answered: 0 } })
  if (answered < majorityOf(settings.witnesses.map((w) => w.id))) problems.push(`only ${answered} of ${settings.witnesses.length} witnesses answered`)
  else if (!standing) problems.push(standing === null ? 'the witnesses hold no record yet: start the leader once with the permission' : 'the witnesses do not agree on a record')
  else if (standing.holder !== st.from || standing.kind === 'handover') problems.push(standing.kind === 'release'
    ? `the permission was released by ${standing.by} (record ${standing.number}) and nobody holds it yet: start the old leader first`
    : `the witnesses name ${standing.holder} (${standing.kind} ${standing.number}), not ${st.from}`)
  if (readMarker(st.sourceHome)) problems.push('this home carries a leader-switch marker already')
  // Who started it, recorded by the leader (console and Walnut Health), and the trust rule for a begin.
  if (running && !problems.length) {
    const b = await src.api('POST', '/api/leader/switch/begin', { to: st.to, switchId: st.id }).catch(() => null)
    const bj = b?.json as { ok?: boolean; why?: string; startedBy?: StartedBy } | null
    if (!bj?.ok) problems.push(`the old leader refused the switch: ${bj?.why ?? `status ${b?.status ?? 0}`}`)
    else if (bj.startedBy) st.startedBy = bj.startedBy
  }
  // The new leader's own check, on its machine, started by the old leader's server over its copy link:
  // IT reaches a majority of the witnesses with no leader link, holding the old leader's record.
  if (running && !problems.length) {
    // Past the route's own deadline (150 s in all, routes/leader-switch.ts), so its answer, a timeout included, is what is read.
    const c = await src.api('POST', '/api/leader/switch/check', { to: st.to, switchId: st.id }, 180_000).catch((err) => ({ status: 0, json: { why: (err as Error).message } }))
    const r = (c.json as { report?: CheckReport & { reach?: { id: string; answered: boolean; held: { holder?: string; kind?: string } | null }[] }; verify?: { drift?: number; error?: string }; why?: string } | null)
    const report = r?.report
    if (!report) problems.push(`the new leader's check did not report: ${r?.why ?? `status ${c.status}`}`)
    else {
      // The copy there, verified by the old leader's server over its copy link before the check read it.
      if (r?.verify?.error) problems.push(`the standby copy on ${st.to} did not verify: ${r.verify.error}`)
      else if (r?.verify?.drift) problems.push(`the standby copy on ${st.to} had ${r.verify.drift} path(s) changed in it directly (repaired, saved under drift/): check them first`)
      problems.push(...report.problems)
      const holding = (report.reach ?? []).filter((w) => w.answered && w.held && w.held.holder === st.from && w.held.kind !== 'handover' && w.held.kind !== 'release').length
      if (report.ok && holding < majorityOf(settings.witnesses.map((w) => w.id))) problems.push(`the witnesses the new leader reaches do not name ${st.from} as the holder (${JSON.stringify(report.reach)})`)
      if (olderVersion(report.version, st.sourceVersion)) problems.push(`the new leader runs ${report.version}, older than ${st.sourceVersion} that wrote the data`)
    }
  }
  if (problems.length) throw new StepFailed(problems.join('; '))
}
