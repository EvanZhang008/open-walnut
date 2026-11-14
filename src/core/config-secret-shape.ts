/**
 * Secrets judged by the shape of their key, and the guard that keeps a masked
 * value from ever being saved.
 *
 * The config holds maps that no field list describes: a plugin's own settings
 * (`plugins.<id>`, written by plugins this repo has never seen), a provider's
 * extra `headers`, a host server's `build_env`, a tunnel provider's `options`,
 * a hook action's arguments. A list of exact field names cannot cover them, so
 * their keys are judged by the words they are made of: `client_secret`,
 * `refreshToken`, `X-Api-Key`, `NPM_TOKEN`, `OPENAI_KEY`, `GITHUB_PAT` and
 * `api_tokens` name a secret; `max_tokens`, `project_key`, `public_key`,
 * `client_id` and `token_prefix` do not. A string of any key that holds a URL
 * with a password in it (`postgres://user:password@host`) has that password
 * masked, and only that.
 *
 * Masking what a client reads is safe only with the other half. Clients save
 * back what they read: Settings lays each save over a fresh GET, the
 * install-plugin skill reads `plugins`, merges and writes it whole, and a config
 * write replaces each top-level key it names. `restoreMaskedSecrets` puts the
 * stored value back wherever a write carries a mask, so a redaction never turns
 * into data loss. It pairs a mask with a stored value by identity (the same key
 * path, the same address of a URL, the same `id` or `name` of a list entry),
 * never by position, and refuses a mask it cannot pair (`MaskedValueError`)
 * rather than guess. A mask never reaches disk on any write path: a string that
 * still holds a run of bullets after the pairing (a mask with other text typed
 * next to it) is refused too, as `edited_mask`.
 */

const BULLET = '\u2022'

/** Words that name a secret wherever they stand in a key. */
const SECRET_WORDS = new Set([
  'token', 'secret', 'secrets', 'password', 'passwords', 'passwd', 'pwd', 'passphrase', 'passcode',
  'credential', 'credentials', 'bearer', 'authorization', 'cookie', 'cookies', 'jwt',
])

/** Words that name a secret as the last word of a key: `DB_PASS`, `SMTP_PASS`, `LDAP_BIND_PW`. */
const SECRET_LAST_WORDS = new Set(['pass', 'pw'])

/** Two words that name a secret together: `basic_auth` (a `user:password`), `totp_seed`. */
const SECRET_PAIRS = new Set(['basic auth', 'totp seed', 'otp seed', 'seed phrase'])

/**
 * `tokens` names a list of tokens (`api_tokens`, `oauth_tokens`, `tokens`)
 * unless the word before it makes it a count: `max_tokens`, `input_tokens`,
 * `budget_tokens`.
 */
const TOKEN_COUNT_WORDS = new Set([
  'max', 'min', 'input', 'output', 'prompt', 'completion', 'budget', 'total', 'estimated', 'used',
  'remaining', 'reserved', 'cache', 'cached', 'creation', 'thinking', 'reasoning',
  'context', 'num', 'per', 'count', 'limit',
])

/** `<qualifier> key` names a key you sign or log in with wherever it stands in a key (`api_key_id`, `xApiKey`). */
const KEY_QUALIFIERS = new Set([
  'api', 'private', 'access', 'secret', 'signing', 'session', 'encryption',
  'client', 'master', 'auth', 'subscription', 'license',
])

/**
 * A key that ends in `key` or `keys` names a key you sign or log in with,
 * whatever word comes before it (`OPENAI_KEY`, `STRIPE_KEY`, `SSH_KEY`,
 * `hmac_key`, `deploy_key`), unless that word names a lookup or the public half
 * of a pair: `project_key`, `sort_key`, `public_key`. Hiding a lookup costs its
 * display only (a write puts the stored value back), while showing a secret
 * costs the secret, so this list names lookups, never vendors.
 */
