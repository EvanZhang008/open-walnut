/**
 * Readiness judged against a model's Claude Code floor with no RPC: the Start
 * gate's "for the model this session will run" answer (C53), the reword after
 * the configured model changes (C90), and the fixture's seed. Split out of
 * host-readiness.ts; import through it.
 */

import { log } from '../../logging/index.js'
import type { HostPreflightResult } from '../../providers/host-runtime-core.js'
import { withFixState } from './host-autofix.js'
import { readinessProblems, type ReadinessProblem } from './host-readiness-problems.js'
import { claudeCliFloorFor, claudeVersionAtLeast, configuredClaudeCliFloor, type ClaudeCliFloor } from './claude-version-floor.js'
import { fixState, getHostReadiness, notifyReadiness, problemCtx, store, type HostReadiness, type StoredReadiness } from './host-readiness-store.js'

/** Test seam: the host fixture's floors replace the model table (host-fixture.ts). */
let floorOverride: { configured: () => ClaudeCliFloor | null; forModel: (model: string) => ClaudeCliFloor | null } | null = null
export function setClaudeFloorOverride(o: typeof floorOverride): void { floorOverride = o }

/** The stored answer judged against `floor` instead of the one it was asked with. */
function judgeAgainstFloor(p: HostPreflightResult, floor: ClaudeCliFloor | null): HostPreflightResult {
  if (!p.claude.found) return p
  const claude = { ...p.claude }
  delete claude.versionOk
  delete claude.minVersion
  if (floor) {
    claude.minVersion = floor.minVersion
    const ok = claudeVersionAtLeast(claude.version, floor.minVersion)
    if (ok !== null) claude.versionOk = ok
  }
  return { ...p, claude }
}

function problemsAgainst(host: string, base: StoredReadiness, floor: ClaudeCliFloor | null): { parsed: HostPreflightResult; problems: ReadinessProblem[] } {
  const parsed = judgeAgainstFloor(base, floor)
  const ctx = problemCtx.get(host) ?? { prebuiltDtach: false, hostLabel: host }
  // Lines that came from the connect (daemon dir) are merged later by buildHostStatus.
  return { parsed, problems: readinessProblems(parsed, { ...ctx, floorModel: floor?.model }) }
}

/**
 * The host's readiness as a Start with this model sees it: the floor (and the
 * model named in the sentence) is the model's own, not the configured default.
 * No model = the stored answer as is.
 */
export function hostReadinessForModel(host: string, model: string | undefined | null, now: number = Date.now()): HostReadiness | undefined {
  const current = getHostReadiness(host, now)
  const base = store.get(host)
  if (!current || !base || !model) return current
  const { parsed, problems } = problemsAgainst(host, base, floorOverride ? floorOverride.forModel(model) : claudeCliFloorFor(model))
  const fx = fixState.get(host)
  return { ...current, claude: parsed.claude, problems: withFixState(problems, parsed, fx?.fixing, fx?.fixes ?? []) }
}

/**
 * The host's readiness as the Start gate judges it (host-start-gate.ts). `model`
 * is the model the session will run: its own pick, else its CLI's default on
 * that host. null = neither is known, and a session with no --model runs
 * whatever that CLI picks, so Walnut's configured model says nothing about it:
 * no floor (the fixture's floor stands in for every model on the test server).
 */
export function hostReadinessForLaunch(host: string, model: string | null, now: number = Date.now()): HostReadiness | undefined {
  if (model) return hostReadinessForModel(host, model, now)
  const current = getHostReadiness(host, now)
  const base = store.get(host)
  if (!current || !base) return current
  const { parsed, problems } = problemsAgainst(host, base, floorOverride ? floorOverride.configured() : null)
  const fx = fixState.get(host)
  return { ...current, claude: parsed.claude, problems: withFixState(problems, parsed, fx?.fixing, fx?.fixes ?? []) }
}

const problemKey = (ps: readonly ReadinessProblem[]): string => JSON.stringify(ps.map((p) => [p.kind, p.message, p.commands]))

/**
 * The configured model changed: reword every stored answer against the new
 * floor from its cached claude version (no RPC), and notify each host whose
 * lines changed. Returns those hosts.
 */
export async function recomputeHostReadinessFloors(floorArg?: ClaudeCliFloor | null): Promise<string[]> {
  const floor = floorArg !== undefined ? floorArg : floorOverride ? floorOverride.configured() : await configuredClaudeCliFloor()
  const changed: string[] = []
  for (const [host, base] of [...store]) {
    const { parsed, problems } = problemsAgainst(host, base, floor)
    if (problemKey(problems) === problemKey(base.problems) && parsed.claude.minVersion === base.claude.minVersion) continue
    store.set(host, { ...base, claude: parsed.claude, problems })
    changed.push(host)
    notifyReadiness(host)
  }
  if (changed.length) log.session.info('host readiness reworded for a new model floor', { hosts: changed, minVersion: floor?.minVersion })
  return changed
}

/** Test and fixture seam: store an answer as if a preflight had returned it. */
export function setHostReadinessForTest(host: string, parsed: HostPreflightResult, ctx: { hostLabel?: string; sshTarget?: string; floor?: ClaudeCliFloor | null } = {}, at: number = Date.now()): HostReadiness {
  problemCtx.set(host, { prebuiltDtach: false, hostLabel: ctx.hostLabel, sshTarget: ctx.sshTarget })
  const judged = ctx.floor === undefined ? parsed : judgeAgainstFloor(parsed, ctx.floor)
  store.set(host, { ...judged, checkedAt: at, problems: readinessProblems(judged, { hostLabel: ctx.hostLabel, sshTarget: ctx.sshTarget, floorModel: ctx.floor?.model }) })
  notifyReadiness(host)
  return getHostReadiness(host, at)!
}
