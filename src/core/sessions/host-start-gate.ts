/**
 * The Start gate for a remote host (spec section 6). Runs BEFORE any write
 * (task, project metadata, TASK_CREATED, and in the web route before images and
 * the cwd mkdir), so a refused Start leaves nothing behind to roll back. Every
 * refusal is a 409 whose body comes from hostGateBody (host-problem.ts), the
 * same module the web renders from, so the error bar says what the banner says.
 *
 *  - removed / disabled host        -> host_removed
 *  - remotes off on this test server -> host_off (no dial)
 *  - failed                          -> a human Start makes ONE fresh connect
 *                                       (connectHostNow); success goes on, failure
 *                                       -> host_unreachable with the NEW attempt's
 *                                       kind / headline / hint. Automation judges
 *                                       the current frame: no dial, no state reset.
 *  - blocking readiness              -> a human Start re-checks first (cached
 *                                       answer on timeout); still blocking ->
 *                                       host_not_ready with the problem's sentence
 *                                       for the model the session will really run
 *  - readiness never checked         -> no gate (nothing true to say)
 * claude_outdated / claude_not_logged_in carry allowOverride; `overrideReadiness`
 * on the request skips exactly those two.
 */

import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import {
  BLOCKING_READINESS_KINDS, HOST_REMOVED_NOTE, OVERRIDABLE_KINDS, REMOTE_OFF_NOTE, hostFailureHeadline, hostGateBody,
  type HostGateBody,
} from '../hosts/host-problem.js'
import type { HostReadiness } from '../hosts/host-readiness.js'
import type { HostStatus } from '../hosts/host-status.js'
import type { ConfigHostDef, ConnectNowResult } from '../hosts/host-connect-action.js'

/** The fresh redial a human Start makes for a failed host; the whole gate stays under ~22s (C47). */
export const GATE_CONNECT_DEADLINE_MS = 20_000
/** A blocking cached answer is re-asked this long before it refuses (C56). */
export const GATE_CHECK_DEADLINE_MS = 5_000

/**
 * 'human': a person pressed Start (web draft, phone, a notification's Fix).
 * 'automation': a routine, trigger or watcher. It must never dial (a dial can
 * prompt for a hardware key or an agent), reset a human's failure state, or
 * wait 20s; it judges the frame as it stands.
 */
export type HostGateSource = 'human' | 'automation'

/**
 * Launches a PERSON started (quickStartSession's `source` tag). Anything else
 * (routines, triggers, watchers, subagents, a caller added later) is automation:
 * an unlisted path can never set off a hardware-key tap or an agent prompt.
 */
const HUMAN_LAUNCH_SOURCES: ReadonlySet<string> = new Set([
  'quick-start', 'mobile-launch', 'mobile-launch-bridge', 'cloud-exec-launch', 'notification-fix',
])

export function hostGateSourceFor(source: string): HostGateSource {
  return HUMAN_LAUNCH_SOURCES.has(source) ? 'human' : 'automation'
}

export interface HostStartGateInput {
  host?: string | null
  model?: string | null
  overrideReadiness?: boolean
  source?: HostGateSource
  /** Budget for the gate's own waits (connect + check). The mobile path passes ~10s to stay inside its 30s request. */
  deadlineMs?: number
}

export interface HostStartGateDeps {
  configDef: (host: string) => Promise<ConfigHostDef | undefined>
  frame: (host: string, def: ConfigHostDef) => HostStatus
  connect: (host: string, opts: { deadlineMs: number }) => Promise<ConnectNowResult>
  check: (host: string, opts: { deadlineMs: number; force: boolean }) => Promise<unknown>
  /** `model` = the model the session will run (explicit or the CLI's own default); null = unknown. */
  readinessFor: (host: string, model: string | null) => HostReadiness | undefined
  /** The model a session with no explicit model gets on this host (its CLI's default), when known. */
  cliDefaultModel: (host: string) => Promise<string | undefined>
  cloudMode?: boolean
  now?: () => number
}

