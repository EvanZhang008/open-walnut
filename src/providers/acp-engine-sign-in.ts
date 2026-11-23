/**
 * Signing an engine's CLI in on THIS host, and installing it here (capability
 * 'engine-sign-in-v1', daemon command `engine.signIn`). Host-local work, so the host's
 * daemon does it (the installer itself: acp-engine-install.ts); the server only asks
 * (core/agents/engine-sign-in.ts) and a person
 * pastes the code in Settings.
 *
 * Today one engine has it: Antigravity (`agy`). Facts read from agy 1.5.14 with no account:
 *   - `agy acp --login` prints "Open this link in a browser to log in with Google:", the
 *     link, then "...paste the authorization code, or the full URL of the page you land on,
 *     and press Enter:" and reads ONE line from stdin. A bad code exits 1 at once
 *     ("couldn't log in: token exchange failed: ..."), stdin closed exits 1 ("login
 *     cancelled"). With SSH_CONNECTION or AGY_ACP_FORCE_FILE_STORAGE set it keeps the
 *     sign-in in a file under ~/.gemini/antigravity-cli and never opens a browser; the env
 *     the server sends (the engine descriptor's, engine-registry.ts) sets both, as for sessions.
 *   - `agy acp` then ACP `authenticate {methodId: "oauth-personal"}` answers an error at once
 *     when there is no stored sign-in ("No browser is available here ... Run `agy acp
 *     --login`"): that is the status check, ~0.5 s, and it creates no session.
 *   - ACP initialize advertises `agentCapabilities.auth.logout`; `logout` answers {}.
 *
 * Only Walnut's own fixed argv runs here (ENGINE_SIGN_INS): no caller text reaches a
 * command line. The pasted code goes to the sign-in process's stdin and nowhere else (never
 * a log line, a file, or an answer: it is cut out of any output this file hands back).
 * One sign-in and one install per engine at a time; a sign-in no one finishes ends after
 * STALE_MS. Every process starts its own process group and every wait has a deadline.
 *
 * Compiled into acp-daemon.ts, which the daemon bundles; node builtins only.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { createEngineInstaller } from './acp-engine-install.js'

export type { InstallState } from './acp-engine-install.js'

export interface EngineSignInSpec {
  /** The engine's CLI (a bare name, found on this host's PATH) and the variable that may name its path instead. */
  binary: string
  overrideEnv: string
  /** argv after the engine's CLI that signs in: prints the link, reads the code. */
  loginArgs: readonly string[]
  /** argv after the CLI that runs its ACP server (the status check, the sign-out). */
  acpArgs: readonly string[]
  /** The ACP auth method the account sign-in is. */
  accountMethod: string
  /** The page the printed link must open, and the redirect it must carry. */
  link: { origin: string; pathPrefix: string; redirectUri: string }
  /** The engine's official installer, run as `curl -fsSL <url> | bash`. */
  installerUrl: string
  /** The variable an API key rides in (an alternative to the account sign-in). */
  apiKeyEnv: string
}

export const ENGINE_SIGN_INS: Readonly<Record<string, EngineSignInSpec>> = {
  antigravity: {
    binary: 'agy',
    overrideEnv: 'WALNUT_ANTIGRAVITY_PATH',
    loginArgs: ['acp', '--login'],
    acpArgs: ['acp'],
    accountMethod: 'oauth-personal',
    link: { origin: 'https://accounts.google.com', pathPrefix: '/o/oauth2/', redirectUri: 'https://antigravity.google/oauth-callback' },
    installerUrl: 'https://antigravity.google/cli/install.sh',
    apiKeyEnv: 'GEMINI_API_KEY',
  },
}

/** A pasted code (or the full URL the browser landed on) is at most this long. */
export const SIGN_IN_CODE_MAX = 4096
const LINK_WAIT_MS = 20_000
const FINISH_WAIT_MS = 60_000
export const STALE_MS = 10 * 60_000
const STATUS_TTL_MS = 30_000
const ACP_WAIT_MS = 15_000
const INSTALL_WAIT_MS = 5 * 60_000
const KILL_GRACE_MS = 2_000
const OUT_MAX = 16 * 1024

