/**
 * A remote-host stand-in for the Playwright fixture server (test-server.ts sets
 * WALNUT_TEST_HOST_FIXTURE_MODE=1). Fixture hosts never dial ssh: their status
 * is the REAL buildHostStatus over fixture inputs, their readiness lives in the
 * real host-readiness store (seeded here; a real host.preflight is never sent,
 * setReadinessProbeSkip), their folder listing goes through the real
 * listSessionDirs classification, and a Start that passes the gate spawns
 * through the MockDaemon like any test session. So every banner, picker and
 * Settings state renders without a real host.
 *
 * DaemonConnections DO get built for fixture hosts: list-dirs pools a direct
 * one to the MockDaemon (fixtureListConnection), and anything that takes the
 * ssh path builds one whose connect() the ephemeral guard refuses before any
 * ssh runs (daemon-connection.ts ephemeralRemoteRefused: the fixture route is
 * only mounted on an ephemeral server, server.ts).
 *
 * Driven by POST /api/test/host-fixture (routes/test-host-fixture.ts).
 */

import type { DaemonConnectState } from '../../providers/daemon-connection.js'
import type { HostPreflightResult } from '../../providers/host-runtime-core.js'
import { claudeCliFloorFor, claudeVersionAtLeast, type ClaudeCliFloor } from './claude-version-floor.js'
import { decideReconnectStep } from '../../providers/daemon-reconnect-cause.js'
import { credentialRetryDelayMs } from '../sessions/host-connect-hint.js'
import { buildHostStatus, type HostDef, type HostStatus } from './host-status.js'
import { getHostReadiness, setClaudeFloorOverride, setHostReadinessForTest, setReadinessProbeSkip, type HostReadiness } from './host-readiness.js'
import { withFixState, type HostFixing, type HostFixRecord } from './host-autofix.js'

export interface FixtureClaude { found?: boolean; version?: string; auth?: 'ok' | 'not-logged-in' | 'unknown'; installMethod?: 'native' | 'npm' | 'homebrew' | 'other'; kind?: string; needsNode?: boolean; nodeFound?: boolean; error?: string; path?: string }

export interface FixtureHostSpec {
  label: string
  hostname: string
  user?: string
  port?: number
  phase?: 'connected' | 'failed' | 'reconnecting' | 'off'
  /** The raw connect failure text (classified by the real classifier). */
  error?: string
  /** A credential re-dial is armed this many seconds from load. */
  retryInSec?: number
  claude?: FixtureClaude
  /** Extra alternative commands per readiness kind (shown after the builder's own). */
  extraCommands?: Record<string, string[]>
  enabled?: boolean
}

export interface FixtureFile {
  user?: string
  ephemeral?: boolean
  floor?: ClaudeCliFloor
  /** Virtual folder tree for the MockDaemon's fs.ls: path -> child dir names, or 'EACCES'. */
  dirs?: Record<string, string[] | 'EACCES'>
  hosts: Record<string, FixtureHostSpec>
}

export interface FixtureHost {
  spec: FixtureHostSpec
  phase: 'connected' | 'failed' | 'reconnecting' | 'off' | 'idle'
  error?: string
  kind?: string
  retryAt?: number
  /** The standing slow probe of a reconnect that turned failed (auth / host_key / dns). */
  probeAt?: number
  connectedAt?: number
  reconnectSince?: number
  lastError?: string
  /** 'ok' or a failure kind: what the next connect attempt answers. */
  nextConnect?: string
  renewed?: boolean
  /** Problems the next check answers with (null = computed from claude). */
  nextCheck?: { claude?: FixtureClaude } | null
  /** How long the simulated automatic fix runs (host-fixture-autofix.ts); default 2s. */
  autofixSlowMs?: number
  /** How long a Check again takes to answer (the 'Checking...' window). */
  checkDelayMs?: number
  /** The simulated automatic fix running now, and the finished ones (merged into readiness like the real store). */
  fixing?: HostFixing
  fixes?: HostFixRecord[]
  /** The claude version a preflight run WITH the host's shell_setup would find. */
  shellSetupVersion?: string
}

