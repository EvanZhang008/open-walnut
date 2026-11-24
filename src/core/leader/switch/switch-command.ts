/**
 * `walnut leader switch`, the command a person types (docs/reference/leader-switch.md, "Two jobs").
 * It does no step itself: it starts this machine's job of the switch as a detached process (so a
 * closed terminal or a killed command stops nothing) and follows it, printing its lines, until it
 * ends. On one computer (both machines here) it follows both jobs.
 *
 *   --to X / --back   start the source job (preflight first: a refusal changes nothing)
 *   --resume          start again each job of this machine that stopped part way (its state says where)
 *   --cancel          ask each such job to roll back (a committed switch goes forward instead), then resume them
 *   --status          this machine's jobs, the witnesses' record as this machine reads it, each machine's newest note
 *   --job source|target   the job itself (what the command starts)
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { lockHolder, readMarker, summarize, switchLockFile } from './records.js'
import { machineByHome, readHomeSwitchConfig, type LeaderSwitchSettings, type MachinePlace } from './settings.js'
import { machineIdFile, permitHolderId } from './machine-id.js'
import { serverCommand } from '../../trial-start/process.js'
import { homeKey, switchFolder, ticketName, readSwitchFile, writeSwitchFile } from './ticket.js'
import {
  SOURCE_FINAL, SwitchRefused, TARGET_FINAL, readSwitchState, readTargetState, sourceCancelFile, targetCancelName,
  type SwitchState, type TargetState,
} from './flow.js'
import { targetJobLog, targetJobArgs } from './peer.js'
import { writeDurableJson } from './records.js'

export interface SwitchCommandOptions {
  home: string
  to?: string
  back?: boolean
  resume?: boolean
  cancel?: boolean
  /** On the machine that will lead: its standby folder (candidate-command.ts); `--to <this machine>` finds it too. */
  standbyDir?: string
  out?: (line: string) => void
  env?: NodeJS.ProcessEnv
}

export interface SwitchOutcome {
  /** 0 switched, 1 refused, 3 rolled back, 4 a job died part way (rerun with --resume). */
  code: 0 | 1 | 3 | 4
  source: SwitchState | null
  target: TargetState | null
  message: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))


/** The source job's output: beside this machine's id, outside every home (a refused switch writes nothing in the home). */
export function sourceJobLog(home: string, env: NodeJS.ProcessEnv): string {
  return path.join(path.dirname(machineIdFile(env)), 'leader-switch-jobs', `source-${homeKey(home)}.log`)
}

function settingsOf(home: string): LeaderSwitchSettings {
  const cfg = readHomeSwitchConfig(home)
  if (!cfg.flag) throw new SwitchRefused('the experiment switchable_leader is off in this Walnut (Settings > Experimental)')
  if (!cfg.settings) throw new SwitchRefused(cfg.problem ?? 'config.yaml has no leader_switch section')
  return cfg.settings
}

/** This machine's environment as its jobs run with it: its entry's env (its machine id, its HOME) over this process's. */
function machineEnv(self: MachinePlace | undefined, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...env, ...(self?.env ?? {}) }
  delete e.WALNUT_LEADER_SWITCH_START
  return e
}

/** A job spawned detached, its output appended to `log`; resolves with how it exited, when this process still lives to see it. */
function spawnJob(args: string[], env: NodeJS.ProcessEnv, log: string): { pid: number | null; exit: Promise<{ code: number | null; signal: string | null }> } {
  fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 })
  const fd = fs.openSync(log, 'a', 0o600)
  const cmd = serverCommand(args)
  const child = spawn(cmd[0]!, cmd.slice(1), { env, detached: true, stdio: ['ignore', fd, fd] })
  fs.closeSync(fd)
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  child.unref()
  return { pid: child.pid ?? null, exit }
}

/**
 * The source job of a switch begun on the new leader's machine (a forwarded begin, leader-relay-door.ts), started
 * by the old leader's server as this command would start it here: this machine's env, its log beside the machine id.
 * Its output for this switch starts at `from` in that log.
 */
