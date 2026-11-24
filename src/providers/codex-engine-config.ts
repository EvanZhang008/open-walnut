/**
 * The Codex config overrides Walnut hands the codex-acp adapter (env CODEX_CONFIG),
 * built in ONE place for every Codex spawn: a session start on this machine, a
 * session start on another host (the server builds the env and sends it with
 * acpStart; that host's daemon passes it through), and the model probe.
 *
 *   engines:
 *     codex:
 *       provider:                 # route Codex through your own OpenAI-compatible endpoint
 *         base_url: http://127.0.0.1:9000/v1
 *         name: my-proxy          # optional, the provider id (default walnut-provider)
 *         wire_api: responses     # optional, responses (default) or chat
 *         env_key: MY_PROXY_KEY   # optional, the variable that holds its API key
 *         model_prefix: vendor.   # optional, prefix the endpoint's model ids need
 *       model: <model id>         # optional default model for a session that names none
 *       effort: <effort>          # optional default reasoning effort
 *   hosts:
 *     <name>:
 *       engines:
 *         codex:
 *           provider: { ... }     # optional, this host's own provider (same shape), over the global one
 *
 * Which provider a host gets is codexProviderForPlace's call: its own, else the global one,
 * except a loopback global (127.0.0.1, localhost) on any machine but the one whose config it is.
 *
 * Why the provider rides CODEX_CONFIG: codex-acp passes `model_provider` and
 * `model_providers.<id>` from it as `-c` overrides on the app-server's command
 * line (Walnut's patch, patches/@agentclientprotocol%2Fcodex-acp@1.4.0.patch) and
 * as the thread config of every thread/start and thread/resume. Both rank above
 * ~/.codex/config.toml, so a host whose config.toml names another provider (a
 * managed one rewritten on every start) cannot win.
 *
 * Keys the user wrote in `engines.codex.env.CODEX_CONFIG` win over the ones built
 * here, so an older config keeps working unchanged. With nothing under
 * `engines.codex` but `env`, the result is exactly that parsed CODEX_CONFIG.
 */

import { isLoopbackHostname, isLoopbackUrl } from '../core/service-url.js'
import { withCodexRequestTag } from '../core/sessions/request-tag.js'

/** A provider id codex reads as a table key; codex-acp's patch passes only these. */
const PROVIDER_ID = /^[A-Za-z0-9_-]+$/
/** Codex's built-in providers win over a user table of the same id, so naming one would route nowhere new. */
const BUILT_IN_PROVIDER_IDS = new Set(['openai', 'ollama', 'lmstudio', 'oss'])
const WIRE_APIS = new Set(['responses', 'chat'])
/** The charset real provider model ids use (resolveModelSwitchValue in core/types.ts). */
const MODEL_ID = /^[A-Za-z0-9._:/-]+$/
const EFFORT = /^[a-z][a-z0-9_-]*$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
export const DEFAULT_CODEX_PROVIDER_ID = 'walnut-provider'
/**
 * The adapter env naming the provider's model prefix. Walnut's codex-acp patch then
 * reads Codex's own model list (`codex debug models`), writes it as a catalog under
 * the prefixed ids and hands it to the app-server (`-c model_catalog_json`), so a
 * prefixed id gets its model's metadata instead of Codex's fallback metadata, which
 * warns in every reply ("Model metadata for `<id>` not found").
 */
export const CODEX_MODEL_PREFIX_ENV = 'WALNUT_CODEX_MODEL_PREFIX'

export interface CodexProviderSettings {
  /** The id codex knows it by (`model_provider` and the `model_providers` key). */
  id: string
  base_url: string
  wire_api: 'responses' | 'chat'
  env_key?: string
  model_prefix?: string
}

export interface CodexEngineSettings {
  provider?: CodexProviderSettings
  /** Default model (base id, as written; resolveCodexEngine applies the prefix) for a session that names none. */
  model?: string
  /** Default reasoning effort for a session that names none. */
  effort?: string
}

/**
 * A wrong `engines.codex` setting: the start or probe fails with this rather than routing to another
 * provider. A setting, not a passing failure: a route answers it 422 with `code` (engine-switch-v1.ts
 * reads `status` and `code`), and a delivery parks on it with its words (delivery-failure.ts).
 */
