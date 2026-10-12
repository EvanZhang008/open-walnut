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
 * still means "unset, use the manifest default". The mask test is for scalars only: a list whose one line
 * left is a mask is an edit (a delete), and dropping it as "unchanged" saved nothing behind a "Saved".
 *
 * The field-type mapping itself (which control each schema draws) lives in plugin-config-cards.test.ts.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MASKED, pluginSavePayload } from '../../web/src/components/settings/sections/PluginConfigCards'
import { SECRET_LIST_HINT, editedMaskField, isSecretListField, listPlaceholder, listTextFor, type PluginFieldSchema } from '../../web/src/components/settings/plugin-config-fields'
import { MaskedValueError, maskPluginFormValues, restoreMaskedSecrets } from '../../src/core/config-secret-shape'

const LIST: PluginFieldSchema = { type: 'array', items: { type: 'string' }, default: ['general'] }
/** What a list entry no tail tells apart is shown as. */
const B8 = '\u2022'.repeat(8)
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

  it('sends a list cut down to one hidden line, so the delete is not taken for "unchanged"', () => {
    // A list of two hidden keys with one line deleted leaves the mask as the textarea's whole text. Testing
    // the raw text dropped the edit (PUT 200, "Saved", both keys still on disk); as a list it goes to the
    // server, which puts the hidden entry back or refuses it.
    expect(pluginSavePayload({ channels: MASKED }, SCHEMAS)).toEqual({ channels: [MASKED] })
    const tail = '\u2022'.repeat(8) + '2222'
    expect(pluginSavePayload({ channels: tail }, SCHEMAS)).toEqual({ channels: [tail] })
    expect(pluginSavePayload({ channels: `${tail}\nnew-key` }, SCHEMAS)).toEqual({ channels: [tail, 'new-key'] })
  })

  it('a hidden list goes through the form\'s text and back to the server whole, a comma in a secret\'s tail too', () => {
    // The form shows a list one entry per line. A list of secrets is split on line breaks only, so the
    // comma in a tail stays in its line.
    const stored = { api_keys: ['sk-one-1111', 'sk-gate-c,dd', 'sk-three-3333'] }
    const read = maskPluginFormValues(stored, { listTails: true }) as { api_keys: string[] }
    const lines = listTextFor(read.api_keys).split('\n')
    expect(lines).toEqual(read.api_keys)
    expect(lines[1]).toContain(',')
    const sent = pluginSavePayload({ api_keys: lines.slice(1).join('\n') }, { api_keys: LIST })
    expect(sent).toEqual({ api_keys: lines.slice(1) })
    expect(restoreMaskedSecrets(sent, stored)).toEqual({ api_keys: ['sk-gate-c,dd', 'sk-three-3333'] })
  })

  it('a list of secrets is one value per line, each line trimmed at both ends; other lists still split on commas', () => {
    const schemas = { api_keys: LIST, channels: LIST }
    expect(isSecretListField('api_keys', LIST)).toBe(true)
    expect(isSecretListField('backup_tokens', LIST)).toBe(true)
    expect(isSecretListField('channels', LIST)).toBe(false)
    expect(isSecretListField('api_key', { type: 'string' })).toBe(false)
    // A comma or a space inside a secret is part of it; the ends of a line are not; a blank line is not an entry.
    expect(pluginSavePayload({ api_keys: 'sk-a,b-1111\n  sk-c d \n\n   \r\nsk-e-2222', channels: 'a, b\nc' }, schemas))
      .toEqual({ api_keys: ['sk-a,b-1111', 'sk-c d', 'sk-e-2222'], channels: ['a', 'b', 'c'] })
    // Any line break separates (a pasted CR or CRLF too).
    expect(pluginSavePayload({ api_keys: 'sk-a-1111\r\nsk-b-2222\rsk-c-3333' }, schemas)).toEqual({ api_keys: ['sk-a-1111', 'sk-b-2222', 'sk-c-3333'] })
    // With no default, the placeholder says how to type it; a default is shown the way the list is typed.
    expect(listPlaceholder({ type: 'array', items: { type: 'string' } }, { secret: true })).toBe('One per line')
    expect(listPlaceholder({ type: 'array', items: { type: 'string' } })).toBe('One per line, or comma-separated')
    expect(listPlaceholder({ type: 'array', items: { type: 'string' }, default: ['x', 'y'] }, { secret: true })).toBe('default: x\ny')
    expect(listPlaceholder({ type: 'array', items: { type: 'string' }, default: ['x', 'y'] })).toBe('default: x, y')
  })

  it('typed next to a hidden line: a stray space at an end is trimmed away, anything else is refused before any request, with the server\'s message', () => {
    const stored = { ring_keys: ['rk-one-1111', 'rk-two-2222', 'rk-three-3333'] }
    const read = (maskPluginFormValues(stored, { listTails: true }) as { ring_keys: string[] }).ring_keys
    const [r0, r1, r2] = read as [string, string, string]
    const text = read.join('\n')
    const save = (t: string) => pluginSavePayload({ ring_keys: t }, { ring_keys: LIST })
    // Gate r10 P5e and P5f: a space after a line or before one is the hidden line itself, so the list saves unchanged.
    for (const t of [`${r0} \n${r1}\n${r2}`, `${r0}\n ${r1}\n${r2}`, `  ${r0}\t\n${r1}\n${r2}  `]) {
      const sent = save(t)
      expect(sent, JSON.stringify(t)).toEqual({ ring_keys: read })
      expect(editedMaskField(sent, 'plugins.acme')).toBeNull()
      expect(restoreMaskedSecrets(sent, stored)).toEqual(stored)
    }
    // P5c, P5d, P5g, P5h: refused before any request, naming the line, with the server's own message.
    for (const [t, at] of [
      [`${r1}, ${r0}, rk-fox-6666`, 0],
      [`${text}, rk-golf-7777`, 2],
      [`${r0},\n${r1}\n${r2}`, 0],
      [`${text} rk-hotel-8888`, 2],
    ] as Array<[string, number]>) {
      const sent = save(t)
      const field = `plugins.acme.ring_keys[${at}]`
      expect(editedMaskField(sent, 'plugins.acme'), t).toBe(field)
      expect(() => restoreMaskedSecrets(sent, stored, 'plugins.acme'), t)
        .toThrow(expect.objectContaining({ field, reason: 'edited_mask', message: new MaskedValueError(field, 'edited_mask').message }))
    }
    // The new key on a line of its own saves.
    expect(restoreMaskedSecrets(save(`${text}\nrk-golf-7777`), stored)).toEqual({ ring_keys: [...stored.ring_keys, 'rk-golf-7777'] })
    // A text field with an edited mask is named too; a masked URL password and an untouched mask are not edits.
    expect(editedMaskField({ client_secret: `${'\u2022'.repeat(6)}x-new` }, 'plugins.acme')).toBe('plugins.acme.client_secret')
    expect(editedMaskField({ database_url: `postgres://u:${B8}@db.acme.invalid/x`, ring_keys: read }, 'plugins.acme')).toBeNull()
    // The hint under such a list says how to type it, like its placeholder.
    expect(SECRET_LIST_HINT).toBe('One per line.')
  })

  it('a secret with a comma, typed in full over a bullets-only line as a refusal asks, is saved as one value', () => {
    // Two entries with the same last 4 (one with a comma) are both shown as bullets only (gate r9 M-1).
    const stored = { pair_keys: ['tok-a,b-QZ12', 'tok-cd-QZ12'] }
    const read = maskPluginFormValues(stored, { listTails: true }) as { pair_keys: string[] }
    expect(read.pair_keys).toEqual([B8, B8])
    // Delete the second line, type the first in full over its line.
    const sent = pluginSavePayload({ pair_keys: 'tok-a,b-QZ12' }, { pair_keys: LIST })
    expect(sent).toEqual({ pair_keys: ['tok-a,b-QZ12'] })
    expect(restoreMaskedSecrets(sent, stored)).toEqual({ pair_keys: ['tok-a,b-QZ12'] })
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

  it('shows the value that was stored after a save, not the one that was typed', () => {
    // A number field clamps to the manifest's minimum / maximum on save (5 in a min-15 box saves as
    // 15). The box kept showing the 5 while config held 15, so the draft takes the payload back.
    const saved = source.indexOf('await onSave(')
    const writeBack = source.indexOf('...cleaned } }))')
    expect(saved).toBeGreaterThan(-1)
    expect(writeBack).toBeGreaterThan(saved)
  })

  it('puts a value in its config shape BEFORE anything tests it for emptiness', () => {
    // That order IS the bug: filtering the raw draft first meant an emptied list never became [].
    expect(source.indexOf('valueForSave(schemas[k], v, ')).toBeGreaterThan(-1)
    expect(source.indexOf('valueForSave(schemas[k], v, ')).toBeLessThan(source.indexOf("v !== ''"))
  })
})
