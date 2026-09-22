/**
 * What a plugin's Save actually writes into config.
 *
 * `PluginConfigCards` renders every plugin's Settings form, and the payload it builds is where a field
 * silently disappears. The bug this file exists for: the draft was filtered for empty strings BEFORE the
 * value was put in its config shape, so clearing a list's textarea dropped the key from the payload
 * entirely, the server fell back to the manifest default, and the list the user had just emptied came
 * back after a refresh — indistinguishable from a save that failed. `parseListText` could therefore
 * never produce the empty array it is perfectly able to produce.
 *
 * The two things that filter is really there for are pinned here as well, because the fix must not trade
 * one for the other: a masked secret must never be written back as the mask, and an emptied scalar box
 * still means "unset, use the manifest default".
 *
 * The field-type mapping itself (which control each schema draws) lives in plugin-config-cards.test.ts.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MASKED, pluginSavePayload } from '../../web/src/components/settings/sections/PluginConfigCards'
import type { PluginFieldSchema } from '../../web/src/components/settings/plugin-config-fields'

const LIST: PluginFieldSchema = { type: 'array', items: { type: 'string' }, default: ['general'] }
const SCHEMAS: Record<string, PluginFieldSchema> = {
  channels: LIST,
  api_token: { type: 'string' },
  digest_time: { type: 'string', default: '08:30' },
  poll_minutes: { type: 'integer', default: 15 },
  ratio: { type: 'number' },
  enabled: { type: 'boolean' },
}

describe('an emptied list saves as an empty list', () => {
  it('sends [] rather than dropping the key', () => {
    // What the textarea leaves behind when the user selects all and deletes.
    expect(pluginSavePayload({ channels: '' }, SCHEMAS)).toEqual({ channels: [] })
    // Separators with nothing between them are the same intent.
    expect(pluginSavePayload({ channels: ' ,\n ' }, SCHEMAS)).toEqual({ channels: [] })
  })

  it('still round-trips a list the user typed', () => {
    expect(pluginSavePayload({ channels: 'general\nplatform-dev' }, SCHEMAS))
      .toEqual({ channels: ['general', 'platform-dev'] })
    // Never edited: still the array that came off the wire, sent back unchanged.
    expect(pluginSavePayload({ channels: ['general'] }, SCHEMAS)).toEqual({ channels: ['general'] })
    expect(pluginSavePayload({ channels: [] }, SCHEMAS)).toEqual({ channels: [] })
  })

  it('does not turn a field with no schema into a list', () => {
    // An unknown key is not rewritten, and an empty one still reads as "unset".
    expect(pluginSavePayload({ mystery: 'x' }, SCHEMAS)).toEqual({ mystery: 'x' })
    expect(pluginSavePayload({ mystery: '' }, SCHEMAS)).toEqual({})
  })
})

describe('the two things the payload must never write', () => {
  it('never writes a masked secret back', () => {
    // The server sends the mask in place of the stored value; writing it back would make the mask the
    // token. An untouched secret is simply absent from the payload, so the stored one stands.
    expect(pluginSavePayload({ api_token: MASKED, channels: ['general'] }, SCHEMAS))
      .toEqual({ channels: ['general'] })
    // A real edit goes through.
    expect(pluginSavePayload({ api_token: 'xoxb-new' }, SCHEMAS)).toEqual({ api_token: 'xoxb-new' })
  })

  it('leaves an emptied scalar box out, so the manifest default applies', () => {
    // A cleared number box hands back '' — sending that would put a string in a numeric config field.
    expect(pluginSavePayload({ poll_minutes: '', ratio: '', digest_time: '' }, SCHEMAS)).toEqual({})
  })

  it('sends only what the draft holds — an untouched field is not invented', () => {
    expect(pluginSavePayload({}, SCHEMAS)).toEqual({})
    expect(Object.keys(pluginSavePayload({ enabled: false }, SCHEMAS))).toEqual(['enabled'])
  })

  it('keeps the values that look empty but are not', () => {
    // `false` and `0` are values a user chose, not blanks.
    expect(pluginSavePayload({ enabled: false, poll_minutes: 0 }, SCHEMAS))
      .toEqual({ enabled: false, poll_minutes: 0 })
  })
})

describe('an integer field saves a whole number', () => {
  it('rounds what the number box let through', () => {
    // `step={1}` is a spinner hint, not a rule: 2.5 can be typed or pasted into the box.
    expect(pluginSavePayload({ poll_minutes: 2.5 }, SCHEMAS)).toEqual({ poll_minutes: 3 })
    expect(pluginSavePayload({ poll_minutes: 14.2 }, SCHEMAS)).toEqual({ poll_minutes: 14 })
    expect(pluginSavePayload({ poll_minutes: 15 }, SCHEMAS)).toEqual({ poll_minutes: 15 })
  })

  it('leaves a genuine number field alone', () => {
    expect(pluginSavePayload({ ratio: 2.5 }, SCHEMAS)).toEqual({ ratio: 2.5 })
  })
})

describe('the form goes through this one function', () => {
  // A pure test can stay green while the component keeps a private copy of the rules; the file is read
  // so that cannot happen silently.
  const source = readFileSync(
    path.join(import.meta.dirname, '../../web/src/components/settings/sections/PluginConfigCards.tsx'),
    'utf8',
  )

  it('builds the save payload with pluginSavePayload and nowhere else', () => {
    expect(source).toContain('pluginSavePayload(draft, schemas)')
  })

  it('puts a value in its config shape BEFORE anything tests it for emptiness', () => {
    // That order IS the bug: filtering the raw draft first meant an emptied list never became [].
    expect(source.indexOf('valueForSave(schemas[k], v)')).toBeGreaterThan(-1)
    expect(source.indexOf('valueForSave(schemas[k], v)')).toBeLessThan(source.indexOf("v !== ''"))
  })
})