/** connect / check / listDirs: attempts per host; failureCacheCleared: connectHostNow cleared it (C46). */
export type FixtureCounter = 'connect' | 'check' | 'listDirs' | 'failureCacheCleared'

interface State {
  file: FixtureFile | null
  hosts: Map<string, FixtureHost>
  floor: ClaudeCliFloor | null
  modelFloors: Map<string, ClaudeCliFloor>
  offsetMs: number
  counters: Record<FixtureCounter, Record<string, number>> & { readinessRpc: number }
  /** The MockDaemon's spawn log (test-server.ts wires it): how many sessions a Start really spawned. */
  spawnProbe: (() => string[]) | null
}

const DEFAULT_FLOOR: ClaudeCliFloor = { minVersion: '2.1.280', model: 'Opus 5.5' }

function emptyCounters(): State['counters'] {
  return { connect: {}, check: {}, listDirs: {}, failureCacheCleared: {}, readinessRpc: 0 }
}

const st: State = { file: null, hosts: new Map(), floor: null, modelFloors: new Map(), offsetMs: Number(process.env.WALNUT_TEST_CLOCK_OFFSET_MS) || 0, counters: emptyCounters(), spawnProbe: null }

/** The fixture is on for this process (the test server only). */
export function hostFixtureMode(): boolean {
  return process.env.WALNUT_TEST_HOST_FIXTURE_MODE === '1'
}

/**
 * May this server mount POST /api/test/host-fixture? The flag alone is not
 * enough: a leaked env var on a real or cloud server would open a route that
 * rewrites config.hosts. Only an ephemeral, non-cloud server qualifies.
 */
export function hostFixtureRouteAllowed(opts: { env: Record<string, string | undefined>; ephemeral: boolean; cloudMode: boolean }): boolean {
  return opts.env.WALNUT_TEST_HOST_FIXTURE_MODE === '1' && opts.ephemeral && !opts.cloudMode
}

export function isFixtureHost(host: string | undefined | null): boolean {
  return !!host && hostFixtureMode() && st.hosts.has(host)
}

export function fixtureHost(host: string): FixtureHost | undefined {
  return hostFixtureMode() ? st.hosts.get(host) : undefined
}

export function fixtureHosts(): string[] {
  return [...st.hosts.keys()]
}

/** The fixture clock: Date.now() plus the advance-clock offset. */
export function fixtureNow(): number {
  return Date.now() + st.offsetMs
}

export function advanceFixtureClock(ms: number): void {
  st.offsetMs += Math.max(0, ms)
}

export function fixtureFloor(): ClaudeCliFloor | null {
  return hostFixtureMode() && st.file ? (st.floor ?? DEFAULT_FLOOR) : null
}

/** `model` given: the floor of that model id only (C53); otherwise the default floor for every model. */
export function setFixtureFloor(floor: ClaudeCliFloor, model?: string): void {
  if (model) st.modelFloors.set(model, floor)
  else st.floor = floor
}

/** A launch model's floor under the fixture: its own entry, the real table, else the default floor. */
function fixtureFloorFor(model: string): ClaudeCliFloor | null {
  return st.modelFloors.get(model) ?? claudeCliFloorFor(model) ?? fixtureFloor()
}

export function fixtureFile(): FixtureFile | null {
  return st.file
}

export function fixtureEphemeral(): boolean {
  return !!st.file?.ephemeral
}

// ── Counters (GET /api/test/host-fixture/counters) ──

export function bumpFixtureCounter(name: FixtureCounter, host: string): void {
  const m = st.counters[name]
  m[host] = (m[host] ?? 0) + 1
}

function bumpReadinessRpc(): void {
  st.counters.readinessRpc++
}

