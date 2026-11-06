/**
 * Which messages become one of an Org node's Threads (src/core/org/thread-capture.ts) and what the
 * node is told about it (the `threads` message hint).
 */
import { describe, it, expect } from 'vitest'
import { threadHintText, userWordsOf, type ThreadHintState } from '../../../src/core/org/thread-capture.js'
import { buildLetterDeliveryText } from '../../../src/core/human-inbox/letter-ops.js'
import { appendReferenceCards, REFERENCE_CARDS_CLOSE, REFERENCE_CARDS_OPEN } from '../../../src/core/sessions/reference-cards.js'

describe('the user\'s own words in a message', () => {
  it('chat words, with the pictures he attached taken from the header', () => {
    const msg = '[Images attached — use the Read tool to view them]\n- /tmp/open-walnut/images/1-a.jpg\n- /tmp/open-walnut/images/2-b.png\n\nit should be clear which is built in'
    expect(userWordsOf(msg, { inChat: true })).toEqual({
      text: 'it should be clear which is built in', images: ['/tmp/open-walnut/images/1-a.jpg', '/tmp/open-walnut/images/2-b.png'], via: 'chat',
    })
  })

  it('a picture with no words is still a request; a file that is not a picture is not listed as one', () => {
    const msg = '[Files attached — open them from these paths]\n- /home/me/up/clip.mov\n\n[Images attached — use the Read tool to view them]\n- /tmp/x.png\n\n'
    expect(userWordsOf(msg, { inChat: true })).toEqual({ text: '', images: ['/tmp/x.png'], via: 'chat' })
  })

  it('the reference cards Walnut appends are not his words', () => {
    const msg = appendReferenceCards('look at <task-ref id="abc" label="Parser"/>', `${REFERENCE_CARDS_OPEN}\n[ref] abc: Parser (IN_PROGRESS)\n${REFERENCE_CARDS_CLOSE}`)
    expect(userWordsOf(msg, { inChat: true })?.text).toBe('look at <task-ref id="abc" label="Parser"/>')
  })

  it('Unicode words stay as he wrote them', () => {
    expect(userWordsOf('微信的 org 非常乱', { inChat: true })?.text).toBe('微信的 org 非常乱')
  })

  it('a letter answer with a note: the note, about the letter, with the letter\'s id (its answer is read there)', () => {
    const msg = buildLetterDeliveryText({ id: 'lt-1', subject: 'Website: pick one of ten' }, { choice: 'Pick', text: 'combine 1 and 10' })
    expect(userWordsOf(msg, { inChat: false })).toEqual({ text: 'combine 1 and 10', images: [], via: 'letter', about: 'Website: pick one of ten', letter: 'lt-1' })
  })

  it('a multi-line note keeps every line', () => {
    const msg = buildLetterDeliveryText({ id: 'lt-1', subject: 'S' }, { text: 'line one\nline two' })
    expect(userWordsOf(msg, { inChat: false })?.text).toBe('line one\nline two')
  })

  it('nothing to file: a choice alone, another task answering for him, a peer\'s or Walnut\'s message, a slash command, an empty message', () => {
    expect(userWordsOf(buildLetterDeliveryText({ id: 'lt-1', subject: 'S' }, { choice: 'Yes' }), { inChat: false })).toBeNull()
    expect(userWordsOf(buildLetterDeliveryText({ id: 'lt-1', subject: 'S' }, { text: 'ok', by: { taskId: 't', sessionId: 's', name: 'Main' } as never }), { inChat: false })).toBeNull()
    expect(userWordsOf('<walnut-message kind="reply" from="x">done</walnut-message>', { inChat: true })).toBeNull()
    expect(userWordsOf('/compact', { inChat: true })).toBeNull()
    expect(userWordsOf('   ', { inChat: true })).toBeNull()
    // Not typed into the chat and not a letter: nothing of his to file.
    expect(userWordsOf('a trigger fired', { inChat: false })).toBeNull()
  })
})

describe('what the node is told', () => {
  const base: ThreadHintState = {
    threadId: 'th-aaaaaaaaaaaa', title: 'Org page threads', created: true, followUp: false, duplicate: false,
    open: [{ id: 'th-bbbbbbbbbbbb', title: 'Hints: built in or yours', state: 'working' }], closed: [],
  }

  it('a new thread: its id, the open ones, how to merge into one of them, and to give it a title', () => {
    const text = threadHintText(base)
    expect(text).toBe('filed as new thread th-aaaaaaaaaaaa. Open: th-bbbbbbbbbbbb "Hints: built in or yours". '
      + 'Same subject as one: thread_update merge_into; else give it a short title.')
    // No open threads: only the title is asked.
    expect(threadHintText({ ...base, open: [] })).toBe('filed as new thread th-aaaaaaaaaaaa. Give it a short title (thread_update).')
  })

  it('a follow-up: filed under the thread, no merge asked', () => {
    const text = threadHintText({ ...base, created: false, followUp: true })
    expect(text).toBe('a follow-up in thread th-aaaaaaaaaaaa "Org page threads", filed there.')
    expect(text).not.toContain('merge_into')
  })

  it('asked again after a close: says which thread it follows', () => {
    expect(threadHintText({ ...base, open: [], follows: { id: 'th-cccccccccccc', title: 'Old' } })).toContain('(asks again about closed th-cccccccccccc "Old")')
  })

  it('names the threads he closed since the node was last told', () => {
    const text = threadHintText({ ...base, closed: [{ id: 'th-dddddddddddd', title: 'Done thing', how: 'acked', by: 'human' }] })
    expect(text).toMatch(/ Closed since: th-dddddddddddd \(by him\)\.$/)
  })

  it('a repeat is named as one, with nothing to do', () => {
    const text = threadHintText({ ...base, duplicate: true, created: false })
    expect(text).toBe('already filed under thread th-aaaaaaaaaaaa "Org page threads".')
  })

  it('is one or two lines: the rules for keeping threads are in the prompt, not the hint', () => {
    const text = threadHintText({ ...base, closed: [{ id: 'th-dddddddddddd', title: 'Done thing', how: 'acked', by: 'human' }] })
    expect(text.length).toBeLessThan(300)
    expect(text).not.toMatch(/state \(working|Walnut puts your chat reply/)
  })
})
