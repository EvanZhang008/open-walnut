/**
 * The pure half of host readiness: the daemon's host.preflight answer read
 * defensively, and turned into one actionable line per thing to fix. Shared by
 * remote hosts (host-readiness.ts, Settings › Remote hosts) and the machine
 * Walnut runs on (local-readiness.ts, the setup banner), which differ only in
 * wording: a remote line names the host and the ssh command that reaches it.
 */

import { HOST_RUNTIME_MESSAGES, type HostPreflightResult } from '../../providers/host-runtime-core.js'
import type { HostFixAction } from '../../providers/host-fix-core.js'
import { claudeVersionAtLeast, type ClaudeCliFloor } from './claude-version-floor.js'

export type ReadinessProblemKind =
  | 'claude_missing' | 'claude_needs_node' | 'claude_error' | 'claude_outdated' | 'claude_not_logged_in'
  | 'compiler_missing' | 'dtach_missing'
  // From the connect itself, not the preflight (host-status.ts connectReadinessProblems).
  | 'daemon_dir_fallback' | 'disk_low'

export interface ReadinessProblem {
  kind: ReadinessProblemKind
  /** One sentence a user can act on. A command inside it is in `backticks`. */
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

export interface ProblemContext {
  /** The server ships a dtach that runs there, so no compiler is needed. */
  prebuiltDtach?: boolean
  /** The machine Walnut runs on (the setup banner), not a remote host. */
  local?: boolean
  /** The remote host's display name. */
  hostLabel?: string
  /** What follows `ssh` to reach the host, as the user types it ("-p 2222 dev@devbox"). */
  sshTarget?: string
  /** The model the version floor comes from ("Opus 5.5"). */
  floorModel?: string
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {})
const VERSION = /^\d+\.\d+\.\d+$/
const AUTH_STATES = ['ok', 'not-logged-in', 'unknown'] as const
const INSTALL_METHODS = ['native', 'npm', 'homebrew', 'other'] as const

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? v as T : undefined
}

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
  const auth = oneOf(c.auth, AUTH_STATES)
  if (auth) claude.auth = auth
  if (str(c.authDetail)) claude.authDetail = str(c.authDetail)!.slice(0, 160)
  if (typeof c.versionOk === 'boolean') claude.versionOk = c.versionOk
  if (str(c.minVersion) && VERSION.test(str(c.minVersion)!)) claude.minVersion = str(c.minVersion)
  const installMethod = oneOf(c.installMethod, INSTALL_METHODS)
  if (installMethod) claude.installMethod = installMethod
  if (!claude.found && str(c.unknown)) claude.unknown = str(c.unknown)!.slice(0, 160)
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
 * A daemon from before the floor check (no `versionOk`) still reports its
 * version, so the server compares it itself. A daemon's own answer wins.
 */
export function applyClaudeFloor(p: HostPreflightResult, floor: ClaudeCliFloor | null): HostPreflightResult {
  if (!floor || !p.claude.found || typeof p.claude.versionOk === 'boolean') return p
  const ok = claudeVersionAtLeast(p.claude.version, floor.minVersion)
  return ok === null ? p : { ...p, claude: { ...p.claude, versionOk: ok, minVersion: floor.minVersion } }
}

/**
 * What a sentence calls the machine: 'this computer' locally, else the host's
 * label (every remote sentence names its host, so no surface ever prefixes it).
 */
export function hostWhere(ctx: ProblemContext): string {
  if (ctx.local) return 'this computer'
  const bare = ctx.sshTarget?.trim().split(/\s+/).pop()?.replace(/^[^@]*@/, '')
  return ctx.hostLabel?.trim() || bare || 'the remote host'
}

/** The claude_missing sentence. The daemon's spawn gate words its refusal with this exact builder. */
export function claudeMissingMessage(ctx: ProblemContext = {}): string {
  return `Claude Code is not installed on ${hostWhere(ctx)}.`
}

/** The claude_needs_node sentence (also the spawn gate's). */
export function claudeNeedsNodeMessage(ctx: ProblemContext = {}): string {
  return `Claude Code on ${hostWhere(ctx)} is the npm build and no working Node.js was found. Install the native build, which needs no Node.`
}

