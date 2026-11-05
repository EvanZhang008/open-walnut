/**
 * Host readiness: what a CONNECTED host can actually run, from the daemon's
 * `host.preflight` RPC (capability 'preflight-v1', computed host-side in
 * src/providers/host-runtime-core.ts). The connect chain (ssh → … → handshake)
 * proves the daemon runs; it says nothing about whether `claude` is installed,
 * whether an npm-built claude has a node it can start with, whether it is
 * signed in, or whether it is new enough for the configured model (the floor
 * the server sends, claude-version-floor.ts). This answers that, once per
 * successful handshake and on every deliberate human connect. The wording lives
 * in host-readiness-problems.ts, shared with this machine's banner
 * (local-readiness.ts).
 *
 * Never blocks a connect: it runs after the host is connected and pushes the
 * result as a fresh `host:status` when it lands. An old daemon without the
 * capability gets no readiness field and no UI line, never an error.
 */

import { log } from '../../logging/index.js'
import {
  autofixDisabledReason, countsAsAttempt, describeFixOutcome, isAgentFix, nextFixAction, runHostAutofix,
  type DtachProvisionOutcome, type HostFixAction, type HostFixing, type HostFixRecord,
} from './host-autofix.js'
import {
  applyClaudeFloor, claudeMissingMessage, claudeNeedsNodeMessage, parsePreflight, readinessProblems,
} from './host-readiness-problems.js'
import { configuredClaudeCliFloor, type ClaudeCliFloor } from './claude-version-floor.js'
import { FIX_RETRY_AFTER_MS, recentFailedFixes, rememberFixOutcome } from './host-fix-memory.js'
import {
  agentsAsked, agentsAskedNow, attempted, fixState, getHostReadiness, inFlight, markCheckFailed, notifyReadiness as notify, onHostReadinessChange,
  prebuiltFor, prebuiltUnusable, problemCtx, readinessProbeSkipped, rounds, setFixState, store, type HostReadiness,
} from './host-readiness-store.js'
import { wireHostSessionUse } from './host-session-use.js'

export type { HostFixAction, HostFixing, HostFixRecord }
export { parsePreflight, readinessProblems }
export type { ReadinessProblem, ReadinessProblemKind } from './host-readiness-problems.js'
// The store and the floor judgements live in their own modules; this stays their import path.
export {
  claudeSessionBlocker, claudeUnusableProblem, clearHostReadiness, getHostReadiness, onHostReadinessChange,
  resetHostAutofixAttempts, setReadinessProbeSkip, type HostReadiness,
} from './host-readiness-store.js'
export {
  hostReadinessForLaunch, hostReadinessForModel, recomputeHostReadinessFloors, setClaudeFloorOverride, setHostReadinessForTest,
} from './host-readiness-floor.js'

/** The subset of a daemon connection this module talks to. */
export interface PreflightConnection {
  hasCapability(cap: string): boolean
  send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<{ ok: boolean; error?: string; [key: string]: unknown }>
}

/**
 * The daemon caps itself at 12s; 2s more covers the tunnel. Kept under the
 * UI's 15s "Check again" wait, so a hung probe still answers as checkError.
 */
export const PREFLIGHT_TIMEOUT_MS = 14_000
/**
 * A reconnect re-probes a HEALTHY host at most this often (a flapping tunnel
 * reconnects dozens of times a day). A host with a problem re-probes on every
 * reconnect, and a human connect always does, so a fix shows up at once.
 */
const HEALTHY_RECHECK_MS = 10 * 60_000

/** How a host's lines name it: its label, the ssh target a user types, and the model floor. */
export interface HostContext {
  label?: string
  sshTarget?: string
  floor: ClaudeCliFloor | null
  /** config.hosts[].shell_setup: the preflight runs it first, as a session spawn does. */
  shellSetup?: string
  /**
   * The host's Linux runs inside Windows, from its probed kernel release, for a daemon
   * whose preflight predates its own `wsl` field (a joined PC updates its daemon itself,
   * so the Mac cannot bring it the new one): its lines and commands still name WSL.
   */
  wsl?: string
}

/** 'WSL' when the host's probed kernel is WSL's (5.15.x-microsoft-standard-WSL2), else undefined. */
export async function probedWsl(host: string): Promise<string | undefined> {
  try {
    const { readHostProfile } = await import('./host-profile.js')
    const os = (await readHostProfile(host)).probed?.os
    return os?.platform === 'linux' && /microsoft/i.test(os.release ?? '') ? 'WSL' : undefined
  } catch {
    return undefined
  }
}

