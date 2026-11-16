/**
 * Every plugin can be configured by an AI (2026-11-16, the user: "all plugin should be configured
 * by ai"). The AI's writer (plugin_settings_set) is generic: it reads each plugin's own manifest
 * `configSchema`, so a plugin is covered only if every field it declares is one the writer can
 * check and write. This ratchet finds every plugin manifest in the repo by walking the folders
 * plugins ship from, so a NEW plugin (or a new field of an old one) is held to it the day it lands:
 *
 *  - each field's type is one the validator knows, all the way down (no field the AI cannot check);
 *  - a valid value made from the field's own schema is accepted, or, for a secret, left to the
 *    person (needsPerson), never refused as unknown;
 *  - the reader lists every declared field.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { describePluginFields, fieldIsCheckable, planPluginSettings } from '../../../src/core/plugins/plugin-settings-plan.js'
import { isSecretField, type PluginFieldSchema } from '../../../src/core/plugins/plugin-config-schema.js'

const ROOT = path.resolve(__dirname, '../../..')
/** Where plugin manifests live in this repo: built-ins, the bundled store, examples, test fixtures. */
const PLUGIN_DIRS = ['src/integrations', 'plugin-store', 'examples/plugins', 'tests/e2e/browser/fixtures', 'tests/fixtures/plugins']

function manifests(): Array<{ file: string; id: string; configSchema?: Record<string, unknown>; uiHints?: Record<string, { label?: string }> }> {
  const out: Array<{ file: string; id: string; configSchema?: Record<string, unknown>; uiHints?: Record<string, { label?: string }> }> = []
  for (const dir of PLUGIN_DIRS) {
    const abs = path.join(ROOT, dir)
    if (!fs.existsSync(abs)) continue
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = path.join(abs, entry.name, 'manifest.json')
      if (!fs.existsSync(file)) continue
      const m = JSON.parse(fs.readFileSync(file, 'utf-8')) as { id?: string; configSchema?: Record<string, unknown>; uiHints?: Record<string, { label?: string }> }
      out.push({ file: path.relative(ROOT, file), id: m.id ?? entry.name, configSchema: m.configSchema, uiHints: m.uiHints })
    }
  }
  return out
}

/** A value that fits `schema`, made from the schema alone. */
function sampleFor(schema: PluginFieldSchema): unknown {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
  if (schema.default !== undefined) return schema.default
  switch (schema.type) {
    case 'string': return 'sample'
    case 'boolean': return true
    case 'integer': return Math.max(Math.ceil(schema.minimum ?? 1), 1)
    case 'number': return schema.minimum ?? 1.5
    case 'array': return schema.items ? [sampleFor(schema.items)] : []
    case 'object': {
      const props = schema.properties ?? {}
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(props)) if (!isSecretField(k, v)) out[k] = sampleFor(v)
      for (const k of schema.required ?? []) if (!(k in out) && props[k]) out[k] = sampleFor(props[k])
      if (typeof schema.additionalProperties === 'object') out.sample = sampleFor(schema.additionalProperties)
      return out
    }
    default: return undefined
  }
}

const all = manifests()

describe('the ratchet itself', () => {
  it('fails a field whose type or keyword the writer cannot check', () => {
    expect(fieldIsCheckable({ type: 'tuple' })).toBe(false)
    expect(fieldIsCheckable({})).toBe(false)
    expect(fieldIsCheckable({ type: 'string', oneOf: [] } as never)).toBe(false)
    expect(fieldIsCheckable({ type: 'array', items: { type: 'string', const: 'x' } as never })).toBe(false)
    expect(fieldIsCheckable({ type: 'object', properties: { a: { type: 'integer', exclusiveMinimum: 0 } as never } })).toBe(false)
    expect(fieldIsCheckable({ type: 'integer', minimum: 1, maximum: 9, multipleOf: 1 })).toBe(true)
  })
})

describe('every plugin in the repo is configurable by an AI', () => {
  it('finds the plugins it guards', () => {
    // A move of the plugin folders must not quietly empty this test.
    expect(all.length).toBeGreaterThanOrEqual(10)
    expect(all.map((m) => m.id)).toEqual(expect.arrayContaining(['mail', 'calendar', 'jira', 'walnut-rhythm']))
  })

  for (const m of all) {
    const props = ((m.configSchema as { properties?: Record<string, PluginFieldSchema> } | undefined)?.properties) ?? {}
    if (Object.keys(props).length === 0) continue
    describe(m.file, () => {
      for (const [key, schema] of Object.entries(props)) {
        it(`${key}: the AI can check and write it`, () => {
          expect(fieldIsCheckable(schema), `${m.id}.${key} states a rule the AI's writer cannot check (its type, or a keyword outside KNOWN_SCHEMA_KEYWORDS): ${JSON.stringify(schema)}`).toBe(true)
          const value = sampleFor(schema)
          const plan = planPluginSettings(m.id, { configSchema: m.configSchema, uiHints: m.uiHints }, {}, { set: { [key]: value } })
          if (isSecretField(key, schema)) {
            expect(plan.needsPerson.map((r) => r.key)).toEqual([key])
          } else {
            expect(plan.refused, `${m.id}.${key} refused ${JSON.stringify(value)}`).toEqual([])
            expect(plan.needsPerson).toEqual([])
            expect(plan.next?.[key]).toEqual(value)
          }
        })
      }
      it('the reader lists every declared field', () => {
        expect(describePluginFields({ configSchema: m.configSchema, uiHints: m.uiHints }, {}).map((f) => f.key)).toEqual(Object.keys(props))
      })
    })
  }
})