export function startSourceJobFor(o: { home: string; switchId: string; to: string; forwardedBy?: string }): { log: string; from: number; pid: number | null; exit: Promise<{ code: number | null; signal: string | null }> } {
  const home = path.resolve(o.home)
  const settings = settingsOf(home)
  const env = machineEnv(machineByHome(settings, home), process.env)
  // A server's own start words never reach the job (a commit start's, a trial's).
  for (const k of ['WALNUT_LEADER_SWITCH_COMMIT', 'WALNUT_LEADER_SWITCH_COMMIT_UNTIL', 'WALNUT_LEADER_TRIAL', 'WALNUT_LEADER_SWITCH_KILL_AT']) delete env[k]
  const log = sourceJobLog(home, env)
  const from = (() => { try { return fs.statSync(log).size } catch { return 0 } })()
  const job = spawnJob(['leader', 'switch', '--job', 'source', '--to', o.to, '--switch', o.switchId, '--home', home, ...(o.forwardedBy ? ['--forwarded-by', o.forwardedBy] : [])], env, log)
  return { log, from, ...job }
}

/** New lines of a log since `from` (bytes), and where they end. */
export function readFrom(file: string, from: number): { text: string; to: number } {
  try {
    const size = fs.statSync(file).size
    if (size <= from) return { text: '', to: from }
    const fd = fs.openSync(file, 'r')
    try {
      const b = Buffer.alloc(size - from)
      fs.readSync(fd, b, 0, b.length, from)
      return { text: b.toString('utf8'), to: size }
    } finally { fs.closeSync(fd) }
  } catch { return { text: '', to: from } }
}

/**
 * The machines whose standby folder this machine may use as a path: every one while this home's copy
 * goes to a folder here (one computer, kind local); with `standby.host` the other machine is another
 * computer, reached only over the leader's copy link, so only this machine's own (a folder of the same
 * path on this disk is not that machine's, whatever it holds).
 */
function machinesHere(settings: LeaderSwitchSettings, home: string, env: NodeJS.ProcessEnv): LeaderSwitchSettings['machines'] {
  if (!readHomeSwitchConfig(home).standbyHost) return settings.machines
  const me = permitHolderId(env)
  return settings.machines.filter((m) => m.id === me)
}

/** The target machine of the source's switch when its standby folder is on this computer (one machine): its state is readable here. */
function localTarget(st: SwitchState | null, here: LeaderSwitchSettings['machines']): { dir: string; id: string } | null {
  if (!st || !here.some((m) => m.standbyDir === st.standbyDir)) return null
  return fs.existsSync(switchFolder(st.standbyDir)) ? { dir: st.standbyDir, id: st.id } : null
}

/** Open target jobs whose standby folder is on this computer (machinesHere). */
function openTargetsHere(here: LeaderSwitchSettings['machines']): { dir: string; id: string; state: TargetState | null }[] {
  const found: { dir: string; id: string; state: TargetState | null }[] = []
  for (const m of here) {
    const folder = switchFolder(m.standbyDir)
    let names: string[] = []
    try { names = fs.readdirSync(folder) } catch { continue }
    for (const n of names) {
      const id = /^(.+)\.json$/.exec(n)?.[1]
      if (!id || id.includes('.')) continue
      const state = readTargetState(m.standbyDir, id)
      if (state && TARGET_FINAL.has(state.step)) continue
      found.push({ dir: m.standbyDir, id, state })
    }
  }
  return found
}