export class CodexEngineConfigError extends Error {
  readonly status = 422
  readonly code = ENGINE_CONFIG_CODE
  constructor(message: string) {
    super(`engines.codex: ${message}`)
    this.name = 'CodexEngineConfigError'
  }
}
export const ENGINE_CONFIG_CODE = 'engine_config'

/** Is `err` a CodexEngineConfigError (by class, or by name for one that crossed a module copy)? */
export function isCodexEngineConfigError(err: unknown): err is CodexEngineConfigError {
  return err instanceof CodexEngineConfigError || (err instanceof Error && err.name === 'CodexEngineConfigError')
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Codex ids carry their effort as `base[effort]` (the catalog's shape). */
export function splitCodexModelId(modelId: string): { base: string; effort?: string } {
  const match = /^(.*?)\[([^\]]+)\]$/.exec(modelId)
  return match ? { base: match[1], effort: match[2] } : { base: modelId }
}

/** The CODEX_CONFIG JSON a user wrote (engines.codex.env, or this server's own env). */
export function parseCodexBaseConfig(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`CODEX_CONFIG must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(parsed)) {
    throw new Error('CODEX_CONFIG must be a JSON object')
  }
  return parsed
}

function optionalString(entry: Record<string, unknown>, key: string, where: string): string | undefined {
  const value = entry[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new CodexEngineConfigError(`${where}${key} must be a string`)
  const trimmed = value.trim()
  return trimmed || undefined
}

/**
 * The provider codexProviderForPlace leaves where none reaches the place it is read for:
 * `{ walnut_refused: <why> }`, refused by readProvider with its words, as a `withheld` one is.
 * Plain data, so a copy of the resolved config (JSON, structuredClone) still refuses.
 */
const REFUSED_KEY = 'walnut_refused'
/** What codexProviderForPlace says the engine env loses at its place (EnvRule), on the resolved `engines.codex`. */
const ENV_RULE_KEY = 'walnut_env_rule'

function readProvider(raw: unknown): CodexProviderSettings | undefined {
  if (raw === undefined || raw === null) return undefined
  if (isRecord(raw) && typeof raw[REFUSED_KEY] === 'string') throw new CodexEngineConfigError(raw[REFUSED_KEY] as string)
  // Only in a copy of the Mac's config (replication/config-allowlist.ts): the Mac has a provider it could not copy.
  if (isRecord(raw) && raw.withheld === true) {
    throw new CodexEngineConfigError('provider on the Mac holds a credential, which is never copied off the Mac, so this server cannot send Codex there. Name the key\'s variable in provider.env_key instead, or start the session from the Mac')
  }
  if (!isRecord(raw)) throw new CodexEngineConfigError('provider must be a mapping with a base_url')
  const baseUrl = optionalString(raw, 'base_url', 'provider.')
  if (!baseUrl) throw new CodexEngineConfigError('provider.base_url is required')
  let url: URL
  try { url = new URL(baseUrl) } catch { throw new CodexEngineConfigError('provider.base_url is not a URL') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CodexEngineConfigError('provider.base_url must start with http:// or https://')
  }
  const id = optionalString(raw, 'name', 'provider.') ?? DEFAULT_CODEX_PROVIDER_ID
  if (!PROVIDER_ID.test(id)) throw new CodexEngineConfigError('provider.name may hold only letters, digits, "-" and "_"')
  if (BUILT_IN_PROVIDER_IDS.has(id.toLowerCase())) {
    throw new CodexEngineConfigError(`provider.name "${id}" is one of Codex's built-in providers; pick another name`)
  }
  const wire = optionalString(raw, 'wire_api', 'provider.') ?? 'responses'
  if (!WIRE_APIS.has(wire)) throw new CodexEngineConfigError('provider.wire_api must be "responses" or "chat"')
  const envKey = optionalString(raw, 'env_key', 'provider.')
  if (envKey !== undefined && !ENV_NAME.test(envKey)) {
    throw new CodexEngineConfigError('provider.env_key must be the NAME of an environment variable, not its value')
  }
  const prefix = optionalString(raw, 'model_prefix', 'provider.')
  if (prefix !== undefined && !MODEL_ID.test(prefix)) throw new CodexEngineConfigError('provider.model_prefix has characters a model id cannot hold')
  return {
    id,
    base_url: baseUrl,
    wire_api: wire as CodexProviderSettings['wire_api'],
    ...(envKey ? { env_key: envKey } : {}),
    ...(prefix ? { model_prefix: prefix } : {}),
  }
}

