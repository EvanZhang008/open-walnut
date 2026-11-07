/**
 * The extension's ask and task rows, review 2026-11-06 round 4 (web/src/popout/ask-words-read.ts,
 * ext-tasks-model.ts, ext-panel-model.ts, ExtApprovals.tsx):
 *
 * - #1: an ask whose chat lives in chat history (a phone chat opened again: its lane session never
 *   ran a turn, so its transcript is empty) reads its words from the chat's earlier part;
 * - #2: the Tasks view's rows say the same words as the drawer, never "Take a look" alone when the
 *   words are known;
 * - #3: an ask whose answer the person read (Walnut's read marker) wears no red dot and is not
 *   counted in the extension, until its next answer; a real ask of the person always counts;
 * - #4/#5: the composer names the agent picked, and a selection offered to one agent is not
 *   offered to the next;
 * - #7: approvals that read the same say which of them each is and when it was asked.
 */
import { describe, expect, it } from 'vitest'
import { EARLIER_KEEP_MS, latestReplies, type ReplySources } from '../../web/src/popout/ask-words-read'
import { wordsOfMessages } from '../../web/src/popout/ext-ask-words'
import { askRowDetail, extTaskLists, needsCount, readHere, rowLine } from '../../web/src/popout/ext-tasks-model'
import { composerPlaceholderOf, selectionLeftOutOnSwitch, selectionOfferedTo } from '../../web/src/popout/ext-panel-model'
import { alikeLines } from '../../web/src/popout/ExtApprovals'

const at = '2026-11-06T00:00:00Z'
/** A quick ask answered: Walnut's To read, as the lab's asks are. */
const readAsk = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: `Ask ${id}`, project: 'Ask Walnut', walnut_agent: true, phase: 'NEED_ACTION', created_at: at, updated_at: at,
  session_id: `s-${id}`, user_status: { state: 'read', waitingOn: 'Its turn ended without asking you anything', toRead: 'turn', category: 'look' }, ...extra,
})

describe('#1 the words of a chat whose history is in chat history', () => {
  const earlierRows = Array.from({ length: 30 }, (_, i) => [
    { id: `u${i}`, role: 'user' as const, text: `Old phone question ${i + 1}` },
    { id: `t${i}`, role: 'assistant' as const, text: '', kind: 'tool' as const },
    { id: `a${i}`, role: 'assistant' as const, text: `Old phone answer ${i + 1}, with **bold** text` },
  ]).flat()
  const src = (over: Partial<ReplySources> = {}): ReplySources => ({
    history: async () => [],
    earlier: async () => ({ messages: earlierRows }),
    ...over,
  })

  it('an empty transcript: the newest answer of the chat\'s earlier part', async () => {
    const rows = await latestReplies('pw-chat-earlier-old', { tail: 4 }, src())
    expect(wordsOfMessages(rows ?? [])).toBe('Old phone answer 30, with bold text')
  })

  it('a transcript with a reply of its own: that one, the earlier part is not asked', async () => {
    let asked = 0
    const rows = await latestReplies('s', { tail: 4 }, src({
      history: async () => [{ role: 'user', text: 'And which flower?' }, { role: 'assistant', text: 'Hellebores flower in late winter.' }],
      earlier: async () => { asked++; return { messages: earlierRows } },
    }))
    expect(wordsOfMessages(rows ?? [])).toBe('Hellebores flower in late winter.')
    expect(asked).toBe(0)
  })

  it('a server out of time, or a failed read: unknown (read again later), never kept as nothing', async () => {
    expect(await latestReplies('s', { tail: 4 }, src({ earlier: async () => ({ messages: [], degraded: true }) }))).toBeNull()
    expect(await latestReplies('s', { tail: 4 }, src({ earlier: async () => { throw new Error('502') } }))).toBeNull()
    expect(await latestReplies('s', { tail: 4 }, src({ history: async () => { throw new Error('502') }, earlier: async () => ({ messages: [] }) }))).toBeNull()
    // No transcript at all (404) and no earlier part: known to say nothing, read again only once it moves.
    expect(await latestReplies('s', { tail: 4 }, src({ history: async () => { throw Object.assign(new Error('404'), { status: 404 }) }, earlier: async () => ({ messages: [] }) }))).toEqual([])
    // ...and a 404 with an earlier part reads that part.
    expect(wordsOfMessages((await latestReplies('s', { tail: 4 }, src({ history: async () => { throw Object.assign(new Error('404'), { status: 404 }) } }))) ?? [])).toBe('Old phone answer 30, with bold text')
    // A conversation with no reply anywhere yet: known to say nothing.
    expect(await latestReplies('s', { tail: 4 }, src({ earlier: async () => ({ messages: [] }) }))).toEqual([])
  })
})

