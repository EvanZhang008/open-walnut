/**
 * Secrets judged by the shape of their key, and the guard that keeps a masked
 * value from ever being saved.
 *
 * The config holds maps that no field list describes: a plugin's own settings
 * (`plugins.<id>`, written by plugins this repo has never seen), a provider's
 * extra `headers`, a host server's `build_env`, a tunnel provider's `options`,
 * a hook action's arguments. A list of exact field names cannot cover them, so
 * their keys are judged by the words they are made of: `client_secret`,
 * `refreshToken`, `X-Api-Key` and `NPM_TOKEN` name a secret; `max_tokens`,
 * `project_key`, `client_id` and `token_prefix` do not.
 *
 * Masking what a client reads is safe only with the other half. Clients save
 * back what they read: Settings lays each save over a fresh GET, the
 * install-plugin skill reads `plugins`, merges and writes it whole, and a config
 * write replaces each top-level key it names. `restoreMaskedSecrets` puts the
 * stored value back wherever a write carries a mask, so a redaction never turns
 * into data loss.
 */

const BULLET = '\u2022'

/** Words that name a secret wherever they stand in a key. */
const SECRET_WORDS = new Set([
  'token', 'secret', 'secrets', 'password', 'passwd', 'pwd', 'passphrase',
  'credential', 'credentials', 'bearer', 'authorization', 'cookie', 'cookies', 'jwt',
])

/** `<qualifier> key` names a key you sign or log in with; `project_key` or `sort_key` names a lookup. */
const KEY_QUALIFIERS = new Set([
  'api', 'private', 'access', 'secret', 'signing', 'session', 'encryption',
  'client', 'master', 'auth', 'subscription', 'license',
])

/** The same words run together, which the word split cannot see (`clientsecret`, `xapikey`, `githubtoken`). */
const SECRET_FRAGMENTS = [
  'secret', 'password', 'passwd', 'passphrase', 'credential', 'bearer',
  ...[...KEY_QUALIFIERS].map((q) => `${q}key`),
]

/**
 * Keys the rule above would hide that name no secret. Compared without case or
 * separators, so `tokenPrefix` and `token-prefix` count too. Number values are
 * never masked, so a count such as `max_tokens` is listed only to say so.
 */
export const NOT_SECRET_KEYS = new Set([
  // The push registry's row handles (core/push/send.ts): a hash and an 8-character slice, never the token.
  'token_prefix', 'token_tag',
  // OAuth bookkeeping: a scheme name, an address, a date.
  'token_type', 'token_url', 'token_endpoint', 'token_expires_at', 'token_expiry',
  'authorization_url', 'authorization_endpoint',
  // Counts and budgets.
  'token_budget', 'max_tokens',
  // A command that prints credentials, not a credential (ProviderConfig).
  'aws_credential_export',
].map(compact))

