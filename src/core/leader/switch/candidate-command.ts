/**
 * `walnut leader switch --to <this machine>` run on the machine that will lead (docs/reference/leader-switch.md,
 * "Running the command on either machine"). It does no step of the switch itself:
 *
 *   1. the candidate check, here, in this process (target-job.ts check mode: the copy, the disk, the witnesses
 *      this machine reaches with no leader link): a refusal changes nothing anywhere;
 *   2. the begin, sent to the leader's server over this machine's own host link (leader-relay.ts): the leader
 *      takes it only from this machine (its link's machine id is `to`), records who began it on which machine,
 *      and starts the source job on its own machine. Where this machine has no link to the leader, it says so
 *      and names the machine to run the command on;
 *   3. it follows: the source job's lines over the same link while the leader runs, then this machine's own
 *      target job (its state and output under the standby folder), until it ends. Its last line says the
 *      old leader's machine still has its hand-off step, and where to check it (handOffLine).
 * Exit codes as on the leader's machine: 0 switched, 1 refused, 3 rolled back, 4 a job died part way.
 */
import path from 'node:path'
import { majorityOf } from '../permit/types.js'
import { machineById, readCopySwitchConfig, readHomeSwitchConfig } from './settings.js'
import { readMarker } from './records.js'
import { permitHolderId } from './machine-id.js'
import { newSwitchId, type CheckReport } from './ticket.js'
import { SwitchRefused, TARGET_FINAL, readTargetState } from './flow.js'
import { targetJobLog } from './peer.js'
import { RELAY_BEGIN_PATH, RELAY_JOB_PATH, leaderRelaySocketPath, relayAbsent, relayDaemonDir, relayRequest, relaySocketOpener, type RelayAnswer } from './leader-relay.js'
import { readFrom, type SwitchOutcome } from './switch-command.js'

/** One request to the leader's relay door; rejects when nothing answered (no stream, a cut, a timeout). */
export type LeaderLink = (method: string, route: string, body: unknown, timeoutMs: number) => Promise<RelayAnswer>

