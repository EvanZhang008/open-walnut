/**
 * Claude Code readiness for the machine Walnut runs on: what the setup banner
 * shows. The local twin of host-readiness.ts, with the same probe, the same
 * wording rules and the same fixes:
 *   - probe: the local daemon's host.preflight when it is connected with
 *     'preflight-v1', else the very same factories run in this process, on
 *     the PATH the daemon gives a session: the user's login-shell PATH
 *     (captured async, once per process), then the daemon's fallback dirs,
 *     then the inherited PATH. Without the login-shell part the fallback dirs
 *     come first and can name a different claude than sessions run;
 *   - an answer this process gave itself is replaced by the daemon's as soon
 *     as the local daemon connects;
 *   - fixes: host.fix through the local daemon ('hostfix-v1'), else in-process.
 * Deliberate differences from a remote host: a fix only runs when the banner's
 * button asks for one (this is the user's own computer), and only the claude_*
 * lines are reported (the terminal's dtach has its own messages). Signing in is
 * never automated: the banner re-checks every 15s while it is open instead.
 */

import fs from 'node:fs'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { log } from '../../logging/index.js'
import { createHostRuntime, type HostPreflightResult, type HostRuntimeDeps } from '../../providers/host-runtime-core.js'
import { createHostFix, type HostFixAction } from '../../providers/host-fix-core.js'
import { createClaudeCheck } from '../../providers/claude-check-core.js'
import {
  describeFixOutcome, fixActionFor, fixingText, sendHostFix, withFixState,
  type FixOutcome, type HostFixing, type HostFixRecord,
} from './host-autofix.js'
import { applyClaudeFloor, parsePreflight, readinessProblems, type ReadinessProblem } from './host-readiness-problems.js'
import { configuredClaudeCliFloor, type ClaudeCliFloor } from './claude-version-floor.js'
import { PREFLIGHT_TIMEOUT_MS, type PreflightConnection } from './host-readiness.js'
import { captureLoginShellPath, LOGIN_SHELL_TIMEOUT_MS, sessionPath } from '../diagnostics/local-probes.js'

export interface LocalClaudeStatus {
  /** When this machine was last asked (success or failure). */
  checkedAt: number
  claude: HostPreflightResult['claude']
  /** Only claude_* kinds; empty when Claude Code is ready. */
  problems: ReadinessProblem[]
  /** The local daemon answered, or this process did because the daemon was not connected. */
  source: 'daemon' | 'in-process'
  /** The last re-check failed; the rest is the previous good answer. */
  checkError?: string
  /** The fix a button started, while it runs. */
  fixing?: HostFixing
  /** The last fix a button started, `ageMs` old when this snapshot was taken. */
  lastFix?: HostFixRecord & { ageMs: number }
}

export type LocalFixStart =
  | { ok: true; status: LocalClaudeStatus }
  | { ok: false; error: 'not-checked' | 'no-such-problem' | 'no-fix' | 'busy' }

/** Everything that touches the machine, as a seam. */
export interface LocalClaudeIo {
  preflight(minClaudeVersion: string | undefined): Promise<{ result: HostPreflightResult | null; source: 'daemon' | 'in-process'; error?: string }>
  fix(action: HostFixAction, params: Record<string, unknown>): Promise<FixOutcome>
  floor(): Promise<ClaudeCliFloor | null>
  now(): number
  /** Calls `cb` each time the local daemon (re)connects. Returns an unsubscribe. */
  onDaemonConnected(cb: () => void): () => void
}

type Env = Record<string, string | undefined>

/** What the default machine is built from: a seam for the daemon-or-in-process choice. */
export interface LocalMachineParts {
  connection(): Promise<PreflightConnection | null>
  onDaemonConnected(cb: () => void): () => void
  env: Env
  /** The user's login-shell PATH, or null when it could not be captured. */
  loginShellPath(): Promise<string | null>
}

type Stored = Omit<LocalClaudeStatus, 'fixing' | 'lastFix'> & { preflight: HostPreflightResult; floor: ClaudeCliFloor | null }

let stored: Stored | undefined
let inFlight: Promise<LocalClaudeStatus | null> | null = null
let fixing: HostFixing | undefined
let lastFix: HostFixRecord | undefined
const listeners = new Set<() => void>()

function notify(): void {
  for (const cb of listeners) {
    try { cb() } catch { /* an observer must never break the probe */ }
  }
}

// ── The machine ──

/**
 * The daemon's factories, in this process, on the PATH the local daemon gives
 * a session (sessionPath: login-shell PATH, fallback dirs, inherited).
 */
