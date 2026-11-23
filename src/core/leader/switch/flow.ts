/**
 * The manual leader switch (docs/reference/leader-switch.md). A stop, not a live freeze:
 *
 *   preflight     refuse with the reason, nothing changed
 *   handover      the marker in the old home, then the old leader's server writes the handover
 *                 record (the witnesses take it only from the process that holds the permission)
 *                 and acts no more; it may still cancel it while it runs
 *   stop-source   a planned stop of the old leader's server
 *   final-batch   one last standby batch of the stopped home, a verify pass, and a second batch
 *                 that must find nothing changed (the copy is the source's final state)
 *   promote       the copy becomes the new home (promote.ts)
 *   trial         the new leader starts with every outward door closed and checks itself
 *   commit        the new leader starts for real, told the handover's number: its own record
 *                 on top of the handover reaches a majority. From here the old machine never
 *                 acts again and there is no way back but a switch
 *   start-target  the new leader opens its doors
 * The switch command itself only reads the witnesses. Before the commit, any failure rolls
 * back: the old leader's server cancels the handover when it still runs; once it stopped no
 * process can (the record was its process's), so the restarted old leader waits until the
 * handover runs out at the witnesses and grants itself. The old home was never changed.
 *
 * Every step is written to `local/leader-switch/switch-state.json` in the old home before it runs and
 * is safe to run again, so `--resume` after a kill finishes or rolls back.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import Database from '../../../lib/sqlite.js'
import { getVersion } from '../../version.js'
import { snapshotTo, verifyStandby, standbyStatus, StandbyTarget } from '../../standby/index.js'
import { majorityOf, type PermitRecord } from '../permit/types.js'
import { makeWitnessReader, type ReadingServer } from './witness-reader.js'
import { appendHistory, readHistory, readMarker, removeMarker, summarize, switchDir, takeSwitchLock, writeDurableJson, writeMarker, writePromoted, promotedFile, readPromoted } from './records.js'
import { demoteTrialHome, moveRoots, promoteCopy } from './promote.js'
import { homePathRules } from './home-path-rules.js'
import { offlineCheck, olderVersion, onlineCheck } from './self-check.js'
import { LocalSide, type SwitchSide } from './side.js'
import { machineByHome, machineById, readHomeSwitchConfig, type LeaderSwitchSettings, type MachinePlace } from './settings.js'

export type SwitchStep =
  | 'preflight' | 'handover' | 'stop-source' | 'final-batch' | 'promote' | 'trial' | 'commit' | 'start-target' | 'done'
  | 'cancel' | 'restore' | 'start-source' | 'rolled-back'

export interface SwitchState {
  id: string
  from: string
  to: string
  sourceHome: string
  targetHome: string
  /** Where the batches of the old leader land (the target machine's standby_dir). */
  standbyDir: string
  /** Where the new leader's batches go (the old machine's standby_dir). */
  reverseStandbyDir: string
  /** The two machines' account home dirs (leader_switch.machines[].account_home): paths under the old one move. */
  sourceAccountHome?: string
  targetAccountHome?: string
  sourceVersion: string
  sourceWasRunning: boolean
  step: SwitchStep
  log: { step: SwitchStep; at: string; note?: string }[]
  handover?: number
  commit?: number
  finalBatch?: number
  startedAt: string
  /** The old leader's server stopped: the downtime starts. */
  stoppedAt?: string
  /** The new leader answers with its doors open: the downtime ends. */
  readyAt?: string
  downtimeMs?: number
  rollbackWhy?: string
  /** The offline self-check of the new home passed (a resumed trial does not judge again a home its trial server touched). */
  offlineChecked?: boolean
  /** The data dir the old leader's hosts know it by, as its server said at the preflight (moved-home.ts). */
  sourceHomeOnHosts?: { home: string; formerHomes: string[] }
  /** Sends the old leader had begun and not settled: never sent again, listed for a person. */
  outcomeUnknown?: string[]
}

export class SwitchRefused extends Error {
  constructor(message: string) { super(message); this.name = 'SwitchRefused' }
}

