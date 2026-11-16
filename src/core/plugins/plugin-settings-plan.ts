/**
 * What an AI may change in one plugin's settings (`plugins.<id>` in config.yaml), decided from the
 * plugin's own manifest `configSchema` and `uiHints`, the one description of its settings every
 * plugin already ships (the generated Settings form draws the same fields). Pure: the caller reads
 * and writes config (src/core/plugins/plugin-settings.ts).
 *
 * The rules, the same for every plugin:
 *  - A declared field takes a value that fits its schema (type, enum, bounds, an object's
 *    properties, a list's items); anything else is refused with the schema's reason.
 *  - A key the plugin stores without declaring it (a plugin App drawing its own form, as
 *    coderelay's endpoints are) takes a value of the same JSON shape as the stored one, so a
 *    plugin that never wrote a schema is still configurable.
 *  - A secret is never added, changed or removed here: the person does that on the plugin's page.
 *    A secret is a value under a key that reads like one, a field marked `format: password` or
 *    `writeOnly` (at any depth), or a URL's password. A value read back masked and sent unchanged
 *    is fine: it is put back as stored. Every value an answer shows has its secrets masked.
 *  - `enabled` is the plugin's switch, not a setting: it is turned on and off on its page.
 *  - All or nothing: one refused key and nothing is written.
 */

import { MaskedValueError, PLUGIN_FORM_MASK, isSecretKey, maskByKey, maskPluginFormValues, maskUrlPasswords, restoreMaskedSecrets } from '../config-secret-shape.js'
import { KNOWN_FIELD_TYPES, KNOWN_SCHEMA_KEYWORDS, isSecretField, jsonTypeOf, validateConfigValue, type PluginFieldSchema } from './plugin-config-schema.js'

export interface PluginSchemaInput {
  configSchema?: Record<string, unknown> | null
  uiHints?: Record<string, { label?: string; help?: string }> | null
}

export interface PluginSettingsField {
  key: string
  label: string
  help?: string
  /** The schema's `type`; for a key the plugin stores without declaring it, the stored value's. */
  type: string
  declared: boolean
  required: boolean
  /** Only the person types it. */
  secret: boolean
  /** Whether config.yaml holds a value now. */
  set: boolean
  /** The stored value, every secret in it masked. */
  value?: unknown
  default?: unknown
  enum?: unknown[]
  minimum?: number
  maximum?: number
  /** For a list or an object: the schema of what is inside, as the manifest says it. */
  items?: unknown
  properties?: unknown
}

const own = <T>(map: Record<string, T> | null | undefined, key: string): T | undefined =>
  (map && Object.hasOwn(map, key) ? map[key] : undefined)

function schemaProps(input: PluginSchemaInput): Record<string, PluginFieldSchema> {
  const props = (input.configSchema as { properties?: unknown } | null | undefined)?.properties
  return props && typeof props === 'object' && !Array.isArray(props) ? props as Record<string, PluginFieldSchema> : {}
}

function requiredKeys(input: PluginSchemaInput): string[] {
  const req = (input.configSchema as { required?: unknown } | null | undefined)?.required
  return Array.isArray(req) ? req.filter((k): k is string => typeof k === 'string') : []
}

/** The switch, written by the loader and the page, never by a settings change. */
const NOT_A_SETTING = new Set(['enabled'])

/** A name every JS object already has (`constructor`, `toString`): never a setting's key. */
const reservedName = (key: string): boolean => key === '__proto__' || key in Object.prototype

/** Calls `visit` on every string of `value` that the schema marks secret, at any depth. */
function walkSchemaSecrets(value: unknown, schema: PluginFieldSchema | undefined, secret: boolean, visit: (v: string) => string): unknown {
  if (typeof value === 'string') return secret && value.length > 0 ? visit(value) : value
  if (Array.isArray(value)) return value.map((v) => walkSchemaSecrets(v, schema?.items, secret, visit))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      const sub = own(schema?.properties, k) ?? (typeof schema?.additionalProperties === 'object' ? schema.additionalProperties : undefined)
      Object.defineProperty(out, k, {
        value: walkSchemaSecrets(v, sub, secret || sub?.format === 'password' || sub?.writeOnly === true, visit),
        enumerable: true, writable: true, configurable: true,
      })
    }
    return out
  }
  return value
}

/** One setting's value as an answer may show it: secrets by key and by schema masked. */
function maskSetting(key: string, value: unknown, schema: PluginFieldSchema | undefined): unknown {
  const byKey = maskPluginFormValues({ [key]: value })[key]
  return walkSchemaSecrets(byKey, schema, isSecretField(key, schema), () => PLUGIN_FORM_MASK)
}