async function inProcessRuntime(parts: LocalMachineParts) {
  const env: Env = { ...parts.env, PATH: sessionPath(await parts.loginShellPath(), parts.env) }
  const exec = execFile as unknown as NonNullable<HostRuntimeDeps['execFile']>
  const runtime = createHostRuntime({ fs, execFile: exec, env, platform: process.platform, arch: process.arch, claudeCheck: createClaudeCheck({ fs, execFile: exec, env }) })
  return { env, exec, runtime }
}

/** The machine: the local daemon when it is connected and new enough, else this process. */
export function createLocalClaudeIo(parts: LocalMachineParts): LocalClaudeIo {
  return {
    floor: configuredClaudeCliFloor,
    now: () => Date.now(),
    onDaemonConnected: parts.onDaemonConnected,
    async preflight(min) {
      const args = min ? { minClaudeVersion: min } : {}
      const conn = await parts.connection()
      if (conn?.hasCapability('preflight-v1')) {
        const reply = await conn.send('host.preflight', args, PREFLIGHT_TIMEOUT_MS)
        return { result: reply.ok ? parsePreflight(reply) : null, source: 'daemon', ...(reply.error ? { error: reply.error } : {}) }
      }
      const { runtime } = await inProcessRuntime(parts)
      return { result: parsePreflight(await runtime.preflight(args)), source: 'in-process' }
    },
    async fix(action, params) {
      const conn = await parts.connection()
      if (conn?.hasCapability('hostfix-v1')) return sendHostFix(conn, action, params)
      const { env, exec, runtime } = await inProcessRuntime(parts)
      const fixer = createHostFix({
        fs, execFile: exec, env, runtime,
        os: { platform: () => process.platform, tmpdir: () => os.tmpdir(), uid: () => (typeof process.getuid === 'function' ? process.getuid() : -1) },
        log: (level, msg, data) => { if (level === 'warn') log.session.warn(msg, data); else log.session.info(msg, data) },
      })
      return { result: await fixer.run(action, params) }
    },
  }
}

async function localConnection(): Promise<PreflightConnection | null> {
  try {
    const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js')
    return getConnectedDaemonConnection('__local__')
  } catch {
    return null
  }
}

function onLocalDaemonConnected(cb: () => void): () => void {
  let off: (() => void) | null = null
  let cancelled = false
  void import('../../providers/daemon-connection.js').then(({ addOnDaemonHostConnected }) => {
    if (cancelled) return
    off = addOnDaemonHostConnected((hostKey) => { if (hostKey === '__local__') cb() })
  }).catch(() => {})
  return () => { cancelled = true; off?.() }
}

/**
 * Captured once per process, like the daemon's own capture at startup. A
 * failed capture (a slow rc file at boot) is tried again after a minute
 * instead of pinning the fallback-first PATH for the process lifetime.
 */
const LOGIN_PATH_RETRY_MS = 60_000
let loginPath: { value: string | null; at: number } | undefined
let loginPathJob: Promise<string | null> | null = null

function cachedLoginShellPath(): Promise<string | null> {
  if (loginPath && (loginPath.value !== null || Date.now() - loginPath.at < LOGIN_PATH_RETRY_MS)) return Promise.resolve(loginPath.value)
  if (!loginPathJob) {
    loginPathJob = captureLoginShellPath(process.env, LOGIN_SHELL_TIMEOUT_MS).catch(() => null).then((value) => {
      loginPath = { value, at: Date.now() }
      loginPathJob = null
      return value
    })
  }
  return loginPathJob
}

const defaultIo: LocalClaudeIo = createLocalClaudeIo({
  connection: localConnection, onDaemonConnected: onLocalDaemonConnected, env: process.env, loginShellPath: cachedLoginShellPath,
})

let io: LocalClaudeIo = defaultIo

// ── State ──

/** The stored answer with the fix state merged in, as the banner reads it. */
export function getLocalClaude(): LocalClaudeStatus | undefined {
  if (!stored) return undefined
  const { preflight, floor: _floor, ...base } = stored
  const problems = withFixState(base.problems, preflight, fixing, lastFix ? [lastFix] : [])
  return {
    ...base, problems,
    ...(fixing ? { fixing } : {}),
    ...(lastFix ? { lastFix: { ...lastFix, ageMs: Math.max(0, io.now() - lastFix.finishedAt) } } : {}),
  }
}

function markFailed(message: string): void {
  if (!stored) return
  stored = { ...stored, checkedAt: io.now(), checkError: message.slice(0, 300) }
  notify()
}

/**
 * Ask this machine again. One probe at a time (a second caller shares it);
 * `maxAgeMs` answers from the stored result when it is that fresh (the
 * banner's 15s poll from several windows must not stack up probes).
 */