export async function runLeaderSwitch(o: SwitchCommandOptions): Promise<SwitchOutcome> {
  const out = o.out ?? (() => {})
  const home = path.resolve(o.home)
  // Run on the machine that will lead: the candidate's check, then the begin over its host link (candidate-command.ts).
  if (!o.resume && !o.cancel && !o.back) {
    const { candidateStandbyDir, runCandidateSwitch } = await import('./candidate-command.js')
    const standbyDir = candidateStandbyDir({ home, env: o.env ?? process.env, ...(o.standbyDir ? { standbyDir: o.standbyDir } : {}), ...(o.to ? { to: o.to } : {}) })
    if (standbyDir) return runCandidateSwitch({ standbyDir, ...(o.to ? { to: o.to } : {}), out, ...(o.env ? { env: o.env } : {}) })
  }
  const settings = settingsOf(home)
  const self = machineByHome(settings, home)
  const env = machineEnv(self, o.env ?? process.env)
  const log = sourceJobLog(home, env)
  let from = (() => { try { return fs.statSync(log).size } catch { return 0 } })()
  const before = readSwitchState(home)
  const lockFile = switchLockFile(home)
  let sourceExit: Promise<{ code: number | null; signal: string | null }> | null = null
  /** A target job this command just started counts as running until its lock shows (or 10 s pass). */
  let targetGraceUntil = 0
  const startTarget = (t: { dir: string; id: string }) => {
    targetGraceUntil = Date.now() + 10_000
    const m = settings.machines.find((x) => x.standbyDir === t.dir)
    const tEnv: NodeJS.ProcessEnv = { ...machineEnv(m, o.env ?? process.env), ...(m ? { OPEN_WALNUT_HOME: m.home } : {}) }
    delete tEnv.WALNUT_LEADER_SWITCH_KILL_AT
    spawnJob(targetJobArgs(t.id, t.dir, false), tEnv, targetJobLog(t.dir, t.id, false))
    out(`target job of switch ${t.id} started again on this machine`)
  }

  if (o.cancel || o.resume) {
    const open = before && !SOURCE_FINAL.has(before.step)
    const targets = openTargetsHere(machinesHere(settings, home, env)).filter((t) => !before || t.id === before.id || !open)
    if (!open && !targets.length) throw new SwitchRefused('no switch from this home is under way')
    if (o.cancel) {
      if (open) writeDurableJson(sourceCancelFile(home), { switchId: before!.id, at: new Date().toISOString() })
      for (const t of targets) writeSwitchFile(t.dir, targetCancelName(t.id), { switchId: t.id, at: new Date().toISOString() })
    }
    if (open && !lockHolder(lockFile)) sourceExit = spawnJob(['leader', 'switch', '--job', 'source', '--resume', '--home', home], env, log).exit
    for (const t of targets) {
      const { targetJobRunning } = await import('./target-job.js')
      if (!targetJobRunning(t.dir, t.id) && (t.state || readSwitchFile(t.dir, ticketName(t.id)))) startTarget(t)
    }
  } else {
    if (before && !SOURCE_FINAL.has(before.step)) throw new SwitchRefused(`switch ${before.id} to ${before.to} is under way (step ${before.step}): finish it with --resume, or --cancel it`)
    sourceExit = spawnJob(['leader', 'switch', '--job', 'source', ...(o.to ? ['--to', o.to] : []), ...(o.back ? ['--back'] : []), '--home', home], env, log).exit
  }

  // Follow: print the jobs' lines, until each job this machine sees has ended.
  const ended: { exit: { code: number | null; signal: string | null } | null } = { exit: null }
  void sourceExit?.then((e) => { ended.exit = e })
  const targetFrom = new Map<string, number>()
  let lastRefusal: string | undefined
  const started = Date.now()
  for (;;) {
    const r = readFrom(log, from)
    from = r.to
    for (const line of r.text.split('\n').filter(Boolean)) { out(line); if (/^leader: |refused: /.test(line)) lastRefusal = line }
    const src = readSwitchState(home)
    const mine = src && (src.id !== before?.id || o.resume || o.cancel) ? src : null
    const t = localTarget(mine, machinesHere(settings, home, env))
    const tgt = t ? readTargetState(t.dir, t.id) : null
    if (t) {
      const tl = targetJobLog(t.dir, t.id, false)
      const tr = readFrom(tl, targetFrom.get(tl) ?? (o.resume || o.cancel ? (() => { try { return fs.statSync(tl).size } catch { return 0 } })() : 0))
      targetFrom.set(tl, tr.to)
      for (const line of tr.text.split('\n').filter(Boolean)) out(`[${t.id.slice(-6)} on ${mine!.to}] ${line}`)
    }
    const exited = ended.exit
    const srcRunning = !!lockHolder(lockFile) || (sourceExit !== null && exited === null)
    const { targetJobRunning } = await import('./target-job.js')
    const tgtLocked = t ? !!targetJobRunning(t.dir, t.id) : false
    if (tgtLocked) targetGraceUntil = 0
    const tgtRunning = tgtLocked || Date.now() < targetGraceUntil
    const srcEnded = !srcRunning
    // A refusal at the preflight: the job wrote no state (or only its refusal), and ended.
    if (srcEnded && exited && (!mine || mine.step === 'rolled-back' && mine.rollbackWhy?.startsWith('refused'))) {
      return { code: 1, source: mine, target: null, message: lastRefusal?.replace(/^(\[[^\]]*\] )?(leader: |refused: )/, '') ?? `the switch job ended (code ${exited.code})` }
    }
    if (srcEnded && mine && !SOURCE_FINAL.has(mine.step)) {
      return { code: 4, source: mine, target: tgt, message: `the source job died at step ${mine.step}${exited?.signal ? ` (${exited.signal})` : ''}: rerun \`walnut leader switch --resume\`` }
    }
    if (t && !tgtRunning && tgt && !TARGET_FINAL.has(tgt.step) && Date.now() - started > 3_000) {
      return { code: 4, source: mine, target: tgt, message: `the target job on ${tgt.to} died at step ${tgt.step}: rerun \`walnut leader switch --resume\`` }
    }
    if (srcEnded && mine && SOURCE_FINAL.has(mine.step) && (!t || !tgtRunning)) {
      if (mine.step === 'done') {
        if (t && tgt && tgt.step !== 'done') return { code: 4, source: mine, target: tgt, message: `${mine.to} committed, but its job stopped at ${tgt.step}: rerun \`walnut leader switch --resume\`` }
        return { code: 0, source: mine, target: tgt, message: `${mine.to} leads` }
      }
      return { code: 3, source: mine, target: tgt, message: `rolled back: ${mine.rollbackWhy ?? 'unknown reason'}` }
    }
    await sleep(300)
  }
}