export interface SwitchOptions {
  /** The home of the machine that leads now (this Walnut's). */
  home: string
  to?: string
  back?: boolean
  resume?: boolean
  cancel?: boolean
  out?: (line: string) => void
  /** How to reach a machine: LocalSide in this phase. */
  sideOf?: (m: MachinePlace) => SwitchSide
  env?: NodeJS.ProcessEnv
  /** Tests only: the promotion leaves the applied-ops ledger as the old home wrote it. */
  skipLedgerRewrite?: boolean
}

const RECENT_BATCH_S = 5 * 60
const FINAL_BATCH_TRIES = 6

export function switchStateFile(home: string): string {
  return path.join(switchDir(home), 'switch-state.json')
}

export function readSwitchState(home: string): SwitchState | null {
  try { return JSON.parse(fs.readFileSync(switchStateFile(home), 'utf8')) as SwitchState } catch { return null }
}

function killPoint(env: NodeJS.ProcessEnv, name: string): void {
  // Tests only: the switch command dies here as a crash would (SIGKILL: no cleanup runs).
  if (env.WALNUT_LEADER_SWITCH_KILL_AT === name) process.kill(process.pid, 'SIGKILL')
}

function freeBytes(dir: string): number | null {
  try {
    let d = dir
    while (!fs.existsSync(d)) d = path.dirname(d)
    const s = fs.statfsSync(d)
    return Number(s.bavail) * Number(s.bsize)
  } catch { return null }
}

export async function runLeaderSwitch(opts: SwitchOptions): Promise<SwitchState> {
  const env = opts.env ?? process.env
  const out = opts.out ?? (() => {})
  const home = path.resolve(opts.home)
  const cfg = readHomeSwitchConfig(home)
  if (!cfg.flag) throw new SwitchRefused('the experiment switchable_leader is off in this Walnut (Settings > Experimental)')
  if (!cfg.settings) throw new SwitchRefused(cfg.problem ?? 'config.yaml has no leader_switch section')
  const settings = cfg.settings
  const sideOf = opts.sideOf ?? ((m: MachinePlace) => new LocalSide(m))
  let release: () => void
  try { release = takeSwitchLock(home) } catch (err) { throw new SwitchRefused((err as Error).message) }
  try {
    return await runLocked(opts, env, out, home, settings, sideOf)
  } finally {
    release()
  }
}

