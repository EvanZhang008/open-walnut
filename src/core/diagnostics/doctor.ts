/**
 * collectDiagnostics: the `open-walnut doctor` report (see types.ts).
 *
 * Contract: resolves always, never throws, never waits long. Every probe runs
 * under a deadline (2s on this machine, 5s for the login shell and per remote
 * host, twice the local budget for the claude preflight) and a probe that fails
 * or runs out of time becomes one `warnings` line while the rest of the report
 * still fills in. A check that did not finish reads "unknown", never "not
 * found": a slow machine must not be told to install what it already has.
 * Every string leaves through maskSecrets, JSON and text alike.
 */

import { getBuildInfo } from '../../lib/build-info.js'
import { redactSensitiveText } from '../../logging/index.js'
import { HOST_RUNTIME_MESSAGES, type HostPreflightResult } from '../../providers/host-runtime-core.js'
import { LOGIN_SHELL_TIMEOUT_MS, sessionPath, summarizePath } from './local-probes.js'
import { applyClaudeFloor } from '../hosts/host-readiness-problems.js'
import { defaultDiagnosticsProbes, type DiagnosticsProbes } from './probes.js'
import { maskSecrets } from './redact.js'
import type { DiagnosticsReport, HostDiagnostics, LocalClaudeDiagnostics, LocalDiagnostics } from './types.js'

export type * from './types.js'
export type { DiagnosticsProbes } from './probes.js'
export { defaultDiagnosticsProbes } from './probes.js'

export const LOCAL_PROBE_TIMEOUT_MS = 2_000
export const HOST_PROBE_TIMEOUT_MS = 5_000
/**
 * The claude preflight runs two CLI commands (`--version`, then `auth status`),
 * each a cold node start for the npm build, so it gets two local budgets.
 */
const PREFLIGHT_BUDGETS = 2

type Env = Record<string, string | undefined>

export interface CollectOptions {
  /** 'cli' = no server is running: local half only, no daemon, config read-only. Default 'server'. */
  collector?: 'server' | 'cli'
  probes?: Partial<DiagnosticsProbes>
  /** Defaults to process.env. Only PATH and SHELL are ever reported from it. */
  env?: Env
  localTimeoutMs?: number
  /** Default 5s, the daemon's own budget for the same capture. */
  loginShellTimeoutMs?: number
  hostTimeoutMs?: number
  now?: () => Date
}

function describeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return redactSensitiveText(msg.split('\n')[0].slice(0, 300))
}

interface Outcome { timedOut?: boolean; failed?: boolean }

/** Run one probe under a deadline; a failure is a warning line and `undefined`. */
function bounded<T>(warnings: string[], label: string, ms: number, fn: () => Promise<T> | T, outcome: Outcome = {}): Promise<T | undefined> {
  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      outcome.timedOut = true
      warnings.push(`${label}: no answer within ${ms / 1000}s`)
      resolve(undefined)
    }, ms)
    timer.unref?.()
    Promise.resolve()
      .then(fn)
      .then(
        (value) => { if (!done) { done = true; clearTimeout(timer); resolve(value) } },
        (err) => {
          if (done) return
          done = true
          clearTimeout(timer)
          outcome.failed = true
          warnings.push(`${label}: ${describeError(err)}`)
          resolve(undefined)
        },
      )
  })
}

/**
 * The CLI's own words for how it signs in, kept only while they look like a
 * method ("Bedrock", "a Claude account"): claude-check-core.ts already drops
 * the email and org fields, and this refuses anything shaped like an address.
 */
export function safeAuthDetail(detail: unknown): string | undefined {
  if (typeof detail !== 'string') return undefined
  const text = detail.replace(/\s+/g, ' ').trim()
  if (!text || text.length > 80 || text.includes('@')) return undefined
  return text
}

