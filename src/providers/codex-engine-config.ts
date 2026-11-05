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

/** A wrong `engines.codex` setting: the start or probe fails with this rather than routing to another provider. */
export class CodexEngineConfigError extends Error {
  constructor(message: string) {
    super(`engines.codex: ${message}`)
    this.name = 'CodexEngineConfigError'
  }
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

function readProvider(raw: unknown): CodexProviderSettings | undefined {
  if (raw === undefined || raw === null) return undefined
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
  options: { pick?: CodexSessionPick } = {},
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