async function runLocked(opts: SwitchOptions, env: NodeJS.ProcessEnv, out: (line: string) => void, home: string, settings: LeaderSwitchSettings, sideOf: (m: MachinePlace) => SwitchSide): Promise<SwitchState> {
  let state = readSwitchState(home)
  const open = state && state.step !== 'done' && state.step !== 'rolled-back'
  if (opts.resume || opts.cancel) {
    if (!state || !open) throw new SwitchRefused('no switch from this home is under way')
  } else {
    if (open) throw new SwitchRefused(`switch ${state!.id} to ${state!.to} is under way (step ${state!.step}): finish it with --resume, or --cancel it`)
    state = newState(home, settings, opts, env)
  }
  const st = state!
  const source = machineById(settings, st.from)
  const target = machineById(settings, st.to)
  if (!source || !target) throw new SwitchRefused(`machine ${!source ? st.from : st.to} is not in leader_switch.machines`)
  const srcSide = sideOf(source)
  const dstSide = sideOf(target)
  // Tests only: the promotion leaves the applied-ops ledger as the old home wrote it.
  const skipLedger = opts.skipLedgerRewrite || env.WALNUT_LEADER_SWITCH_SKIP_LEDGER_REWRITE === '1'

  const save = (step: SwitchStep, note?: string) => {
    st.step = step
    st.log.push({ step, at: new Date().toISOString(), ...(note ? { note } : {}) })
    writeDurableJson(switchStateFile(home), st)
    out(`${step}${note ? `: ${note}` : ''}`)
  }

  if (opts.cancel) {
    if (st.step === 'start-target' || st.step === 'done') throw new SwitchRefused(`switch ${st.id} committed (record ${st.commit}): only a switch back undoes it`)
    st.rollbackWhy = 'cancelled by hand'
    save('cancel', 'cancelled by hand')
  } else if (!opts.resume) {
    save('preflight')
  } else {
    out(`resuming switch ${st.id} at ${st.step}`)
  }

  // The switch command reads the witnesses and never proposes: they take records only from the
  // process that holds the permission, which is always a server.
  const readWitnesses = witnessReading(`${st.from}-switch-reader`, settings, srcSide, dstSide)
  const fail = (why: string): never => { throw new StepFailed(why) }

  for (;;) {
    try {
      switch (st.step) {
        case 'preflight': {
          await preflight(st, settings, srcSide, dstSide, env)
          save('handover', `checks passed; handing over to ${st.to}`)
          break
        }
        case 'handover': {
          writeMarker(st.sourceHome, { switchId: st.id, to: st.to, state: 'switching', at: new Date().toISOString(), ...(st.handover ? { handover: st.handover } : {}) })
          const { standing } = await readWitnesses()
          let done: number | null = null
          if (standing && standing.kind === 'handover' && standing.from === st.from && standing.to === st.to) done = standing.number
          else if (committedRecord(standing, st)) { save('commit', `already committed (record ${standing!.number})`); break }
          else {
            if (!standing || standing.holder !== st.from) fail(`the witnesses do not name ${st.from} as the holder (${JSON.stringify(summarize(standing))})`)
            if (!srcSide.runningServer()) fail(`the old leader's server is not running: only the process that holds the permission can hand it over`)
            const r = await srcSide.api('POST', '/api/leader/handover', { to: st.to }).catch((err) => ({ status: 0, json: { why: (err as Error).message } }))
            const j = r.json as { ok?: boolean; record?: number; why?: string } | null
            if (!j?.ok || !j.record) fail(`the old leader did not hand over: ${j?.why ?? `status ${r.status}`}`)
            done = j!.record!
          }
          st.handover = done!
          writeMarker(st.sourceHome, { switchId: st.id, to: st.to, state: 'switching', handover: st.handover, at: new Date().toISOString() })
          save('stop-source', `handover record ${st.handover} at a majority`)
          killPoint(env, 'after-handover')
          break
        }
        case 'stop-source': {
          const { wasRunning } = await srcSide.stopServer()
          if (wasRunning || !st.stoppedAt) st.stoppedAt ??= new Date().toISOString()
          save('final-batch', wasRunning ? 'the old leader stopped' : 'the old leader was not running')
          break
        }
        case 'final-batch': {
          let ok = false
          let reason = ''
          if (env.WALNUT_LEADER_SWITCH_KILL_AT === 'during-final-batch') setTimeout(() => killPoint(env, 'during-final-batch'), 30).unref?.()
          for (let i = 0; i < FINAL_BATCH_TRIES && !ok; i++) {
            const r = await snapshotTo(st.sourceHome, st.standbyDir)
            if (r.ok) { ok = true; st.finalBatch = r.commit.batch } else reason = r.reason
          }
          if (!ok) fail(`the final batch stayed void ${FINAL_BATCH_TRIES} times: ${reason}`)
          await verifyStandby(st.standbyDir)
          // Nothing of the stopped home may change after its final batch: a second batch must find nothing new.
          const again = await snapshotTo(st.sourceHome, st.standbyDir)
          if (!again.ok || !again.commit.unchanged) fail(`the old home changed after its final batch (${again.ok ? `${again.commit.written} written, ${again.commit.deleted} deleted` : again.reason}): a writer outside Walnut is still at it`)
          if (again.ok) st.finalBatch = again.commit.batch
          save('promote', `final batch ${st.finalBatch}, unchanged on a second look`)
          break
        }
        case 'promote': {
          // A switch back: the old home's standby (handed-over.ts) may still run there. It is
          // stopped before its home is moved aside and the copy takes that path and its port.
          await dstSide.stopServer()
          const r = await promoteCopy({
            switchId: st.id, standbyDir: st.standbyDir, home: st.targetHome, previousHome: st.sourceHome, reverseStandbyDir: st.reverseStandbyDir,
            ...accountHomes(st),
            skipLedgerRewrite: skipLedger,
            afterRename: () => killPoint(env, 'during-promote'),
          })
          st.outcomeUnknown = listUnsettledSends(st.targetHome)
          const moved = r.rewritten.reduce((n, d) => n + d.values, 0)
          save('trial', `copy is the new home${r.movedAside ? ` (what was there is kept at ${r.movedAside})` : ''}; ${r.ledgerRows} ledger rows moved to it; ${moved} old-machine paths rewritten in ${r.rewritten.length} files`)
          killPoint(env, 'after-promote')
          break
        }
        case 'trial': {
          await dstSide.stopServer()
          const files = (await new StandbyTarget(st.standbyDir).current()).files
          // A resumed trial: its server may have touched the home (a WAL checkpoint, a row it
          // reconciled), so sizes and row counts are judged only the first time.
          const off = await offlineCheck({
            sourceHome: st.sourceHome, home: st.targetHome, files, sizesAndRows: !st.offlineChecked,
            roots: moveRoots({ previousHome: st.sourceHome, home: st.targetHome, ...accountHomes(st) }),
            rules: homePathRules({ skipLedgerRewrite: skipLedger }),
          })
          if (!off.ok) fail(`self-check of the new home: ${off.problems.join('; ')}`)
          if (!st.offlineChecked) {
            st.offlineChecked = true
            const p = off.detail.paths as { files: number; ms: number; kept: number }
            save('trial', `offline self-check passed (old-machine paths scanned: ${p.files} files in ${p.ms} ms, ${p.kept} kept on purpose, none left)`)
          }
          const started = await dstSide.startServer('trial')
          if (!started.ok) fail(`the trial start failed: ${started.why}${started.logTail ? `\n${started.logTail.split('\n').slice(-8).join('\n')}` : ''}`)
          killPoint(env, 'during-trial')
          const on = await onlineCheck({ side: dstSide, sourceHome: st.sourceHome, sourceVersion: st.sourceVersion, task: off.task, note: off.note })
          await dstSide.stopServer()
          if (!on.ok) fail(`the trial server's self-check: ${on.problems.join('; ')}`)
          save('commit', 'the trial passed')
          break
        }
        case 'commit': {
          // The new leader's server writes the commit itself (the witnesses take a renew on the
          // handover from the new holder's server): start it told the handover's number.
          // Before its start the new home says where the old leader was on its hosts: it declares that once its commit stands (moved-home.ts).
          const onHosts = { to: st.to, handover: st.handover, ...(st.sourceHomeOnHosts ? { fromHomeOnHosts: st.sourceHomeOnHosts.home, fromFormerHomes: st.sourceHomeOnHosts.formerHomes } : {}) }
          if (readPromoted(st.targetHome)?.state !== 'led') writePromoted(st.targetHome, { switchId: st.id, state: 'promoted', from: st.sourceHome, ...onHosts, at: new Date().toISOString() })
          let committed: PermitRecord | null = null
          const deadline = Date.now() + takeBackMs(settings)
          while (!committed && Date.now() < deadline) {
            const { standing } = await readWitnesses()
            if (committedRecord(standing, st)) { committed = standing!; break }
            if (standing && !(standing.kind === 'handover' && standing.to === st.to && standing.from === st.from)) fail(`the handover is not standing at the witnesses any more (${JSON.stringify(summarize(standing))})`)
            if (!dstSide.runningServer()) {
              const started = await dstSide.startServer('leader', 120_000, st.handover)
              if (!started.ok) fail(`the new leader did not start to commit: ${started.why}${started.logTail ? `\n${started.logTail.split('\n').slice(-8).join('\n')}` : ''}`)
            }
            await new Promise((r) => setTimeout(r, 250))
          }
          if (!committed) fail('the new leader\'s commit did not reach a majority of the witnesses')
          st.commit = committed!.number
          killPoint(env, 'after-commit-majority')
          writeMarker(st.sourceHome, { switchId: st.id, to: st.to, state: 'handed-over', handover: st.handover, commit: st.commit, at: new Date().toISOString() })
          writePromoted(st.targetHome, { switchId: st.id, state: 'led', from: st.sourceHome, ...onHosts, at: new Date().toISOString() })
          appendHistory(st.targetHome, { switchId: st.id, from: st.from, to: st.to, committedAt: new Date().toISOString(), record: st.commit })
          save('start-target', `record ${st.commit} at a majority: ${st.to} holds the write permission, ${st.from} never acts again`)
          break
        }
        case 'start-target': {
          if (!dstSide.runningServer()) {
            // Its commit's process is gone (a crash): a new one waits until that record runs out, then grants.
            const started = await dstSide.startServer('leader')
            if (!started.ok) throw new SwitchRefused(`committed, but the new leader did not start: ${started.why}. Rerun with --resume; the old home stays handed over.\n${started.logTail ?? ''}`)
          }
          const ready = await waitDoorsOpen(dstSide, takeBackMs(settings))
          if (!ready) throw new SwitchRefused('committed, but the new leader has not opened its doors (its permission); rerun with --resume')
          st.readyAt ??= new Date().toISOString()
          if (st.stoppedAt) st.downtimeMs = Date.parse(st.readyAt) - Date.parse(st.stoppedAt)
          save('done', `${st.to} leads${st.downtimeMs !== undefined ? `; downtime ${(st.downtimeMs / 1000).toFixed(1)} s` : ''}`)
          killPoint(env, 'after-commit')
          return st
        }
        case 'done':
          return st
        case 'cancel': {
          // A commit that stood first sends the switch forward, whatever asked for the cancel.
          const before = (await readWitnesses()).standing
          if (committedRecord(before, st)) {
            out('cancel: the commit stood before the cancel; finishing the switch instead')
            save('commit', 'committed before the cancel')
            break
          }
          // The new leader's server may be up for its commit: stopped, so that what the witnesses
          // hold next is final (the switch command itself proposes nothing). A commit that stood
          // between the read above and the stop shows below (its release, too, counts).
          await dstSide.stopServer()
          const { standing } = await readWitnesses()
          if (committedRecord(standing, st)) {
            out('cancel: the commit stood before the cancel; finishing the switch instead')
            save('commit', 'committed before the cancel')
            break
          }
          if (srcSide.runningServer()) {
            // The old leader still runs: its own process takes the handover back and leads at once.
            const r = await srcSide.api('POST', '/api/leader/cancel').catch((err) => ({ status: 0, json: { why: (err as Error).message } }))
            const j = r.json as { ok?: boolean; why?: string } | null
            if (!j?.ok && j?.why === 'committed before the cancel') { save('commit', 'committed before the cancel'); break }
            if (!j?.ok) throw new SwitchRefused(`the old leader could not cancel the handover (${j?.why ?? `status ${r.status}`}): rerun with --cancel (no witness majority, no leader)`)
            save('restore', 'the old leader cancelled the handover and leads again')
            break
          }
          if (standing === undefined) throw new SwitchRefused('no majority of the witnesses answers, so it is not known whether the new leader committed: both sides stay stopped; rerun with --cancel (no witness majority, no leader)')
          save('restore', standing?.kind === 'handover' && standing.from === st.from
            ? `the old leader's server stopped, so nobody can cancel its handover (record ${standing.number}): the old leader takes the permission back once it runs out at the witnesses`
            : 'no handover stood')
          break
        }
        case 'restore': {
          await dstSide.stopServer()
          const d = await demoteTrialHome({ switchId: st.id, home: st.targetHome })
          // A kill just before the copy's rename left the promotion mark in the copy itself: it
          // is the switch's own, not a change to report as drift.
          dropPromotionMark(path.join(st.standbyDir, 'copy'), st.id)
          // The standby copy went into the tried home: build it again from its chunks.
          if (fs.existsSync(st.standbyDir)) await verifyStandby(st.standbyDir).catch(() => null)
          if (readMarker(st.sourceHome)?.switchId === st.id) removeMarker(st.sourceHome)
          save('start-source', d.keptAt ? `the tried home is kept at ${d.keptAt}` : 'nothing to put back')
          break
        }
        case 'start-source': {
          if (st.sourceWasRunning && !srcSide.runningServer()) {
            const started = await srcSide.startServer('leader')
            if (!started.ok) throw new SwitchRefused(`rolled back, but the old leader did not start again: ${started.why}\n${started.logTail ?? ''}`)
          }
          // A restarted old leader holds again only once its handover ran out (up to a minute).
          const leads = st.sourceWasRunning ? await waitDoorsOpen(srcSide, takeBackMs(settings)) : true
          save('rolled-back', `${st.rollbackWhy ?? ''}${leads ? '' : ` (${st.from} has not taken the permission back yet; it keeps asking)`}`)
          return st
        }
        case 'rolled-back':
          return st
      }
    } catch (caught) {
      // Before the commit every failure rolls back, a bug's included: the old home was never
      // changed, so going back is always safe. From the commit on only --resume goes forward.
      const preCommit = PRE_COMMIT.has(st.step)
      if (!(caught instanceof StepFailed) && !preCommit) throw caught
      const err = caught instanceof StepFailed ? caught : new StepFailed(`${st.step}: ${(caught as Error)?.message ?? String(caught)}`)
      if (st.step === 'preflight') {
        st.rollbackWhy = err.message
        save('rolled-back', `refused: ${err.message}`)
        throw new SwitchRefused(err.message)
      }
      st.rollbackWhy = err.message
      save('cancel', err.message)
    }
  }
}