const LOOKUP_KEY_WORDS = new Set([
  // A record in another system (an issue tracker, a wiki, a calendar) or in a table.
  'project', 'issue', 'space', 'team', 'workspace', 'board', 'repo', 'channel', 'calendar', 'list',
  'task', 'item', 'record', 'entity', 'object', 'file', 'field', 'column', 'row', 'table', 'label',
  'tag', 'status', 'group', 'category', 'parent', 'child', 'ref', 'reference',
  // Database, cache and queue keys.
  'primary', 'foreign', 'unique', 'composite', 'natural', 'surrogate', 'partition', 'sort', 'range',
  'hash', 'shard', 'routing', 'cache', 'lookup', 'map', 'dedupe', 'dedup', 'idempotency', 'cursor',
  'page', 'continuation', 'order', 'sequence', 'index', 'queue',
  // The name of a thing: a header, an environment variable, a query parameter, a message, a setting.
  'header', 'env', 'query', 'param', 'translation', 'message', 'i18n', 'locale', 'config', 'setting',
  'option', 'property', 'attribute', 'metric', 'dimension', 'event', 'state', 'display',
  // A key on a keyboard.
  'hot', 'shortcut', 'modifier', 'menu',
  // The half of a key pair that is meant to be shown.
  'public', 'pub',
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
  const words = wordsOf(key)
  const last = words.at(-1) ?? ''
  const before = words.at(-2)
  if (flat === 'key' || flat === 'keys' || flat === 'pat' || flat === 'tokens' || SECRET_LAST_WORDS.has(flat)) return true
  if (before !== undefined && SECRET_LAST_WORDS.has(last)) return true
  // A final key (OPENAI_KEY, hmac_key) unless it is a lookup; a final pat, a personal access token (GITHUB_PAT).
  if ((last === 'key' || last === 'keys') && before !== undefined && !LOOKUP_KEY_WORDS.has(before)) return true
  if ((last === 'pat' || last === 'pats') && before !== undefined) return true
  // Run-together spellings the word split cannot see (githubtoken, oauthtokens, clientsecret, xapikey).
  if (flat.endsWith('token') || (last !== 'tokens' && last.endsWith('tokens'))) return true
  if (SECRET_FRAGMENTS.some((f) => flat.includes(f))) return true
  return words.some((w, i) => SECRET_WORDS.has(w)
    || (w === 'tokens' && !(i > 0 && TOKEN_COUNT_WORDS.has(words[i - 1])))
    || (i > 0 && SECRET_PAIRS.has(`${words[i - 1]} ${w}`))
    || (w === 'key' && i > 0 && KEY_QUALIFIERS.has(words[i - 1])))
}

/**
 * `scheme://user:password@address`, wherever it stands in a string: group 1 is
 * everything up to the password, group 2 the password, group 3 the address
 * after it (host, port, path, query), up to a space, a quote or the next
 * `scheme://`. The password ends at the last `@` before the path, so one with
 * an `@` in it is masked whole. Groups 1 and 3 together name the URL without
 * its password, which is how a write is paired with what is stored.
 */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/?#@:]*:)([^\s/?#]+)@((?:(?![a-z][a-z0-9+.-]*:\/\/)[^\s"'<>])*)/gi

/** What a URL's password is shown as: eight bullets (U+2022), no tail. */
const URL_PASSWORD_MASK = BULLET.repeat(8)

/** A string with the password of every URL in it masked, the rest as it is. */
export function maskUrlPasswords(v: string): string {
  return v.includes('://')
    ? v.replace(URL_PASSWORD, (_whole, head: string, _password: string, address: string) => `${head}${URL_PASSWORD_MASK}@${address}`)
    : v
}

const MASKED_URL_PASSWORD = new RegExp(`^${BULLET}{4,}$`)

function hasMaskedUrlPassword(v: string): boolean {
  return v.includes('://') && [...v.matchAll(URL_PASSWORD)].some((m) => MASKED_URL_PASSWORD.test(m[2]!))
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
 *  - A record `{ name, value }` whose name is a secret's (`{ name: 'GITHUB_TOKEN', value }`, an
 *    env list, a header list) has its `value` masked; the write-back pairs it by `name`.
 *  - Any other string keeps everything but the password of a URL in it (`maskUrlPasswords`).
 * Numbers, booleans and empty strings are never masked. `mask` is told where the string stands
 * (`MaskPlace`): an entry of a list, and whether that entry may show a tail.
 */
export function maskByKey<T>(value: T, mask: (v: string, place: MaskPlace) => string, judge: KeyJudge = byShape): T {
  return walk(value, [], false, false, mask, judge, NOT_IN_LIST) as T
}

/**
 * Where a masked string stands: `inList` for an entry of a list; `blind` for a list entry that
 * must show no tail (`listEntriesWithoutTail`).
 */
export interface MaskPlace { inList: boolean; blind: boolean }
const NOT_IN_LIST: MaskPlace = { inList: false, blind: false }

function walk(
  value: unknown, path: readonly string[], named: boolean, inherited: boolean,
  mask: (v: string, place: MaskPlace) => string, judge: KeyJudge, place: MaskPlace,
): unknown {
  if (typeof value === 'string') {
    if (value.length === 0) return value
    return named || inherited ? mask(value, place) : maskUrlPasswords(value)
  }
  if (Array.isArray(value)) {
    const blind = listEntriesWithoutTail(value)
    return value.map((v) => walk(v, path, isRecord(v) ? false : named, inherited, mask, judge, { inList: true, blind: typeof v === 'string' && blind.has(v) }))
  }
  if (isRecord(value)) {
    const inner = inherited || named
    const valueIsSecret = typeof value.name === 'string' && judge(value.name, path) === 'secret'
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      const verdict = k === 'value' && valueIsSecret ? 'secret' : judge(k, path)
      if (verdict === 'drop') continue
      setOwn(out, k, walk(v, [...path, k], verdict === 'secret', inner, mask, judge, NOT_IN_LIST))
    }
    return out
  }
  return value
}

