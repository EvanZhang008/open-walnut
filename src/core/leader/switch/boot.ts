/**
 * The server's boot step for the write permission (src/web/server.ts calls it right after
 * the single-instance lock). It reaches the permit only when ALL hold:
 *   - the experiment `switchable_leader` is on and config.yaml has a `leader_switch` section
 *     (the experiment alone is the standby copy, which needs no permission);
 *   - this server would boot as the leader (role() is 'leader');
 *   - it is not an ephemeral server, unless WALNUT_EPHEMERAL_LEADER_SWITCH=1 (an ephemeral
 *     server runs on a copy of the user's data with the user's config: it must never ask the
 *     user's witnesses for the permission).
 * Otherwise it returns null at once and nothing of the permit is imported.
 *
 * Whatever the experiment and the section say, a home a switch marked refuses to lead: the
 * handed-over marker, or a promotion the switch has not committed (records.ts). Turning the
 * experiment off, or deleting the section, must not bring a handed-over home back as a second
 * leader. server.ts calls this with the experiment off only when the home has a
 * `local/leader-switch/` folder (no home that never took part in a switch has one).
 *
 * A refusal because another machine leads (the marker, or a record of the witnesses naming
 * another holder) carries `standby`: server.ts then runs the home as a standby that leads
 * nothing (handed-over.ts) instead of exiting. server.ts checks the marker itself before the
 * boot touches the home, so the marker's refusal here is the backstop.
 */
import type { PermitRuntime } from './runtime.js'
import type { HandedOverStandby } from './handed-over.js'

let current: { runtime: PermitRuntime; machine: string; trial: boolean } | null = null

/** The running permit of this server (for its status route); null with the experiment off. */
export function currentLeaderPermit(): { runtime: PermitRuntime; machine: string; trial: boolean } | null {
  return current
}

export class LeaderBootRefused extends Error {
  constructor(why: string, readonly standby?: HandedOverStandby) {
    super(`Walnut does not start as the leader: ${why}`)
    this.name = 'LeaderBootRefused'
  }
}

export interface LeaderBootInput {
  home: string
  flagOn: boolean
  isLeaderRole: boolean
  ephemeral: boolean
  /** A leader switch's trial start (server.ts reads WALNUT_LEADER_TRIAL, the one read of it). */
  trial?: boolean
  env?: NodeJS.ProcessEnv
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
  /** Tests: this machine's own daemon for the first lead's take-back (default the server's link to it). */
  ownDaemon?: import('./host-follow.js').OwnDaemon
}

async function takeBackLeftovers(input: LeaderBootInput, machine: string): Promise<void> {
  const log = input.log ?? (() => {})
  try {
    const { takeBackSwitchLeftovers } = await import('./host-follow.js')
    const r = await takeBackSwitchLeftovers({ home: input.home, machine, ...(input.ownDaemon ? { daemon: input.ownDaemon } : {}) })
    if (!r.ok) log('warn', 'leader switch: what a switch left on this machine was not all taken back', { why: r.why })
    else if (r.console || r.hostService || r.credential || r.credentialFile) log('info', 'leader switch: this home leads: what a switch left on this machine is taken back', { console: r.console, hostService: r.hostService, credential: r.credential, credentialFile: r.credentialFile })
  } catch (err) {
    log('warn', 'leader switch: what a switch left on this machine was not all taken back', { error: err instanceof Error ? err.message : String(err) })
  }
}