function dropPromotionMark(copy: string, switchId: string): void {
  const file = promotedFile(copy)
  if (readPromoted(copy)?.switchId !== switchId) return
  try { fs.chmodSync(path.dirname(file), 0o700); fs.unlinkSync(file) } catch { /* gone */ }
}

/**
 * A record of the new holder above this switch's handover: the switch committed. Its renew or
 * grant names it the holder; its release (a planned stop of the new leader) names no holder,
 * but only a holder releases, so it committed too.
 */
function committedRecord(standing: PermitRecord | null | undefined, st: SwitchState): boolean {
  if (!standing || standing.number <= (st.handover ?? 0)) return false
  if (standing.kind === 'release') return standing.by === st.to
  return standing.holder === st.to && standing.kind !== 'handover'
}

/**
 * How long a server may take to hold the permission when the record standing was written by a
 * process that is gone: the witness's hold of it, the grant's back-off, and some room.
 */
function takeBackMs(settings: LeaderSwitchSettings): number {
  const p = settings.params
  return p.validMs + p.witnessMarginMs + p.backoffMaxMs + 30_000
}

function accountHomes(st: SwitchState): { previousAccountHome?: string; accountHome?: string } {
  return { ...(st.sourceAccountHome ? { previousAccountHome: st.sourceAccountHome } : {}), ...(st.targetAccountHome ? { accountHome: st.targetAccountHome } : {}) }
}