/** The sign-in link in `text` when it is the page `spec` names, else null (a link elsewhere is refused). */
export function signInLinkOf(text: string, spec: EngineSignInSpec): string | null {
  for (const m of String(text).matchAll(/https:\/\/[^\s"'<>]+/g)) {
    let url: URL
    try { url = new URL(m[0]) } catch { continue }
    if (url.origin !== spec.link.origin || !url.pathname.startsWith(spec.link.pathPrefix)) continue
    if (url.searchParams.get('redirect_uri') !== spec.link.redirectUri) return null
    return url.toString()
  }
  return null
}

/** The pasted code as it goes to stdin, or why it cannot: one line, trimmed, bounded, no control characters. */
export function signInCodeOf(raw: unknown): { code: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'the code must be text' }
  const code = raw.trim()
  if (!code) return { error: 'the code is empty' }
  if (code.length > SIGN_IN_CODE_MAX) return { error: `the code is longer than ${SIGN_IN_CODE_MAX} characters` }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(code)) return { error: 'the code must be one line' }
  return { code }
}

export interface FoundBinary { path?: string; reason?: string }

export interface EngineSignInDeps {
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess
  /** This host's env (the daemon's own); the server's env overlay merges over it. */
  env: NodeJS.ProcessEnv
  /** The engine's CLI on this host (acp-host-artifacts.ts findHostBinary). */
  findBinary: (spec: Pick<EngineSignInSpec, 'binary' | 'overrideEnv'>, env: NodeJS.ProcessEnv) => FoundBinary
  version: (binary: string, env: NodeJS.ProcessEnv) => Promise<string | null>
  /** The env the server's overlay makes (acp-worker/protocol.ts mergeAcpSpawnEnv). */
  mergeEnv: (base: NodeJS.ProcessEnv, overlay: Record<string, string> | undefined) => NodeJS.ProcessEnv
  /** The daemon's own dir: an install's record, output and exit code (acp-engine-install.ts). */
  stateDir: string
  /** After an install: drop what the host's engine probe cached. */
  onInstalled?: () => void
  log?: (level: string, msg: string, data?: Record<string, unknown>) => void
  now?: () => number
  /** Test seams. */
  waits?: Partial<{ link: number; finish: number; stale: number; statusTtl: number; acp: number; install: number }>
}

export type SignInView = { id: string; link: string; startedAt: number; expiresAt: number; phase: 'waiting_code' | 'checking' }

type StartAnswer = { ok: true; reused?: true } & SignInView | { ok: false; code: string; message: string }

interface Login {
  id: string
  engine: string
  link: string
  proc: ChildProcess
  startedAt: number
  /** 'starting' until its link shows: a second start waits for `ready` instead of spawning another. */
  phase: 'starting' | 'waiting_code' | 'checking'
  ready: Promise<StartAnswer>
  out: string
  exit: { code: number | null; signal: string | null } | null
  onExit: Array<() => void>
  staleTimer: ReturnType<typeof setTimeout>
  code?: string
}

type Fail = { ok: false; code: string; message: string }
const fail = (code: string, message: string): Fail => ({ ok: false, code, message })