export function refreshLocalClaude(opts: { maxAgeMs?: number } = {}): Promise<LocalClaudeStatus | null> {
  if (stored && opts.maxAgeMs && io.now() - stored.checkedAt < opts.maxAgeMs) return Promise.resolve(getLocalClaude() ?? null)
  if (inFlight) return inFlight
  const job = (async (): Promise<LocalClaudeStatus | null> => {
    try {
      const floor = await io.floor()
      const answer = await io.preflight(floor?.minVersion)
      const parsed = answer.result ? applyClaudeFloor(answer.result, floor) : null
      if (!parsed) {
        log.session.warn('local claude check returned no usable answer', { error: answer.error, source: answer.source })
        markFailed(answer.error || 'no usable answer')
        return null
      }
      stored = {
        checkedAt: io.now(), claude: parsed.claude, source: answer.source, preflight: parsed, floor,
        problems: readinessProblems(parsed, { local: true, floorModel: floor?.model }),
      }
      log.session.info('local claude check', {
        source: answer.source, found: parsed.claude.found, version: parsed.claude.version, versionOk: parsed.claude.versionOk,
        auth: parsed.claude.auth, installMethod: parsed.claude.installMethod, problems: stored.problems.map((p) => p.kind),
      })
      notify()
      return getLocalClaude() ?? null
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.session.warn('local claude check failed', { error: message })
      markFailed(message)
      return null
    }
  })().finally(() => { if (inFlight === job) inFlight = null })
  inFlight = job
  return job
}

/**
 * The banner's one-click fix for one problem: install the native build, or
 * update it. Answers at once; the fix runs on, pushes its progress through the
 * change listeners, then re-checks. Sign-in has no fix.
 */
export function startLocalClaudeFix(kind: string): LocalFixStart {
  if (!stored) return { ok: false, error: 'not-checked' }
  if (!stored.problems.some((p) => p.kind === kind)) return { ok: false, error: 'no-such-problem' }
  const action = fixActionFor(kind, stored.preflight)
  if (!action) return { ok: false, error: 'no-fix' }
  if (fixing) return { ok: false, error: 'busy' }
  const started: HostFixing = { action, startedAt: io.now(), text: fixingText(action) }
  const params = action === 'update-claude' && stored.floor ? { minClaudeVersion: stored.floor.minVersion } : {}
  fixing = started
  log.session.info('local claude fix started', { action, problem: kind })
  notify()
  void (async () => {
    let outcome: FixOutcome
    try {
      outcome = await io.fix(action, params)
    } catch (err) {
      outcome = { result: null, daemonError: err instanceof Error ? err.message : String(err) }
    }
    const record = describeFixOutcome(action, outcome, io.now())
    const fields = { action, ok: record.ok, error: record.error, skipped: record.skipped, output: typeof outcome.result?.log === 'string' ? outcome.result.log : undefined }
    if (record.ok) log.session.info('local claude fix finished', fields)
    else log.session.warn('local claude fix finished', fields)
    lastFix = record
    if (fixing === started) fixing = undefined
    notify()
    // A probe that started before the fix ended describes the old machine.
    await inFlight?.catch(() => null)
    await refreshLocalClaude()
  })()
  return { ok: true, status: getLocalClaude()! }
}

/** The configured model changed: re-check only when its floor moved. */
export async function localClaudeConfigChanged(): Promise<void> {
  if (!stored) return
  const floor = await io.floor()
  if ((floor?.minVersion ?? null) !== (stored.floor?.minVersion ?? null)) void refreshLocalClaude()
}

/**
 * The local daemon connected: an answer this process gave itself (the daemon
 * was not up yet) is replaced by the daemon's, which is what sessions see.
 * Nothing is asked when nothing was asked before (a test server's opt-out).
 */
async function recheckThroughDaemon(): Promise<void> {
  await inFlight?.catch(() => null)
  if (!stored || stored.source === 'daemon') return
  await refreshLocalClaude()
}

/** Server wiring: `onChange` gets every new snapshot. Returns an unsubscribe. */
export function wireLocalClaude(opts: { onChange: (status: LocalClaudeStatus | undefined) => void; probeNow?: boolean }): () => void {
  const cb = () => opts.onChange(getLocalClaude())
  listeners.add(cb)
  const offDaemon = io.onDaemonConnected(() => { void recheckThroughDaemon() })
  if (opts.probeNow) void refreshLocalClaude()
  return () => { listeners.delete(cb); offDaemon() }
}

/** Test seam: replace the machine (partially), and forget every answer and fix. */
export function setLocalClaudeIo(next?: Partial<LocalClaudeIo>): void {
  io = next ? { ...defaultIo, ...next } : defaultIo
  stored = undefined
  inFlight = null
  fixing = undefined
  lastFix = undefined
}
