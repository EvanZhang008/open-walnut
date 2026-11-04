/**
 * The side panel's quote under a sent question (web/src/popout/PopoutExtPanel.tsx attachmentsOf)
 * is read back from the message's own object-context hint once the conversation is reloaded: the
 * selection the panel put in the context (pageContextBlock) must survive the server's rendering of
 * the hint (core/hints) and the history's parse of it (parseHinted), so selectionOfContext finds
 * exactly what was selected, for a first message and for a follow-up alike.
 */
import { describe, expect, it } from 'vitest'
import { putHintContext } from '../../src/core/hints/hint-context.js'
import { requestedHintBlocks } from '../../src/core/hints/hint-send.js'
import { parseHinted } from '../../src/core/hints/hint-format.js'
import { CONTEXT_NAME, pageContextBlock, selectionOfContext } from '../../web/src/popout/ext-panel-model'

const page = { url: 'https://docs.example.test/notes', title: 'Release notes 4.2' }

async function sentAndReadBack(selection: string | undefined, words: string) {
  const id = putHintContext({ name: CONTEXT_NAME, text: pageContextBlock({ ...page, ...(selection ? { selection } : {}) }, {}) })
  const parsed = parseHinted(await requestedHintBlocks(words, { 'object-context': { arg: id } }, { config: null }))
  return { parsed, quote: selectionOfContext(parsed.hints.find((h) => h.kind === 'object-context')?.text) }
}

describe('the quote under a sent question, read back from its hint', () => {
  it('a selection of one line and of several comes back as selected; the words stay as typed', async () => {
    const one = await sentAndReadBack('The sync engine now retries a failed upload three times.', 'Summarize the selected text')
    expect(one.parsed.text).toBe('Summarize the selected text')
    expect(one.quote).toBe('The sync engine now retries a failed upload three times.')
    const many = await sentAndReadBack('First line.\n\nSecond <b>line</b> & more.', 'What does this mean?')
    expect(many.quote).toBe('First line.\n\nSecond <b>line</b> & more.')
  })

  it('a message without a selection shows no quote', async () => {
    expect((await sentAndReadBack(undefined, 'What is this page?')).quote).toBe('')
    expect(selectionOfContext(undefined)).toBe('')
  })
})