describe('M3: one read of a conversation at a time, its earlier part kept', () => {
  const earlierRows = [
    { id: 'u1', role: 'user' as const, text: 'Old question' },
    { id: 'a1', role: 'assistant' as const, text: 'Old answer' },
  ]
  it('rows reading one conversation at once share one read; the earlier part is not read again for 5 minutes', async () => {
    let history = 0
    let earlier = 0
    let clock = 0
    const src: ReplySources = {
      history: async () => { history++; await new Promise((r) => setTimeout(r, 5)); return [] },
      earlier: async (_sid, tail) => { earlier++; expect(tail).toBe(8); return { messages: earlierRows } },
    }
    const [a, b] = await Promise.all([latestReplies('s', { tail: 4 }, src, () => clock), latestReplies('s', { tail: 4 }, src, () => clock)])
    expect(a).toEqual(b)
    expect(history).toBe(1)
    expect(earlier).toBe(1)
    // A later read (the row moved): its transcript again, the earlier part from memory.
    clock = EARLIER_KEEP_MS - 1
    expect(wordsOfMessages((await latestReplies('s', { tail: 8 }, src, () => clock)) ?? [])).toBe('Old answer')
    expect(history).toBe(2)
    expect(earlier).toBe(1)
    clock = EARLIER_KEEP_MS + 1
    await latestReplies('s', { tail: 4 }, src, () => clock)
    expect(earlier).toBe(2)
  })

  it('a server out of time is kept 30 s, then twice as long each time, up to 5 minutes', async () => {
    let earlier = 0
    let clock = 0
    const src: ReplySources = { history: async () => [], earlier: async () => { earlier++; return { messages: [], degraded: true } } }
    const at = async (t: number) => { clock = t; return latestReplies('s', { tail: 4 }, src, () => clock) }
    expect(await at(0)).toBeNull()
    expect(await at(29_000)).toBeNull()
    expect(earlier).toBe(1)
    await at(31_000)
    expect(earlier).toBe(2)
    await at(31_000 + 59_000)
    expect(earlier).toBe(2)
    await at(31_000 + 61_000)
    expect(earlier).toBe(3)
  })

  it('an abort ends only its own wait; the shared read goes on for the other row', async () => {
    let release!: () => void
    const src: ReplySources = {
      history: () => new Promise((r) => { release = () => r([{ role: 'assistant', text: 'Shared answer' }]) }),
      earlier: async () => ({ messages: [] }),
    }
    const c = new AbortController()
    const first = latestReplies('s', { tail: 4, signal: c.signal }, src)
    const second = latestReplies('s', { tail: 4 }, src)
    c.abort()
    await expect(first).rejects.toBeTruthy()
    release()
    expect(wordsOfMessages((await second) ?? [])).toBe('Shared answer')
  })
})

describe('#2 the Tasks view says what each task last said', () => {
  it('a Needs you row: its category, then the same words the drawer shows', () => {
    const t = readAsk('a1', { unread: true })
    const words = 'Old phone answer 30, with bold text'
    const lists = extTaskLists([t as never], new Set(), (id) => (id === 'a1' ? words : ''))
    expect(lists.needs).toHaveLength(1)
    expect(rowLine(lists.needs[0], 'needs')).toBe(`Take a look: ${words}`)
    expect(askRowDetail(t as never, words).line).toBe(words)
    // Nothing it said known: the category alone, as before.
    expect(rowLine(extTaskLists([t as never], new Set(), () => '').needs[0], 'needs')).toBe('Take a look')
  })
})