/** test-server.ts: the session ids the MockDaemon was asked to start, oldest first. */
export function setFixtureSpawnProbe(probe: (() => string[]) | null): void {
  st.spawnProbe = probe
}

export function fixtureCounters(): State['counters'] & { spawns: string[] } {
  const counters = JSON.parse(JSON.stringify(st.counters)) as State['counters']
  return { ...counters, spawns: st.spawnProbe?.() ?? [] }
}

// ── Load / reset ──

function hostFrom(spec: FixtureHostSpec, now: number, ephemeral: boolean): FixtureHost {
  const phase = ephemeral ? 'off' : (spec.phase ?? 'connected')
  const h: FixtureHost = { spec, phase }
  if (phase === 'failed' && spec.error) h.error = spec.error
  if (phase === 'failed' && spec.retryInSec) h.retryAt = now + spec.retryInSec * 1000
  if (phase === 'connected') h.connectedAt = now - 5_000
  if (phase === 'reconnecting') h.reconnectSince = now
  return h
}

/** Replace the fixture wholesale (counters and clock start over). */
export function loadFixtureState(file: FixtureFile): void {
  st.file = file
  st.floor = file.floor ?? null
  st.modelFloors.clear()
  setClaudeFloorOverride({ configured: fixtureFloor, forModel: fixtureFloorFor })
  // The MockDaemon behind a fixture host has no host.preflight: never probe one for real.
  setReadinessProbeSkip(isFixtureHost)
  st.offsetMs = Number(process.env.WALNUT_TEST_CLOCK_OFFSET_MS) || 0
  st.counters = emptyCounters()
  st.hosts.clear()
  const now = fixtureNow()
  for (const [key, spec] of Object.entries(file.hosts)) {
    if (spec.enabled === false) continue
    st.hosts.set(key, hostFrom(spec, now, !!file.ephemeral))
  }
}

export function resetFixtureState(): void {
  st.file = null
  st.floor = null
  st.modelFloors.clear()
  setClaudeFloorOverride(null)
  setReadinessProbeSkip(null)
  st.hosts.clear()
  st.counters = emptyCounters()
  st.offsetMs = Number(process.env.WALNUT_TEST_CLOCK_OFFSET_MS) || 0
}

export function forgetFixtureHost(host: string): void {
  st.hosts.delete(host)
}

// ── What the real modules read ──

/** The DaemonConnectState a fixture host would report (fed to the real buildHostStatus). */
export function fixtureConnectState(host: string, now = fixtureNow()): DaemonConnectState | null {
  const h = st.hosts.get(host)
  if (!h) return null
  const phase = h.phase === 'off' ? 'idle' : h.phase
  const state: DaemonConnectState = { host, connected: phase === 'connected', phase, phaseElapsedMs: 0, connectElapsedMs: 0 }
  if (phase === 'failed' && h.error) state.error = h.error
  // A standing reconnect cause (auth / host_key / dns) has its own slow probe; credential re-dials ride extra.credentialRetryAt.
  if (phase === 'failed' && typeof h.probeAt === 'number') { state.retryAt = h.probeAt; if (h.kind) state.kind = h.kind }
  if (phase === 'connected' && h.connectedAt) state.connectedAt = h.connectedAt
  if (phase === 'reconnecting') {
    state.reconnectSince = h.reconnectSince ?? now
    state.attemptStartedAt = now
    if (h.lastError) state.lastError = h.lastError
  }
  return state
}

/** The credential re-dial the warmup would have armed (cert_expired / agent_missing hosts). */
function fixtureCredentialRetryAt(host: string): number | undefined {
  const h = st.hosts.get(host)
  return h?.phase === 'failed' ? h.retryAt : undefined
}