/** The id an endpoint answers to: a bare id gets the provider's prefix, a prefixed one stays. */
export function codexModelForProvider(model: string, provider: CodexProviderSettings | undefined): string {
  const prefix = provider?.model_prefix
  if (!prefix || model.startsWith(prefix)) return model
  return prefix + model
}

/**
 * `engines.codex` as the user wrote it. Throws CodexEngineConfigError on a wrong
 * value. The model is as written (no prefix yet): which prefix applies depends on
 * the provider the thread really goes to, which resolveCodexEngine decides.
 */
export function readCodexEngineSettings(config: unknown): CodexEngineSettings {
  const entry = isRecord(config) && isRecord(config.engines) ? config.engines.codex : undefined
  if (!isRecord(entry)) return {}
  const provider = readProvider(entry.provider)
  const rawModel = optionalString(entry, 'model', '')
  const rawEffort = optionalString(entry, 'effort', '')
  let model: string | undefined
  let effort = rawEffort
  if (rawModel) {
    const { base, effort: inId } = splitCodexModelId(rawModel)
    if (!MODEL_ID.test(base)) throw new CodexEngineConfigError('model has characters a model id cannot hold')
    model = base
    effort ??= inId
  }
  if (effort !== undefined && !EFFORT.test(effort)) throw new CodexEngineConfigError('effort must be a reasoning level such as low, medium, high or xhigh')
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  }
}

/** Where a Codex process runs, as codexProviderForPlace needs it. */
export interface CodexPlace {
  /** The host key (`hosts.<name>`) it runs on; absent for the machine of this server that has no host key. */
  host?: string
  /** The host's other keys, proven to reach the same daemon (revoked-hosts.ts sameDaemonKeysNow): its provider may be written under any. */
  aliases?: readonly string[]
  /** Is the config's global `engines.codex` this machine's own (false off the leader, and on another host)? */
  configIsThisMachine: boolean
  /**
   * This server is a follower: its global provider is the leader's copy, while its engine env is
   * its own (codex-engine-source.ts withCopiedEngines), so nothing in that env points at the
   * leader's providers and none of it is left out.
   */
  follower?: boolean
}

/** What codexProviderForPlace did with the provider, for one log line and the tests. */
export type CodexProviderSource =
  | { from: 'host'; host: string }
  | { from: 'global' }
  | { from: 'none' }
  | { from: 'refused-loopback'; host: string | undefined; name: string; base_url: string }

/**
 * THE provider a Codex process gets at `place` (every spawn path takes it, through
 * codex-engine-source.ts codexWalnutConfig): `config` with `engines.codex.provider` replaced by
 *
 *   1. the host's own `hosts.<host>.engines.codex.provider`, when it is set (under its own key, else
 *      under another name of the same machine, `place.aliases`);
 *   2. else the global `engines.codex.provider`, EXCEPT a loopback one (127.0.0.1, localhost, ::1)
 *      on a machine other than the one whose config it is: it reaches nothing there, so the
 *      start is refused with what to set (readProvider throws its words), as a server that
 *      cannot tell the provider refuses (codex-engine-source.ts). Never the host's own
 *      ~/.codex/config.toml in its place: that one may send the session to another account.
 *
 * And the engine env (`engines.codex.env`, and an overlay built elsewhere through
 * codexEnvAtPlace) without every provider entry that reaches nothing there (EnvRule):
 *   - the global provider's, where another provider is used and it is not the same one (another
 *     id and another server): a MODEL_PROVIDER naming it, the variable holding its key, a value
 *     holding its URL, its CODEX_CONFIG entry;
 *   - when the env goes to another machine, every loopback endpoint but the provider used there:
 *     a CODEX_CONFIG `model_providers` entry at one (any spelling: localhost, 127.x, [::1]), a
 *     `model_provider` or a profile's `model_provider` naming one, a MODEL_PROVIDER naming one,
 *     and a value holding such a URL. A CODEX_CONFIG entry of the used provider's own id keeps
 *     its other keys (headers, retries) with the used provider's URL.
 * The env a follower reads is its own and keeps everything.
 *
 * Pure: the caller says which machine the config is (configIsThisMachine) and logs a refusal.
 */