/** `ssh` arguments as the user would type them: `[-p port] [user@]hostname`. */
export function sshTargetText(def: { hostname?: unknown; user?: unknown; port?: unknown } | undefined, host: string): string {
  const hostname = typeof def?.hostname === 'string' && def.hostname ? def.hostname : host
  const user = typeof def?.user === 'string' && def.user ? `${def.user}@` : ''
  const port = typeof def?.port === 'number' && def.port !== 22 ? `-p ${def.port} ` : ''
  return `${port}${user}${hostname}`
}

async function defaultHostContext(host: string): Promise<HostContext> {
  const floor = await configuredClaudeCliFloor()
  try {
    const { getConfig } = await import('../config-manager.js')
    const hosts = (await getConfig()).hosts ?? {}
    const def = Object.hasOwn(hosts, host) ? hosts[host] as { hostname?: unknown; user?: unknown; port?: unknown; label?: unknown; shell_setup?: unknown } : undefined
    const label = typeof def?.label === 'string' && def.label ? def.label : host
    const shellSetup = typeof def?.shell_setup === 'string' && def.shell_setup.trim() ? def.shell_setup : undefined
    const wsl = await probedWsl(host)
    return { label, sshTarget: sshTargetText(def, host), floor, ...(shellSetup ? { shellSetup } : {}), ...(wsl ? { wsl } : {}) }
  } catch {
    return { label: host, sshTarget: host, floor }
  }
}

async function defaultConnection(host: string): Promise<PreflightConnection | null> {
  const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js')
  return getConnectedDaemonConnection(host)
}

/** Seams for the automatic fixes; every one has a live default. */
export interface AutofixOptions {
  /** The host's config entry (`autofix: false` turns fixes off for it). */
  hostSettings?: (host: string) => Promise<{ autofix?: unknown } | undefined>
  env?: Record<string, string | undefined>
  /** After a fix that changes what the terminal probe would answer. */
  onFixed?: (host: string, action: HostFixAction) => void
  dtachSources?: () => Promise<Record<string, string>>
  /** The terminal's dtach provisioning for the host, forced fresh (ssh). */
  provisionDtach?: (host: string) => Promise<DtachProvisionOutcome>
}

type RefreshContext = (host: string) => Promise<HostContext>

/** Does the server ship a prebuilt dtach for this platform/arch? Path or null. */
export type PrebuiltLookup = (platform: string | undefined, arch: string | undefined) => Promise<string | null>

async function defaultFindPrebuilt(platform: string | undefined, arch: string | undefined): Promise<string | null> {
  return (await import('../../web/terminal/dtach-prebuilt.js')).findPrebuiltDtach(platform, arch)
}

/**
 * `fresh` only skips a cached FAILURE: a cached ok lives for the process, and
 * would answer "dtach is installed" for a host reimaged since. Forget the entry
 * first so the probe really looks.
 */
async function defaultProvisionDtach(host: string): Promise<DtachProvisionOutcome> {
  const m = await import('../../web/terminal/dtach-provision.js')
  m.invalidateDtachCache(host)
  return m.resolveRemoteDtach(host, { fresh: true })
}

async function defaultHostSettings(host: string): Promise<{ autofix?: unknown } | undefined> {
  const { getConfig } = await import('../config-manager.js')
  const hosts = (await getConfig()).hosts ?? {}
  return Object.hasOwn(hosts, host) ? hosts[host] : undefined
}

async function defaultDtachSources(): Promise<Record<string, string>> {
  return (await import('../../web/terminal/dtach-sources.js')).DTACH_SOURCES
}

/** The terminal caches a host's dtach answer; a fresh compiler or dtach must be seen. */
function defaultOnFixed(host: string, action: HostFixAction): void {
  if (action !== 'build-dtach' && action !== 'install-compiler') return
  void import('../../web/terminal/dtach-provision.js')
    .then((m) => m.invalidateDtachCache(host))
    .catch(() => { /* no terminal module in this process */ })
}

/**
 * Start an autofix round when this answer has problems a fix can address and
 * the daemon can run fixes. Fire-and-forget: the caller (a connect, a human
 * re-check) never waits for an install.
 */