/** The shape rule with `maskSecret`'s look: eight bullets (U+2022) and the last 4 characters. */
export function maskSecretShapes<T>(value: T, mask: (v: string, place: MaskPlace) => string = maskSecretTailInPlace): T {
  return maskByKey(value, mask)
}

/** Eight bullets (U+2022) and the last 4 characters, or four bullets for a value of 4 characters or fewer. */
export function maskSecretTail(v: string): string {
  return v.length > 4 ? BULLET.repeat(8) + v.slice(-4) : BULLET.repeat(4)
}

/** What a list entry that may show no tail is shown as: eight bullets (U+2022), nothing else. */
export const BLIND_LIST_MASK = BULLET.repeat(8)

/** `maskSecretTail`, except a list entry that may show no tail (`BLIND_LIST_MASK`). */
export function maskSecretTailInPlace(v: string, place: MaskPlace = NOT_IN_LIST): string {
  return place.blind ? BLIND_LIST_MASK : maskSecretTail(v)
}

/**
 * A tail a mask cannot carry: one with a line break (the settings form edits a
 * list of secrets one value per line, so it would split the line) or a bullet
 * (a mask is bullets and then the tail, so it would not read as a mask), or one
 * that ends in whitespace (the form trims each line, so it would come back
 * without it).
 */
const UNSAFE_TAIL = new RegExp(`[\\r\\n${BULLET}]|\\s$`)

/**
 * The string entries of a list that a view shows without a tail: one of 4
 * characters or fewer (nothing to show), one whose last 4 characters hold a
 * line break or a bullet or end in whitespace (`UNSAFE_TAIL`), and one whose
 * last 4 characters another entry ends with too (a tail that names neither). A
 * comma or a space inside the tail is an ordinary character: the form splits a
 * list of secrets on line breaks only. The write-back pairs the bullets-only
 * entries of a list with these, in order (`blindPartners`).
 */
export function listEntriesWithoutTail(list: readonly unknown[]): Set<string> {
  const strings = list.filter((v): v is string => typeof v === 'string' && v.length > 0)
  const tails = new Map<string, number>()
  for (const v of strings) if (v.length > 4) tails.set(v.slice(-4), (tails.get(v.slice(-4)) ?? 0) + 1)
  return new Set(strings.filter((v) => v.length <= 4 || UNSAFE_TAIL.test(v.slice(-4)) || (tails.get(v.slice(-4)) ?? 0) > 1))
}

/**
 * What the plugin settings forms are sent in place of a secret: six bullets,
 * no tail (web/src/components/settings/sections/PluginConfigCards.tsx `MASKED`,
 * which a save leaves out). Used by GET /api/integrations/settings and
 * GET /api/v1/integrations/settings.
 */
export const PLUGIN_FORM_MASK = BULLET.repeat(6)

/**
 * A plugin's settings for its form: every secret-shaped value, at any depth, as
 * `PLUGIN_FORM_MASK`, except, with `listTails`, an entry of a list, which looks
 * as GET /api/config shows it (`maskSecretTailInPlace`). A list is edited as a
 * whole: with six bullets on every line, a save after deleting one could not say
 * which one is left, while each tail pairs with the one stored entry it ends
 * like, and the entries shown without one pair in order.
 *
 * `listTails` is for GET /api/integrations/settings, whose callers (the person
 * at this machine, a paired phone) read the same tails in GET /api/config. GET
 * /api/v1/integrations/settings leaves it off: the cloud companion can forward
 * a call to that route, and it cannot read GET /api/config here.
 */
