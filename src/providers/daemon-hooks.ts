/**
 * The session daemon's hooks: the declarative rules each Walnut pushes (hooks.configure),
 * kept per Walnut, persisted to hooks.json, and evaluated at the intercept points of the
 * session code (hookActions).
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts), whose command table
 * takes cmdHooksConfigure (answers); its session code calls hookActions, its walnut-scope fold moves a
 * home's rules (daemonHooksByHome, HOOKS_DIR), and its boot and cron restore read them back.
 * The code is the runtime's as it was; deps carry the runtime's own names.
 */
import fs from 'node:fs'
import path from 'node:path'
import { evalDaemonHookRules, builtinSessionOnlyCronHook, type DaemonHooksConfig, type DaemonHookPoint } from './daemon-core.js'
import { DaemonSessionGate, persistCronHooks } from './daemon-cron-runtime.js'
import type { createWalnutScope } from './walnut-scope-core.js'
import { ok, fail, type Answer, type Answers, type DaemonEnv, type DaemonLog } from './daemon-module-deps.js'

/** One Walnut's pushed rules, with the hash on disk and when they arrived. */
export interface ScopedHooks { config: DaemonHooksConfig; persistedHash: string | null | undefined; at: number }

export interface DaemonHooksDeps<W extends object> {
  daemonEnv: DaemonEnv
  DAEMON_DIR: string
  /** A service set's runtime: hooks live in its state dir, written through the cron store. */
  SERVICE_MODE: boolean
  DAEMON_STATE_DIR: string | undefined
  /** Each Walnut's own dir under the runtime's (hooks are per Walnut). */
  walnutScope: ReturnType<typeof createWalnutScope>
  /** The Walnut each trusted socket speaks for. */
  gatewayClientHomes: WeakMap<W, string>
  /** The Walnut a session belongs to. */
  sessionHomeOf: (sid: string) => string
  logMsg: DaemonLog
}