const PRE_COMMIT = new Set<SwitchStep>(['preflight', 'handover', 'stop-source', 'final-batch', 'promote', 'trial', 'commit'])

/**
 * The witnesses' record for the switch: local ones read here, remote ones through whichever side's server
 * runs (the old leader before the handover, the new leader's commit start after it; a trial start cannot read them).
 */
function witnessReading(id: string, settings: LeaderSwitchSettings, srcSide: SwitchSide, dstSide: SwitchSide): () => Promise<{ standing: PermitRecord | null | undefined; answered: number }> {
  const servers = (): ReadingServer[] => [srcSide, dstSide].filter((side) => side.runningServer()).map((side) => ({ api: (m: string, p: string) => side.api(m, p) }))
  const read = makeWitnessReader(id, settings, servers)
  return () => read().catch((err) => { throw err instanceof Error && err.name === 'NoLeaderServerToRead' ? new StepFailed(err.message) : err })
}

class StepFailed extends Error {
  constructor(message: string) { super(message); this.name = 'StepFailed' }
}

function newState(home: string, settings: LeaderSwitchSettings, opts: SwitchOptions, env: NodeJS.ProcessEnv): SwitchState {
  const source = machineByHome(settings, home)
  if (!source) throw new SwitchRefused(`this home (${home}) is not the home of any machine in leader_switch.machines`)
  let to = opts.to
  if (opts.back) {
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
    from: source.id,
    to: target.id,
    sourceHome: source.home,
    targetHome: target.home,
    ...(source.accountHome ? { sourceAccountHome: source.accountHome } : {}),
    ...(target.accountHome ? { targetAccountHome: target.accountHome } : {}),
    standbyDir: target.standbyDir,
    reverseStandbyDir: source.standbyDir,
    sourceVersion: env.WALNUT_LEADER_SWITCH_SOURCE_VERSION || getVersion(),
    sourceWasRunning: false,
    step: 'preflight',
    log: [],
    startedAt: new Date().toISOString(),
  }
}

