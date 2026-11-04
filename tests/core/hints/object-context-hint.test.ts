/**
 * The `object-context` hint (core/hints/hint-context.ts): what a client says about the thing the
 * person asks about is stored, asked for by id on a send, and rendered as a Walnut block beside
 * the words; the first message of a quick start carries it the same way (requestedHintBlocks).
 */
import { describe, expect, it } from 'vitest'
import { cleanHintContext, getHintContext, putHintContext } from '../../../src/core/hints/hint-context.js'
import { planHints, requestedHintBlocks } from '../../../src/core/hints/hint-send.js'
import { effectiveHints } from '../../../src/core/hints/hint-registry.js'
import { parseHinted } from '../../../src/core/hints/hint-format.js'

describe('object-context hint', () => {
  it('stores a context and finds it by id; refuses empty text and odd ids', () => {
    expect(cleanHintContext({ text: '  ' })).toBeNull()
    expect(cleanHintContext({ name: 'Web\npage', text: 'Page: A' })).toEqual({ name: 'Web page', text: 'Page: A' })
    const id = putHintContext({ name: 'Web page', text: 'Page: A' })
    expect(id).toMatch(/^hc-[0-9a-f]{16}$/)
    expect(getHintContext(id)?.text).toBe('Page: A')
    expect(getHintContext('../x')).toBeNull()
    expect(getHintContext(id, Date.now() + 25 * 3600_000)).toBeNull()
  })

  it('a send that asks for it carries the block; one that does not, does not', () => {
    const id = putHintContext({ name: 'Browser tab you may act in', text: 'They let you act in this tab: tab 7.' })
    const hints = effectiveHints(null)
    const asked = planHints({ hints, target: { sessionId: 's' }, record: null, config: null, requested: { 'object-context': { arg: id } }, only: new Set(['on_request']) })
    expect(asked.carried.map((h) => h.kind)).toEqual(['object-context'])
    expect(asked.before.join('')).toContain('They let you act in this tab: tab 7.')
    const not = planHints({ hints, target: { sessionId: 's' }, record: null, config: null, only: new Set(['on_request']) })
    expect(not.carried).toEqual([])
    // A context gone (a restart) says nothing rather than failing the send.
    const gone = planHints({ hints, target: { sessionId: 's' }, record: null, config: null, requested: { 'object-context': { arg: 'hc-0000000000000000' } }, only: new Set(['on_request']) })
    expect(gone.carried).toEqual([])
  })

  it('a first message keeps the words as typed and the context as a hint around them', async () => {
    const id = putHintContext({ name: 'Web page you are asking about', text: 'Address: https://docs.example.test/notes' })
    const out = await requestedHintBlocks('What changed?', { 'object-context': { arg: id } }, { config: null })
    const parsed = parseHinted(out)
    expect(parsed.text).toBe('What changed?')
    expect(parsed.hints.map((h) => h.kind)).toEqual(['object-context'])
    expect(parsed.hints[0].text).toContain('Address: https://docs.example.test/notes')
    expect(await requestedHintBlocks('Q', {}, { config: null })).toBe('Q')
  })
})