/** The preflight answer a fixture host gives (claude block from the spec or the last set-check-result). */
function fixturePreflight(host: string, opts: { withShellSetup?: boolean } = {}): HostPreflightResult | null {
  const h = st.hosts.get(host)
  if (!h || h.phase !== 'connected') return null
  const c = { ...(h.spec.claude ?? {}), ...(h.nextCheck?.claude ?? {}) }
  if (opts.withShellSetup && h.shellSetupVersion) c.version = h.shellSetupVersion
  const found = c.found !== false
  const claude: HostPreflightResult['claude'] = found
    ? {
        found: true, path: c.path ?? '/home/alice/.local/bin/claude', kind: (c.kind as 'native' | 'npm' | undefined) ?? 'native', needsNode: c.needsNode ?? false,
        ...(c.version ? { version: c.version } : {}), ...(c.auth ? { auth: c.auth } : { auth: 'ok' as const }),
        installMethod: c.installMethod ?? 'native', ...(c.nodeFound !== undefined ? { nodeFound: c.nodeFound } : {}),
        ...(c.error ? { error: c.error } : {}),
      }
    : { found: false }
  return { claude, compiler: { found: true, name: 'gcc' }, dtach: { found: true, path: '/usr/bin/dtach' }, platform: 'linux', arch: 'x64' }
}

/** A Claude Code that passes the current floor (what a finished update or a sign-in reports). */
export function healthyFixtureClaude(): FixtureClaude {
  const floor = fixtureFloor()?.minVersion
  const version = floor && claudeVersionAtLeast('2.1.281', floor) === false ? floor : '2.1.281'
  return { found: true, version, auth: 'ok', needsNode: false, error: undefined }
}

// ── Connect and check, as the fixture answers them ──

/** A raw failure text that the real classifier reads as `kind`. */
export function fixtureFailureText(kind: string, hostname: string): string {
  switch (kind) {
    case 'auth': return 'Permission denied (publickey).'
    case 'host_key': return 'Host key verification failed.'
    case 'cert_expired': return 'Permission denied (publickey).\nwalnut-ssh-evidence: cert-expired (SSH certificate expired)'
    case 'agent_missing': return 'Permission denied (publickey).\nwalnut-ssh-evidence: agent-missing (no key in the agent)'
    case 'dns': return `ssh: Could not resolve hostname ${hostname}: nodename nor servname provided, or not known`
    case 'unreachable': return `ssh: connect to host ${hostname} port 22: No route to host`
    case 'refused': return `ssh: connect to host ${hostname} port 22: Connection refused`
    case 'timeout': return `ssh: connect to host ${hostname} port 22: Operation timed out`
    case 'proxy': return 'kex_exchange_identification: Connection closed by remote host'
    case 'runtime': return 'the remote runtime could not start: glibc is too old'
    case 'daemon': return 'daemon handshake failed'
    case 'shell_noise': return 'shell_noise: the login shell printed text before the protocol started'
    default: return 'the connection ended for a reason Walnut does not recognize'
  }
}

const CREDENTIAL = new Set(['cert_expired', 'agent_missing'])
const kindOfText = (text: string): string => (/cert-expired/.test(text) ? 'cert_expired' : /agent-missing/.test(text) ? 'agent_missing' : '')

/** Mark a host failed with `kind` (or a raw text). Credential kinds re-arm a 60s re-dial like the warmup's first tier. */
export function failFixtureHost(host: string, kindOrText: { kind?: string; text?: string }, now = fixtureNow()): void {
  const h = st.hosts.get(host)
  if (!h) return
  const text = kindOrText.text ?? fixtureFailureText(kindOrText.kind ?? 'unknown', h.spec.hostname)
  const kind = kindOrText.kind ?? kindOfText(text)
  h.phase = 'failed'
  h.error = text
  h.kind = kind || undefined
  h.connectedAt = undefined
  h.probeAt = undefined
  h.retryAt = CREDENTIAL.has(kind) ? now + 60_000 : undefined
}

export function connectFixtureHost(host: string, now = fixtureNow()): void {
  const h = st.hosts.get(host)
  if (!h) return
  Object.assign(h, { phase: 'connected', connectedAt: now, error: undefined, kind: undefined, retryAt: undefined, probeAt: undefined, lastError: undefined, reconnectSince: undefined, renewed: false, nextConnect: undefined })
}