async function defaultDeps(): Promise<HostStartGateDeps> {
  const action = await import('../hosts/host-connect-action.js')
  const { hostReadinessForLaunch } = await import('../hosts/host-readiness.js')
  return {
    configDef: action.configHostDef,
    frame: (host, def) => action.hostStatusFrame(host, def),
    connect: action.connectHostNow,
    check: action.checkHostNow,
    readinessFor: (host, model) => hostReadinessForLaunch(host, model),
    cliDefaultModel: async (host) => {
      // The 'default' row of the host's last CLI model catalog resolves to the CLI's own pick.
      const { getHostModelCatalog } = await import('../host-model-catalog.js')
      const catalog = await getHostModelCatalog(host).catch(() => null)
      return catalog?.models.find((m) => m.value === 'default')?.resolvedModel || undefined
    },
    cloudMode: CLOUD_MODE,
  }
}

/** The first problem that refuses this Start; an override skips only the overridable kinds, never a later hard block. */
function blockingProblem(r: HostReadiness | undefined, override: boolean) {
  return r?.problems.find((p) => BLOCKING_READINESS_KINDS.includes(p.kind) && !(override && OVERRIDABLE_KINDS.includes(p.kind)))
}

/** null = go ahead; otherwise the 409 body. Never throws for a host problem. */
export async function hostStartGate(input: HostStartGateInput, depsArg?: HostStartGateDeps): Promise<HostGateBody | null> {
  const host = input.host
  if (!host || host === '__local__') return null
  const deps = depsArg ?? await defaultDeps()
  // A replica never dials and learns readiness from the primary's pushes: the
  // primary gates the relayed launch itself.
  if (deps.cloudMode) return null
  const source = input.source ?? 'human'
  const now = deps.now ?? Date.now
  const started = now()
  const budget = input.deadlineMs ?? GATE_CONNECT_DEADLINE_MS + GATE_CHECK_DEADLINE_MS
  const left = () => Math.max(0, budget - (now() - started))
  const def = await deps.configDef(host)
  if (!def || def.enabled === false) return hostGateBody({ code: 'host_removed', host, headline: HOST_REMOVED_NOTE })
  const label = def.label ?? host
  let status = deps.frame(host, def)
  if (status.phase === 'off') return hostGateBody({ code: 'host_off', host, headline: REMOTE_OFF_NOTE })

  if (!status.connected && status.phase === 'failed') {
    let outcome: string | undefined
    if (source === 'human') {
      // A deliberate Start is a fresh redial, never a refusal on a stale frame (G2).
      const r = await deps.connect(host, { deadlineMs: Math.min(GATE_CONNECT_DEADLINE_MS, left()) })
      outcome = r.outcome
      status = r.status ?? deps.frame(host, def)
    }
    if (!status.connected) {
      const kind = status.phase === 'failed' ? status.kind ?? 'unknown' : 'timeout'
      log.session.info('start refused: host unreachable', { host, kind, outcome, source })
      return hostGateBody({ code: 'host_unreachable', host, kind, headline: hostFailureHeadline(kind, label), hint: status.hint })
    }
  }
  if (!status.connected) return null

  const override = input.overrideReadiness === true
  // No explicit model: the session runs the CLI's own default, so that model's floor decides (not Walnut's configured model).
  const model = input.model || await deps.cliDefaultModel(host).catch(() => undefined) || null
  if (!blockingProblem(deps.readinessFor(host, model), override)) return null
  // A human may have fixed it in a terminal a minute ago: ask again first (G6).
  // Automation reads the answer as it stands (a re-check every run would probe the host on every tick).
  const checkMs = Math.min(GATE_CHECK_DEADLINE_MS, left())
  if (source === 'human' && checkMs > 0) await deps.check(host, { deadlineMs: checkMs, force: true }).catch(() => null)
  const problem = blockingProblem(deps.readinessFor(host, model), override)
  if (!problem) return null
  log.session.info('start refused: host not ready', { host, kind: problem.kind, model, source })
  return hostGateBody({
    code: 'host_not_ready', host, kind: problem.kind, headline: problem.message,
    allowOverride: OVERRIDABLE_KINDS.includes(problem.kind),
  })
}
