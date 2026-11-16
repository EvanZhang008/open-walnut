/**
 * The slice of JSON Schema a plugin's manifest `configSchema` uses, read the same way by every
 * place that edits `plugins.<id>` in config.yaml: the generated Settings form in the browser
 * (web/src/components/settings/plugin-config-fields.ts re-exports the field helpers), the loader's
 * check at load, and the AI's `plugin_settings_set` (src/core/plugins/plugin-settings.ts).
 *
 * Browser-safe and pure: no node imports, no I/O.
 */

import { isSecretKey } from '../config-secret-shape.js'

export interface PluginFieldSchema {
  type?: string
  default?: unknown
  description?: string
  enum?: unknown[]
  items?: PluginFieldSchema
  properties?: Record<string, PluginFieldSchema>
  required?: string[]
  additionalProperties?: boolean | PluginFieldSchema
  /** JSON Schema bounds for a number or integer. The form's input carries them and a save clamps to them. */
  minimum?: number
  maximum?: number
  multipleOf?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  minItems?: number
  maxItems?: number
  /** `password` marks a secret a person types, whatever its key is called. */
  format?: string
  writeOnly?: boolean
}

/** The control the generated form draws for a field. */
export type PluginFieldKind = 'boolean' | 'text' | 'number' | 'integer' | 'list'

/** The control for this schema, or `null` for "not drawn by the form" (an object, a list of objects). */
export function fieldKindFor(schema: PluginFieldSchema | undefined): PluginFieldKind | null {
  switch (schema?.type) {
    case 'boolean': return 'boolean'
    case 'string': return 'text'
    case 'number': return 'number'
    case 'integer': return 'integer'
    case 'array': return schema.items?.type === 'string' ? 'list' : null
    default: return null
  }
}

/** The `min` / `max` / `step` a numeric input gets. Absent bounds stay absent. */
export function fieldBounds(schema: PluginFieldSchema | undefined): { min?: number; max?: number; step?: number } {
  const kind = fieldKindFor(schema)
  if (kind !== 'number' && kind !== 'integer') return {}
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const min = num(schema?.minimum)
  const max = num(schema?.maximum)
  const step = num(schema?.multipleOf) ?? (kind === 'integer' ? 1 : undefined)
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(step !== undefined ? { step } : {}) }
}

/**
 * A field whose value is a secret only a person types: its key reads like one (`api_key`,
 * `backup_tokens`, the rule the server masks values with) or its schema says so.
 */
export function isSecretField(key: string, schema: PluginFieldSchema | undefined): boolean {
  return isSecretKey(key) || schema?.format === 'password' || schema?.writeOnly === true
}

/** The JSON type of a value as JSON Schema names it (`integer` is reported as `number`). */
export function jsonTypeOf(value: unknown): 'array' | 'object' | 'string' | 'number' | 'boolean' | 'null' | 'undefined' {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'undefined') return t
  return 'object'
}

/** The schema types this validator understands. A field of any other type cannot be checked. */
export const KNOWN_FIELD_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object'])

/**
 * Every schema keyword this validator enforces, or that only describes (a title, a default, a
 * format other than `password`). A field using any other keyword (`oneOf`, `const`,
 * `exclusiveMinimum`) holds a rule nobody checks, so the ratchet refuses it.
 */
export const KNOWN_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'type', 'title', 'description', 'default', 'examples', 'format', 'writeOnly',
  'enum', 'minimum', 'maximum', 'multipleOf', 'minLength', 'maxLength', 'pattern',
  'items', 'minItems', 'maxItems', 'properties', 'required', 'additionalProperties',
])

/**
 * Every way `value` breaks `schema`, as `<path>: <why>` lines; `[]` when it fits. Checks the type
 * (integer included), enum, numeric bounds, an object's required keys and declared properties
 * (and `additionalProperties` when it is a schema), and every item of an array.
 */
export function validateConfigValue(value: unknown, schema: PluginFieldSchema | Record<string, unknown>, fieldPath: string): string[] {
  const s = schema as PluginFieldSchema
  const errors: string[] = []
  const schemaType = s.type

  if (schemaType) {
    const actualType = jsonTypeOf(value)
    if (schemaType === 'integer') {
      if (typeof value !== 'number' || !Number.isInteger(value)) errors.push(`${fieldPath}: expected integer, got ${actualType}`)
    } else if (actualType !== schemaType) {
      errors.push(`${fieldPath}: expected ${schemaType}, got ${actualType}`)
    }
  }
  if (errors.length > 0) return errors

  if ((schemaType === 'number' || schemaType === 'integer') && typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) errors.push(`${fieldPath}: must be at least ${s.minimum}`)
    if (typeof s.maximum === 'number' && value > s.maximum) errors.push(`${fieldPath}: must be at most ${s.maximum}`)
    if (typeof s.multipleOf === 'number' && s.multipleOf > 0 && Math.abs(value / s.multipleOf - Math.round(value / s.multipleOf)) > 1e-9) {
      errors.push(`${fieldPath}: must be a multiple of ${s.multipleOf}`)
    }
  }

  if (schemaType === 'string' && typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) errors.push(`${fieldPath}: must be at least ${s.minLength} characters`)
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) errors.push(`${fieldPath}: must be at most ${s.maxLength} characters`)
    if (typeof s.pattern === 'string') {
      let re: RegExp | null = null
      try { re = new RegExp(s.pattern, 'u') } catch { errors.push(`${fieldPath}: the plugin's pattern cannot be read`) }
      if (re && !re.test(value)) errors.push(`${fieldPath}: must match ${s.pattern}`)
    }
  }

  if (schemaType === 'array' && Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) errors.push(`${fieldPath}: needs at least ${s.minItems} entries`)
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) errors.push(`${fieldPath}: takes at most ${s.maxItems} entries`)
  }

  if (schemaType === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    for (const key of s.required ?? []) {
      if (!(key in record)) errors.push(`${fieldPath}.${key}: required field missing`)
    }
    const properties = s.properties ?? {}
    for (const [key, propValue] of Object.entries(record)) {
      if (propValue === undefined) continue
      const propSchema = (Object.hasOwn(properties, key) ? properties[key] : undefined)
        ?? (typeof s.additionalProperties === 'object' ? s.additionalProperties : undefined)
      if (propSchema) errors.push(...validateConfigValue(propValue, propSchema, `${fieldPath}.${key}`))
    }
  }

  if (schemaType === 'array' && Array.isArray(value) && s.items) {
    for (let i = 0; i < value.length; i++) errors.push(...validateConfigValue(value[i], s.items, `${fieldPath}[${i}]`))
  }

  if (Array.isArray(s.enum) && !s.enum.includes(value)) {
    errors.push(`${fieldPath}: value must be one of [${s.enum.join(', ')}]`)
  }

  return errors
}
