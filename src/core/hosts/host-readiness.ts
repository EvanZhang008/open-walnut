/**
 * Host readiness: what a CONNECTED host can actually run, from the daemon's
 * `host.preflight` RPC (capability 'preflight-v1', computed host-side in
 * src/providers/host-runtime-core.ts). The connect chain (ssh → … → handshake)
 * proves the daemon runs; it says nothing about whether `claude` is installed,
 * or whether an npm-built claude has a node it can start with. This answers
 * that, once per successful handshake and on every deliberate human connect.
 *
 * Never blocks a connect: it runs after the host is connected and pushes the
 * result as a fresh `host:status` when it lands. An old daemon without the
 * capability gets no readiness field and no UI line, never an error.
 */

import { log } from '../../logging/index.js'
import { HOST_RUNTIME_MESSAGES, type HostPreflightResult } from '../../providers/host-runtime-core.js'
import {
  FIX_FOR_PROBLEM, autofixDisabledReason, nextFixAction, runHostAutofix,
  type DtachProvisionOutcome, type HostFixAction, type HostFixing, type HostFixRecord,
} from './host-autofix.js'

export type { HostFixAction, HostFixing, HostFixRecord }

export type ReadinessProblemKind = 'claude_missing' | 'claude_needs_node' | 'claude_error' | 'compiler_missing' | 'dtach_missing'

export interface ReadinessProblem {
  kind: ReadinessProblemKind
  /** One sentence a user can act on. */
  message: string
  /** Commands to copy, in the order they are worth trying. */
  commands: string[]
  /**
   * Walnut is fixing this itself right now ('running': show that instead of the
   * command), or its attempt failed ('failed': `text` is the reason, and
   * `commands` then holds the exact command the host needs).
   */
  fix?: { action: HostFixAction; state: 'running' | 'failed'; text: string; needsPassword?: boolean; detail?: string }
}

export interface HostReadiness extends HostPreflightResult {
  /** When the host was last ASKED (success or failure): the UI's "is this answer new" key. */
  checkedAt: number
  /** Empty when nothing needs doing: the UI then shows nothing at all. */
  problems: ReadinessProblem[]
  /**
   * The last re-check failed (RPC error or timeout). The other fields are the
   * previous good answer, kept so the problem lines do not vanish on a blip.
   */
  checkError?: string
  /** The automatic fix running on the host right now (host-autofix.ts). */
  fixing?: HostFixing
  /**
   * Every automatic fix this server ran on the host, oldest first. `ageMs` is
   * how long ago each finished when this snapshot was taken, so a client times
   * a fix line against its own clock (server and browser clocks may differ).
   */
  fixes: Array<HostFixRecord & { ageMs: number }>
}

/** What the store keeps: the preflight answer; fix state is merged on read. */
type StoredReadiness = Omit<HostReadiness, 'fixing' | 'fixes'>

/** The subset of a daemon connection this module talks to. */
export interface PreflightConnection {
  hasCapability(cap: string): boolean
  send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<{ ok: boolean; error?: string; [key: string]: unknown }>
}

/**
 * The daemon caps itself at 12s; 2s more covers the tunnel. Kept under the
 * UI's 15s "Check again" wait, so a hung probe still answers as checkError.
 */
const PREFLIGHT_TIMEOUT_MS = 14_000
/**
 * A reconnect re-probes a HEALTHY host at most this often (a flapping tunnel
 * reconnects dozens of times a day). A host with a problem re-probes on every
 * reconnect, and a human connect always does, so a fix shows up at once.
 */
const HEALTHY_RECHECK_MS = 10 * 60_000

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {})

/** The wire answer, defensively: a field an old or odd daemon omits stays absent. */
export function parsePreflight(raw: unknown): HostPreflightResult | null {
  const r = obj(raw)
  if (!r.claude || typeof r.claude !== 'object') return null
  const c = obj(r.claude)
  const kind = c.kind === 'native' || c.kind === 'npm' || c.kind === 'unknown' ? c.kind : undefined
  const claude: HostPreflightResult['claude'] = { found: c.found === true }
  if (str(c.path)) claude.path = str(c.path)
  if (str(c.version)) claude.version = str(c.version)
  if (kind) claude.kind = kind
  if (typeof c.needsNode === 'boolean') claude.needsNode = c.needsNode
  if (typeof c.nodeFound === 'boolean') claude.nodeFound = c.nodeFound
  if (str(c.nodeVersion)) claude.nodeVersion = str(c.nodeVersion)
  if (str(c.error)) claude.error = str(c.error)!.slice(0, 300)
  const cc = obj(r.compiler)
  const dt = obj(r.dtach)
  return {
    claude,
    compiler: cc.found === true ? { found: true, ...(str(cc.name) ? { name: str(cc.name) } : {}) } : { found: false },
    dtach: dt.found === true ? { found: true, ...(str(dt.path) ? { path: str(dt.path) } : {}) } : { found: false },
    ...(str(r.platform) ? { platform: str(r.platform)!.slice(0, 32) } : {}),
    ...(str(r.arch) ? { arch: str(r.arch)!.slice(0, 32) } : {}),
  }
}

