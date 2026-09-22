/**
 * Which plugin config fields Settings actually draws.
 *
 * `PluginConfigCards` is the ONE renderer every plugin's Settings form goes through, and a field type
 * it does not recognise renders nothing at all — no label, no input, no error. That is how five of
 * Mail's seven fields (all `integer`) and both of Calendar's `array` fields were invisible in Settings
 * while being perfectly valid in config.yaml. The split is graded here against the REAL shipped
 * manifests, so a plugin that adds a field type nobody renders shows up as a failing test rather than
 * as a form with a gap in it.
 *
 * The rendering rules themselves live in a pure module because this file is the cheap layer: a
 * Playwright spec proves one field works, a table proves every type is accounted for.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  fieldKindFor,
  listPlaceholder,
  listTextFor,
  parseListText,
  valueForSave,
  type PluginFieldSchema,
} from '../../web/src/components/settings/plugin-config-fields'

const REPO = path.resolve(import.meta.dirname, '../..')

function manifestFields(rel: string): Record<string, PluginFieldSchema> {
  const manifest = JSON.parse(readFileSync(path.join(REPO, rel), 'utf8')) as {
    configSchema?: { properties?: Record<string, PluginFieldSchema> }
  }
  return manifest.configSchema?.properties ?? {}
}

const kindsOf = (fields: Record<string, PluginFieldSchema>) =>
  Object.fromEntries(Object.entries(fields).map(([key, schema]) => [key, fieldKindFor(schema)]))

describe('fieldKindFor', () => {
  it('keeps the field set for the types that already rendered', () => {
    // The three that worked before this change, unchanged: a boolean is a switch, a string is a text
    // box, a number is a number box. If any of these moves, every plugin's form moves with it.
    expect(fieldKindFor({ type: 'boolean' })).toBe('boolean')
    expect(fieldKindFor({ type: 'string' })).toBe('text')
    expect(fieldKindFor({ type: 'number' })).toBe('number')
  })

  it('renders an integer as a number box', () => {
    expect(fieldKindFor({ type: 'integer' })).toBe('integer')
    expect(fieldKindFor({ type: 'integer', default: 15 })).toBe('integer')
  })

  it('renders an array of strings as a list, and nothing else as anything', () => {
    expect(fieldKindFor({ type: 'array', items: { type: 'string' } })).toBe('list')
    // An array of objects has no honest one-line form; a half-rendered nested form is worse than
    // sending the user to config.yaml.
    expect(fieldKindFor({ type: 'array', items: { type: 'object' } })).toBeNull()
    expect(fieldKindFor({ type: 'array' })).toBeNull()
    expect(fieldKindFor({ type: 'object' })).toBeNull()
    expect(fieldKindFor({})).toBeNull()
    expect(fieldKindFor(undefined)).toBeNull()
  })

  it('makes every field of the shipped Mail manifest visible (5 of 7 used to be missing)', () => {
    const fields = kindsOf(manifestFields('src/integrations/mail/manifest.json'))
    expect(fields).toMatchObject({
      poll_interval_seconds: 'integer',
      retention_days: 'integer',
      digest_enabled: 'boolean',
      digest_time: 'text',
    })
    // The invariant, not the inventory: a field added to a first-party manifest in a type nobody
    // renders must fail HERE rather than as a gap in Settings nobody notices.
    expect(Object.entries(fields).filter(([, kind]) => kind === null)).toEqual([])
  })

  it('makes the shipped Calendar manifest whole: string arrays and integers', () => {
    const fields = kindsOf(manifestFields('src/integrations/calendar/manifest.json'))
    expect(fields).toMatchObject({
      source_enabled: 'boolean',
      hidden_calendar_ids: 'list',
      visible_calendar_ids: 'list',
      refresh_minutes: 'integer',
    })
    expect(Object.entries(fields).filter(([, kind]) => kind === null)).toEqual([])
  })

  it('leaves the object-shaped fields of the shipped manifests to config.yaml', () => {
    // `accounts` is a list of credentialed account objects: there is no honest one-line control for
    // it, and guessing one would be a form that silently drops half of what the user typed.
    expect(kindsOf(manifestFields('src/integrations/mail-imap/manifest.json'))).toMatchObject({
      accounts: null,
      append_sent: 'boolean',
      server_saves_sent: 'boolean',
    })
    const tracker = kindsOf(manifestFields('src/integrations/jira/manifest.json'))
    expect(tracker.auth).toBeNull()
    expect(tracker.project_mapping).toBeNull()
    expect(tracker.base_url).toBe('text')
    expect(tracker.sync_interval_ms).toBe('number')
  })
})

describe('an integer field saves as a number', () => {
  it('passes the value through untouched — the control already produced a number', () => {
    expect(valueForSave({ type: 'integer' }, 10)).toBe(10)
    expect(valueForSave({ type: 'number' }, 2.5)).toBe(2.5)
    expect(valueForSave({ type: 'string' }, '08:30')).toBe('08:30')
    expect(valueForSave({ type: 'boolean' }, true)).toBe(true)
  })
})

describe('a string-array field round-trips through a textarea', () => {
  it('shows one entry per line and reads back newlines OR commas', () => {
    expect(listTextFor(['general', 'platform-dev'])).toBe('general\nplatform-dev')
    expect(parseListText('general\nplatform-dev')).toEqual(['general', 'platform-dev'])
    expect(parseListText('general, platform-dev')).toEqual(['general', 'platform-dev'])
    expect(parseListText('general,\nplatform-dev\n')).toEqual(['general', 'platform-dev'])
  })

  it('survives the shapes an editing session actually produces', () => {
    // Mid-typing the draft holds raw TEXT, not an array — re-parsing per keystroke would delete the
    // separator the moment it was typed.
    expect(listTextFor('general, ')).toBe('general, ')
    expect(listTextFor(undefined)).toBe('')
    expect(listTextFor(null)).toBe('')
    expect(listTextFor([])).toBe('')
    // A trailing separator is not an entry, and neither is whitespace.
    expect(parseListText('  a ,, b  ,\n\n')).toEqual(['a', 'b'])
    expect(parseListText('   ')).toEqual([])
  })

  it('saves as an array whichever shape the draft is in', () => {
    const schema: PluginFieldSchema = { type: 'array', items: { type: 'string' } }
    expect(valueForSave(schema, 'general\nplatform-dev')).toEqual(['general', 'platform-dev'])
    // Never edited: the value is still the array that came off the wire.
    expect(valueForSave(schema, ['general'])).toEqual(['general'])
    // Cleared to separators only: an explicit empty list, not the string the user left behind.
    expect(valueForSave(schema, ' , ')).toEqual([])
    // An array of objects is not a list, so its value is never rewritten on save.
    expect(valueForSave({ type: 'array', items: { type: 'object' } }, [{ a: 1 }])).toEqual([{ a: 1 }])
  })

  it('offers the manifest default as the placeholder, else how to type it', () => {
    expect(listPlaceholder({ type: 'array', items: { type: 'string' }, default: ['a', 'b'] }))
      .toBe('default: a, b')
    expect(listPlaceholder({ type: 'array', items: { type: 'string' }, default: [] }))
      .toBe('One per line, or comma-separated')
    expect(listPlaceholder({ type: 'array', items: { type: 'string' } }))
      .toBe('One per line, or comma-separated')
  })
})

describe('the renderer goes through these rules', () => {
  // A pure table can stay green while the component keeps its own private branch; the file is read
  // here so that cannot happen silently.
  const source = readFileSync(
    path.join(REPO, 'web/src/components/settings/sections/PluginConfigCards.tsx'),
    'utf8',
  )

  it('asks fieldKindFor which control to draw, and never branches on the raw type again', () => {
    expect(source).toContain('fieldKindFor(schema)')
    expect(source).not.toMatch(/schema\.type === '(string|number)'/)
  })

  it('puts every saved value through valueForSave', () => {
    expect(source).toContain('valueForSave(schemas[k], v)')
  })

  it('draws the list with the shared text helpers', () => {
    expect(source).toContain('listTextFor(value)')
    expect(source).toContain('listPlaceholder(schema)')
  })
})
