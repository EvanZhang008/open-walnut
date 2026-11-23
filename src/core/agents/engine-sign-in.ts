/**
 * An engine CLI's own sign-in, per host (Settings > Sessions, "Antigravity sign-in"): is it
 * installed there, is it signed in and how, sign it in with the account's link and pasted
 * code, sign it out, install it. The host's daemon does every step on that host
 * (providers/acp-engine-sign-in.ts, `engine.signIn`); this file only asks it, with a deadline,
 * and adds what this server knows (the API key in Settings, the host's name).
 *
 * Who may: whoever may change Walnut's settings. An agent calls the same routes (a person
 * still opens the link and pastes the code); nothing here borrows a task's host_exec grant,
 * and no caller text reaches a command line: the daemon runs only its own fixed argv.
 *
 * The API key is `engines.<id>.env.<apiKeyEnv>` in config.yaml (masked in every config view,
 * config-redact.ts), the overlay every session of that engine on every host gets; with it set,
 * the worker signs in with the key first (engine-registry.ts auth plan).
 */
import { ENGINE_SIGN_INS, type EngineSignInSpec, type InstallState, type SignInView } from '../../providers/acp-engine-sign-in.js'
import { ENGINE_REGISTRY, engineCaps } from './engine-registry.js'
import type { SessionEngine } from '../types.js'
import { descriptorAdapterEnv } from '../../providers/acp-worker/adapter-env.js'
import { hostDisplayName } from '../hosts/host-display-name.js'
import { notSignedInSentence } from './engine-sign-in-words.js'
import { log } from '../../logging/index.js'

export const ENGINE_SIGN_IN_CAPABILITY = 'engine-sign-in-v1'
const LOCAL_HOST = '__local__'

/** How long each ask may take, beyond what the daemon itself allows its step (acp-engine-sign-in.ts). */
const DEADLINE_MS = { link: 15_000, status: 25_000, start: 30_000, finish: 75_000, quick: 15_000 } as const
export const API_KEY_MAX = 512

export class EngineSignInError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
    this.name = 'EngineSignInError'
  }
}

export function engineSignInSpec(engine: string): EngineSignInSpec | null {
  return Object.hasOwn(ENGINE_SIGN_INS, engine) && ENGINE_REGISTRY.has(engine as SessionEngine) ? ENGINE_SIGN_INS[engine] : null
}

function specOrThrow(engine: string): EngineSignInSpec {
  const spec = engineSignInSpec(engine)
  if (!spec) throw new EngineSignInError(`engine '${engine}' has no sign-in`, 404, 'unknown_engine')
  return spec
}

/** The name a person knows `host` by in a sentence ("this Mac" for this machine). */
export function signInHostName(host: string, config?: { hosts?: Record<string, unknown> }): string {
  if (!host || host === LOCAL_HOST) return process.platform === 'darwin' ? 'this Mac' : 'this computer'
  const def = config?.hosts && Object.hasOwn(config.hosts, host) ? config.hosts[host] as { label?: unknown } | undefined : undefined
  return hostDisplayName(host, def?.label)
}

/** The words a session that is not signed in shows; the chat reads them back (engine-sign-in-words.ts) for its link to Settings. */
export function notSignedInWords(engine: SessionEngine, hostName: string): string {
  return notSignedInSentence(engine, hostName)
}

function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new EngineSignInError(`${what} did not answer within ${Math.round(ms / 1000)}s`, 504, 'host_unreachable')), ms)
    timer.unref?.()
    p.then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
  })
}

async function configNow(): Promise<Record<string, unknown>> {
  const { getConfig } = await import('../config-manager.js')
  return await getConfig() as unknown as Record<string, unknown>
}

/** What every process of the engine gets: its descriptor's variables under the operator's overlay, as a session's. */
async function processEnv(engine: SessionEngine, config: Record<string, unknown>): Promise<Record<string, string>> {
  const { engineEnvOverlayFromConfig } = await import('../../providers/acp-session.js')
  return { ...(descriptorAdapterEnv(engineCaps(engine).acpAdapter) ?? {}), ...(engineEnvOverlayFromConfig(config, engine) ?? {}) }
}

function apiKeyOf(config: Record<string, unknown>, engine: string, spec: EngineSignInSpec): string {
  const env = (config.engines as Record<string, { env?: Record<string, unknown> } | undefined> | undefined)?.[engine]?.env
  const v = env?.[spec.apiKeyEnv]
  return typeof v === 'string' ? v : ''
}

/**
 * One `engine.signIn` op on `host`'s daemon; its `result`, or an EngineSignInError a route answers as it is.
 * `dial: false` asks only a link already open (this machine's own daemon always is): code 'not_connected' else.
 */