async function preflight(st: SwitchState, settings: LeaderSwitchSettings, src: SwitchSide, dst: SwitchSide, env: NodeJS.ProcessEnv): Promise<void> {
  const problems: string[] = []
  // The old leader: running with its permission (only its process can hand it over).
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
  if (dst.runningServer()) problems.push(`a server already runs on the new leader's home ${st.targetHome}`)
  // The standby copy: complete, recent, verified.
  try {
    const status = await standbyStatus(st.standbyDir)
    if (status.batch === null) problems.push(`the standby copy ${st.standbyDir} holds no complete batch yet`)
    else if ((status.ageSeconds ?? Infinity) > RECENT_BATCH_S) problems.push(`the standby copy's last batch is ${status.ageSeconds} s old (more than ${RECENT_BATCH_S} s): is the standby running?`)
    const v = await verifyStandby(st.standbyDir)
    if (v.drift.length) problems.push(`the standby copy had ${v.drift.length} path(s) changed in it directly (repaired, saved under drift/): check them first`)
    const copyCfg = readHomeSwitchConfig(path.join(st.standbyDir, 'copy'))
    if (!copyCfg.flag || !copyCfg.settings) problems.push('the standby copy\'s config.yaml does not have the experiment and leader_switch set: the new leader would not hold the permission')
    const free = freeBytes(st.targetHome)
    const need = Math.max(1024 ** 3, status.bytes * 0.2)
    if (free !== null && free < need) problems.push(`only ${(free / 1024 ** 3).toFixed(1)} GB free where the new home goes; ${(need / 1024 ** 3).toFixed(1)} GB needed`)
  } catch (err) {
    problems.push(`the standby copy ${st.standbyDir}: ${(err as Error).message}`)
  }
  // The witnesses: a majority answers and names the old leader.
  const { standing, answered } = await witnessReading(`${st.from}-switch-reader`, settings, src, dst)()
  if (answered < majorityOf(settings.witnesses.map((w) => w.id))) problems.push(`only ${answered} of ${settings.witnesses.length} witnesses answered`)
  else if (!standing) problems.push(standing === null ? 'the witnesses hold no record yet: start the leader once with the permission' : 'the witnesses do not agree on a record')
  else if (standing.holder !== st.from || standing.kind === 'handover') problems.push(standing.kind === 'release'
    ? `the permission was released by ${standing.by} (record ${standing.number}) and nobody holds it yet: start the old leader first`
    : `the witnesses name ${standing.holder} (${standing.kind} ${standing.number}), not ${st.from}`)
  // The programs: the new leader's must read what the old one wrote.
  const targetVersion = dst.machine.env?.WALNUT_LEADER_SWITCH_FAKE_VERSION || getVersion()
  if (olderVersion(targetVersion, st.sourceVersion)) problems.push(`the new leader runs ${targetVersion}, older than ${st.sourceVersion} that wrote the data`)
  if (readMarker(st.sourceHome)) problems.push('this home carries a leader-switch marker already')
  if (problems.length) throw new StepFailed(problems.join('; '))
}