function maybeStartAutofix(host: string, conn: PreflightConnection, answer: HostReadiness, opts: AutofixOptions, now: () => number, findPrebuilt?: PrebuiltLookup, context?: RefreshContext): void {
  // A round running reads the ask at each step (`agents` below): a click during it joins it.
  if (answer.problems.length === 0 || rounds.has(host)) return
  if (!conn.hasCapability('hostfix-v1')) {
    // The person clicked Install and nothing can run it here: the line says so, never a silent no-op.
    refuseAsked(host, answer, 'unknown-action', now())
    return
  }
  let tried = attempted.get(host)
  // First round on this host in this server: what failed under an earlier one is read first.
  const fresh = !tried
  if (!tried) { tried = new Set(); attempted.set(host, tried) }
  const prebuiltDtach = () => prebuiltFor.get(host) === true
  // The ask's own clock (the click's Date.now), not the round's injectable one. It is used up
  // when its fix starts (onStart), so a later connect installs nothing by itself.
  const agents = () => agentsAskedNow(host)
  if (!fresh && !nextFixAction(answer, tried, { prebuiltDtach: prebuiltDtach(), agents: agents() })) return
  const triedNow = tried
  const round = (async () => {
    if (fresh) await recallFailedFixes(host, triedNow, now())
    if (!nextFixAction(answer, triedNow, { prebuiltDtach: prebuiltDtach(), agents: agents() })) return
    let def: { autofix?: unknown } | undefined
    try {
      def = await (opts.hostSettings ?? defaultHostSettings)(host)
    } catch (err) {
      // Unreadable config: `autofix: false` may be in it. Fail closed, never
      // run a mutating fix on a guess. The next connect reads it again.
      log.session.warn('host autofix skipped: host config unreadable', { host, error: err instanceof Error ? err.message : String(err) })
      return
    }
    const off = autofixDisabledReason(opts.env ?? process.env, def)
    // `hosts.<alias>.autofix: false` turns off the fixes nobody asked for; a person's Install
    // or Update still runs there, alone (2026-11-03: the user clicked Install on such a host
    // and nothing happened). The env switch turns off every fix on this Mac.
    const agentsOnly = off === 'config'
    if (off === 'env' || (agentsOnly && !agents())) {
      log.session.info('host autofix off', { host, reason: off, problems: answer.problems.map((p) => p.kind), asked: agents() })
      if (off === 'env') refuseAsked(host, answer, 'fixes-off', now())
      return
    }
    // The floor rides the install too, and a host with no claude has none in its answer.
    const floor = answer.claude.minVersion
      ?? (await (context ?? defaultHostContext)(host).catch(() => null))?.floor?.minVersion
    await runHostAutofix(answer, {
      conn,
      tried: triedNow,
      agents,
      agentsOnly,
      now,
      ...(floor ? { minClaudeVersion: floor } : {}),
      preflight: () => refreshHostReadiness(host, { getConnection: () => conn, now, force: true, autofix: false, findPrebuilt, hostContext: context }),
      prebuiltDtach,
      provisionDtach: () => (opts.provisionDtach ?? defaultProvisionDtach)(host),
      onPrebuiltUnusable: () => {
        log.session.warn('host prebuilt dtach did not run, planning for a compiler', { host })
        prebuiltUnusable.add(host)
        prebuiltFor.set(host, false)
      },
      dtachSources: opts.dtachSources ?? defaultDtachSources,
      onStart: (fixing) => {
        log.session.info('host fix started', { host, action: fixing.action })
        if (isAgentFix(fixing.action)) agentsAsked.delete(host)
        setFixState(host, (st) => { st.fixing = fixing })
      },
      onAttempt: (record) => { void rememberFixOutcome(host, record) },
      onFinish: (record, result) => {
        const fields = {
          host, action: record.action, ok: record.ok, error: record.error, needsPassword: record.needsPassword,
          skipped: record.skipped, durationMs: result?.durationMs, output: typeof result?.log === 'string' ? result.log : undefined,
        }
        if (record.ok) log.session.info('host fix finished', fields)
        else log.session.warn('host fix finished', fields)
        setFixState(host, (st) => { delete st.fixing; st.fixes.push(record) })
        if (record.ok) (opts.onFixed ?? defaultOnFixed)(host, record.action)
      },
    })
  })()
    .catch((err) => { log.session.warn('host autofix failed', { host, error: err instanceof Error ? err.message : String(err) }) })
    .finally(() => {
      if (rounds.get(host) === round) rounds.delete(host)
      // A round that ends while a fix is marked running (it threw) must not leave the spinner-free line up.
      const st = fixState.get(host)
      if (st?.fixing) setFixState(host, (x) => { delete x.fixing })
    })
  rounds.set(host, round)
}

