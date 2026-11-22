/**
 * A host's launcher (service-launcher-script.ts), on the server: its facts as the fleet shows them,
 * and Walnut Health for a put-back.
 *
 * A host's launcher put its daemon back to the previous version (service-launcher-script.ts): one
 * Walnut Health item per put-back (`host-launcher-rollback:<host>:<at>`), never a toast or a bell row
 * (no needsYou: the launcher already brought the host back, and the server holds that build a day).
 * Read from the daemon's hello (`launcher.rollback`); only a put-back of the last day is raised, and
 * each one once per server process. Nothing here throws, and nothing waits for it.
 */
import { log } from '../../logging/index.js'
import type { LauncherFacts } from '../../providers/service-launcher-beat.js'
import { PROBATION_SECONDS } from '../../providers/service-launcher-script.js'
import type { NewNotification } from '../notifications/store.js'
import type { FleetLauncher } from './fleet-model.js'

const DAY_S = 24 * 60 * 60
const told = new Set<string>()

/** A version as a person reads it: its build, else the start of its version dir (versions/<sha256>/daemon). */
export function launcherVersionWords(exe: string, build?: string): string {
  if (build) return `build ${build.replace(/^walnut-daemon-/, '')}`
  const dir = exe.split('/').slice(-2, -1)[0] ?? ''
  return /^[0-9a-f]{64}$/.test(dir) ? `version ${dir.slice(0, 12)}` : exe
}

/** The launcher's facts for the host's card (null without a launcher). */
export function fleetLauncher(facts: LauncherFacts | null | undefined): FleetLauncher | null {
  if (!facts) return null
  const r = facts.rollback
  return {
    current: launcherVersionWords(facts.current, facts.build),
    good: launcherVersionWords(facts.good, facts.goodBuild),
    phase: facts.phase,
    watchedUntil: facts.phase === 'probation' && facts.since > 0 ? (facts.since + PROBATION_SECONDS) * 1000 : null,
    lastRollback: r ? { at: r.at * 1000, from: launcherVersionWords(r.from, r.build), reason: r.reason } : null,
  }
}

export function launcherRollbackItem(hostKey: string, label: string, facts: LauncherFacts): NewNotification | null {
  const r = facts.rollback
  if (!r) return null
  const back = launcherVersionWords(r.to || facts.current, facts.goodBuild)
  return {
    kind: 'operation-error',
    severity: 'warning',
    title: `Walnut on ${label} went back to its previous version`,
    body: `The new ${launcherVersionWords(r.from, r.build)} did not hold: ${r.reason}. The host runs ${back} again, its sessions kept, and Walnut does not install that build there again for a day.`,
    detail: `launcher rollback on ${hostKey} at ${new Date(r.at * 1000).toISOString()}: from ${r.from} to ${r.to}: ${r.reason}`,
    dedupKey: `host-launcher-rollback:${hostKey}:${r.at}`,
    category: 'Sessions',
    host: hostKey,
  }
}

/** Raise the host's latest put-back, when it is of the last day and not told yet. */
export async function noteLauncherRollback(hostKey: string, facts: LauncherFacts | null, nowS = Math.floor(Date.now() / 1000)): Promise<void> {
  const r = facts?.rollback
  if (!r || nowS - r.at > DAY_S) return
  const key = `${hostKey}:${r.at}`
  if (told.has(key)) return
  told.add(key)
  const { hostLabel, raiseHealthItem } = await import('../notifications/health-items.js')
  const item = launcherRollbackItem(hostKey, await hostLabel(hostKey), facts!)
  if (!item) return
  if (!(await raiseHealthItem(item, 'host-launcher'))) { told.delete(key); return }
  log.session.warn('host launcher: the daemon was put back to its previous version', { host: hostKey, from: r.from, to: r.to, reason: r.reason })
}

/** Tests only. */
export function _resetLauncherHealthForTesting(): void { told.clear() }