export function maskPluginFormValues(values: Record<string, unknown>, opts: { listTails?: boolean } = {}): Record<string, unknown> {
  const listTails = opts.listTails ?? false
  return maskByKey(values, (v, place) => (listTails && place.inList ? maskSecretTailInPlace(v, place) : PLUGIN_FORM_MASK))
}

/**
 * A value a client view put in place of a secret: `maskSecretTail`'s (eight
 * bullets and a tail of 4, or four bullets) or the plugin settings forms' six
 * bullets. A run of at least four bullets (U+2022), then at most four other
 * characters.
 */
const MASKED_SHAPE = new RegExp(`^${BULLET}{4,}[^${BULLET}]{0,4}$`)

/** A mask that shows no tail: bullets only. */
const BLIND_SHAPE = new RegExp(`^${BULLET}{4,}$`)

function isBlindMask(v: unknown): v is string {
  return typeof v === 'string' && BLIND_SHAPE.test(v)
}

export function isMaskedSecret(v: unknown): v is string {
  return typeof v === 'string' && MASKED_SHAPE.test(v)
}

/** A run of bullets as long as the shortest mask a view shows (four). */
const MASK_RUN = new RegExp(`${BULLET}{4,}`)

/**
 * Whether a string holds a mask run that is not a mask: bullets with other text
 * typed next to them (a mask with `, sk-new` after it, a trailing space or comma),
 * or bullets anywhere but a URL's password. Such a string pairs with nothing
 * and, written as sent, would put the mask on disk in place of the secret, so
 * every write path refuses it (`edited_mask`) unless it is exactly what is
 * stored at its place. The settings form checks each line with this too.
 */
export function holdsEditedMask(v: string): boolean {
  if (MASKED_SHAPE.test(v)) return false
  const rest = v.includes('://')
    ? v.replace(URL_PASSWORD, (whole: string, head: string, password: string, address: string) => (MASKED_URL_PASSWORD.test(password) ? `${head}@${address}` : whole))
    : v
  return MASK_RUN.test(rest)
}

/**
 * Why a mask could not be paired. Each message names an action that works;
 * typing the full value always does.
 *  - `unmatched`: values are stored there, but none ends like the mask now: the
 *    stored value changed after the client read it, so a reload helps;
 *  - `missing`: nothing is stored under its key, URL address, `id` or `name`
 *    (the client moved it, or it is gone), so only the full value helps;
 *  - `ambiguous`: it matches more than one stored value (two entries that look
 *    alike), so only the full value helps;
 *  - `renamed`: the name of an entry changed, or went, while its value stayed
 *    hidden (a `{ name, value }` entry named like a secret, or a list entry
 *    paired by its name, whatever key holds its value);
 *  - `edited_mask`: other text was typed next to a mask (`holdsEditedMask`), so
 *    it is neither the hidden value nor a new one.
 */
export type MaskedValueReason = 'unmatched' | 'missing' | 'ambiguous' | 'renamed' | 'edited_mask'

const REASON_ADVICE: Record<MaskedValueReason, (value: string) => string> = {
  unmatched: (value) => `and no value stored there matches it now (it changed after it was read). Reload to get the current settings and try again, or type the full value of ${value}.`,
  missing: (value) => `and nothing is stored under the same name or address. Type the full value of ${value}.`,
  ambiguous: (value) => `and it matches more than one stored value. Type the full value of ${value}.`,
  renamed: (value) => `while the name of its entry changed. Type the full value of ${value} to keep it under the new name.`,
  edited_mask: (value) => `with other text added to it. Keep the hidden value exactly as it was shown, or replace it with the full value of ${value}.`,
}

/**
 * A write that carries a mask the server cannot pair with one stored value.
 * The routes answer 400 with `field` and `reason`, and nothing is written:
 * guessing could put one host's password on another, and leaving the value out
 * could lose it (a renamed key would take the mask and drop the stored value
 * with the old key). The message never carries a value.
 */