/**
 * A fix that failed on `host` under an earlier server, within its retry window,
 * counts as tried here too, and its line stays on screen (host-fix-memory.ts).
 */
async function recallFailedFixes(host: string, tried: Set<HostFixAction>, now: number): Promise<void> {
  const failed = await recentFailedFixes(host, now).catch(() => [])
  if (!failed.length) return
  const fresh = failed.filter((r) => !tried.has(r.action))
  for (const r of fresh) tried.add(r.action)
  if (!fresh.length) return
  log.session.info('host autofix: fixes that failed under an earlier server are not run again yet', {
    host, actions: fresh.map((r) => r.action), retryAfterHours: FIX_RETRY_AFTER_MS / 3_600_000,
  })
  setFixState(host, (st) => {
    const have = new Set(st.fixes.map((f) => `${f.action}@${f.finishedAt}`))
    for (const r of fresh) if (!have.has(`${r.action}@${r.finishedAt}`)) st.fixes.push(r)
    st.fixes.sort((a, b) => a.finishedAt - b.finishedAt)
  })
}

/**
 * A person asked for the coding agent's fix and it cannot start: record why on the line
 * (`error` is a REASONS code in host-autofix.ts), once per ask. Nothing when nobody asked
 * or the line has no such fix.
 */
function refuseAsked(host: string, answer: HostReadiness, error: string, at: number): void {
  if (!agentsAskedNow(host)) return
  const action = nextFixAction(answer, new Set(), { agents: true, agentsOnly: true })
  agentsAsked.delete(host)
  if (!action) return
  const record = describeFixOutcome(action, { result: { ok: false, error } }, at)
  log.session.warn('host fix not started', { host, action, error })
  setFixState(host, (st) => { st.fixes.push(record) })
}

/** Test seam: the autofix round running on a host, if any. */
export function hostAutofixRound(host: string): Promise<void> | undefined {
  return rounds.get(host)
}

/**
 * Ask a connected host what it can run, store the answer, notify. One probe per
 * host at a time (a second caller shares the first). Resolves null, and leaves
 * the previous answer alone, when the host is not connected or the RPC fails;
 * an old daemon without 'preflight-v1' clears any answer instead. An answer
 * with problems starts the automatic fixes unless `autofix: false`.
 */