export function createDaemonHooks<W extends object>(deps: DaemonHooksDeps<W>) {
  const { daemonEnv, DAEMON_DIR, SERVICE_MODE, DAEMON_STATE_DIR, walnutScope, gatewayClientHomes, sessionHomeOf, logMsg } = deps

  // ── Daemon hooks (declarative rules pushed from walnut) ──
  // The daemon holds one compiled rules JSON (daemon-core DaemonHooksConfig) per
  // Walnut, received via the hooks.configure command and persisted to hooks.json so
  // a daemon restart keeps enforcing without waiting for the next connect. They are
  // the ONLY source of interventions: no pushed hooks ⇒ the daemon denies nothing,
  // evicts nothing, rewrites nothing (stream markers stay — they are observation for
  // the human, not intervention).
  //
  // Per Walnut (walnut-scope-core.ts): a push names its home and replaces only that
  // Walnut's rules, which apply only to that Walnut's sessions. A push with no home
  // (an older server) is the unnamed copy, kept in hooks.json as before; it applies
  // to every session whose Walnut pushed none of its own. A hooks.json an older
  // daemon wrote (no `scoped` mark) was the one copy for everyone: it applies the
  // same way until the first named push, which drops it.
  //
  // Back-compat: a server older than this protocol sets WALNUT_ENFORCE_SESSION_CRON=1
  // at spawn instead of pushing; synthesize the equivalent built-in rule set at
  // boot (a later hooks.configure replaces it). WALNUT_ALLOW_DURABLE_CRON=1 wins
  // over everything (emergency off-switch).
  const HOOKS_DIR = SERVICE_MODE && DAEMON_STATE_DIR ? DAEMON_STATE_DIR : DAEMON_DIR
  const HOOKS_FILE = path.join(HOOKS_DIR, 'hooks.json')
  /** Rules by Walnut home; '' is the unnamed copy (an older server, or inherited). */
  const daemonHooksByHome = new Map<string, ScopedHooks>()
  let hooksInherited = false
  // For a session no copy covers: null = provably no hooks file, undefined = unknown.
  let hooksNoneOnDisk: null | undefined = undefined
  const hooksConfigureGate = new DaemonSessionGate()
  function hooksFileOf(home: string): string {
    return path.join(walnutScope.dirFor(HOOKS_DIR, home), 'hooks.json')
  }
  function readHooksFile(file: string): (DaemonHooksConfig & { home?: unknown; scoped?: unknown }) | null {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf-8')) as DaemonHooksConfig & { home?: unknown; scoped?: unknown }
    // Same shape gate as cmdHooksConfigure: a wrong-version/shape file (e.g.
    // left by a future daemon) falls through to the env fallback, not silence.
    return loaded && loaded.version === 1 && Array.isArray(loaded.hooks) ? loaded : null
  }
  function loadDaemonHooksAtBoot() {
    if (daemonEnv.WALNUT_ALLOW_DURABLE_CRON === '1') return
    for (const [key, dir] of walnutScope.scopeDirs(fs, HOOKS_DIR)) {
      try {
        const loaded = readHooksFile(path.join(dir, 'hooks.json'))
        if (!loaded || typeof loaded.home !== 'string' || walnutScope.keyOf(loaded.home) !== key) continue
        daemonHooksByHome.set(loaded.home, { config: loaded, persistedHash: typeof loaded.hash === 'string' ? loaded.hash : undefined, at: 0 })
        logMsg('info', 'daemon hooks loaded from disk', { walnut: key, hash: loaded.hash, hooks: loaded.hooks.length })
      } catch { /* unreadable: that Walnut pushes again at connect */ }
    }
    let persistedHash: null | undefined = undefined
    hooksNoneOnDisk = undefined
    try {
      const loaded = readHooksFile(HOOKS_FILE)
      if (loaded) {
        daemonHooksByHome.set('', { config: loaded, persistedHash: typeof loaded.hash === 'string' ? loaded.hash : undefined, at: 0 })
        hooksInherited = loaded.scoped !== 1
        logMsg('info', 'daemon hooks loaded from disk', { walnut: 'unnamed', hash: loaded.hash, hooks: loaded.hooks.length, inherited: hooksInherited })
        return
      }
    } catch (error) {
      // No file: a cron restore can tell that no hooks were ever on disk.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') persistedHash = null
    }
    hooksNoneOnDisk = persistedHash
    if (daemonEnv.WALNUT_ENFORCE_SESSION_CRON === '1') {
      daemonHooksByHome.set('', { config: { version: 1, hash: 'env-compat', hooks: [builtinSessionOnlyCronHook()] }, persistedHash: undefined, at: 0 })
      logMsg('info', 'daemon hooks synthesized from WALNUT_ENFORCE_SESSION_CRON (legacy server)')
    }
  }
  /** The copy a session runs under: its Walnut's, else the unnamed one. */
  function hooksEntryForSession(sid: unknown): ScopedHooks | undefined {
    const home = typeof sid === 'string' && sid ? sessionHomeOf(sid) : ''
    return (home && daemonHooksByHome.get(home)) || daemonHooksByHome.get('')
  }
  function hooksForSession(sid: unknown): DaemonHooksConfig | null {
    return hooksEntryForSession(sid)?.config ?? null
  }
  /** The hooks on disk a session's cron restore was recorded under (daemon-cron-runtime.ts). */
  function persistedHooksHashFor(sid: string): string | null | undefined {
    const entry = hooksEntryForSession(sid)
    return entry ? entry.persistedHash : hooksNoneOnDisk
  }
  /**
   * What a service handover carries: one rules file, read back as an unmarked (so
   * inherited) copy, which each Walnut's next push replaces. The unnamed copy when
   * there is one, else the latest push.
   */
  function handoverHooks(): DaemonHooksConfig | null {
    const unnamed = daemonHooksByHome.get('')
    if (unnamed) return unnamed.config
    let latest: ScopedHooks | null = null
    for (const entry of daemonHooksByHome.values()) if (!latest || entry.at > latest.at) latest = entry
    return latest?.config ?? null
  }
  /** Evaluate the pushed rules at one intercept point (empty when no hooks). */
  function hookActions(point: DaemonHookPoint, ctx: Record<string, unknown>): string[] {
    if (daemonEnv.WALNUT_ALLOW_DURABLE_CRON === '1') return []
    try { return evalDaemonHookRules(hooksForSession(ctx.sid), point, ctx) } catch { return [] }
  }

  async function cmdHooksConfigure(cmd: Record<string, unknown>, from: W): Promise<Answer> {
    return hooksConfigureGate.run('hooks', () => configureDaemonHooks(cmd, from))
  }

  async function configureDaemonHooks(cmd: Record<string, unknown>, from: W): Promise<Answer> {
    const next = cmd.config as DaemonHooksConfig | undefined
    if (!next || next.version !== 1 || !Array.isArray(next.hooks) || typeof next.hash !== 'string') {
      return fail('hooks.configure: invalid config')
    }
    const scope = walnutScope.resolve(cmd, gatewayClientHomes.get(from), 'hooks.configure')
    if (!scope.ok) return fail(scope.error, { errorKind: 'not_owner' })
    const home = scope.home
    const prev = daemonHooksByHome.get(home)
    // An unnamed push over an inherited copy makes the file this daemon's own (marked).
    const changed = !prev || next.hash !== prev.config.hash || (!home && hooksInherited)
    // What goes to disk: the unnamed copy marked as this daemon's own, a named one with its home.
    const stored = home ? { ...next, home, scoped: 1 } : { ...next, scoped: 1 }
    const dir = walnutScope.dirFor(HOOKS_DIR, home)
    let persistedHash = prev?.persistedHash
    if (SERVICE_MODE && DAEMON_STATE_DIR && (changed || persistedHash !== next.hash)) {
      persistedHash = undefined
      await persistCronHooks(dir, stored)
      persistedHash = next.hash
    }
    daemonHooksByHome.set(home, { config: next, persistedHash, at: Date.now() })
    if (!home) hooksInherited = false
    // The first push that names its Walnut ends the copy an older daemon left for everyone.
    if (home && hooksInherited) {
      hooksInherited = false
      daemonHooksByHome.delete('')
      try { fs.unlinkSync(HOOKS_FILE) } catch {}
      logMsg('info', 'daemon hooks: the copy an older daemon left is replaced by each Walnut\'s own', { walnut: walnutScope.label(home) })
    }
    // The kill switch gates EVALUATION (hookActions), not storage — accepting
    // the push keeps the daemon current for when the switch is lifted, but an
    // operator debugging "why is nothing enforced" needs to see the switch.
    if (daemonEnv.WALNUT_ALLOW_DURABLE_CRON === '1') {
      logMsg('warn', 'daemon hooks stored but INERT: WALNUT_ALLOW_DURABLE_CRON=1 disables all hook evaluation', { hash: next.hash })
    }
    if (changed) {
      // Persist failure is non-fatal (rules ARE applied in memory; the next
      // connect re-pushes) but must be visible: an unwritable DAEMON_DIR means
      // enforcement silently reverts to zero-hook on the next daemon restart.
      if (!SERVICE_MODE) {
        try {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
          fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify(stored), { mode: 0o600 })
        } catch (err) { logMsg('warn', 'daemon hooks persist failed (in-memory only)', { error: (err as Error).message }) }
      }
      logMsg('info', 'daemon hooks configured', { walnut: walnutScope.label(home), hash: next.hash, hooks: next.hooks.length })
    }
    return ok({ applied: true, changed, hash: next.hash })
  }

  const answers: Answers<W> = { 'hooks.configure': cmdHooksConfigure }

  return {
    answers, hookActions,
    HOOKS_DIR, daemonHooksByHome, loadDaemonHooksAtBoot, persistedHooksHashFor, handoverHooks,
  }
}