/** Every secret string in one setting's value (a URL with a password counts whole), for a multiset compare. */
function secretsIn(key: string, value: unknown, schema: PluginFieldSchema | undefined): string[] {
  const out: string[] = []
  maskByKey({ [key]: value }, (v) => { out.push(v); return v })
  walkSchemaSecrets(value, schema, isSecretField(key, schema), (v) => { out.push(v); return v })
  const walkUrls = (v: unknown): void => {
    if (typeof v === 'string') { if (maskUrlPasswords(v) !== v) out.push(v); return }
    if (Array.isArray(v)) { v.forEach(walkUrls); return }
    if (v && typeof v === 'object') Object.values(v).forEach(walkUrls)
  }
  walkUrls(value)
  return out
}

/** How many secrets of `a` are not in `b` (a multiset difference). */
function secretsMissing(a: string[], b: string[]): number {
  const pool = new Map<string, number>()
  for (const s of b) pool.set(s, (pool.get(s) ?? 0) + 1)
  let missing = 0
  for (const s of a) {
    const n = pool.get(s) ?? 0
    if (n > 0) pool.set(s, n - 1)
    else missing++
  }
  return missing
}

/** Every setting of the plugin: its declared fields in manifest order, then what it stores undeclared. */
export function describePluginFields(input: PluginSchemaInput, stored: Record<string, unknown>): PluginSettingsField[] {
  const props = schemaProps(input)
  const required = new Set(requiredKeys(input))
  const hints = input.uiHints ?? {}
  const has = (key: string) => Object.hasOwn(stored, key) && stored[key] !== undefined
  const fields: PluginSettingsField[] = Object.entries(props).map(([key, schema]) => {
    const help = own(hints, key)?.help ?? schema.description
    return {
      key,
      label: own(hints, key)?.label ?? key,
      ...(help ? { help } : {}),
      type: typeof schema.type === 'string' ? schema.type : 'unknown',
      declared: true,
      required: required.has(key),
      secret: isSecretField(key, schema),
      set: has(key),
      ...(has(key) ? { value: maskSetting(key, stored[key], schema) } : {}),
      ...(schema.default !== undefined ? { default: schema.default } : {}),
      ...(Array.isArray(schema.enum) ? { enum: schema.enum } : {}),
      ...(typeof schema.minimum === 'number' ? { minimum: schema.minimum } : {}),
      ...(typeof schema.maximum === 'number' ? { maximum: schema.maximum } : {}),
      ...(schema.items ? { items: schema.items } : {}),
      ...(schema.properties || typeof schema.additionalProperties === 'object' ? { properties: schema.properties ?? { '*': schema.additionalProperties } } : {}),
    }
  })
  for (const [key, value] of Object.entries(stored)) {
    if (Object.hasOwn(props, key) || NOT_A_SETTING.has(key) || value === undefined) continue
    fields.push({
      key, label: own(hints, key)?.label ?? key, type: jsonTypeOf(value), declared: false, required: false,
      secret: isSecretKey(key), set: true, value: maskSetting(key, value, undefined),
    })
  }
  return fields
}

/**
 * Whether the validator checks every rule this field states: a type it knows and only keywords it
 * enforces or that only describe, all the way down (a list's items, an object's properties). The
 * ratchet in tests/core/plugins/plugin-settings-every-plugin.test.ts holds every shipped manifest to it.
 */
export function fieldIsCheckable(schema: PluginFieldSchema | undefined): boolean {
  if (!schema || typeof schema.type !== 'string' || !KNOWN_FIELD_TYPES.has(schema.type)) return false
  if (Object.keys(schema).some((k) => !KNOWN_SCHEMA_KEYWORDS.has(k))) return false
  if (schema.type === 'array' && schema.items && !fieldIsCheckable(schema.items)) return false
  if (schema.type === 'object') {
    for (const p of Object.values(schema.properties ?? {})) if (!fieldIsCheckable(p)) return false
    if (typeof schema.additionalProperties === 'object' && !fieldIsCheckable(schema.additionalProperties)) return false
  }
  return true
}

export interface SettingsChange {
  set?: Record<string, unknown>
  unset?: string[]
}

export interface PlannedChange { key: string; label: string; from?: unknown; to?: unknown; removed?: boolean }
export interface PlanRefusal { key: string; label: string; reason: string }