/**
 * One line per thing the user must fix. Nothing when the host is fine.
 * `prebuiltDtach`: the server ships a dtach that runs there, so no compiler is needed.
 */
export function readinessProblems(p: HostPreflightResult, opts: { prebuiltDtach?: boolean } = {}): ReadinessProblem[] {
  const install = HOST_RUNTIME_MESSAGES.install
  const out: ReadinessProblem[] = []
  if (!p.claude.found) {
    out.push({ kind: 'claude_missing', message: 'Claude Code is not installed on this host.', commands: [install] })
  } else if (p.claude.needsNode && p.claude.nodeFound === false) {
    out.push({
      kind: 'claude_needs_node',
      message: 'Claude Code here is the npm build and no working Node.js was found. Install the native build, which needs no Node.',
      commands: [install],
    })
  } else if (p.claude.error) {
    out.push({ kind: 'claude_error', message: `Claude Code did not start: ${p.claude.error}`, commands: [install] })
  }
  // A compiler only matters while dtach is missing: Walnut builds dtach from
  // source, and dtach is what keeps a terminal alive across disconnects. A
  // shipped prebuilt for the host's platform/arch needs no compiler at all.
  if (!p.compiler.found && !p.dtach.found && opts.prebuiltDtach) {
    // The compiler line is moot, but dtach is still missing: a host whose
    // prebuilt turns out not to run must never read as healthy. The autofix
    // installs the prebuilt (or learns it fails and asks for gcc instead).
    out.push({
      kind: 'dtach_missing',
      message: 'dtach is not installed yet, so terminals on this host will not survive a disconnect until Walnut installs it.',
      commands: [],
    })
  } else if (!p.compiler.found && !p.dtach.found) {
    out.push({
      kind: 'compiler_missing',
      message: 'No C compiler, so terminals on this host will not survive a disconnect.',
      // A Mac's compiler comes with the Command Line Tools, never from yum/apt.
      commands: p.platform === 'darwin' ? ['xcode-select --install'] : ['sudo yum install -y gcc', 'sudo apt-get install -y gcc'],
    })
  }
  return out
}

// ── Per-host store ──

const store = new Map<string, StoredReadiness>()
const inFlight = new Map<string, Promise<HostReadiness | null>>()
const listeners = new Set<(host: string) => void>()
/** Per host: the fix running now and the finished ones (kept across reconnects). */
const fixState = new Map<string, { fixing?: HostFixing; fixes: HostFixRecord[] }>()
/** Per host: fixes already tried this server lifetime (the once-per-problem rule). */
const attempted = new Map<string, Set<HostFixAction>>()
/** Per host: the autofix round in progress, if any. */
const rounds = new Map<string, Promise<void>>()
const MAX_FIX_RECORDS = 20
/** Per host: a shipped prebuilt dtach matches its platform/arch (last preflight). */
const prebuiltFor = new Map<string, boolean>()
/** Hosts where the prebuilt was offered and did not run (an older glibc, say). */
const prebuiltUnusable = new Set<string>()

/** The stored answer with the fix state merged in, as every surface reads it. */
export function getHostReadiness(host: string, now: number = Date.now()): HostReadiness | undefined {
  const base = store.get(host)
  if (!base) return undefined
  const fx = fixState.get(host)
  const fixes = fx?.fixes ?? []
  const fixing = fx?.fixing
  const problems = base.problems.map((p): ReadinessProblem => {
    const action = FIX_FOR_PROBLEM[p.kind]
    if (!action) return p
    if (fixing?.action === action) return { ...p, fix: { action, state: 'running', text: fixing.text } }
    let last: HostFixRecord | undefined
    for (const r of fixes) if (r.action === action) last = r
    if (!last || last.ok) return p
    return {
      ...p,
      commands: last.command ? [last.command] : p.commands,
      fix: {
        action, state: 'failed', text: last.text,
        ...(last.needsPassword ? { needsPassword: true } : {}), ...(last.detail ? { detail: last.detail } : {}),
      },
    }
  })
  return {
    ...base, problems,
    fixes: fixes.map((f) => ({ ...f, ageMs: Math.max(0, now - f.finishedAt) })),
    ...(fixing ? { fixing } : {}),
  }
}

/**
 * A human asked again ("Check again" / Connect): every fix may run once more.
 * A round already running keeps its own record and is not restarted.
 */
export function resetHostAutofixAttempts(host: string): void {
  attempted.delete(host)
}