export class MaskedValueError extends Error {
  readonly code = 'masked_value_unmatched'
  /**
   * `valueField` is the hidden value the message is about and the field to type in, when it is not
   * `field` (a renamed entry: `field` is its name, `valueField` the key that holds its value).
   */
  constructor(readonly field: string, readonly reason: MaskedValueReason = 'unmatched', valueField = field) {
    super(`${valueField || 'The value'} was sent back hidden, ${REASON_ADVICE[reason](valueField || 'the value')}`)
    this.name = 'MaskedValueError'
  }
}

/**
 * Put the stored value back wherever a write carries a mask.
 *
 * `sent` is what a client wants written, `stored` what is on disk at the same
 * place, `at` where that place is in the config (for the error). A mask is
 * paired with a stored value by identity, never by position:
 *  - a masked string in a record takes the stored string at the same key;
 *  - a masked URL password takes the password of the stored URL with the same
 *    address (scheme, user, host, port, path) at the same key, so a host never
 *    gets another host's password, and a password the client typed is written
 *    as typed;
 *  - a list sent back exactly as it was read is restored entry by entry; in a
 *    list the client changed, a masked string with a tail takes the one stored
 *    entry it is a mask of, the bullets-only ones take the stored entries a view
 *    shows that way (`blindPartners`), and a record the stored one with its `id`,
 *    else its `name`, else the one stored record it shows unchanged;
 *  - a `{ name, value }` entry named like a secret keeps its name while its
 *    value is hidden.
 * A mask that matches nothing stored at its place (nothing is stored there, a
 * URL's address changed), or more than one thing, throws `MaskedValueError`, so
 * a mask is never written and never guessed; so does a string that still holds
 * a run of bullets and is not what is stored at its place (`holdsEditedMask`).
 * Nothing else is changed: an edited
 * value, an emptied one and a removed key are written as sent. A value only
 * ever returns to the place it was read from, so this reveals nothing a client
 * could not already read.
 */
export function restoreMaskedSecrets<T>(sent: T, stored: unknown, at = ''): T {
  return restore(sent, stored, at) as T
}

function restore(sent: unknown, stored: unknown, at: string): unknown {
  if (isMaskedSecret(sent)) {
    if (typeof stored !== 'string') throw new MaskedValueError(at, 'missing')
    return stored
  }
  if (typeof sent === 'string' && holdsEditedMask(sent) && sent !== stored) throw new MaskedValueError(at, 'edited_mask')
  if (typeof sent === 'string' && hasMaskedUrlPassword(sent)) {
    // Sent back as read: the stored string, whatever URLs it holds (one address twice, say).
    if (typeof stored === 'string' && maskUrlPasswords(stored) === sent) return stored
    return restoreUrlPasswords(sent, typeof stored === 'string' ? [stored] : [], at)
  }
  if (Array.isArray(sent)) return restoreList(sent, Array.isArray(stored) ? stored : [], at)
  if (isRecord(sent)) {
    const base = isRecord(stored) ? stored : {}
    // A `{ name, value }` entry named like a secret is masked by its name, so its name is
    // part of its place: renamed (or its name removed) with the value still hidden, the value
    // would show in full on every later read.
    if (typeof base.name === 'string' && isSecretKey(base.name) && sent.name !== base.name && hasMask(sent.value)) {
      throw new MaskedValueError(at ? `${at}.name` : 'name', 'renamed', at ? `${at}.value` : 'value')
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(sent)) setOwn(out, k, restore(v, Object.hasOwn(base, k) ? base[k] : undefined, at ? `${at}.${k}` : k))
    return out
  }
  return sent
}

function restoreList(sent: unknown[], pool: unknown[], at: string): unknown[] {
  // Sent back as it was read: each entry is still where it was.
  if (sent.length === pool.length && sent.every((item, i) => shows(item, pool[i]))) {
    return sent.map((item, i) => restore(item, pool[i], `${at}[${i}]`))
  }
  const strings = pool.filter((p): p is string => typeof p === 'string')
  const blind = blindPartners(sent, strings, at)
  return sent.map((item, i) => {
    const where = `${at}[${i}]`
    if (isMaskedSecret(item)) return blind.get(i) ?? maskedEntry(item, strings, where)
    if (typeof item === 'string' && holdsEditedMask(item) && !strings.includes(item)) throw new MaskedValueError(where, 'edited_mask')
    if (typeof item === 'string' && hasMaskedUrlPassword(item)) return listUrlEntry(item, strings, where)
    if (typeof item === 'string') return item
    if (!hasMask(item)) {
      refuseEditedMasks(item, pool, where)
      return item
    }
    return restore(item, partnerOf(item, pool, where), where)
  })
}