export function codexProviderForPlace(
  config: Record<string, unknown>,
  place: CodexPlace,
): { config: Record<string, unknown>; source: CodexProviderSource } {
  const engines = isRecord(config.engines) ? config.engines : {}
  const codex = isRecord(engines.codex) ? engines.codex : {}
  const global = codex.provider
  const at = (provider: unknown, used: Record<string, unknown> | undefined): Record<string, unknown> => {
    const rule = place.follower ? undefined : envRuleFor(isRecord(global) ? global : undefined, used, !place.configIsThisMachine)
    if (provider === global && !rule) return config
    const next: Record<string, unknown> = { ...codex, ...(provider !== undefined ? { provider } : {}) }
    if (rule) {
      next[ENV_RULE_KEY] = rule
      if (isRecord(codex.env)) next.env = envWithout(codex.env, rule)
    }
    return { ...config, engines: { ...engines, codex: next } }
  }
  const hosts = isRecord(config.hosts) ? config.hosts : {}
  const providerOf = (key: string): unknown => {
    const entry = Object.hasOwn(hosts, key) && isRecord(hosts[key]) ? hosts[key] as Record<string, unknown> : undefined
    const engines = entry && isRecord(entry.engines) ? entry.engines : undefined
    const own = engines && isRecord(engines.codex) ? engines.codex.provider : undefined
    return own === null ? undefined : own
  }
  // The host's own key first, then its other names of the same machine.
  for (const key of place.host ? [place.host, ...(place.aliases ?? [])] : []) {
    const own = providerOf(key)
    if (own !== undefined) return { config: at(own, isRecord(own) ? own : undefined), source: { from: 'host', host: key } }
  }
  if (global === undefined || global === null) return { config: at(global, undefined), source: { from: 'none' } }
  if (!place.configIsThisMachine && isRecord(global) && isLoopbackUrl(global.base_url)) {
    const name = providerIdOf(global) ?? DEFAULT_CODEX_PROVIDER_ID
    const baseUrl = String(global.base_url)
    return {
      config: at({ [REFUSED_KEY]: unreachableText(place.host, name, baseUrl) }, undefined),
      source: { from: 'refused-loopback', host: place.host, name, base_url: baseUrl },
    }
  }
  return { config: at(global, isRecord(global) ? global : undefined), source: { from: 'global' } }
}

/** The id a provider entry goes by (its `name`, else Walnut's default), or undefined for no mapping. */
function providerIdOf(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  return name || DEFAULT_CODEX_PROVIDER_ID
}

/** The refusal of a loopback provider read on another machine: what is wrong and the exact setting that fixes it. */
function unreachableText(host: string | undefined, name: string, baseUrl: string): string {
  const key = host ?? '<name of this host>'
  return `provider "${name}" is at ${baseUrl}, a loopback address of the machine whose config it is, `
    + `so it reaches nothing on ${host ? `host "${host}"` : 'this server'} and the Codex session is not started there. `
    + 'Give that host its own provider, hosts.<name>.engines.codex.provider in config.yaml (the proxy it runs itself), for example:\n'
    + `hosts:\n  ${key}:\n    engines:\n      codex:\n        provider:\n          name: ${host ? host.replace(/[^A-Za-z0-9_-]/g, '-') : 'host'}-proxy\n`
    + `          base_url: http://127.0.0.1:<port of the proxy on that host>/v1\n`
    + 'See "A provider per host" in docs/reference/codex-engine.md.'
}

/**
 * What the engine env loses at a place (codexProviderForPlace). Plain data on the resolved
 * `engines.codex`, so codexEnvAtPlace applies the same to an overlay, and a copy keeps it.
 */
