/**
 * Config secret masking, shared by the client views of the config
 * (core/config-broadcast.ts) and the bug-report bundler (always). Key-name-based
 * deep masking: a field whose name is in SECRET_FIELDS, or whose name has a
 * secret's shape (config-secret-shape.ts), gets its value replaced with a stub
 * of bullets and its last 4 characters.
 */
import { isSecretKey, maskByKey, maskSecretTail, type KeyJudge } from './config-secret-shape.js'

/** Fields that hold provider/API secrets — masked before leaving the box. */
export const SECRET_FIELDS = new Set([
  'bedrock_bearer_token', 'bearer_token', 'api_key', 'perplexity_api_key',
  'openai_api_key', 'aws_secret_access_key', 'aws_access_key_id', 'key',
  'hotspot_password',
  // Not the APNs private key itself (config only ever stores a PATH to it), but
  // the path names a file worth protecting and rides bug-report bundles that get
  // pasted into public issues.
  'key_path',
])

/**
 * Fields masked only inside a specific parent, because the field NAME alone is
 * too generic to put in the global denylist.
 *
 * `push_tokens[].token` is the case: a push device token is a send capability
 * (with the APNs key it puts a notification on the user's lock screen), so it
 * must not ride a bug report. The shape rule masks a `token` anywhere now too;
 * that is safe only because `PUT /api/config` puts a mask read back to its
 * stored value (`restoreMaskedSecrets`), and this entry keeps the row's token
 * masked by name whatever the rule says.
 */
const SECRET_FIELDS_BY_PARENT: Record<string, Set<string>> = {
  push_tokens: new Set(['token']),
}

/**
 * Fields dropped inside a specific parent: bookkeeping only this box reads,
 * with no place in any answer. `push_tokens[].claims` (core/push/claims.ts) is
 * a one-way hash of each pairing's bearer that registered a relayed row; only
 * the push registry reads it. Both `maskPushTokens` and `redactConfig` drop it.
 */
const DROPPED_FIELDS_BY_PARENT: Record<string, Set<string>> = {
  push_tokens: new Set(['claims']),
}

export function maskSecret(v: unknown): unknown {
  if (typeof v !== 'string' || v.length === 0) return v
  return maskSecretTail(v)
}

/**
 * Mask the device token of every `push_tokens` row, and nothing else.
 *
 * `GET /api/config` serves the whole config to the console on the Mac, because
 * Settings edits it there. A push token is different: no screen shows one and no
 * client writes one, and it is a send capability for that phone. The push
 * registry is its only reader and writer, so the token is masked in every mode,
 * and `PUT /api/config` drops `push_tokens` so a masked value that is read back
 * and saved can never replace the real one. A row's `claims` are dropped
 * (DROPPED_FIELDS_BY_PARENT); the copy on disk keeps them.
 */
export function maskPushTokens<T>(config: T): T {
  const rows = (config as { push_tokens?: unknown } | null)?.push_tokens
  if (!Array.isArray(rows)) return config
  const dropped = DROPPED_FIELDS_BY_PARENT.push_tokens
  return {
    ...(config as object),
    push_tokens: rows.map((row) => {
      if (!row || typeof row !== 'object') return row
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
        if (dropped.has(k)) continue
        out[k] = v
      }
      out.token = maskSecret((row as { token?: unknown }).token)
      return out
    }),
  } as T
}

/**
 * Maps keyed by a name someone chose (a plugin id, a provider, a host, a tag, a
 * hook id), by their path in the config. The name is not a field and is never
 * judged: a host called `secret-box` keeps its record, while every field inside
 * it is judged as usual.
 */
const NAME_KEYED_MAPS = new Set([
  'plugins', 'providers', 'hosts', 'session_limits', 'tag_display', 'tag_links',
  'hooks.overrides', 'external_session_import.excluded_cwds',
])

/** Every secret, by name or by shape, and the dropped bookkeeping. */
const redactJudge: KeyJudge = (key, path) => {
  if (NAME_KEYED_MAPS.has(path.join('.'))) return null
  const parentKey = path.at(-1)
  if (parentKey && DROPPED_FIELDS_BY_PARENT[parentKey]?.has(key)) return 'drop'
  if (SECRET_FIELDS.has(key) || (parentKey && SECRET_FIELDS_BY_PARENT[parentKey]?.has(key)) || isSecretKey(key)) return 'secret'
  return null
}

/**
 * Deep-clone config with every secret-valued field masked. Used in CLOUD mode
 * for `GET /api/config` (reachable by ANY paired device) and unconditionally
 * for bug-report bundles (pasted into public chats/issues). A field is secret
 * by its name (SECRET_FIELDS, SECRET_FIELDS_BY_PARENT) or by its shape
 * (`isSecretKey`), wherever it stands: a plugin's `client_secret` is masked as
 * surely as a provider's `api_key`. `PUT /api/config` restores a mask read back
 * (`restoreMaskedSecrets`), so a whole round trip keeps every stored value.
 */
export function redactConfig(value: unknown): unknown {
  return maskByKey(value, maskSecretTail, redactJudge)
}

/**
 * The free-form maps of a config: places no field list describes, so their keys
 * are judged by shape. Each path is a map whose keys someone else chose.
 */
function maskFreeFormMaps(config: Record<string, unknown>): Record<string, unknown> {
  const out = { ...config }
  // Each entry of a map keyed by a name (a plugin id, a provider, a host); the name itself is not judged.
  const each = (map: unknown, fn: (v: Record<string, unknown>) => unknown) =>
    isRecord(map) ? Object.fromEntries(Object.entries(map).map(([k, v]) => [k, isRecord(v) ? fn(v) : v])) : map
  const at = (rec: Record<string, unknown>, key: string, fn: (v: unknown) => unknown) =>
    rec[key] === undefined ? rec : { ...rec, [key]: fn(rec[key]) }
  const shapes = (v: unknown) => maskByKey(v, maskSecretTail)
  // A plugin's own settings, written by plugins this repo has never seen.
  if (config.plugins !== undefined) out.plugins = each(config.plugins, shapes)
  // A provider's extra request headers (`Authorization`, `X-Api-Key`).
  if (config.providers !== undefined) out.providers = each(config.providers, (p) => at(p, 'headers', shapes))
  // A host server's build environment (`NPM_TOKEN`) and its tunnel provider's options.
  if (config.hosts !== undefined) {
    out.hosts = each(config.hosts, (h) => at(h, 'server', (server) => isRecord(server)
      ? at(at(server, 'build_env', shapes), 'expose', (e) => (isRecord(e) ? at(e, 'options', shapes) : e))
      : server))
  }
  // This server's own tunnel provider's options.
  if (isRecord(config.expose)) out.expose = at(config.expose, 'options', shapes)
  // A hook action's arguments: `{ type, [key]: unknown }`.
  if (isRecord(config.hooks) && Array.isArray(config.hooks.defs)) {
    out.hooks = { ...config.hooks, defs: config.hooks.defs.map((d) => (isRecord(d) ? at(d, 'action', shapes) : d)) }
  }
  return out
}

/**
 * The Mac's client view: push device tokens masked (`maskPushTokens`), and every
 * secret-shaped value inside the free-form maps (`maskFreeFormMaps`). Settings on
 * the Mac edits the typed fields, so they stay as they are; no screen reads a
 * plugin's secret, and any paired device can read this view.
 */
export function maskForMacClients<T>(config: T): T {
  const pushMasked = maskPushTokens(config)
  return isRecord(pushMasked) ? maskFreeFormMaps(pushMasked) as T : pushMasked
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}