/**
 * A changed list's record (or nested list) with no mask in it is written as sent, so a string in it
 * that holds an edited mask is refused, unless the entry is one stored in the list unchanged.
 */
function refuseEditedMasks(item: unknown, pool: unknown[], at: string): void {
  const text = JSON.stringify(item)
  if (pool.some((p) => JSON.stringify(p) === text)) return
  const where = editedMaskAt(item, at)
  if (where !== null) throw new MaskedValueError(where, 'edited_mask')
}

function editedMaskAt(v: unknown, at: string): string | null {
  if (typeof v === 'string') return holdsEditedMask(v) ? at : null
  if (Array.isArray(v)) {
    for (const [i, x] of v.entries()) {
      const hit = editedMaskAt(x, `${at}[${i}]`)
      if (hit !== null) return hit
    }
    return null
  }
  if (isRecord(v)) {
    for (const [k, x] of Object.entries(v)) {
      const hit = editedMaskAt(x, `${at}.${k}`)
      if (hit !== null) return hit
    }
  }
  return null
}

/** A masked string with a tail in a changed list: the one stored entry it is a mask of. */
function maskedEntry(mask: string, strings: string[], at: string): string {
  const hits = [...new Set(strings.filter((p) => maskSecretTail(p) === mask))]
  if (hits.length !== 1) throw new MaskedValueError(at, hits.length ? 'ambiguous' : 'unmatched')
  return hits[0]!
}

/**
 * The bullets-only entries of a changed list, by position in `sent`: they stand
 * for the stored entries a view shows without a tail (`listEntriesWithoutTail`).
 * All of them sent back pair in order: they look alike, so their order is the
 * only thing a client could not have changed. Fewer or more pair only when they
 * all stand for one value (copies of one secret), or, where no entry is shown
 * that way, when one comes back and one value is stored (the six bullets of a
 * view that shows no tails). Anything else is ambiguous.
 */
function blindPartners(sent: unknown[], strings: string[], at: string): Map<number, string> {
  const out = new Map<number, string>()
  const where = sent.flatMap((item, i) => (isBlindMask(item) ? [i] : []))
  if (where.length === 0) return out
  const hidden = listEntriesWithoutTail(strings)
  const opaque = strings.filter((v) => hidden.has(v))
  if (where.length === opaque.length) {
    where.forEach((i, n) => out.set(i, opaque[n]!))
    return out
  }
  const distinct = [...new Set(opaque.length ? opaque : strings)]
  if (distinct.length === 1 && (opaque.length > 0 || where.length === 1)) {
    for (const i of where) out.set(i, distinct[0]!)
    return out
  }
  throw new MaskedValueError(`${at}[${where[0]}]`, distinct.length ? 'ambiguous' : 'missing')
}

/** A string with a masked URL password in a changed list: a stored entry it shows unchanged, else URL by URL. */
function listUrlEntry(sent: string, candidates: string[], at: string): string {
  const same = [...new Set(candidates.filter((c) => maskUrlPasswords(c) === sent))]
  return same.length === 1 ? same[0]! : restoreUrlPasswords(sent, candidates, at)
}

/**
 * A masked URL password takes the password of the stored URL with the same
 * address, among the stored strings at the same place (`candidates`: the one at
 * the same key, or the entries of the same list). An address stored with more
 * than one password, or not stored at all, is refused.
 */
function restoreUrlPasswords(sent: string, candidates: string[], at: string): string {
  const known = new Map<string, Set<string>>()
  for (const c of candidates) {
    for (const m of c.matchAll(URL_PASSWORD)) {
      const address = `${m[1]}@${m[3]}`
      known.set(address, (known.get(address) ?? new Set()).add(m[2]!))
    }
  }
  let refused: MaskedValueReason | null = null
  const out = sent.replace(URL_PASSWORD, (whole, head: string, password: string, address: string) => {
    if (!MASKED_URL_PASSWORD.test(password)) return whole
    const own = known.get(`${head}@${address}`)
    if (!own || own.size !== 1) { refused ??= own ? 'ambiguous' : 'missing'; return whole }
    return `${head}${[...own][0]}@${address}`
  })
  if (refused) throw new MaskedValueError(at, refused)
  return out
}