interface EnvRule {
  /** Provider ids nothing at the place answers to: the set-aside global's. */
  dead_ids: string[]
  /** Servers nothing at the place reaches, by origin: the set-aside global's. */
  dead_urls: string[]
  /** The env goes to another machine: every loopback server but the used provider's reaches nothing. */
  loopback_dead: boolean
  /** Variables holding a dead provider's key (the set-aside global's env_key, unless the used one reads it too). */
  dead_key_vars: string[]
  /** The provider used there, none for a refusal. */
  used?: { id: string; base_url?: string }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** The server a URL names (scheme, host, port), every loopback spelling as one; '' for a non-URL. */
function originOf(raw: string): string {
  try {
    const url = new URL(raw.trim())
    const host = isLoopbackHostname(url.hostname) ? 'loopback' : url.hostname.toLowerCase()
    return `${url.protocol}//${host}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`
  } catch {
    return ''
  }
}
const sameServer = (a: string, b: string | undefined): boolean => !!b && originOf(a) !== '' && originOf(a) === originOf(b)

function envRuleFor(global: Record<string, unknown> | undefined, used: Record<string, unknown> | undefined, loopbackDead: boolean): EnvRule | undefined {
  const usedInfo = used ? { id: providerIdOf(used)!, ...(str(used.base_url) ? { base_url: str(used.base_url) } : {}) } : undefined
  // The global provider is dead where another one is used, unless that one is the same (its id, or its server).
  const aside = global && global !== used ? global : undefined
  const globalDead = !!aside && !(usedInfo && (usedInfo.id === providerIdOf(aside) || sameServer(str(aside.base_url), usedInfo.base_url)))
  if (!globalDead && !loopbackDead) return undefined
  const keyVar = aside ? str(aside.env_key) : ''
  return {
    dead_ids: globalDead ? [providerIdOf(aside)!] : [],
    dead_urls: globalDead && str(aside!.base_url) ? [str(aside!.base_url)] : [],
    loopback_dead: loopbackDead,
    dead_key_vars: globalDead && keyVar && keyVar !== str(used?.env_key) ? [keyVar] : [],
    ...(usedInfo ? { used: usedInfo } : {}),
  }
}

function readEnvRule(raw: unknown): EnvRule | undefined {
  if (!isRecord(raw)) return undefined
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const used = isRecord(raw.used) && typeof raw.used.id === 'string' ? { id: raw.used.id, ...(typeof raw.used.base_url === 'string' ? { base_url: raw.used.base_url } : {}) } : undefined
  return { dead_ids: list(raw.dead_ids), dead_urls: list(raw.dead_urls), loopback_dead: raw.loopback_dead === true, dead_key_vars: list(raw.dead_key_vars), ...(used ? { used } : {}) }
}

/**
 * The engine env (`engines.codex.env` as an adapter overlay) for a Codex spawn resolved by
 * codexWalnutConfig: as it is, unless codexProviderForPlace said what it loses at that place.
 */
export function codexEnvAtPlace(env: Record<string, string> | undefined, resolved: unknown): Record<string, string> | undefined {
  const codex = isRecord(resolved) && isRecord(resolved.engines) && isRecord(resolved.engines.codex) ? resolved.engines.codex : undefined
  const rule = readEnvRule(codex?.[ENV_RULE_KEY])
  if (!env || !rule) return env
  return envWithout(env, rule) as Record<string, string>
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>,;]+/gi

function envWithout(env: Record<string, unknown>, rule: EnvRule): Record<string, unknown> {
  const usedId = rule.used?.id
  const usedUrl = rule.used?.base_url
  const deadUrl = (u: string): boolean => (rule.loopback_dead && isLoopbackUrl(u) && !sameServer(u, usedUrl))
    || rule.dead_urls.some((d) => sameServer(u, d))
  const deadIds = new Set(rule.dead_ids)
  // CODEX_CONFIG first: the entries it loses are dead ids for MODEL_PROVIDER too.
  const raw = env.CODEX_CONFIG
  const stripped = typeof raw === 'string' && raw ? codexConfigWithout(raw, usedId, usedUrl, deadUrl, deadIds) : raw
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(env)) {
    if (k === 'CODEX_CONFIG') { out[k] = stripped; continue }
    if (k === 'MODEL_PROVIDER' && typeof v === 'string' && deadIds.has(v.trim()) && v.trim() !== usedId) continue
    if (rule.dead_key_vars.includes(k)) continue
    if (typeof v === 'string' && (v.match(URL_IN_TEXT) ?? []).some(deadUrl)) continue
    out[k] = v
  }
  return out
}