function compact(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** The words of a key: `X-Api-Key` is x, api, key; `refreshToken` is refresh, token; `NPM_TOKEN` is npm, token. */
function wordsOf(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** Whether a key, by its shape, names a secret. */
export function isSecretKey(key: string): boolean {
  const flat = compact(key)
  if (!flat || NOT_SECRET_KEYS.has(flat)) return false
  if (flat === 'key' || flat.endsWith('token')) return true
  if (SECRET_FRAGMENTS.some((f) => flat.includes(f))) return true
  const words = wordsOf(key)
  return words.some((w, i) => SECRET_WORDS.has(w) || (w === 'key' && i > 0 && KEY_QUALIFIERS.has(words[i - 1])))
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** An own property, as JSON.parse makes one: a key called `__proto__` stays a key, never a prototype. */
function setOwn(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
}

/**
 * How a walk judges one key: secret (mask its strings), dropped (leave it out),
 * or neither. `path` holds the keys from where the walk started down to the
 * key's parent (array positions left out).
 */
export type KeyJudge = (key: string, path: readonly string[]) => 'secret' | 'drop' | null

const byShape: KeyJudge = (key) => (isSecretKey(key) ? 'secret' : null)

/**
 * Deep copy with every string under a secret key replaced by `mask(value)`.
 *  - A plain object under a secret key is a map of secrets: every string in it is masked.
 *  - An array takes its key's verdict for its strings; a record in it is judged by its own keys,
 *    so `api_keys: [{ name, key }]` keeps each name and masks each key.
 * Numbers, booleans and empty strings are never masked.
 */
export function maskByKey<T>(value: T, mask: (v: string) => string, judge: KeyJudge = byShape): T {
  return walk(value, [], false, false, mask, judge) as T
}

function walk(
  value: unknown, path: readonly string[], named: boolean, inherited: boolean,
  mask: (v: string) => string, judge: KeyJudge,
): unknown {
  if (typeof value === 'string') return (named || inherited) && value.length > 0 ? mask(value) : value
  if (Array.isArray(value)) return value.map((v) => walk(v, path, isRecord(v) ? false : named, inherited, mask, judge))
  if (isRecord(value)) {
    const inner = inherited || named
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      const verdict = judge(k, path)
      if (verdict === 'drop') continue
      setOwn(out, k, walk(v, [...path, k], verdict === 'secret', inner, mask, judge))
    }
    return out
  }
  return value
}

/** The shape rule with `maskSecret`'s look: eight bullets (U+2022) and the last 4 characters. */
export function maskSecretShapes<T>(value: T, mask: (v: string) => string = maskSecretTail): T {
  return maskByKey(value, mask)
}

/** Eight bullets (U+2022) and the last 4 characters, or four bullets for a value of 4 characters or fewer. */
export function maskSecretTail(v: string): string {
  return v.length > 4 ? BULLET.repeat(8) + v.slice(-4) : BULLET.repeat(4)
}

/**
 * What the plugin settings forms are sent in place of a secret: six bullets,
 * no tail (web/src/components/settings/sections/PluginConfigCards.tsx `MASKED`,
 * which a save leaves out). Used by GET /api/integrations/settings and
 * GET /api/v1/integrations/settings.
 */
export const PLUGIN_FORM_MASK = BULLET.repeat(6)

/** A plugin's settings for its form: every secret-shaped value, at any depth, as `PLUGIN_FORM_MASK`. */
export function maskPluginFormValues(values: Record<string, unknown>): Record<string, unknown> {
  return maskByKey(values, () => PLUGIN_FORM_MASK)
}

/**
 * A value a client view put in place of a secret: `maskSecretTail`'s (eight
 * bullets and a tail of 4, or four bullets) or the plugin settings forms' six
 * bullets. A run of at least four bullets (U+2022), then at most four other
 * characters.
 */
const MASKED_SHAPE = new RegExp(`^${BULLET}{4,}[^${BULLET}]{0,4}$`)

export function isMaskedSecret(v: unknown): v is string {
  return typeof v === 'string' && MASKED_SHAPE.test(v)
}

const DROP = Symbol('drop')

/**
 * Put the stored value back wherever a write carries a mask.
 *
 * `sent` is what a client wants written, `stored` what is on disk at the same
 * place. A masked string becomes the stored string at the same path; with none
 * stored there it is left out, so a mask is never written. Records in an array
 * are paired by their `id`, else by their `name`, else by position, so a list
 * the client reordered still gets each record's own value back. Nothing else is
 * changed: an edited value, an emptied one and a removed key are written as
 * sent. A value only ever returns to the place it was read from, so this
 * reveals nothing a client could not already read.
 */
export function restoreMaskedSecrets<T>(sent: T, stored: unknown): T {
  const out = restore(sent, stored)
  return (out === DROP ? undefined : out) as T
}

function restore(sent: unknown, stored: unknown): unknown {
  if (isMaskedSecret(sent)) return typeof stored === 'string' ? stored : DROP
  if (Array.isArray(sent)) {
    const pool = Array.isArray(stored) ? stored : []
    const out: unknown[] = []
    sent.forEach((item, i) => {
      const r = restore(item, partnerOf(item, i, pool))
      if (r !== DROP) out.push(r)
    })
    return out
  }
  if (isRecord(sent)) {
    const base = isRecord(stored) ? stored : {}
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(sent)) {
      const r = restore(v, Object.hasOwn(base, k) ? base[k] : undefined)
      if (r !== DROP) setOwn(out, k, r)
    }
    return out
  }
  return sent
}

function partnerOf(item: unknown, index: number, pool: unknown[]): unknown {
  if (isRecord(item)) {
    for (const id of ['id', 'name']) {
      if (typeof item[id] === 'string') return pool.find((p) => isRecord(p) && p[id] === item[id])
    }
  }
  return pool[index]
}