export function refreshHostReadiness(
  host: string,
  opts: {
    getConnection?: (host: string) => Promise<PreflightConnection | null> | PreflightConnection | null
    now?: () => number
    /** Skip the healthy-host throttle (a human asked). */
    force?: boolean
    /** false = only look (the autofix round's own re-checks). */
    autofix?: false | AutofixOptions
    /** Test seam: the shipped-prebuilt lookup (dtach-prebuilt.ts). */
    findPrebuilt?: PrebuiltLookup
    /** Test seam: the host's label, ssh target and model floor (config by default). */
    hostContext?: RefreshContext
  } = {},
): Promise<HostReadiness | null> {
  if (!host || host === '__local__') return Promise.resolve(null)
  // A fixture host answers from its seeded store entry, never over the wire.
  if (readinessProbeSkipped(host)) return Promise.resolve(getHostReadiness(host) ?? null)
  const now = opts.now ?? Date.now
  const known = store.get(host)
  if (!opts.force && known && known.problems.length === 0 && now() - known.checkedAt < HEALTHY_RECHECK_MS) {
    return Promise.resolve(getHostReadiness(host) ?? null)
  }
  const running = inFlight.get(host)
  if (running) return running
  const job = (async (): Promise<HostReadiness | null> => {
    try {
      const conn = await (opts.getConnection ?? defaultConnection)(host)
      if (!conn) return null
      if (!conn.hasCapability('preflight-v1')) {
        if (store.delete(host)) notify(host)
        return null
      }
      const ctx = await (opts.hostContext ?? defaultHostContext)(host)
      const params: Record<string, unknown> = ctx.floor ? { minClaudeVersion: ctx.floor.minVersion } : {}
      if (ctx.shellSetup) params.shellSetup = ctx.shellSetup
      const reply = await conn.send('host.preflight', params, PREFLIGHT_TIMEOUT_MS)
      const answered = reply.ok ? parsePreflight(reply) : null
      // The daemon's own word wins; the probed kernel only fills in for an older daemon.
      const raw = answered && !answered.wsl && ctx.wsl && answered.platform === 'linux' ? { ...answered, wsl: ctx.wsl } : answered
      const parsed = raw ? applyClaudeFloor(raw, ctx.floor) : null
      if (!parsed) {
        log.session.warn('host preflight returned no usable answer', { host, error: reply.error })
        markCheckFailed(host, reply.error || 'the host gave no usable answer', now())
        return null
      }
      // Only a host with neither a compiler nor dtach asks whether a prebuilt fits.
      const prebuilt = !parsed.dtach.found && !parsed.compiler.found && !prebuiltUnusable.has(host)
        && !!(await (opts.findPrebuilt ?? defaultFindPrebuilt)(parsed.platform, parsed.arch).catch(() => null))
      prebuiltFor.set(host, prebuilt)
      problemCtx.set(host, { prebuiltDtach: prebuilt, hostLabel: ctx.label, sshTarget: ctx.sshTarget })
      store.set(host, {
        ...parsed, checkedAt: now(),
        problems: readinessProblems(parsed, { prebuiltDtach: prebuilt, hostLabel: ctx.label, sshTarget: ctx.sshTarget, floorModel: ctx.floor?.model }),
      })
      const readiness = getHostReadiness(host)!
      log.session.info('host preflight', {
        host, problems: readiness.problems.map((p) => p.kind),
        claude: readiness.claude.found ? readiness.claude.kind : 'missing', compiler: readiness.compiler.found,
        claudeVersion: readiness.claude.version, versionOk: readiness.claude.versionOk, auth: readiness.claude.auth,
      })
      notify(host)
      if (opts.autofix !== false) maybeStartAutofix(host, conn, readiness, opts.autofix ?? {}, now, opts.findPrebuilt, opts.hostContext)
      return readiness
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.session.warn('host preflight failed', { host, error: message })
      markCheckFailed(host, message, now())
      return null
    }
  })().finally(() => { if (inFlight.get(host) === job) inFlight.delete(host) })
  inFlight.set(host, job)
  return job
}

/**
 * Server wiring: probe every configured host right after its handshake, re-push its status
 * when the answer lands, and keep `usedForSessions` current (host-session-use.ts), re-pushing
 * a host whose answer flips. (A card whose cause was fixed by hand goes at the next re-ask:
 * the page re-asks every blocked host when its window comes back, useHostStatus.ts.)
 * Returns one unsubscribe.
 */
export function wireHostReadiness(opts: {
  onConnected: (cb: (host: string) => void) => () => void
  isKnownHost: (host: string) => boolean
  emit: (host: string) => void
  /** Test seam; defaults to refreshHostReadiness against the live pool. */
  refresh?: (host: string) => Promise<unknown>
  /** Test seams for host-session-use; false leaves it unwired. */
  sessionUse?: false | { everyMs?: number; read?: () => Promise<Set<string>> }
}): () => void {
  const refresh = opts.refresh ?? ((host: string) => refreshHostReadiness(host))
  const offConnected = opts.onConnected((host) => {
    if (host === '__local__' || !opts.isKnownHost(host)) return
    void refresh(host)
  })
  const offChange = onHostReadinessChange((host) => opts.emit(host))
  const offUse = opts.sessionUse === false ? () => {} : wireHostSessionUse(
    (host) => { if (store.has(host)) notify(host) },
    { hosts: () => store.keys(), ...(opts.sessionUse ?? {}) },
  )
  return () => { offConnected(); offChange(); offUse() }
}

// ── The spawn gate's sentence (C5) ──

/**
 * The daemon refused a spawn with `claude_missing` / `claude_needs_node`: the
 * sentence every other surface shows, with the host's label (`host` null = this
 * computer). Chosen by code, so an older daemon's wording never leaks through.
 */
export async function spawnGateSentence(code: 'claude_missing' | 'claude_needs_node', host: string | null): Promise<string> {
  const ctx = host ? { hostLabel: (await defaultHostContext(host)).label ?? host } : { local: true }
  return code === 'claude_missing' ? claudeMissingMessage(ctx) : claudeNeedsNodeMessage(ctx)
}
