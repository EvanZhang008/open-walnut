/**
 * A host's one Walnut service that keeps no copy of the leader's data (experiment
 * `service_without_copy`): what the host-server manager decides for a Linux host too small for a
 * copy (gate `memory` or `disk`, eligibility.ts) and for one whose switch the person turned off
 * (`hosts.<name>.server.enabled: false`, which from now on means: the service runs, keeps no copy,
 * opens no port and has no console).
 *
 * Such a host gets the follower spec every host gets, with one more env line
 * (`WALNUT_COPIES=none`, replication/kinds/gate.ts keepsNoCopy), and nothing else: no copy target
 * (the task copy, the search copy and the copy kinds have nobody to send to), no notes, memory or
 * skills copy (host-replica.ts hostKeepFor asks runsCopyless), no exposed port and no console door
 * (its sessions' channel to the leader still rides the stream lane). It runs as the host's one
 * service (service-launcher-flag.ts offers it: two programs on a
 * host short of memory make no sense), so only a host whose runtime names `copyless-service-v1`
 * and already runs under the service launcher takes it; any other keeps today's daemon, its gate
 * shown. macOS hosts wait for the macOS one-service work: Linux only for now.
 *
 * Back: the flag off (or the host growing past the floors on a later probe) writes the spec without
 * the env line, or takes the follower down for a turned-off host, as before.
 */
import { experimentalEnabled } from '../experimental.js'
import type { HostServerHost, WorkingProgram } from './manager-types.js'
import type { FollowerGateReason } from './eligibility.js'
import type { HostTarget } from './host-target.js'

export const COPYLESS_CAPABILITY = 'copyless-service-v1'
const COPIES_ENV = 'WALNUT_COPIES'

/** The words the host's Settings row and card say while it runs this way. */
export const COPYLESS_TEXT = 'Runs without a copy of your data: Walnut runs here as its service and keeps its sessions going while this computer is away, but keeps no copy of your data, opens no port and has no console.'

/** The gates a copyless service answers: too little memory or disk for a copy, never no build or another name. */
const COPYLESS_GATES: ReadonlySet<FollowerGateReason> = new Set(['memory', 'disk'])

export async function copylessWanted(): Promise<boolean> {
  try {
    const { getConfig } = await import('../config-manager.js')
    return experimentalEnabled((await getConfig()).experimental, 'service_without_copy')
  } catch {
    return false
  }
}

/**
 * Why this host cannot run without a copy now (null: it can): its runtime, its launcher, its system.
 * `service`: the host runs as this Walnut's one service already (one-service-mode.ts), so a launcher keeps it.
 * `refused`: the one service is not for this host (service-launcher-flag.ts oneServiceRefused: the
 * launcher off, or its own `service_offer: false`): it would run the follower beside the daemon.
 */
export function copylessUnfit(host: HostServerHost, target: HostTarget | null, service = false, refused = false): string | null {
  if (!host.hasCapability(COPYLESS_CAPABILITY)) return 'its Walnut is older than the service without a copy'
  if (refused) return 'the one service is turned off for this host'
  if (!service && host.underLauncher && !host.underLauncher()) return 'its session helper does not run under the service launcher yet'
  // Not known yet (the probe's answer did not parse) counts as not Linux: the next look decides.
  if (!target?.target.startsWith('linux-')) return 'only Linux hosts run without a copy for now'
  return null
}

/** A gate the copyless service answers. */
export function copylessGate(reason: FollowerGateReason): boolean {
  return COPYLESS_GATES.has(reason)
}

/** The program with the env line on (copyless) or off. */
export function withCopies(p: WorkingProgram, copyless: boolean): WorkingProgram {
  const has = p.env[COPIES_ENV] === 'none'
  if (has === copyless) return p
  const env = { ...p.env }
  if (copyless) env[COPIES_ENV] = 'none'
  else delete env[COPIES_ENV]
  return { ...p, env }
}

/** The env line a copyless program carries (replica-run.ts adds it). */
export function copylessEnv(copyless: boolean): Record<string, string> {
  return copyless ? { [COPIES_ENV]: 'none' } : {}
}

export function programIsCopyless(p: WorkingProgram | undefined): boolean {
  return p?.env?.[COPIES_ENV] === 'none'
}

/** The hosts this leader runs without a copy now (set by the manager as it configures them). */
const hosts = new Set<string>()

export function noteCopyless(hostKey: string, on: boolean): void {
  // Never the cloud box: it is never on by default (follower-default.ts), so neither gate nor a turned-off switch reaches it.
  if (on) hosts.add(hostKey)
  else hosts.delete(hostKey)
}

/** This leader runs `hostKey` without a copy: no copy of any kind goes there, and it is offered the one service. */
export function runsCopyless(hostKey: string): boolean {
  return hosts.has(hostKey)
}