describe('#3 an answer the person read in the panel', () => {
  it('no red dot and not counted; the next answer brings it back', () => {
    const unread = readAsk('a1', { unread: true })
    const read = readAsk('a1', { unread: false })
    expect(askRowDetail(unread as never, 'Done.').needs).toBe(true)
    expect(askRowDetail(read as never, 'Done.').needs).toBe(false)
    expect(readHere(read as never)).toBe(true)
    expect(needsCount([unread as never, readAsk('a2', { unread: true }) as never])).toBe(2)
    expect(needsCount([read as never, readAsk('a2', { unread: true }) as never])).toBe(1)
    expect(extTaskLists([read as never]).needs).toHaveLength(0)
    // Its next answer: the phase machine marks it unread again (phase.ts readMarkerForPhase).
    expect(needsCount([{ ...read, unread: true } as never])).toBe(1)
  })

  it('a real ask of the person, or a task that is not an ask, is never read away', () => {
    const asking = readAsk('a3', { unread: false, user_status: { state: 'needs', source: 'session', ask: 'Pick the 3 pm slot?', category: 'decide' } })
    expect(askRowDetail(asking as never).needs).toBe(true)
    expect(needsCount([asking as never])).toBe(1)
    const work = { ...readAsk('w1', { unread: false }), project: 'Website', walnut_agent: false }
    expect(readHere(work as never)).toBe(false)
    expect(needsCount([work as never])).toBe(1)
    // An ask never marked either way (no read marker yet) still counts: nobody saw its answer here.
    expect(needsCount([readAsk('a4') as never])).toBe(1)
  })
})

describe('#4 #5 the composer: the agent picked, and the selection of the last agent left out', () => {
  it('names the agent', () => {
    expect(composerPlaceholderOf('Mentor', true)).toBe('Ask Mentor, or ask it to do something here…')
    expect(composerPlaceholderOf('Walnut', false)).toBe('Ask Walnut anything…')
    expect(composerPlaceholderOf('', true)).toBe('Ask Walnut, or ask it to do something here…')
  })
  it('a switch leaves out the selection of the moment; the same agent\'s new chat keeps it', () => {
    expect(selectionLeftOutOnSwitch('general', 'mentor', ' Uploads retry. ')).toBe('Uploads retry.')
    expect(selectionLeftOutOnSwitch('general', 'general', 'Uploads retry.')).toBe('')
    expect(selectionLeftOutOnSwitch('general', 'mentor', undefined)).toBe('')
  })
  it('back on the agent the selection was made for, it shows again (L5)', () => {
    const owner = { sel: 'Uploads retry.', agent: 'general' }
    // Walnut -> Mentor: left out of Mentor's.
    expect(selectionLeftOutOnSwitch(selectionOfferedTo(owner, 'Uploads retry.', 'general'), 'mentor', 'Uploads retry.')).toBe('Uploads retry.')
    // Mentor -> Walnut (picked last: Mentor): Walnut's own again.
    expect(selectionLeftOutOnSwitch(selectionOfferedTo(owner, 'Uploads retry.', 'mentor'), 'general', 'Uploads retry.')).toBe('')
    // A selection the owner does not know: the agent picked last.
    expect(selectionOfferedTo(owner, 'Dark mode follows.', 'mentor')).toBe('mentor')
  })
})

describe('#7 approvals that read the same', () => {
  const a = (id: string, createdAt: string, what = 'Let a Walnut agent click button "Place order" on shop.example.test? It buys or pays.') => ({
    id, what, detail: 'Page: https://shop.example.test/cart', digest: '', mode: 'tap', createdAt, expiresAt: createdAt, status: 'pending',
    requester: { host: '__local__', command: 'walnut browser click' },
  })
  it('each says which of them it is, oldest first, and when it was asked; one of a kind says nothing', () => {
    const list = [a('x3', '2026-11-06T10:00:03Z'), a('x1', '2026-11-06T10:00:01Z'), a('x2', '2026-11-06T10:00:02Z'), a('y', '2026-11-06T10:00:04Z', 'Let a Walnut agent click button "Send" on mail.example.test? It sends or posts.')]
    const lines = alikeLines(list as never, (iso) => iso.slice(11, 19))
    expect(lines.get('x1')).toBe('1 of 3 alike · asked 10:00:01')
    expect(lines.get('x2')).toBe('2 of 3 alike · asked 10:00:02')
    expect(lines.get('x3')).toBe('3 of 3 alike · asked 10:00:03')
    expect(lines.has('y')).toBe(false)
  })
})