export interface SettingsPlan {
  /** The section to write, or null when nothing may be written (a refusal) or nothing changes. */
  next: Record<string, unknown> | null
  changes: PlannedChange[]
  unchanged: string[]
  /** Keys whose value breaks the schema, or that the plugin has no setting for. */
  refused: PlanRefusal[]
  /** Secrets: the person types them on the plugin's page. */
  needsPerson: PlanRefusal[]
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const SWITCH = 'This is the plugin\'s on/off switch, not a setting: turn it on or off on its page in Apps.'

/**
 * The change `change` makes to `stored`, under the plugin's schema. `pluginId` only names places in
 * the reasons. Never throws on a bad value: each one is a refusal the caller reports.
 */
export function planPluginSettings(
  pluginId: string,
  input: PluginSchemaInput,
  stored: Record<string, unknown>,
  change: SettingsChange,
): SettingsPlan {
  const props = schemaProps(input)
  const required = new Set(requiredKeys(input))
  const additional = (input.configSchema as { additionalProperties?: unknown } | null | undefined)?.additionalProperties
  const hints = input.uiHints ?? {}
  const label = (key: string) => own(hints, key)?.label ?? key
  const isStored = (key: string) => Object.hasOwn(stored, key) && stored[key] !== undefined
  const known = [...Object.keys(props), ...Object.keys(stored).filter((k) => !Object.hasOwn(props, k) && !NOT_A_SETTING.has(k))]
  const next: Record<string, unknown> = { ...stored }
  const plan: SettingsPlan = { next: null, changes: [], unchanged: [], refused: [], needsPerson: [] }
  const refuse = (key: string, reason: string) => plan.refused.push({ key, label: label(key), reason })
  const askPerson = (key: string, reason: string) => plan.needsPerson.push({ key, label: label(key), reason })

  for (const [key, raw] of Object.entries(change.set ?? {})) {
    if (NOT_A_SETTING.has(key)) { refuse(key, SWITCH); continue }
    if (reservedName(key)) { refuse(key, `${key} cannot be a setting's name.`); continue }
    const declared = own(props, key)
    const schema = declared ?? (!isStored(key) && additional && typeof additional === 'object' ? additional as PluginFieldSchema : undefined)
    const secretField = isSecretField(key, schema)
    const before = isStored(key) ? stored[key] : undefined
    let value: unknown
    try {
      value = restoreMaskedSecrets(raw, before, `plugins.${pluginId}.${key}`)
    } catch (err) {
      if (!(err instanceof MaskedValueError)) throw err
      // A mask that pairs with nothing stored: for a setting that keeps a secret, only the person can
      // type it again (a renamed entry, say); anywhere else the mask is just a wrong value.
      if (secretField || secretsIn(key, before, schema).length > 0) askPerson(key, `${label(key)} keeps a secret this change cannot carry over: the person types it on the plugin's page, never an AI. (${err.message})`)
      else refuse(key, err.message)
      continue
    }
    if (schema) {
      const errors = validateConfigValue(value, schema, key)
      if (errors.length > 0) { refuse(key, errors.join('; ')); continue }
    } else if (isStored(key)) {
      const want = jsonTypeOf(before)
      if (jsonTypeOf(value) !== want) { refuse(key, `${key} holds a ${want} now; the plugin does not describe it, so it keeps that shape.`); continue }
    } else {
      refuse(key, known.length > 0
        ? `The plugin has no setting named ${key}. Its settings: ${known.join(', ')}.`
        : 'The plugin describes no settings, and none is stored yet.')
      continue
    }
    if (sameValue(value, before)) { plan.unchanged.push(key); continue }
    const was = secretsIn(key, before, schema)
    const will = secretsIn(key, value, schema)
    if (secretField || secretsMissing(will, was) > 0) {
      askPerson(key, `${label(key)} holds a secret: the person types it on the plugin's page, never an AI.`)
      continue
    }
    if (secretsMissing(was, will) > 0) {
      askPerson(key, `This change would remove a secret kept in ${label(key)}: the person removes it on the plugin's page, never an AI.`)
      continue
    }
    next[key] = value
    plan.changes.push({ key, label: label(key), ...(before !== undefined ? { from: maskSetting(key, before, schema) } : {}), to: maskSetting(key, value, schema) })
  }

  for (const key of change.unset ?? []) {
    if (NOT_A_SETTING.has(key)) { refuse(key, SWITCH); continue }
    if (change.set && Object.hasOwn(change.set, key)) { refuse(key, 'Both set and removed in one change.'); continue }
    if (!isStored(key)) { plan.unchanged.push(key); continue }
    if (required.has(key)) { refuse(key, `${label(key)} is required: the plugin does not run without it. Set another value instead.`); continue }
    const schema = own(props, key)
    if (isSecretField(key, schema) || secretsIn(key, stored[key], schema).length > 0) {
      askPerson(key, `${label(key)} holds a secret: the person removes it on the plugin's page, never an AI.`)
      continue
    }
    delete next[key]
    plan.changes.push({ key, label: label(key), from: maskSetting(key, stored[key], schema), removed: true })
  }

  if (plan.refused.length === 0 && plan.needsPerson.length === 0 && plan.changes.length > 0) plan.next = next
  return plan
}