function claudeFrom(pre: HostPreflightResult | undefined, fallbackPath: string | null, unknown: string | null): LocalClaudeDiagnostics {
  if (!pre) {
    return { found: !!fallbackPath, path: fallbackPath, version: null, kind: null, ...(unknown ? { unknown } : {}) }
  }
  const c = pre.claude
  const out: LocalClaudeDiagnostics = { found: c.found, path: c.path ?? null, version: c.version ?? null, kind: c.kind ?? null }
  if (c.needsNode) out.node = { found: !!c.nodeFound, version: c.nodeVersion ?? null }
  if (c.auth === 'ok' || c.auth === 'not-logged-in' || c.auth === 'unknown') out.auth = c.auth
  const detail = safeAuthDetail(c.authDetail)
  if (detail) out.authDetail = detail
  if (typeof c.versionOk === 'boolean') out.versionOk = c.versionOk
  if (c.minVersion) out.minVersion = c.minVersion
  if (c.error && c.found) out.error = c.error
  return out
}

interface LocalBudgets { ms: number; loginMs: number }

async function collectLocal(p: DiagnosticsProbes, env: Env, b: LocalBudgets, warnings: string[]): Promise<LocalDiagnostics> {
  const preflightMs = b.ms * PREFLIGHT_BUDGETS
  const sideProbes = Promise.all([
    bounded(warnings, 'sqlite', b.ms, p.sqlite),
    bounded(warnings, 'web assets', b.ms, p.webAssets),
  ])
  const loginAnswer = bounded(warnings, 'login shell PATH', b.loginMs, () => p.loginShellPath(b.loginMs))
  const floor = (await bounded(warnings, 'claude version floor', b.ms, p.claudeFloor)) ?? null
  // The local daemon answers for this machine when it is connected: its PATH is the one sessions get.
  let raw = (await bounded(warnings, 'local daemon preflight', preflightMs, () => p.daemonPreflight(floor?.minVersion, preflightMs))) ?? undefined
  const source: LocalDiagnostics['preflightSource'] = raw ? 'daemon' : null
  const login = await loginAnswer
  const pathStr = sessionPath(login ?? null, env)
  const outcome: Outcome = {}
  if (!raw) raw = await bounded(warnings, 'claude preflight', preflightMs, () => p.preflight(pathStr, floor?.minVersion), outcome)
  // A daemon too old to compare still gets the floor applied here, as host-readiness does.
  const pre = raw ? applyClaudeFloor(raw, floor) : undefined
  let fallbackPath: string | null = null
  if (!pre) {
    try { fallbackPath = p.claudePath(pathStr) } catch { /* reported as unknown */ }
  }
  const unknown = pre ? null : outcome.timedOut ? 'preflight timed out' : 'preflight failed'

  let compiler: LocalDiagnostics['compiler']
  if (pre) compiler = { found: pre.compiler.found, name: pre.compiler.name ?? null }
  else {
    try { compiler = p.compiler(pathStr) } catch { compiler = { found: false, name: null, unknown: 'check failed' } }
  }
  const dtachOutcome: Outcome = {}
  const dtach = await bounded(warnings, 'dtach', b.ms, () => p.dtach(pathStr), dtachOutcome)
  const [sqlite, webAssets] = await sideProbes
  return {
    node: { version: process.version, path: process.execPath },
    claude: claudeFrom(pre, fallbackPath, unknown),
    loginShellPath: login ? summarizePath(login) : null,
    processPath: summarizePath(env.PATH),
    shell: env.SHELL?.trim() || null,
    preflightSource: pre ? source ?? 'in-process' : null,
    compiler,
    dtach: dtach ?? { found: false, path: null, source: null, unknown: dtachOutcome.timedOut ? 'checking' : 'check failed' },
    sqliteOk: sqlite ? sqlite.ok : null,
    ...(sqlite?.version ? { sqliteVersion: sqlite.version } : {}),
    webAssetsOk: webAssets ?? null,
  }
}