function codexConfigWithout(raw: string, usedId: string | undefined, usedUrl: string | undefined, deadUrl: (u: string) => boolean, deadIds: Set<string>): string {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return raw } // resolveCodexEngine refuses it with the reason
  if (!isRecord(parsed)) return raw
  const next: Record<string, unknown> = { ...parsed }
  if (isRecord(next.model_providers)) {
    const providers: Record<string, unknown> = {}
    for (const [pid, entry] of Object.entries(next.model_providers)) {
      const url = isRecord(entry) ? str(entry.base_url) : ''
      if (pid === usedId) {
        // The used provider's own id: the user's other keys for it stay, at the server it is at here.
        providers[pid] = url && usedUrl && deadUrl(url) ? { ...(entry as Record<string, unknown>), base_url: usedUrl } : entry
        continue
      }
      if (deadIds.has(pid) || (url && deadUrl(url))) { deadIds.add(pid); continue }
      providers[pid] = entry
    }
    if (Object.keys(providers).length > 0) next.model_providers = providers
    else delete next.model_providers
  }
  const named = (v: unknown): boolean => typeof v === 'string' && deadIds.has(v) && v !== usedId
  if (named(next.model_provider)) delete next.model_provider
  if (isRecord(next.profiles)) {
    const profiles: Record<string, unknown> = {}
    for (const [name, profile] of Object.entries(next.profiles)) {
      if (isRecord(profile) && named(profile.model_provider)) {
        const { model_provider: _dead, ...rest } = profile
        profiles[name] = rest
      } else profiles[name] = profile
    }
    next.profiles = profiles
  }
  return JSON.stringify(next)
}

/** The CODEX_CONFIG keys the settings stand for. */
export function codexConfigFromSettings(settings: CodexEngineSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const p = settings.provider
  if (p) {
    out.model_provider = p.id
    out.model_providers = {
      [p.id]: {
        name: p.id,
        base_url: p.base_url,
        wire_api: p.wire_api,
        // Without a key variable the endpoint needs no sign-in; with one, codex reads the key from it.
        ...(p.env_key ? { env_key: p.env_key } : { requires_openai_auth: false }),
      },
    }
  }
  if (settings.model) out.model = codexModelForProvider(settings.model, p)
  if (settings.effort) out.model_reasoning_effort = settings.effort
  return out
}

/** The model a session itself asked for (its start's pick, kept on its record as acpConfig). */
export interface CodexSessionPick { model?: string; reasoning_effort?: string }

/**
 * The pick as codex must receive it, given the EFFECTIVE settings (resolveCodexEngine's
 * `settings`): the prefix of the provider the thread goes to applied. Only with a
 * provider configured: there the endpoint's ids are the truth, while codex's own
 * catalog may list other ones, so a pick rides the thread config to land.
 */
export function codexPickForProvider(pick: CodexSessionPick | undefined, settings: CodexEngineSettings): CodexSessionPick | undefined {
  if (!settings.provider || !pick?.model) return undefined
  const { base, effort } = splitCodexModelId(pick.model.trim())
  if (!base || !MODEL_ID.test(base)) return undefined
  const reasoning = pick.reasoning_effort ?? effort
  return { model: codexModelForProvider(base, settings.provider), ...(reasoning ? { reasoning_effort: reasoning } : {}) }
}

/**
 * The CODEX_CONFIG a user set for this spawn: engines.codex.env's (`null` there
 * unsets it), else this server's own environment, which says nothing about
 * another host. The same rule the adapter env is built by.
 */
export function codexRawConfig(config: unknown, remote: boolean): string | undefined {
  const engines = isRecord(config) && isRecord(config.engines) ? config.engines : undefined
  const env = engines && isRecord(engines.codex) ? engines.codex.env : undefined
  if (isRecord(env) && Object.hasOwn(env, 'CODEX_CONFIG')) return typeof env.CODEX_CONFIG === 'string' && env.CODEX_CONFIG ? env.CODEX_CONFIG : undefined
  return remote ? undefined : process.env.CODEX_CONFIG
}

export interface CodexEngineResolution {
  /** The CODEX_CONFIG the adapter gets, or undefined for none. */
  baseConfig: Record<string, unknown> | undefined
  /**
   * The settings in force: `provider.model_prefix` only when the thread goes to
   * that provider (a CODEX_CONFIG routing elsewhere wins, and that provider's ids
   * are its own). Every reader of the prefix (a pick, the replay, a mid-session
   * switch, the model menu, the adapter env) takes it from here.
   */
  settings: CodexEngineSettings
  /** That prefix, when it applies (the adapter's WALNUT_CODEX_MODEL_PREFIX). */
  prefix: string | undefined
}