/**
 * One connect attempt (the fixture's getDaemonConnection). `renew-credential`
 * and `set-next-connect` decide it; otherwise a failed host fails the same way
 * again and a reconnecting one comes back.
 */
export function fixtureConnectAttempt(host: string): { connected: boolean; error?: string } {
  bumpFixtureCounter('connect', host)
  const h = st.hosts.get(host)
  if (!h) return { connected: false, error: `Unknown host: ${host}` }
  if (h.phase === 'off') return { connected: false, error: 'ephemeral server: remote hosts are off' }
  const next = h.renewed ? 'ok' : h.nextConnect ?? (h.phase === 'failed' ? '' : 'ok')
  if (next === 'ok') { connectFixtureHost(host); return { connected: true } }
  if (next) failFixtureHost(host, { kind: next })
  else failFixtureHost(host, { text: h.error ?? fixtureFailureText('unknown', h.spec.hostname), kind: h.kind ?? kindOfText(h.error ?? '') })
  h.nextConnect = undefined
  return { connected: false, error: h.error }
}

// ── Reconnect, as the real loop decides it (daemon-reconnect-cause.ts) ──

export function startFixtureReconnect(host: string, since?: number): void {
  const h = st.hosts.get(host)
  if (!h) return
  Object.assign(h, { phase: 'reconnecting', reconnectSince: since ?? fixtureNow(), connectedAt: undefined, error: undefined, kind: undefined, lastError: undefined, probeAt: undefined })
}

/**
 * A reconnect attempt failed with `kind`. The REAL decision function says
 * whether it is standing (the frame turns failed, with the slow probe or the
 * credential re-dial as retryAt) or the network waking up (stays reconnecting).
 */
export function injectFixtureFailure(host: string, kind: string, afterWake: boolean): void {
  const h = st.hosts.get(host)
  if (!h) return
  const now = fixtureNow()
  if (h.phase !== 'reconnecting' && h.phase !== 'failed') startFixtureReconnect(host)
  const step = decideReconnectStep({
    kind, now, delayMs: 2_000, credentialAttempt: 0, lastSignalAt: afterWake ? now - 1_000 : 0,
    standingDelayMs: 10 * 60_000, maxDelayMs: 30_000, credentialDelayMs: credentialRetryDelayMs,
  })
  const text = fixtureFailureText(kind, h.spec.hostname)
  if (!step.standing) {
    Object.assign(h, { phase: 'reconnecting', lastError: text, error: undefined, kind })
    return
  }
  Object.assign(h, { phase: 'failed', error: text, kind, connectedAt: undefined })
  if (step.credentialWait) { h.retryAt = step.retryAt; h.probeAt = undefined } else { h.probeAt = step.retryAt; h.retryAt = undefined }
}

// ── Readiness, stored in the REAL host-readiness store ──

function sshTargetOf(spec: FixtureHostSpec): string {
  const user = spec.user ?? st.file?.user
  return `${spec.port && spec.port !== 22 ? `-p ${spec.port} ` : ''}${user ? `${user}@` : ''}${spec.hostname}`
}

/** The preflight answer for a connected fixture host, judged against the fixture floor. False when not connected. */
export function seedFixtureReadiness(host: string, opts: { withShellSetup?: boolean } = {}): boolean {
  const h = st.hosts.get(host)
  const pre = fixturePreflight(host, opts)
  if (!h || !pre) return false
  bumpReadinessRpc()
  setHostReadinessForTest(host, pre, { hostLabel: h.spec.label, sshTarget: sshTargetOf(h.spec), floor: fixtureFloor() }, fixtureNow())
  return true
}

/**
 * Readiness as the frame carries it: the simulated fix merged in the way the
 * real store merges its own (withFixState), then the spec's alternative commands.
 */