async function collectHosts(p: DiagnosticsProbes, ms: number, warnings: string[]): Promise<HostDiagnostics[]> {
  const hosts = await bounded(warnings, 'hosts', ms, p.hosts)
  if (!hosts) return []
  // One warnings list per host, joined in host order: the parallel probes finish in any order.
  const perHost = hosts.map(() => [] as string[])
  const filled = await Promise.all(hosts.map(async (h, i) => {
    const entry: HostDiagnostics = { ...h }
    if (h.readiness?.claude.authDetail !== undefined) {
      const { authDetail, ...claude } = h.readiness.claude
      const safe = safeAuthDetail(authDetail)
      entry.readiness = { ...h.readiness, claude: safe ? { ...claude, authDetail: safe } : claude }
    }
    if (!entry.connected) return entry
    const hello = await bounded(perHost[i], `host ${h.alias}: daemon hello`, ms, () => p.daemonHello(h.alias, ms))
    if (hello) {
      entry.daemonVersion = hello.version
      // The connection's own runtime wins; the hello only knows it in service mode.
      if (hello.runtime && !entry.runtime) entry.runtime = hello.runtime
    }
    return entry
  }))
  for (const lines of perHost) warnings.push(...lines)
  return filled
}

/** Facts worth a line even though no probe failed. A check that did not finish concludes nothing. */
function findings(report: Omit<DiagnosticsReport, 'warnings'>): string[] {
  const out: string[] = []
  const { claude } = report.local
  if (!claude.found && !claude.unknown) out.push(`claude: not found on this machine (install: ${HOST_RUNTIME_MESSAGES.install})`)
  else if (claude.error) out.push(`claude: ${claude.error}`)
  if (claude.found && claude.auth === 'not-logged-in') out.push('claude: not signed in (run `claude` once in a terminal and sign in)')
  if (claude.found && claude.versionOk === false) {
    out.push(`claude: ${claude.version ?? 'this version'} is older than ${claude.minVersion ?? '?'}, the oldest the configured model runs on`)
  }
  if (report.server?.nice && report.server.nice > 0) {
    out.push(`server: running at nice ${report.server.nice}, it will be starved under load (restart it from a normal shell)`)
  }
  if (report.local.sqliteOk === false) out.push('sqlite: the native module does not load under this node')
  if (report.local.webAssetsOk === false) out.push('web assets: the built web app is missing where this server serves it from')
  return out
}

export async function collectDiagnostics(opts: CollectOptions = {}): Promise<DiagnosticsReport> {
  const env = opts.env ?? process.env
  const collector = opts.collector ?? 'server'
  const probes: DiagnosticsProbes = { ...defaultDiagnosticsProbes(env, collector), ...opts.probes }
  const localMs = opts.localTimeoutMs ?? LOCAL_PROBE_TIMEOUT_MS
  const loginMs = opts.loginShellTimeoutMs ?? LOGIN_SHELL_TIMEOUT_MS
  const hostMs = opts.hostTimeoutMs ?? HOST_PROBE_TIMEOUT_MS
  const now = opts.now ?? (() => new Date())
  const w = { local: [] as string[], config: [] as string[], hosts: [] as string[], server: [] as string[] }

  const [local, config, hosts, server, update] = await Promise.all([
    collectLocal(probes, env, { ms: localMs, loginMs }, w.local),
    bounded(w.config, 'config', localMs, probes.config),
    collector === 'server' ? collectHosts(probes, hostMs, w.hosts) : Promise.resolve([]),
    collector === 'server' ? bounded(w.server, 'server', localMs, probes.server) : Promise.resolve(null),
    // A registry round trip when nothing is cached yet: the remote-host budget, not the local one.
    bounded(w.server, 'update', hostMs, probes.update),
  ])
  if (collector === 'cli') w.server.push('server: not running, so remote hosts were not checked')

  let build: DiagnosticsReport['build']
  try {
    build = getBuildInfo()
  } catch (err) {
    build = { version: 'unknown', commit: null, branch: null, builtAt: null, dirty: false }
    w.server.push(`build: ${describeError(err)}`)
  }
  const base = { generatedAt: now().toISOString(), collector, build, update: update ?? null, server: server ?? null, local, hosts, config: config ?? null }
  // Secrets never leave, in any form: fix logs, check errors and claude errors are free text.
  return maskSecrets({ ...base, warnings: [...w.server, ...w.local, ...w.config, ...w.hosts, ...findings(base)] })
}

export { redactDiagnostics } from './redact.js'
export { renderDiagnosticsText, type RenderOptions } from './render.js'