/** Fires when a host's readiness changed (set or cleared). Returns an unsubscribe. */
export function onHostReadinessChange(cb: (host: string) => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

function notify(host: string): void {
  for (const cb of listeners) {
    try { cb(host) } catch { /* an observer must never break the probe */ }
  }
}

/** Test seam + disconnect-free reset. */
export function clearHostReadiness(host?: string): void {
  if (host === undefined) {
    store.clear(); inFlight.clear(); fixState.clear(); attempted.clear(); rounds.clear()
    prebuiltFor.clear(); prebuiltUnusable.clear()
    return
  }
  store.delete(host)
  inFlight.delete(host)
  fixState.delete(host)
  attempted.delete(host)
  rounds.delete(host)
  prebuiltFor.delete(host)
  prebuiltUnusable.delete(host)
}

/**
 * A re-check that failed still answers the human who asked: keep the previous
 * good answer, stamp the attempt and its error, and push. With no previous
 * answer there is nothing on screen to update, so nothing is stored.
 */
function markCheckFailed(host: string, message: string, at: number): void {
  const prev = store.get(host)
  if (!prev) return
  store.set(host, { ...prev, checkedAt: at, checkError: message.slice(0, 300) })
  notify(host)
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

function setFixState(host: string, update: (s: { fixing?: HostFixing; fixes: HostFixRecord[] }) => void): void {
  const s = fixState.get(host) ?? { fixes: [] }
  update(s)
  if (s.fixes.length > MAX_FIX_RECORDS) s.fixes.splice(0, s.fixes.length - MAX_FIX_RECORDS)
  fixState.set(host, s)
  notify(host)
}

/**
 * Start an autofix round when this answer has problems a fix can address and
 * the daemon can run fixes. Fire-and-forget: the caller (a connect, a human
 * re-check) never waits for an install.
 */
function maybeStartAutofix(host: string, conn: PreflightConnection, answer: HostReadiness, opts: AutofixOptions, now: () => number, findPrebuilt?: PrebuiltLookup): void {
  if (answer.problems.length === 0 || !conn.hasCapability('hostfix-v1') || rounds.has(host)) return
  let tried = attempted.get(host)
  if (!tried) { tried = new Set(); attempted.set(host, tried) }
  const prebuiltDtach = () => prebuiltFor.get(host) === true
  if (!nextFixAction(answer, tried, { prebuiltDtach: prebuiltDtach() })) return
  const triedNow = tried
  const round = (async () => {
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
    if (off) {
      log.session.info('host autofix off', { host, reason: off, problems: answer.problems.map((p) => p.kind) })
      return
    }
    await runHostAutofix(answer, {
      conn,
      tried: triedNow,
      now,
      preflight: () => refreshHostReadiness(host, { getConnection: () => conn, now, force: true, autofix: false, findPrebuilt }),
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
        setFixState(host, (st) => { st.fixing = fixing })
      },
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
  } = {},
): Promise<HostReadiness | null> {
  if (!host || host === '__local__') return Promise.resolve(null)
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
      const reply = await conn.send('host.preflight', {}, PREFLIGHT_TIMEOUT_MS)
      const parsed = reply.ok ? parsePreflight(reply) : null
      if (!parsed) {
        log.session.warn('host preflight returned no usable answer', { host, error: reply.error })
        markCheckFailed(host, reply.error || 'the host gave no usable answer', now())
        return null
      }
      // Only a host with neither a compiler nor dtach asks whether a prebuilt fits.
      const prebuilt = !parsed.dtach.found && !parsed.compiler.found && !prebuiltUnusable.has(host)
        && !!(await (opts.findPrebuilt ?? defaultFindPrebuilt)(parsed.platform, parsed.arch).catch(() => null))
      prebuiltFor.set(host, prebuilt)
      store.set(host, { ...parsed, checkedAt: now(), problems: readinessProblems(parsed, { prebuiltDtach: prebuilt }) })
      const readiness = getHostReadiness(host)!
      log.session.info('host preflight', {
        host, problems: readiness.problems.map((p) => p.kind),
        claude: readiness.claude.found ? readiness.claude.kind : 'missing', compiler: readiness.compiler.found,
      })
      notify(host)
      if (opts.autofix !== false) maybeStartAutofix(host, conn, readiness, opts.autofix ?? {}, now, opts.findPrebuilt)
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
 * Server wiring: probe every configured host right after its handshake, and
 * re-push its status when the answer lands. Returns one unsubscribe for both.
 */
export function wireHostReadiness(opts: {
  onConnected: (cb: (host: string) => void) => () => void
  isKnownHost: (host: string) => boolean
  emit: (host: string) => void
  /** Test seam; defaults to refreshHostReadiness against the live pool. */
  refresh?: (host: string) => Promise<unknown>
}): () => void {
  const refresh = opts.refresh ?? ((host: string) => refreshHostReadiness(host))
  const offConnected = opts.onConnected((host) => {
    if (host === '__local__' || !opts.isKnownHost(host)) return
    void refresh(host)
  })
  const offChange = onHostReadinessChange((host) => opts.emit(host))
  return () => { offConnected(); offChange() }
}