function outdatedProblem(c: HostPreflightResult['claude'], ctx: ProblemContext): ReadinessProblem {
  const where = hostWhere(ctx)
  const who = ctx.floorModel ?? 'Walnut'
  const base = `Claude Code on ${where} is ${c.version ?? 'too old'}, but ${who} needs ${c.minVersion ?? 'a newer one'} or newer.`
  const method = c.installMethod ?? (c.kind === 'npm' ? 'npm' : c.kind === 'native' ? 'native' : 'other')
  if (method === 'npm') {
    return { kind: 'claude_outdated', message: `${base} It is the npm build: the native build replaces it and keeps itself up to date.`, commands: [HOST_RUNTIME_MESSAGES.install] }
  }
  if (method === 'native') return { kind: 'claude_outdated', message: base, commands: ['claude update'] }
  if (method === 'homebrew') return { kind: 'claude_outdated', message: base, commands: ['brew upgrade claude-code'] }
  const at = c.path ? ` (${c.path})` : ''
  return { kind: 'claude_outdated', message: `${base} It was not installed by the native installer, so update it the way it was installed${at}.`, commands: [] }
}

function signInProblem(ctx: ProblemContext): ReadinessProblem {
  if (ctx.local) {
    return { kind: 'claude_not_logged_in', message: 'Claude Code is not signed in. Run `claude` once in a terminal and sign in.', commands: ['claude'] }
  }
  if (ctx.sshTarget) {
    // -t: `ssh host claude` gets no terminal, and the sign-in screen needs one.
    const command = `ssh -t ${ctx.sshTarget} claude`
    return {
      kind: 'claude_not_logged_in',
      message: `Claude Code on ${hostWhere(ctx)} is not signed in. Run \`${command}\` once and sign in, then Check again.`,
      commands: [command],
    }
  }
  const where = hostWhere(ctx)
  return {
    kind: 'claude_not_logged_in',
    message: `Claude Code on ${where} is not signed in. Run \`claude\` on ${where} once and sign in, then Check again.`,
    commands: ['claude'],
  }
}

/** One line per thing the user must fix. Nothing when the host is fine. */
export function readinessProblems(p: HostPreflightResult, ctx: ProblemContext = {}): ReadinessProblem[] {
  const install = HOST_RUNTIME_MESSAGES.install
  const out: ReadinessProblem[] = []
  // The probe could not tell (the login shell or shell_setup ran out of time):
  // saying "not installed" would hard-block a host whose sessions start fine.
  if (p.claude.unknown) {
    // no claude line
  } else if (!p.claude.found) {
    out.push({ kind: 'claude_missing', message: claudeMissingMessage(ctx), commands: [install] })
  } else if (p.claude.needsNode && p.claude.nodeFound === false) {
    out.push({ kind: 'claude_needs_node', message: claudeNeedsNodeMessage(ctx), commands: [install] })
  } else if (p.claude.error) {
    const on = ctx.local ? '' : ` on ${hostWhere(ctx)}`
    out.push({ kind: 'claude_error', message: `Claude Code did not start${on}: ${p.claude.error}`, commands: [install] })
  } else {
    // Both can hold at once: an old CLI signs in just fine, so neither hides the other.
    if (p.claude.versionOk === false) out.push(outdatedProblem(p.claude, ctx))
    if (p.claude.auth === 'not-logged-in') out.push(signInProblem(ctx))
  }
  if (ctx.local) return out
  // A compiler only matters while dtach is missing: Walnut builds dtach from
  // source, and dtach is what keeps a terminal alive across disconnects. A
  // shipped prebuilt for the host's platform/arch needs no compiler at all.
  if (!p.compiler.found && !p.dtach.found && ctx.prebuiltDtach) {
    // The compiler line is moot, but dtach is still missing: a host whose
    // prebuilt turns out not to run must never read as healthy. The autofix
    // installs the prebuilt (or learns it fails and asks for gcc instead).
    out.push({
      kind: 'dtach_missing',
      message: `dtach is not installed on ${hostWhere(ctx)} yet, so its terminals will not survive a disconnect until Walnut installs it.`,
      commands: [],
    })
  } else if (!p.compiler.found && !p.dtach.found) {
    out.push({
      kind: 'compiler_missing',
      message: `No C compiler on ${hostWhere(ctx)}, so its terminals will not survive a disconnect.`,
      // A Mac's compiler comes with the Command Line Tools, never from yum/apt.
      commands: p.platform === 'darwin' ? ['xcode-select --install'] : ['sudo yum install -y gcc', 'sudo apt-get install -y gcc'],
    })
  }
  return out
}