function idOf(now: number): string {
  return `si-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Signal a whole process group, never pid 1 or below (-1 is every process this user may signal). */
function killGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  const pid = proc.pid
  if (!pid || pid <= 1) return
  try { process.kill(-pid, signal) } catch { try { proc.kill(signal) } catch { /* gone */ } }
}

function stop(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  killGroup(proc, 'SIGTERM')
  const hard = setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) killGroup(proc, 'SIGKILL') }, KILL_GRACE_MS)
  hard.unref?.()
}

/** The last line a process printed, the code cut out, bounded: the words a person reads about its failure. */
function lastWords(out: string, code?: string): string {
  const text = code ? out.split(code).join('[code]') : out
  const line = text.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
  return line.replace(/^Error:\s*/, '').slice(0, 300)
}

/** The folder Walnut's processes start in: HOME when it is there (a spawn in a missing cwd fails). */
function cwdOf(env: NodeJS.ProcessEnv): string | undefined {
  try { return env.HOME && fs.statSync(env.HOME).isDirectory() ? env.HOME : undefined } catch { return undefined }
}

export function createEngineSignIn(deps: EngineSignInDeps) {
  const now = deps.now ?? Date.now
  const wait = { link: LINK_WAIT_MS, finish: FINISH_WAIT_MS, stale: STALE_MS, statusTtl: STATUS_TTL_MS, acp: ACP_WAIT_MS, install: INSTALL_WAIT_MS, ...(deps.waits ?? {}) }
  const log = deps.log ?? (() => {})
  const logins = new Map<string, Login>()
  const installer = createEngineInstaller({
    spawn: deps.spawn, findBinary: deps.findBinary, version: deps.version, stateDir: deps.stateDir, waitMs: wait.install,
    onInstalled: deps.onInstalled, log, now,
  })
  const statusCache = new Map<string, { at: number; value: AccountCheck }>()
  const statusInFlight = new Map<string, Promise<AccountCheck>>()

  const view = (l: Login): SignInView => ({ id: l.id, link: l.link, startedAt: l.startedAt, expiresAt: l.startedAt + wait.stale, phase: l.phase === 'checking' ? 'checking' : 'waiting_code' })

  function end(l: Login, why: string): void {
    clearTimeout(l.staleTimer)
    if (logins.get(l.engine) === l) logins.delete(l.engine)
    if (!l.exit) stop(l.proc)
    log('info', 'engine sign-in ended', { engine: l.engine, id: l.id, why })
  }

  /**
   * Every stream of the child has an error listener: a write to a child that closed its stdin is
   * EPIPE, which with no listener is an uncaught exception that ends the whole daemon. The
   * child's own end (its 'close') says how it went.
   */
  function spawnIn(bin: string, args: readonly string[], env: NodeJS.ProcessEnv): ChildProcess {
    const proc = deps.spawn(bin, [...args], { env, cwd: cwdOf(env), detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    for (const stream of [proc.stdin, proc.stdout, proc.stderr]) stream?.on('error', (err: Error) => log('info', 'engine sign-in child stream error', { error: err.message }))
    return proc
  }

  function specOf(engine: unknown): EngineSignInSpec | null {
    return typeof engine === 'string' && Object.hasOwn(ENGINE_SIGN_INS, engine) ? ENGINE_SIGN_INS[engine] : null
  }

  // ── The account check and the sign-out: one short ACP conversation each ──

  type AccountCheck = { signedIn: boolean | null; detail?: string; canLogout?: boolean }

  /**
   * initialize, then `then(initializeResult, call)`; the process ends with the answer or at
   * the deadline. `call` sends one request and resolves its JSON-RPC answer.
   */
  function acpTalk<T>(bin: string, spec: EngineSignInSpec, env: NodeJS.ProcessEnv, then: (init: Record<string, unknown>, call: (method: string, params: unknown) => Promise<{ result?: unknown; error?: { message?: string } }>) => Promise<T>, onTimeout: T): Promise<T> {
    return new Promise((resolve) => {
      let proc: ChildProcess
      try { proc = spawnIn(bin, spec.acpArgs, env) } catch (err) { resolve(onTimeout); log('warn', 'engine acp check could not start', { error: String(err) }); return }
      let done = false
      const pending = new Map<number, (msg: { result?: unknown; error?: { message?: string } }) => void>()
      let nextId = 1
      let buf = ''
      const finish = (v: T) => { if (done) return; done = true; clearTimeout(timer); stop(proc); resolve(v) }
      const timer = setTimeout(() => finish(onTimeout), wait.acp)
      proc.on('error', () => finish(onTimeout))
      proc.on('exit', () => { for (const r of pending.values()) r({ error: { message: 'the ACP server exited' } }); pending.clear() })
      proc.stderr?.resume()
      proc.stdout?.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        if (buf.length > 1024 * 1024) buf = buf.slice(-OUT_MAX)
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
          let msg: { id?: unknown; result?: unknown; error?: { message?: string } }
          try { msg = JSON.parse(line) } catch { continue }
          const r = typeof msg.id === 'number' ? pending.get(msg.id) : undefined
          if (r) { pending.delete(msg.id as number); r(msg) }
        }
      })
      const call = (method: string, params: unknown) => new Promise<{ result?: unknown; error?: { message?: string } }>((res) => {
        const id = nextId++
        pending.set(id, res)
        try { proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') } catch { pending.delete(id); res({ error: { message: 'could not write to the ACP server' } }) }
      })
      call('initialize', { protocolVersion: 1, clientCapabilities: {} }).then(async (init) => {
        if (init.error || !init.result) return finish(onTimeout)
        finish(await then(init.result as Record<string, unknown>, call))
      }, () => finish(onTimeout))
    })
  }

  function canLogout(init: Record<string, unknown>): boolean {
    const caps = init.agentCapabilities as { auth?: { logout?: unknown } } | undefined
    return !!caps?.auth?.logout
  }

  function accountCheck(engine: string, spec: EngineSignInSpec, bin: string, env: NodeJS.ProcessEnv, fresh: boolean): Promise<AccountCheck> {
    const hit = statusCache.get(engine)
    if (!fresh && hit && now() - hit.at < wait.statusTtl) return Promise.resolve(hit.value)
    const running = statusInFlight.get(engine)
    if (running) return running
    const work = acpTalk<AccountCheck>(bin, spec, env, async (init, call) => {
      const methods = Array.isArray(init.authMethods) ? init.authMethods.map((m) => (m as { id?: unknown })?.id) : []
      if (!methods.includes(spec.accountMethod)) return { signedIn: null, detail: `${spec.accountMethod} is not a sign-in this CLI offers`, canLogout: canLogout(init) }
      const answer = await call('authenticate', { methodId: spec.accountMethod })
      return answer.error
        ? { signedIn: false, detail: String(answer.error.message ?? '').slice(0, 300), canLogout: canLogout(init) }
        : { signedIn: true, canLogout: canLogout(init) }
    }, { signedIn: null, detail: 'the sign-in check did not answer in time' }).then((value) => {
      if (value.signedIn !== null) statusCache.set(engine, { at: now(), value })
      return value
    }).finally(() => statusInFlight.delete(engine))
    statusInFlight.set(engine, work)
    return work
  }

  // ── The ops ──

  async function status(p: { engine?: unknown; env?: Record<string, string>; fresh?: unknown }) {
    const spec = specOf(p.engine)
    if (!spec) return fail('unknown_engine', `${String(p.engine)} has no sign-in here`)
    const engine = p.engine as string
    const env = deps.mergeEnv(deps.env, p.env)
    const found = deps.findBinary(spec, env)
    const login = logins.get(engine)
    const base = {
      ok: true as const,
      apiKeyInHostEnv: !!deps.env[spec.apiKeyEnv],
      signIn: login && login.phase !== 'starting' ? view(login) : null,
      install: await installer.status(engine, spec, env),
    }
    if (!found.path) return { ...base, installed: false, version: null, reason: found.reason ?? 'not installed', account: null }
    const [version, account] = await Promise.all([deps.version(found.path, env), accountCheck(engine, spec, found.path, env, p.fresh === true)])
    return { ...base, installed: true, version, path: found.path, reason: null, account }
  }

  async function start(p: { engine?: unknown; env?: Record<string, string>; restart?: unknown }): Promise<StartAnswer> {
    const spec = specOf(p.engine)
    if (!spec) return fail('unknown_engine', `${String(p.engine)} has no sign-in here`)
    const engine = p.engine as string
    const env = deps.mergeEnv(deps.env, p.env)
    if (await installer.running(engine, spec, env)) return fail('busy', 'an install runs on this host; sign in once it ends')
    const running = logins.get(engine)
    if (running) {
      if (running.phase === 'checking') return fail('busy', 'a code is being checked on this host')
      if (p.restart !== true) {
        // One sign-in per host: a start while one starts or waits is that one.
        const r = running.phase === 'starting' ? await running.ready : { ok: true as const, ...view(running) }
        return r.ok ? { ...r, reused: true as const } : r
      }
      end(running, 'restarted')
    }
    const found = deps.findBinary(spec, env)
    if (!found.path) return fail('not_installed', found.reason ?? 'not installed')
    let proc: ChildProcess
    try { proc = spawnIn(found.path, spec.loginArgs, env) } catch (err) { return fail('failed', `the sign-in could not start: ${(err as Error).message}`) }
    const startedAt = now()
    const l: Login = {
      id: idOf(startedAt), engine, link: '', proc, startedAt, phase: 'starting', ready: Promise.resolve(fail('failed', 'starting')),
      out: '', exit: null, onExit: [], staleTimer: setTimeout(() => end(l, 'stale'), wait.stale),
    }
    l.staleTimer.unref?.()
    // In the map before any wait: a second start finds this one.
    logins.set(engine, l)
    const take = (chunk: Buffer) => { l.out = (l.out + chunk.toString('utf8')).slice(-OUT_MAX) }
    proc.stdout?.on('data', take)
    proc.stderr?.on('data', take)
    // 'close', not 'exit': the last words are read by then.
    proc.on('close', (code, signal) => {
      l.exit = { code, signal }
      clearTimeout(l.staleTimer)
      if (logins.get(engine) === l && l.phase !== 'checking') logins.delete(engine)
      for (const f of l.onExit.splice(0)) f()
    })
    proc.on('error', (err) => { l.out += `\n${err.message}`; if (!l.exit) { l.exit = { code: -1, signal: null }; for (const f of l.onExit.splice(0)) f() } })
    l.ready = (async (): Promise<StartAnswer> => {
      // The link and the prompt after it, or the process's end, or the deadline.
      const link = await new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), wait.link)
        const look = () => {
          if (/press Enter/i.test(l.out) || l.exit) { clearTimeout(timer); proc.stdout?.off('data', look); resolve(signInLinkOf(l.out, spec)) }
        }
        proc.stdout?.on('data', look)
        l.onExit.push(look)
        look()
      })
      if (!link) {
        const exited = l.exit
        end(l, 'no link')
        if (exited) return fail('failed', `the sign-in ended before it showed a link: ${lastWords(l.out) || `exit ${exited.code}`}`)
        if (/https:\/\//.test(l.out)) return fail('bad_link', 'the sign-in showed a link that is not the expected Google sign-in page, so Walnut did not open it')
        return fail('timeout', 'the sign-in did not show its link in time')
      }
      // Cancelled or replaced while it started: not the host's sign-in any more.
      if (logins.get(engine) !== l) return fail('failed', 'the sign-in was cancelled before it showed its link')
      l.link = link
      l.phase = 'waiting_code'
      log('info', 'engine sign-in started', { engine, id: l.id })
      return { ok: true as const, ...view(l) }
    })()
    return l.ready
  }

  async function finish(p: { engine?: unknown; signInId?: unknown; code?: unknown }) {
    const spec = specOf(p.engine)
    if (!spec) return fail('unknown_engine', `${String(p.engine)} has no sign-in here`)
    const engine = p.engine as string
    const l = logins.get(engine)
    if (!l || l.id !== p.signInId || l.phase === 'starting') return fail('no_sign_in', 'this sign-in is no longer running: start it again')
    if (l.phase === 'checking') return fail('busy', 'this code is already being checked')
    const parsed = signInCodeOf(p.code)
    if ('error' in parsed) return fail('invalid_code', parsed.error)
    l.phase = 'checking'
    l.code = parsed.code
    const before = l.out.length
    const exited = new Promise<void>((resolve) => { if (l.exit) resolve(); else l.onExit.push(resolve) })
    try {
      l.proc.stdin?.write(parsed.code + '\n')
      l.proc.stdin?.end()
    } catch {
      end(l, 'stdin closed')
      return fail('failed', 'the sign-in process stopped reading: start it again')
    }
    const timedOut = await Promise.race([exited.then(() => false), new Promise<boolean>((r) => { const t = setTimeout(() => r(true), wait.finish); t.unref?.() })])
    const words = lastWords(l.out.slice(before), parsed.code)
    l.code = undefined
    end(l, timedOut ? 'timeout' : `exit ${l.exit?.code}`)
    statusCache.delete(engine)
    if (timedOut) return fail('timeout', 'the sign-in did not finish in time: start it again')
    if (l.exit?.code === 0) return { ok: true as const, signedIn: true }
    return fail('bad_code', words || `the sign-in was refused (exit ${l.exit?.code ?? l.exit?.signal})`)
  }

  function cancel(p: { engine?: unknown; signInId?: unknown }) {
    const l = typeof p.engine === 'string' ? logins.get(p.engine) : undefined
    if (!l || (p.signInId !== undefined && l.id !== p.signInId)) return { ok: true as const, cancelled: false }
    end(l, 'cancelled')
    return { ok: true as const, cancelled: true }
  }

  async function logout(p: { engine?: unknown; env?: Record<string, string> }) {
    const spec = specOf(p.engine)
    if (!spec) return fail('unknown_engine', `${String(p.engine)} has no sign-in here`)
    const engine = p.engine as string
    const env = deps.mergeEnv(deps.env, p.env)
    const found = deps.findBinary(spec, env)
    if (!found.path) return fail('not_installed', found.reason ?? 'not installed')
    const r = await acpTalk<{ ok: boolean; code?: string; message?: string }>(found.path, spec, env, async (init, call) => {
      if (!canLogout(init)) return { ok: false, code: 'unsupported', message: 'this CLI has no sign-out' }
      const answer = await call('logout', {})
      return answer.error ? { ok: false, code: 'failed', message: String(answer.error.message ?? '').slice(0, 300) } : { ok: true }
    }, { ok: false, code: 'timeout', message: 'the sign-out did not answer in time' })
    statusCache.delete(engine)
    return r.ok ? { ok: true as const } : fail(r.code ?? 'failed', r.message ?? 'the sign-out failed')
  }

  /** Starts the official installer (acp-engine-install.ts); `installStatus` reads how it goes. */
  async function install(p: { engine?: unknown; env?: Record<string, string> }) {
    const spec = specOf(p.engine)
    if (!spec) return fail('unknown_engine', `${String(p.engine)} has no installer here`)
    if (logins.get(p.engine as string)) return fail('busy', 'a sign-in runs on this host; install once it ends')
    return installer.install(p.engine as string, spec, deps.mergeEnv(deps.env, p.env))
  }

  async function installStatus(p: { engine?: unknown; env?: Record<string, string> }) {
    const spec = specOf(p.engine)
    if (!spec) return fail('unknown_engine', `${String(p.engine)} has no installer here`)
    return { ok: true as const, ...await installer.status(p.engine as string, spec, deps.mergeEnv(deps.env, p.env)) }
  }

  // No stop-all on the daemon's stop: a sign-in reads its code from a pipe this daemon holds, so
  // it ends by itself when the daemon goes (agy answers EOF with "login cancelled", exit 1).

  /** One daemon command, `op` naming what to do; a sign-in is named by `signInId` (the frame's own `id` is the RPC's). */
  async function handle(cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
    const env = cmd.env && typeof cmd.env === 'object' && !Array.isArray(cmd.env) ? cmd.env as Record<string, string> : undefined
    const p: { engine?: unknown; signInId?: unknown; code?: unknown; restart?: unknown; fresh?: unknown; env?: Record<string, string> } = { ...cmd, env }
    switch (cmd.op) {
      case 'status': return status(p)
      case 'start': return start(p)
      case 'finish': return finish(p)
      case 'cancel': return cancel(p)
      case 'logout': return logout(p)
      case 'install': return install(p)
      case 'installStatus': return installStatus(p)
      default: return fail('unknown_op', `engine.signIn has no op ${String(cmd.op)}`)
    }
  }

  return { handle, status, start, finish, cancel, logout, install, installStatus }
}

export type EngineSignIn = ReturnType<typeof createEngineSignIn>
