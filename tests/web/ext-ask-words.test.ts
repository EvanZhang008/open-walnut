/**
 * The second line of an ask's row in the side panel's drawer and Continue lists says where the ask
 * stopped (web/src/popout/ext-tasks-model.ts askRowDetail, ext-ask-words.ts): its own question when
 * it really needs the person, else Walnut's read of its last words, else the latest words of its
 * conversation, and the bare category ("Take a look") only when nothing it said is known (review
 * 2026-11-06 round 3: every finished ask read "Take a look"). The red dot is Needs you either way.
 */
import { describe, expect, it } from 'vitest'
import { askRowDetail } from '../../web/src/popout/ext-tasks-model'
import { ASK_WORDS_MAX, keepWords, keptWords, wordsOfMessages, wordsStamp, wordsToRead } from '../../web/src/popout/ext-ask-words'

const base = { id: 't1', title: 'Compare laptops', phase: 'IN_PROGRESS', created_at: '2026-11-06T00:00:00Z', updated_at: '2026-11-06T00:00:00Z' }
const answered = { ...base, phase: 'NEED_ACTION', user_status: { state: 'read', kind: 'you', toRead: 'answer' } }
const done = { ...base, phase: 'COMPLETE', user_status: { state: 'done' } }
const asking = { ...base, phase: 'NEED_ACTION', user_status: { state: 'needs', kind: 'you', source: 'session', ask: 'Pick the 3 pm slot?' } }

describe('the line an ask row shows', () => {
  it('an answered ask: the latest words of its conversation, with the red dot, never "Take a look"', () => {
    const d = askRowDetail(answered as never, 'Zen 14 wins on battery; X1 on the keyboard.')
    expect(d).toEqual({ line: 'Zen 14 wins on battery; X1 on the keyboard.', needs: true })
    // Two answered asks read apart.
    expect(askRowDetail({ ...answered, id: 't2' } as never, 'Booked the 3 pm slot.').line).not.toBe(d.line)
  })

  it('nothing it said known yet: the category, so the row still says what to do', () => {
    expect(askRowDetail(answered as never, '')).toEqual({ line: 'Take a look', needs: true })
  })

  it('a real ask of the person wins over the words', () => {
    expect(askRowDetail(asking as never, 'Here are three slots.')).toEqual({ line: 'Pick the 3 pm slot?', needs: true })
  })

  it('a finished ask: its last words, no dot', () => {
    expect(askRowDetail(done as never, 'Sent the reply to Dana.')).toEqual({ line: 'Sent the reply to Dana.', needs: false })
    expect(askRowDetail(done as never, '')).toEqual({ line: '', needs: false })
  })

  it('Walnut\'s own read of its last words, when it has one, before this browser\'s', () => {
    const read = { ...done, last_words: { text: 'Uploads retry three times.', at: '2026-11-05T00:00:00Z' } }
    expect(askRowDetail(read as never, 'Hello! I processed your message').line).toBe('Uploads retry three times.')
    expect(askRowDetail(done as never, 'Hello! I processed your message').line).toBe('Hello! I processed your message')
  })
})

describe('the words read from a conversation', () => {
  it('the newest reply, as one plain line with its end kept', () => {
    const msgs = [
      { role: 'user', text: 'Which laptop?' },
      { role: 'assistant', text: 'First pass.' },
      { role: 'user', text: 'And battery?' },
      { role: 'assistant', text: '## Battery\n\n**Zen 14** lasts longer.\n\n```js\nnoise()\n```\n\nSee [the review](https://x.example.test).' },
      { role: 'user', text: 'thanks' },
    ]
    expect(wordsOfMessages(msgs)).toBe('Battery Zen 14 lasts longer. See the review.')
    expect(wordsOfMessages([{ role: 'user', text: 'only me' }])).toBe('')
    const long = `${'Background sentence. '.repeat(20)}So: pick the 3 pm slot?`
    const w = wordsOfMessages([{ role: 'assistant', text: long }])
    expect(w.length).toBeLessThanOrEqual(ASK_WORDS_MAX + 1)
    expect(w.startsWith('…')).toBe(true)
    expect(w.endsWith('pick the 3 pm slot?')).toBe(true)
  })

  it('kept by ask, and read again only once the ask moved', () => {
    const m = new Map<string, string>()
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } }
    const t = { ...answered, session_id: 's1', last_session_update: '2026-11-06T01:00:00Z' }
    const rows = [{ id: 't1', task: t as never }, { id: 't2' }]
    const sessionOf = (x: { session_id?: string }) => x.session_id ?? null
    expect(wordsToRead(rows, sessionOf as never, (id) => keptWords(id, s))).toEqual([{ taskId: 't1', sessionId: 's1', stamp: wordsStamp(t as never) }])
    keepWords('t1', 'Booked.', wordsStamp(t as never), s)
    expect(keptWords('t1', s)?.text).toBe('Booked.')
    expect(wordsToRead(rows, sessionOf as never, (id) => keptWords(id, s))).toEqual([])
    const moved = { ...t, last_session_update: '2026-11-06T02:00:00Z' }
    expect(wordsToRead([{ id: 't1', task: moved as never }], sessionOf as never, (id) => keptWords(id, s))).toHaveLength(1)
  })
})