async function ask(host: string, op: string, params: Record<string, unknown>, ms: number, opts: { dial?: boolean } = {}): Promise<Record<string, unknown>> {
  const name = signInHostName(host, await configNow() as { hosts?: Record<string, unknown> })
  const { link, UnknownHostError } = await import('../hosts/link.js')
  let conn: Awaited<ReturnType<typeof link>>
  if (opts.dial === false && host !== LOCAL_HOST) {
    const open = (await import('../../providers/daemon-connection.js')).getConnectedDaemonConnection(host)
    if (!open) throw new EngineSignInError(`${name} is not connected now; open it to check`, 409, 'not_connected')
    conn = open
  } else {
    try {
      conn = await withDeadline(link(host), DEADLINE_MS.link, `the daemon on ${name}`)
    } catch (err) {
      if (err instanceof EngineSignInError) throw err
      if (err instanceof UnknownHostError) throw new EngineSignInError(`unknown host '${host}'`, 400, 'unknown_host')
      throw new EngineSignInError(`could not reach ${name}: ${err instanceof Error ? err.message : String(err)}`, 502, 'host_unreachable')
    }
  }
  if (!conn.hasCapability(ENGINE_SIGN_IN_CAPABILITY)) {
    throw new EngineSignInError(`the Walnut daemon on ${name} is older than this Walnut and cannot sign engines in; it updates on its next connect`, 501, 'daemon_needs_upgrade')
  }
  const resp = await withDeadline(conn.send('engine.signIn', { op, ...params }, ms), ms + 2_000, `the daemon on ${name}`)
  if (!resp.ok) throw new EngineSignInError(String((resp as { error?: unknown }).error ?? 'the daemon refused'), 502, 'daemon_error')
  const result = (resp as { result?: unknown }).result
  if (!result || typeof result !== 'object') throw new EngineSignInError('the daemon gave no answer', 502, 'daemon_error')
  return result as Record<string, unknown>
}

/** A daemon answer `{ok:false, code, message}` as the error a route answers. */
function refused(r: Record<string, unknown>): EngineSignInError | null {
  if (r.ok !== false) return null
  const code = String(r.code ?? 'failed')
  const status = code === 'timeout' ? 504 : code === 'busy' || code === 'installed' ? 409 : code === 'not_installed' ? 412 : ['invalid_code', 'bad_code', 'no_sign_in'].includes(code) ? 400 : 502
  return new EngineSignInError(String(r.message ?? code), status, code)
}

export type SignInState = 'signed_in' | 'not_signed_in' | 'not_installed' | 'unknown'

export interface EngineSignInStatus {
  engine: string
  host: string
  /** The host as a person knows it ("this Mac", a label, its alias). */
  hostName: string
  state: SignInState
  /** null: the host did not say. */
  installed: boolean | null
  version: string | null
  /** Why the state is what it is, in words (not installed, the host did not answer, ...). */
  reason: string | null
  /** What its sessions on that host sign in with now: the API key wins over the account. */
  method: 'google' | 'api-key' | null
  /** The CLI's own account sign-in on that host; null when the check could not tell. */
  google: boolean | null
  apiKey: { set: boolean; source: 'settings' | 'host-env' | null }
  /** A sign-in waiting for its code on that host. */
  signIn: SignInView | null
  install: InstallState & { command: string; canInstall: boolean }
  /** The daemon there must update before it can do any of this. */
  needsDaemonUpdate?: boolean
  /** false: the host had no open link and was not dialled (the hosts list); asking that one host alone dials it. */
  connected?: boolean
  checkedAt: string
}

/**
 * The engine's CLI on `host` (null: every host) reads signed in or not: messages its sessions
 * parked for want of the sign-in go out once it is (sessions/agent-wait-resend.ts). `confirmed`:
 * a person's own step, which sends them even when a status read already said signed in.
 */
function noteSignedIn(engine: string, host: string | null, signedIn: boolean, confirmed = false): void {
  void import('../sessions/agent-wait-resend.js')
    .then((m) => m.noteEngineSignedIn(engine, host, signedIn, { confirmed }))
    .catch((err) => log.web.warn('engine sign-in: sending the messages that waited failed', { engine, host, error: err instanceof Error ? err.message : String(err) }))
}

function installLine(spec: EngineSignInSpec): string {
  return `curl -fsSL ${spec.installerUrl} | bash`
}