/**
 * THE function every Codex adapter spawn takes its config from
 * (tests/providers/codex-engine-config-ratchet.test.ts holds every caller to it).
 *
 *   config          the Walnut config (engines.codex is read from it)
 *   rawCodexConfig  the CODEX_CONFIG a user set (codexRawConfig)
 *   pick            the session's own model choice, when it has one
 *
 * Order: the settings' keys, then the user's CODEX_CONFIG over them (a provider of
 * the same id is the user's whole), then a session's pick over the model; the
 * provider the merged config names decides the prefix.
 */
export function resolveCodexEngine(
  config: unknown,
  rawCodexConfig: string | undefined,
  options: { pick?: CodexSessionPick; tag?: { session: string; project: string | undefined } } = {},
): CodexEngineResolution {
  const resolved = resolveUntagged(config, rawCodexConfig, options)
  // session.tag_requests: the provider the threads go to carries the session's tag headers.
  const tag = options.tag
  return tag ? { ...resolved, baseConfig: withCodexRequestTag(resolved.baseConfig, tag.session, tag.project) } : resolved
}

function resolveUntagged(
  config: unknown,
  rawCodexConfig: string | undefined,
  options: { pick?: CodexSessionPick },
): CodexEngineResolution {
  const explicit = parseCodexBaseConfig(rawCodexConfig)
  const configured = readCodexEngineSettings(config)
  const goesTo = typeof explicit?.model_provider === 'string' ? explicit.model_provider : configured.provider?.id
  let provider = configured.provider
  if (provider?.model_prefix && goesTo !== provider.id) {
    provider = { ...provider }
    delete provider.model_prefix
  }
  const settings: CodexEngineSettings = { ...configured, ...(provider ? { provider } : {}) }
  const prefix = provider?.model_prefix
  const derived = codexConfigFromSettings(settings)
  const pick = codexPickForProvider(options.pick, settings)
  if (Object.keys(derived).length === 0 && !pick) return { baseConfig: explicit, settings, prefix }
  const merged: Record<string, unknown> = { ...derived, ...(explicit ?? {}) }
  if (isRecord(derived.model_providers) || isRecord(explicit?.model_providers)) {
    merged.model_providers = {
      ...(isRecord(derived.model_providers) ? derived.model_providers : {}),
      ...(isRecord(explicit?.model_providers) ? explicit.model_providers : {}),
    }
  }
  if (pick?.model) {
    merged.model = pick.model
    if (pick.reasoning_effort) merged.model_reasoning_effort = pick.reasoning_effort
  }
  // A bare model the user's CODEX_CONFIG names still needs the prefix of the provider it goes to.
  // With none named at all, the adapter takes the host's own default and prefixes it (the patch).
  if (prefix && typeof merged.model === 'string') merged.model = codexModelForProvider(merged.model, provider)
  return { baseConfig: merged, settings, prefix }
}

/** resolveCodexEngine's CODEX_CONFIG alone. */
export function resolveCodexAdapterConfig(
  config: unknown,
  rawCodexConfig: string | undefined,
  options: { pick?: CodexSessionPick } = {},
): Record<string, unknown> | undefined {
  return resolveCodexEngine(config, rawCodexConfig, options).baseConfig
}

interface CatalogLike { models: Array<{ modelId: string; name: string; description?: string | null }>; currentModelId?: string }

/**
 * The model menu as the endpoint answers it: with a `model_prefix`, every bare id
 * codex listed becomes the prefixed one (the bare one starts a session that, on
 * such an endpoint, gets no tools), so the picker and task_start offer the id
 * that works. Names stay as codex wrote them.
 */
export function mapCodexCatalog<T extends CatalogLike>(catalog: T, settings: CodexEngineSettings): T {
  if (!settings.provider?.model_prefix) return catalog
  const map = (id: string): string => {
    const { base, effort } = splitCodexModelId(id)
    const mapped = codexModelForProvider(base, settings.provider)
    return effort ? `${mapped}[${effort}]` : mapped
  }
  const seen = new Set<string>()
  const models = catalog.models
    .map((m) => ({ ...m, modelId: map(m.modelId) }))
    .filter((m) => (seen.has(m.modelId) ? false : (seen.add(m.modelId), true)))
  return { ...catalog, models, ...(catalog.currentModelId ? { currentModelId: map(catalog.currentModelId) } : {}) }
}