export interface CandidateSwitchOptions {
  /** This machine's standby folder (its `standby_dir`): the copy holds the config it reads. */
  standbyDir: string
  to?: string
  out?: (line: string) => void
  env?: NodeJS.ProcessEnv
  /** Tests: the link to the leader (default this machine's relay socket), or null for none, with why. */
  link?: LeaderLink | { none: string }
  /** Tests: the candidate check (default the target job's check mode, in this process). */
  check?: (switchId: string) => Promise<CheckReport>
  /** How often the follow loop looks (default 400 ms). */
  pollMs?: number
  /** The longest the follow waits for its target job to start once the leader's job runs (default the commit window and 5 min). */
  followMs?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * The machine whose standby folder is `standbyDir`, when it is this one's. Not on the machine's own home that may
 * lead (no handed-over marker): there `--to <this machine>` is the leader's command, which says it leads already.
 */
export function candidateStandbyDir(o: { home: string; env: NodeJS.ProcessEnv; standbyDir?: string; to?: string }): string | null {
  if (o.standbyDir) return path.resolve(o.standbyDir)
  const me = permitHolderId(o.env)
  if (!me || o.to !== me) return null
  // `--to <this machine>` with this machine's home or copy: its standby folder from that config.
  for (const home of [o.home, path.join(o.home, 'copy')]) {
    const s = readHomeSwitchConfig(home).settings
    const self = s ? machineById(s, me) : undefined
    if (!self) continue
    if (path.resolve(home) === path.resolve(self.home) && !readMarker(self.home)) return null
    return self.standbyDir
  }
  return null
}


export async function runCandidateSwitch(o: CandidateSwitchOptions): Promise<SwitchOutcome> {
  const out = o.out ?? (() => {})
  const env: NodeJS.ProcessEnv = { ...(o.env ?? process.env) }
  const standbyDir = path.resolve(o.standbyDir)
  const copy = path.join(standbyDir, 'copy')
  const cfg = await readCopySwitchConfig(copy)
  if (!cfg.flag) throw new SwitchRefused(`the standby copy ${copy} does not have the experiment switchable_leader on`)
  if (!cfg.settings) throw new SwitchRefused(cfg.problem ?? `the standby copy ${copy} has no leader_switch section`)
  const settings = cfg.settings
  const me = permitHolderId(env)
  const self = me ? machineById(settings, me) : undefined
  if (!self) throw new SwitchRefused(`this machine (${me ?? 'no id'}) is not one of leader_switch.machines`)
  if (path.resolve(self.standbyDir) !== standbyDir) throw new SwitchRefused(`${standbyDir} is not this machine's standby_dir (${self.standbyDir})`)
  const to = o.to ?? self.id
  if (to !== self.id) throw new SwitchRefused(`on a machine that does not lead, the command switches to that machine only (--to ${self.id}); to switch to ${to}, run it on the machine that leads`)
  const others = settings.machines.filter((m) => m.id !== self.id).map((m) => m.id)
  const switchId = newSwitchId()

  // 1. The candidate check, here.
  out(`candidate check on ${self.id} (switch ${switchId})`)
  const check = o.check ?? (async (id: string) => (await import('./target-job.js')).runTargetJob({ standbyDir, switchId: id, check: true, env, out }) as Promise<CheckReport>)
  const report = await check(switchId)
  const leader = holderOf(report, settings.witnesses.map((w) => w.id)) ?? (others.length === 1 ? others[0]! : null)
  const runThere = leader ? `run \`walnut leader switch --to ${self.id}\` on ${leader}, the machine that leads` : `run \`walnut leader switch --to ${self.id}\` on the machine that leads (${others.join(' or ')})`
  if (!report.ok) return refused(`the check on ${self.id}: ${report.problems.join('; ')}`)

  // 2. The begin, over this machine's host link to the leader.
  let link: LeaderLink
  if (o.link && 'none' in o.link) return refused(`this machine has no link to the leader${leader ? ` ${leader}` : ''} (${o.link.none}): ${runThere}`)
  if (o.link) link = o.link
  else {
    const { instanceIdAt } = await import('../../device-store.js')
    const walnutId = await instanceIdAt(copy).catch(() => null)
    if (!walnutId) return refused(`the standby copy ${copy} holds no Walnut id`)
    const socket = leaderRelaySocketPath(await relayDaemonDir(env), walnutId)
    const absent = relayAbsent(socket)
    if (absent) return refused(`this machine has no link to the leader${leader ? ` ${leader}` : ''} (${absent}): ${runThere}`)
    const open = relaySocketOpener(socket)
    link = (method, route, body, timeoutMs) => relayRequest(open, method, route, body, timeoutMs)
  }
  const begun = await link('POST', RELAY_BEGIN_PATH, { to: self.id, switchId }, 60_000).catch((err: unknown) => err instanceof Error ? err : new Error(String(err)))
  if (begun instanceof Error) return refused(`this machine's host link did not reach the leader${leader ? ` ${leader}` : ''} (${begun.message}): ${runThere}`)
  const bj = (begun.json ?? {}) as { ok?: boolean; why?: string; leader?: string }
  const leaderId = bj.leader ?? leader ?? 'the leader'
  if (begun.status !== 200 || bj.ok !== true) return refused(`${leaderId} refused the switch: ${bj.why ?? `status ${begun.status}`}`)
  out(`${leaderId} took the switch begun here (${switchId}); its source job runs there`)

  // 3. Follow: the leader's job while its link answers, this machine's target job after.
  const pollMs = o.pollMs ?? 400
  const until = Date.now() + (o.followMs ?? settings.commitWindowMs + 5 * 60_000)
  let from = 0
  let linkUp = true
  let lastLine = ''
  let leaderJob: { running: boolean; exit: { code: number | null } | null; state: { step: string; rollbackWhy: string | null } | null } | null = null
  const logFile = targetJobLog(standbyDir, switchId, false)
  let logFrom = 0
  let stoppedRunningAt = 0
  const { targetJobRunning } = await import('./target-job.js')
  for (;;) {
    if (linkUp) {
      const j = await link('GET', `${RELAY_JOB_PATH}?switchId=${encodeURIComponent(switchId)}&from=${from}`, undefined, 10_000).catch(() => null)
      if (!j || j.status !== 200) linkUp = false
      else {
        const x = j.json as { text?: string; to?: number; running?: boolean; exit?: { code: number | null } | null; state?: { step: string; rollbackWhy: string | null } | null }
        for (const line of (x.text ?? '').split('\n').filter(Boolean)) { out(`[on ${leaderId}] ${line}`); lastLine = line }
        if (typeof x.to === 'number') from = x.to
        leaderJob = { running: x.running === true, exit: x.exit ?? null, state: x.state ?? null }
      }
    }
    const r = readFrom(logFile, logFrom)
    logFrom = r.to
    for (const line of r.text.split('\n').filter(Boolean)) out(line)
    const tgt = readTargetState(standbyDir, switchId)
    if (tgt && TARGET_FINAL.has(tgt.step) && !targetJobRunning(standbyDir, switchId)) {
      return tgt.step === 'done'
        ? { code: 0, source: null, target: tgt, message: `Switched: ${self.id} leads.\n${handOffLine(leaderId)}` }
        : { code: 3, source: null, target: tgt, message: `rolled back: ${tgt.rollbackWhy ?? 'unknown reason'}` }
    }
    // The leader's job ended before any target job here: refused at its preflight, or rolled back before the ticket.
    if (leaderJob && !leaderJob.running && !tgt) {
      if (!leaderJob.state || leaderJob.state.rollbackWhy?.startsWith('refused')) return refused(lastLine.replace(/^(\[[^\]]*\] )?(leader: |refused: )/, '') || `${leaderId}'s switch job ended (code ${leaderJob.exit?.code ?? 'unknown'})`)
      if (leaderJob.state.step === 'rolled-back') return { code: 3, source: null, target: null, message: `rolled back: ${leaderJob.state.rollbackWhy ?? 'unknown reason'}` }
    }
    // A target job here that stopped part way.
    if (tgt && !TARGET_FINAL.has(tgt.step) && !targetJobRunning(standbyDir, switchId)) {
      stoppedRunningAt ||= Date.now()
      if (Date.now() - stoppedRunningAt > 3_000) return { code: 4, source: null, target: tgt, message: `the target job on ${self.id} died at step ${tgt.step}: rerun \`walnut leader switch --resume\` here` }
    } else stoppedRunningAt = 0
    if (Date.now() > until && !tgt) return { code: 4, source: null, target: null, message: `no target job started on ${self.id} within the commit window; \`walnut leader switch --status\` on ${leaderId} shows where its job stands` }
    await sleep(pollMs)
  }

  // The caller prints the refusal (the CLI as `leader: ...`).
  function refused(message: string): SwitchOutcome {
    return { code: 1, source: null, target: null, message }
  }
}

/**
 * The command's last line after a switch begun here: the source job's last step runs on the old leader's machine
 * after its server stopped (so nothing here follows it), and only that machine shows how it ended.
 */
export function handOffLine(leader: string): string {
  return `${leader} still has its final hand-off step (its old home marked handed over, its service set to follow this machine): check it on ${leader} with \`walnut leader switch --status\``
}

/** The holder a majority of the witnesses the check reached name, or null. */
function holderOf(report: CheckReport, list: string[]): string | null {
  const counts = new Map<string, number>()
  for (const w of report.reach ?? []) if (w.answered && w.held?.holder) counts.set(w.held.holder, (counts.get(w.held.holder) ?? 0) + 1)
  for (const [h, n] of counts) if (n >= majorityOf(list)) return h
  return null
}