/** `walnut leader switch --status`: what this machine knows of its switches, read only. */
export async function switchStatus(o: { home: string; env?: NodeJS.ProcessEnv }): Promise<Record<string, unknown>> {
  const home = path.resolve(o.home)
  const settings = settingsOf(home)
  const self = machineByHome(settings, home)
  const env = machineEnv(self, o.env ?? process.env)
  const source = readSwitchState(home)
  const lock = switchLockFile(home)
  const { targetJobRunning } = await import('./target-job.js')
  const targets: Record<string, unknown>[] = []
  for (const m of machinesHere(settings, home, env)) {
    let names: string[] = []
    try { names = fs.readdirSync(switchFolder(m.standbyDir)) } catch { continue }
    for (const n of names) {
      const id = /^(.+)\.state\.json$/.exec(n)?.[1]
      if (!id) continue
      const t = readTargetState(m.standbyDir, id)
      if (t) targets.push({ id, machine: t.to, step: t.step, running: targetJobRunning(m.standbyDir, id), handover: t.handover, commit: t.commit ?? null, downtimeMs: t.downtimeMs ?? null, rollbackWhy: t.rollbackWhy ?? null, last: t.log.at(-1) ?? null })
    }
  }
  const switchId = source?.id ?? (targets.at(-1)?.id as string | undefined)
  const out: Record<string, unknown> = {
    machine: (await import('./machine-id.js')).permitHolderId(env),
    marker: readMarker(home),
    source: source ? { id: source.id, from: source.from, to: source.to, step: source.step, running: lockHolder(lock), handover: source.handover ?? null, commit: source.commit ?? null, startedBy: source.startedBy ?? null, rollbackWhy: source.rollbackWhy ?? null, last: source.log.at(-1) ?? null } : null,
    targets,
  }
  // The witnesses as THIS machine reads them (its own ways, or its running server), and the newest note of each machine.
  const { makeWitnessReader } = await import('./witness-reader.js')
  const { LocalSide } = await import('./side.js')
  const side = self ? new LocalSide(self) : null
  try {
    const read = makeWitnessReader(`${self?.id ?? 'status'}-status`, settings, () => (side?.runningServer() ? [{ api: (m: string, p: string) => side.api(m, p) }] : []), async () => {
      const r = side ? await side.reachWitnesses(home).catch(() => null) : null
      return r?.majority ? { standing: r.standing, answered: r.answered } : null
    })
    const r = await read()
    out.witnesses = { answered: r.answered, of: settings.witnesses.length, standing: r.standing === undefined ? 'no majority' : summarize(r.standing) }
  } catch (err) {
    out.witnesses = { unavailable: (err as Error).message }
  }
  if (switchId) {
    const { notesAccessOf, readSwitchNotes } = await import('./switch-notes.js')
    const access = await notesAccessOf(home, env).catch(() => null)
    const notes = access ? await readSwitchNotes(access, switchId).catch(() => new Map()) : new Map()
    out.notes = Object.fromEntries([...notes].map(([m, n]) => [m, { step: n.step, why: n.why ?? null, at: n.at, ageS: Math.round((Date.now() - Date.parse(n.at)) / 1000) }]))
  }
  return out
}