export async function leaderPermitAtBoot(input: LeaderBootInput): Promise<PermitRuntime | null> {
  const env = input.env ?? process.env
  if (!input.isLeaderRole) return null
  if (input.ephemeral && env.WALNUT_EPHEMERAL_LEADER_SWITCH !== '1') return null
  const commit = Number(env.WALNUT_LEADER_SWITCH_COMMIT)
  const commitHandover = Number.isInteger(commit) && commit > 0 ? commit : undefined
  const until = Number(env.WALNUT_LEADER_SWITCH_COMMIT_UNTIL)
  const commitUntil = commitHandover !== undefined && Number.isSafeInteger(until) && until > 0 ? until : undefined
  const trial = input.trial === true
  const { readMarker, markerRefusal, promotionRefusal } = await import('./records.js')
  const marker = readMarker(input.home)
  if (marker) throw new LeaderBootRefused(markerRefusal(marker), (await import('./handed-over.js')).handedOverAtBoot({ home: input.home, env }) ?? undefined)
  const unfinished = promotionRefusal(input.home, { trial, commit: commitHandover !== undefined })
  if (unfinished) throw new LeaderBootRefused(unfinished)
  // A switch's trial or commit start must run with its doors guarded: without the permit it
  // would be a full server with nothing closed (plugins, sessions, routines, mail).
  const switchStart = trial || commitHandover !== undefined
  if (!input.flagOn) {
    if (switchStart) throw new LeaderBootRefused('a leader switch started this server, but the experiment switchable_leader is off in its config: it would run with no outward door closed')
    return null
  }
  const { readHomeSwitchConfig } = await import('./settings.js')
  const cfg = readHomeSwitchConfig(input.home)
  if (!cfg.settings) {
    if (switchStart) throw new LeaderBootRefused(`a leader switch started this server, but its config has no usable leader_switch section (${cfg.problem ?? 'none'}): it would run with no outward door closed`)
    return null
  }
  const { permitHolderId, machineIdFile, leaderInstanceLockPath } = await import('./machine-id.js')
  const id = permitHolderId(env)
  if (!id) throw new LeaderBootRefused(`leader_switch is set up but this machine has no id (${machineIdFile(env)}): without one it cannot hold the write permission`)
  if (!cfg.settings.machines.some((m) => m.id === id)) throw new LeaderBootRefused(`this machine (${id}) is not one of leader_switch.machines`)
  const { startPermitRuntime } = await import('./runtime.js')
  // WALNUT_LEADER_SWITCH_COMMIT: set only by `walnut leader switch` when it starts the new
  // leader after the trial; the number of the handover to this machine it may renew on.
  const rt = await startPermitRuntime({
    home: input.home,
    holderId: id,
    settings: cfg.settings,
    trial,
    lockPath: leaderInstanceLockPath(env),
    ...(commitHandover !== undefined ? { commitHandover } : {}),
    ...(commitUntil !== undefined ? { commitUntil } : {}),
    log: input.log,
    // The first time this server leads (at boot, or later from waiting): what a switch left on this
    // machine goes (host-follow.ts takeBackSwitchLeftovers). In the background: it waits for this
    // server's link to its own daemon, and nothing waits for it.
    onFirstLead: () => { void takeBackLeftovers(input, id) },
  })
  if (rt.decision.kind === 'refuse') {
    await rt.stop()
    // The standby this becomes holds no link to a host (witness-transport.ts: none is opened before the runtime leads).
    await (await import('./witness-transport.js')).closeWitnessLinks()
    const d = rt.decision
    throw new LeaderBootRefused(d.why, d.leader ? (await import('./handed-over.js')).standbyForRecord({ home: input.home, env, leader: d.leader, record: d.record, why: d.why }) : undefined)
  }
  current = { runtime: rt, machine: id, trial: rt.decision.kind === 'trial' }
  // A leader's handovers take its hosts along (host-follow-steps.ts); a trial start hands nothing over.
  if (!current.trial) (await import('./handover-host-steps.js')).setHandoverHostSteps((await import('./host-follow-steps.js')).hostFollowSteps)
  // Way c over this server's door too: a host that dialed it answers its witness on that socket.
  const unreach = await (await import('./witness-transport.js')).reachDialedHosts()
  const stop = rt.stop
  rt.stop = () => { current = null; unreach(); void import('./handover-host-steps.js').then((m) => m.setHandoverHostSteps(null)); return stop() }
  input.log?.('info', 'leader permit at boot', { decision: rt.decision.kind, ...(rt.decision.kind === 'waiting' ? { why: rt.decision.why } : {}) })
  return rt
}