export function fixtureReadinessView(host: string): HostReadiness | undefined {
  const now = fixtureNow()
  let r = getHostReadiness(host, now)
  const h = st.hosts.get(host)
  if (!r || !h) return r
  if (h.fixing || h.fixes?.length) {
    const fixes = h.fixes ?? []
    r = {
      ...r, problems: withFixState(r.problems, r, h.fixing, fixes),
      fixes: fixes.map((f) => ({ ...f, ageMs: Math.max(0, now - f.finishedAt) })),
      ...(h.fixing ? { fixing: h.fixing } : {}),
    }
  }
  const extra = h.spec.extraCommands
  if (!extra) return r
  return { ...r, problems: r.problems.map((p) => (extra[p.kind] ? { ...p, commands: [...p.commands, ...extra[p.kind]] } : p)) }
}

/** The whole frame for a fixture host: the real buildHostStatus over fixture inputs. */
export function fixtureHostStatus(host: string, def: HostDef): HostStatus | null {
  const state = fixtureConnectState(host)
  const h = st.hosts.get(host)
  if (!state || !h) return null
  const now = fixtureNow()
  const credentialRetryAt = fixtureCredentialRetryAt(host)
  return buildHostStatus(host, def, state, undefined, now, state.connected ? fixtureReadinessView(host) : undefined, {
    off: h.phase === 'off', ...(credentialRetryAt ? { credentialRetryAt } : {}),
  })
}

/** The config.hosts entry a fixture host is written as. */
export function fixtureHostDef(spec: FixtureHostSpec, user?: string): HostDef & { shell_setup?: string } {
  const u = spec.user ?? user
  return { hostname: spec.hostname, label: spec.label, ...(u ? { user: u } : {}), ...(spec.port ? { port: spec.port } : {}), ...(spec.enabled === false ? { enabled: false } : {}) }
}

/**
 * The "connection" list-dirs uses for a fixture host: the MockDaemon (its
 * fs.ls serves the fixture tree) when connected, the host's own failure text
 * when failed, and a connect that never finishes while reconnecting.
 */
export async function fixtureListConnection(host: string): Promise<{ send(command: string, params: Record<string, unknown>): Promise<Record<string, unknown>> }> {
  const h = st.hosts.get(host)
  if (!h) throw new Error(`Unknown host: ${host}`)
  if (h.phase === 'failed') throw new Error(h.error ?? fixtureFailureText('unknown', h.spec.hostname))
  if (h.phase === 'reconnecting' || h.phase === 'idle') return new Promise(() => { /* still connecting */ })
  const url = process.env.WALNUT_TEST_HOST_FIXTURE_DAEMON_URL
  if (!url) throw new Error('daemon handshake failed: the host fixture has no MockDaemon url')
  const { getDirectDaemonConnection } = await import('../../providers/daemon-connection.js')
  return getDirectDaemonConnection(host, url)
}

/**
 * The fixture tree as the daemon's fs.ls answers it (the MockDaemon asks this
 * first): `~` is the fixture user's home, an 'EACCES' entry is the listing
 * failure the picker must NOT call a connect failure. null = not in the tree.
 */
export function fixtureFsLs(dirPath: string): { entries: Array<{ name: string; type: string }>; resolvedPath: string } | { error: string } | null {
  const tree = hostFixtureMode() ? st.file?.dirs : undefined
  if (!tree) return null
  const home = `/home/${st.file?.user ?? 'alice'}`
  let p = dirPath === '~' || dirPath.startsWith('~/') ? home + dirPath.slice(1) : dirPath
  if (p.length > 1) p = p.replace(/\/+$/, '')
  if (!Object.hasOwn(tree, p)) return null
  const node = tree[p]
  if (node === 'EACCES') return { error: `EACCES: permission denied, scandir '${p}'` }
  return { entries: node.map((name) => ({ name, type: 'dir' })), resolvedPath: p }
}