/** `host`'s status; never throws for a host that does not answer (state 'unknown', the reason says why). */
export async function engineSignInStatus(engine: string, host: string, opts: { fresh?: boolean; dial?: boolean } = {}): Promise<EngineSignInStatus> {
  const spec = specOrThrow(engine)
  const config = await configNow()
  const hostName = signInHostName(host, config as { hosts?: Record<string, unknown> })
  const settingsKey = !!apiKeyOf(config, engine, spec)
  const base: EngineSignInStatus = {
    engine, host, hostName, state: 'unknown', installed: null, version: null, reason: null, method: settingsKey ? 'api-key' : null,
    google: null, apiKey: { set: settingsKey, source: settingsKey ? 'settings' : null }, signIn: null,
    install: { state: 'idle', command: installLine(spec), canInstall: false }, checkedAt: new Date().toISOString(),
  }
  let r: Record<string, unknown>
  try {
    r = await ask(host, 'status', { engine, env: await processEnv(engine as SessionEngine, config), ...(opts.fresh ? { fresh: true } : {}) }, DEADLINE_MS.status, { dial: opts.dial })
  } catch (err) {
    const e = err instanceof EngineSignInError ? err : null
    if (e?.code === 'unknown_host') throw e
    return {
      ...base, reason: err instanceof Error ? err.message : String(err),
      ...(e?.code === 'daemon_needs_upgrade' ? { needsDaemonUpdate: true } : {}), ...(e?.code === 'not_connected' ? { connected: false } : {}),
    }
  }
  const no = refused(r)
  if (no) return { ...base, reason: no.message }
  const install = { ...(r.install as InstallState | undefined ?? { state: 'idle' as const }), command: installLine(spec), canInstall: r.installed !== true }
  const hostKey = r.apiKeyInHostEnv === true && !settingsKey
  const apiKey = settingsKey ? base.apiKey : hostKey ? { set: true, source: 'host-env' as const } : base.apiKey
  if (r.installed !== true) {
    return { ...base, apiKey, install, installed: false, state: 'not_installed', reason: String(r.reason ?? 'not installed') }
  }
  const account = (r.account ?? null) as { signedIn?: boolean | null; detail?: string } | null
  const google = typeof account?.signedIn === 'boolean' ? account.signedIn : null
  const method = apiKey.set ? 'api-key' as const : google ? 'google' as const : null
  if (method || google === false) noteSignedIn(engine, host, !!method)
  return {
    ...base, apiKey, install, installed: true, version: typeof r.version === 'string' ? r.version : null, google, method,
    signIn: (r.signIn ?? null) as SignInView | null,
    state: method ? 'signed_in' : google === false ? 'not_signed_in' : 'unknown',
    reason: method ? null : account?.detail ? String(account.detail) : null,
  }
}

/**
 * Every host Walnut knows, this machine first, each within its own deadline. Opening Settings
 * dials nothing: a host with no open link reads `connected: false` until its own row is asked.
 */
export async function engineSignInHosts(engine: string): Promise<EngineSignInStatus[]> {
  specOrThrow(engine)
  const config = await configNow()
  const { pickableHosts } = await import('../hosts/joined-twins.js')
  // The hosts a person picks from elsewhere too: enabled, each machine once.
  const hosts = [LOCAL_HOST, ...pickableHosts((config.hosts ?? {}) as Record<string, { enabled?: unknown }>, config.net).map(([alias]) => alias)]
  return Promise.all(hosts.map((h) => engineSignInStatus(engine, h, { dial: false }).catch((err) => ({
    engine, host: h, hostName: signInHostName(h, config as { hosts?: Record<string, unknown> }), state: 'unknown' as const, installed: null, version: null,
    reason: err instanceof Error ? err.message : String(err), method: null, google: null, apiKey: { set: false, source: null }, signIn: null,
    install: { state: 'idle' as const, command: installLine(engineSignInSpec(engine)!), canInstall: false }, checkedAt: new Date().toISOString(),
  }))))
}

export async function startEngineSignIn(engine: string, host: string, opts: { restart?: boolean } = {}): Promise<SignInView & { host: string; reused?: boolean }> {
  specOrThrow(engine)
  const config = await configNow()
  const r = await ask(host, 'start', { engine, env: await processEnv(engine as SessionEngine, config), ...(opts.restart ? { restart: true } : {}) }, DEADLINE_MS.start)
  const no = refused(r)
  if (no) throw no
  log.web.info('engine sign-in link handed out', { engine, host, id: r.id, reused: r.reused === true })
  return { host, id: String(r.id), link: String(r.link), startedAt: Number(r.startedAt), expiresAt: Number(r.expiresAt), phase: r.phase as SignInView['phase'], ...(r.reused === true ? { reused: true } : {}) }
}

/** Writes the pasted code to the sign-in waiting on `host`; the code is never logged. */
export async function finishEngineSignIn(engine: string, host: string, id: string, code: unknown): Promise<EngineSignInStatus> {
  specOrThrow(engine)
  const r = await ask(host, 'finish', { engine, signInId: id, code }, DEADLINE_MS.finish)
  const no = refused(r)
  if (no) {
    log.web.info('engine sign-in not finished', { engine, host, id, code: no.code })
    throw no
  }
  log.web.info('engine signed in', { engine, host, id })
  forgetEngineAvailability(engine, host)
  noteSignedIn(engine, host, true, true)
  return engineSignInStatus(engine, host, { fresh: true })
}