async function waitDoorsOpen(side: SwitchSide, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await side.api('GET', '/api/leader/status').catch(() => null)
    if ((r?.json as { permit?: { mayAct?: boolean } } | null)?.permit?.mayAct) return true
    await new Promise((res) => setTimeout(res, 250))
  }
  return false
}

/**
 * Mail sends the old leader claimed (`sending`) or could not settle (`unknown`): the new
 * leader's ledger has them as they were, its reaper makes `sending` into `unknown`, and none
 * is ever sent again. Listed for a person to check.
 */
function listUnsettledSends(home: string): string[] {
  const out: string[] = []
  const root = path.join(home, 'plugins')
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.isFile() && e.name.endsWith('.sqlite')) out.push(...unsettledIn(p))
    }
  }
  walk(root, 0)
  return out
}

function unsettledIn(file: string): string[] {
  try {
    const db = new Database(file, { readonly: true })
    try {
      const cols = (db.prepare("SELECT name FROM pragma_table_info('sends')").all() as { name: string }[]).map((c) => c.name)
      if (!cols.includes('idempotency_key') || !cols.includes('state')) return []
      return (db.prepare("SELECT idempotency_key AS k, state FROM sends WHERE state IN ('sending', 'unknown')").all() as { k: string; state: string }[]).map((r) => `mail ${r.k} (${r.state})`)
    } finally { db.close() }
  } catch { return [] }
}
