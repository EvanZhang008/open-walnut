/**
 * The models an OpenAI-compatible endpoint really serves, read from its own
 * `GET <base_url>/models`, so a Codex model menu offers only what its route answers.
 *
 * Codex lists the models IT knows, and a newer Codex knows models an endpoint may
 * not serve yet: on 2026-11-18 a Codex update listed openai.gpt-6.2-sol, the picker
 * offered it, and the local proxy the session went through answered every turn
 * "404 The model 'openai.gpt-6.2-sol' does not exist".
 *
 * Unknown is never empty: an endpoint that does not answer the list (no such route,
 * a timeout, a shape we cannot read) leaves the menu as Codex listed it, and so does
 * a list that matches none of Codex's ids (the endpoint names its models some other way).
 */

const LIST_TIMEOUT_MS = 4_000
const CACHE_MS = 60_000
const MAX_BODY_BYTES = 4 * 1024 * 1024

export interface EndpointProvider {
  base_url: string
  env_key?: string
  experimental_bearer_token?: string
  http_headers?: Record<string, string>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** The provider a Codex config routes threads to (`model_providers[model_provider]`), when it names one with a base_url. */
export function providerFromCodexConfig(config: unknown): EndpointProvider | undefined {
  if (!isRecord(config)) return undefined
  const id = config.model_provider
  const providers = config.model_providers
  if (typeof id !== 'string' || !isRecord(providers)) return undefined
  const def = providers[id]
  if (!isRecord(def) || typeof def.base_url !== 'string' || !/^https?:\/\//i.test(def.base_url)) return undefined
  const headers = isRecord(def.http_headers)
    ? Object.fromEntries(Object.entries(def.http_headers).filter((e): e is [string, string] => typeof e[1] === 'string'))
    : undefined
  return {
    base_url: def.base_url,
    ...(typeof def.env_key === 'string' && def.env_key ? { env_key: def.env_key } : {}),
    ...(typeof def.experimental_bearer_token === 'string' && def.experimental_bearer_token ? { experimental_bearer_token: def.experimental_bearer_token } : {}),
    ...(headers && Object.keys(headers).length > 0 ? { http_headers: headers } : {}),
  }
}

/** The ids of an OpenAI-shaped list (`{data:[{id}]}`), or of a bare `{models:[{id|slug}]}`; null when it is neither. */
export function parseModelList(body: unknown): Set<string> | null {
  if (!isRecord(body)) return null
  const rows = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : null
  if (!rows) return null
  const ids = new Set<string>()
  for (const row of rows) {
    const id = isRecord(row) ? (typeof row.id === 'string' ? row.id : typeof row.slug === 'string' ? row.slug : undefined) : undefined
    if (id) ids.add(id)
  }
  return ids
}

const cache = new Map<string, { at: number; ids: Set<string> }>()

/** Test hook. */
export function _resetEndpointModelCache(): void { cache.clear() }

/** The ids the endpoint serves; null when it cannot say. */
export async function endpointServedModels(
  provider: EndpointProvider | undefined,
  env: NodeJS.ProcessEnv,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Set<string> | null> {
  if (!provider) return null
  const url = `${provider.base_url.replace(/\/+$/, '')}/models`
  const hit = cache.get(url)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.ids
  const headers: Record<string, string> = { accept: 'application/json', ...(provider.http_headers ?? {}) }
  const key = provider.experimental_bearer_token ?? (provider.env_key ? env[provider.env_key] : undefined)
  if (key) headers.authorization = `Bearer ${key}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? LIST_TIMEOUT_MS)
  try {
    const resp = await (options.fetchImpl ?? fetch)(url, { headers, signal: controller.signal })
    if (!resp.ok) return null
    const text = await resp.text()
    if (text.length > MAX_BODY_BYTES) return null
    const ids = parseModelList(JSON.parse(text))
    if (!ids || ids.size === 0) return null
    cache.set(url, { at: Date.now(), ids })
    return ids
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** The base of a catalog id (`model[effort]` → model). */
const baseOf = (id: string): string => id.replace(/\[[^\]]*\]$/, '')

/**
 * Only the entries whose model the endpoint serves. Unchanged when the endpoint
 * could not say (`served` null) or when nothing would be left (the endpoint names
 * its models in a shape Codex's ids do not share).
 */
export function keepServedModels<T>(entries: T[], served: Set<string> | null, idOf: (entry: T) => string): T[] {
  if (!served) return entries
  const kept = entries.filter((e) => served.has(baseOf(idOf(e))))
  return kept.length > 0 ? kept : entries
}