/** The stored record (or nested list) a changed list's entry with a mask in it stands for. */
function partnerOf(item: unknown, pool: unknown[], at: string): unknown {
  const kin = pool.filter((p) => (isRecord(item) ? isRecord(p) : Array.isArray(p)))
  if (isRecord(item)) {
    for (const id of ['id', 'name']) {
      if (typeof item[id] !== 'string') continue
      const own = kin.filter((p) => (p as Record<string, unknown>)[id] === item[id])
      if (own.length === 1) {
        if (id === 'name') refuseMovedValue(item, own[0] as Record<string, unknown>, kin, at)
        return own[0]
      }
      if (own.length > 1) throw new MaskedValueError(`${at}.${id}`, 'ambiguous')
      // An entry with no stored namesake and its value hidden (under `value`, `token` or any key of its
      // own): renamed (or gone). The message names the key that holds the value.
      const hidden = id === 'name' ? hiddenValueKey(item) : null
      if (hidden !== null) throw new MaskedValueError(`${at}.name`, 'renamed', `${at}.${hidden}`)
      throw new MaskedValueError(`${at}.${id}`, 'missing')
    }
  }
  // A record whose `name` is there but no longer a string (null, a number) is found by what it
  // shows apart from its name, as one whose name was removed is; `restore` then refuses it as
  // renamed when the stored record is named like a secret.
  const probe = isRecord(item) && Object.hasOwn(item, 'name') && typeof item.name !== 'string' ? withoutName(item) : item
  const hits = [...new Map(kin.filter((p) => shows(probe, p)).map((p) => [JSON.stringify(p), p])).values()]
  if (hits.length !== 1) throw new MaskedValueError(at, hits.length ? 'ambiguous' : 'unmatched')
  return hits[0]
}

/** The first key of a record, other than its `id` and `name`, whose value holds a mask. */
function hiddenValueKey(item: Record<string, unknown>): string | null {
  return Object.keys(item).find((k) => k !== 'id' && k !== 'name' && hasMask(item[k])) ?? null
}

function withoutName(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(item)) if (k !== 'name') setOwn(out, k, v)
  return out
}

/**
 * A record paired by `name` whose hidden value shows another stored record's tail
 * and not its namesake's: a rename onto the name of a record the same write
 * drops (or a swap of two names). Taking the namesake's value would put a value
 * under a name it was not read under, so it is refused as renamed. A tail that
 * matches no stored record (the value changed after it was read) keeps the
 * namesake's, as anywhere else. Every key of the record counts (`value`, `token`,
 * `secret`), and the refusal names the one that holds the moved value.
 */
function refuseMovedValue(item: Record<string, unknown>, partner: Record<string, unknown>, kin: unknown[], at: string): void {
  for (const [k, v] of Object.entries(item)) {
    if (!isMaskedSecret(v) || isBlindMask(v)) continue
    const own = partner[k]
    if (typeof own === 'string' && maskShows(v, own)) continue
    const other = kin.some((p) => p !== partner && isRecord(p) && typeof p[k] === 'string' && maskSecretTail(p[k] as string) === v)
    if (other) throw new MaskedValueError(`${at}.name`, 'renamed', `${at}.${k}`)
  }
}

/** Whether `mask` is what a client view shows in place of `stored`: its tail, or bullets only. */
function maskShows(mask: string, stored: string): boolean {
  return mask === maskSecretTail(stored) || isBlindMask(mask)
}

/** Whether `sent` is what a client view shows for `stored`: the same, with masks where the view puts them. */
function shows(sent: unknown, stored: unknown): boolean {
  if (typeof sent === 'string') {
    if (typeof stored !== 'string') return false
    return sent === stored || (isMaskedSecret(sent) && maskShows(sent, stored)) || (sent.includes('://') && maskUrlPasswords(stored) === sent)
  }
  if (Array.isArray(sent)) return Array.isArray(stored) && stored.length === sent.length && sent.every((v, i) => shows(v, stored[i]))
  if (isRecord(sent)) return isRecord(stored) && Object.entries(sent).every(([k, v]) => Object.hasOwn(stored, k) && shows(v, stored[k]))
  return sent === stored
}

/** Whether a value has a mask anywhere in it. */
function hasMask(v: unknown): boolean {
  if (typeof v === 'string') return isMaskedSecret(v) || hasMaskedUrlPassword(v)
  if (Array.isArray(v)) return v.some(hasMask)
  if (isRecord(v)) return Object.values(v).some(hasMask)
  return false
}