export async function cancelEngineSignIn(engine: string, host: string, id?: string): Promise<{ cancelled: boolean }> {
  specOrThrow(engine)
  const r = await ask(host, 'cancel', { engine, ...(id ? { signInId: id } : {}) }, DEADLINE_MS.quick)
  return { cancelled: r.cancelled === true }
}

/** Signs the CLI's account out on `host` (its own ACP logout). */
export async function signOutEngine(engine: string, host: string): Promise<EngineSignInStatus> {
  specOrThrow(engine)
  const config = await configNow()
  const r = await ask(host, 'logout', { engine, env: await processEnv(engine as SessionEngine, config) }, DEADLINE_MS.status)
  const no = refused(r)
  if (no) throw no
  log.web.info('engine signed out', { engine, host })
  return engineSignInStatus(engine, host, { fresh: true })
}

export async function startEngineInstall(engine: string, host: string): Promise<InstallState> {
  specOrThrow(engine)
  const config = await configNow()
  const r = await ask(host, 'install', { engine, env: await processEnv(engine as SessionEngine, config) }, DEADLINE_MS.quick)
  const no = refused(r)
  if (no) throw no
  log.web.info('engine install started', { engine, host })
  return installStateOf(r)
}

/** How the install on `host` goes; once it ended, the engine pickers ask that host again. */
export async function engineInstallStatus(engine: string, host: string): Promise<InstallState> {
  specOrThrow(engine)
  const r = await ask(host, 'installStatus', { engine }, DEADLINE_MS.quick)
  const no = refused(r)
  if (no) throw no
  const state = installStateOf(r)
  if (state.state === 'done' || state.state === 'failed') forgetEngineAvailability(engine, host)
  return state
}

function installStateOf(r: Record<string, unknown>): InstallState {
  const { ok: _ok, ...rest } = r
  return rest as unknown as InstallState
}

/** The engine pickers' cached availability of `host`, dropped: the next ask probes again. */
function forgetEngineAvailability(engine: string, host: string): void {
  void Promise.all([import('./engine-probe.js'), import('./host-engines.js')]).then(([probe, remote]) => {
    if (!host || host === LOCAL_HOST) probe.forgetEngineProbe(engine as SessionEngine)
    else remote.forgetHostEngines(host)
  }).catch(() => { /* the cache ages out in a minute anyway */ })
}

/** The API key's shape: one token, bounded; never logged. */
export function apiKeyOfInput(raw: unknown): string {
  if (typeof raw !== 'string') throw new EngineSignInError('the key must be text', 400, 'invalid_key')
  const key = raw.trim()
  if (!key) throw new EngineSignInError('the key is empty', 400, 'invalid_key')
  if (key.length > API_KEY_MAX) throw new EngineSignInError(`the key is longer than ${API_KEY_MAX} characters`, 400, 'invalid_key')
  if (/[\s\u0000-\u001f\u007f]/.test(key)) throw new EngineSignInError('the key must be one token without spaces', 400, 'invalid_key')
  return key
}

/**
 * Sets (a string) or removes (null) `engines.<engine>.env.<apiKeyEnv>` in config.yaml, under the
 * config write lock; every other field of the engine's section stays as it is.
 */
export async function setEngineApiKey(engine: string, key: string | null): Promise<{ set: boolean }> {
  const spec = specOrThrow(engine)
  const { modifyConfigDoc } = await import('../config-store.js')
  await modifyConfigDoc((doc) => {
    const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
    const engines = isObj(doc.engines) ? { ...doc.engines } : {}
    const section = isObj(engines[engine]) ? { ...(engines[engine] as Record<string, unknown>) } : {}
    const env = isObj(section.env) ? { ...section.env } : {}
    if (key === null) {
      if (!Object.hasOwn(env, spec.apiKeyEnv)) return { write: false, result: undefined }
      delete env[spec.apiKeyEnv]
    } else {
      if (env[spec.apiKeyEnv] === key) return { write: false, result: undefined }
      env[spec.apiKeyEnv] = key
    }
    if (Object.keys(env).length) section.env = env
    else delete section.env
    if (Object.keys(section).length) engines[engine] = section
    else delete engines[engine]
    doc.engines = engines
    return { write: true, result: undefined }
  })
  log.web.info(key === null ? 'engine api key removed' : 'engine api key saved', { engine })
  // The key signs every host's sessions of the engine in.
  if (key !== null) noteSignedIn(engine, null, true, true)
  return { set: key !== null }
}
