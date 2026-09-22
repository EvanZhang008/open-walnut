/**
 * The conversation behind an "ask about this object" drawer.
 *
 * Every rule here is one the drawer cannot be trusted to enforce by itself, and three of them are
 * bugs the Slack copy of this file shipped before the discipline existed:
 *
 *   . ONE conversation per object, so reopening a mail lands in the chat that already has the answer;
 *   . ONE request in flight per object, because the drawer's effect re-runs the moment a display name
 *     resolves — the racing pair used to make two conversations, and the one that wrote localStorage
 *     LAST was not the one on screen;
 *   . a remembered id the server no longer knows makes a NEW conversation instead of a chat that
 *     renders forever empty — but a FAILED list read is not an empty answer and must keep the id;
 *   . a refusal surfaces as an error the user can retry, never as a permanent spinner;
 *   . localStorage does not grow without bound: 30 days unused and an entry is gone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  askObjectConversationFor,
  askObjectTitle,
  forgetAskObjectConversation,
  pruneAskObjectStore,
} from '../../web/src/components/chat/ask-object-conversation'

class FakeStorage {
  readonly map = new Map<string, string>()
  get length(): number { return this.map.size }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null }
  getItem(key: string): string | null { return this.map.get(key) ?? null }
  setItem(key: string, value: string): void { this.map.set(key, value) }
  removeItem(key: string): void { this.map.delete(key) }
  clear(): void { this.map.clear() }
}

const AGENT = 'walnut'
const KEY = 'mail:acct-1:msg-1'
const STORE_KEY = `walnut:ask-object:${AGENT}:${KEY}`

interface Host {
  storage: FakeStorage
  created: string[]
  listed: number
  known: string[]
  listIds: (agentId: string) => Promise<string[]>
  create: (agentId: string, title: string) => Promise<string>
  agentId: string
  now?: () => number
}

function host(overrides: Partial<Host> = {}): Host {
  const state: Host = {
    storage: new FakeStorage(),
    created: [],
    listed: 0,
    known: [],
    agentId: AGENT,
    listIds: async () => { state.listed++; return state.known },
    create: async (_agentId, title) => {
      state.created.push(title)
      const id = `conv-${state.created.length}`
      state.known.push(id)
      return id
    },
    ...overrides,
  }
  return state
}

describe('askObjectTitle', () => {
  it('reads as "<where>: <subject>" and never exceeds 60 characters', () => {
    expect(askObjectTitle('Mail: Bo Marina', 'Can we ship the whiteboard today?'))
      .toBe('Mail: Bo Marina: Can we ship the whiteboard today?')
    expect(askObjectTitle('Mail: Bo Marina', 'x'.repeat(200))).toHaveLength(60)
    // Nothing to say about: the head stands alone rather than ending in a bare colon.
    expect(askObjectTitle('Mail: Bo Marina', '   ')).toBe('Mail: Bo Marina')
    expect(askObjectTitle('', '')).toBe('Ask Walnut')
    // Whitespace in a subject is folded, so a quoted mail body cannot make a multi-line title.
    expect(askObjectTitle('Mail', 'two\n\nlines  here')).toBe('Mail: two lines here')
    // A head with no room left for the subject keeps the head, clipped, and adds no colon.
    expect(askObjectTitle('M'.repeat(80), 'subject')).toHaveLength(60)
    expect(askObjectTitle('M'.repeat(80), 'subject')).not.toContain(':')
  })
})

describe('askObjectConversationFor', () => {
  it('makes ONE conversation per object and reuses it on reopen', async () => {
    const deps = host()
    const first = await askObjectConversationFor(KEY, askObjectTitle('Mail: Bo Marina', 'Ship it?'), deps)
    expect(first).toBe('conv-1')
    expect(deps.created).toEqual(['Mail: Bo Marina: Ship it?'])
    expect(deps.storage.getItem(STORE_KEY)).toContain('conv-1')

    const second = await askObjectConversationFor(KEY, 'a title nobody needs', deps)
    expect(second).toBe('conv-1')
    expect(deps.created).toHaveLength(1)

    // A different object is a different conversation.
    expect(await askObjectConversationFor('mail:acct-1:msg-2', 'Mail: other', deps)).toBe('conv-2')
    expect(deps.created).toHaveLength(2)
  })

  it('files the same object under a different agent as its own conversation', async () => {
    const deps = host()
    expect(await askObjectConversationFor(KEY, 'Mail: a', deps)).toBe('conv-1')
    expect(await askObjectConversationFor(KEY, 'Mail: a', { ...deps, agentId: 'mentor' })).toBe('conv-2')
    expect(deps.storage.getItem(`walnut:ask-object:mentor:${KEY}`)).toContain('conv-2')
  })

  it('collapses two synchronous opens into ONE request, and storage agrees with the screen', async () => {
    const deps = host()
    const [a, b] = await Promise.all([
      askObjectConversationFor('mail:acct-1:racy', askObjectTitle('Mail', 'first words'), deps),
      askObjectConversationFor('mail:acct-1:racy', askObjectTitle('Mail: Bo Marina', 'first words'), deps),
    ])
    expect(a).toBe('conv-1')
    expect(b).toBe('conv-1')
    expect(deps.created).toHaveLength(1)
    expect(deps.storage.getItem('walnut:ask-object:walnut:mail:acct-1:racy')).toContain('conv-1')

    // Settled: a later open reads storage, not the finished flight.
    expect(await askObjectConversationFor('mail:acct-1:racy', 'later', deps)).toBe('conv-1')
    expect(deps.created).toHaveLength(1)
  })

  it('forgets a remembered id the server no longer knows and makes a new one', async () => {
    const deps = host()
    deps.storage.setItem(STORE_KEY, JSON.stringify({ id: 'conv-deleted', at: Date.now() }))
    deps.known = ['conv-someone-elses']

    const id = await askObjectConversationFor(KEY, 'Mail: Bo Marina: Ship it?', deps)
    expect(id).toBe('conv-1')
    expect(deps.created).toHaveLength(1)
    expect(deps.storage.getItem(STORE_KEY)).toContain('conv-1')
    expect(deps.storage.getItem(STORE_KEY)).not.toContain('conv-deleted')
  })

  it('keeps a remembered id when the LIST request itself refuses', async () => {
    // A failed read is not an empty answer: treating an unreachable server as "that conversation is
    // gone" would mint a new one per open and scatter the history across them.
    const deps = host({ listIds: async () => { throw new Error('HTTP 503') } })
    deps.storage.setItem(STORE_KEY, JSON.stringify({ id: 'conv-held', at: Date.now() }))
    expect(await askObjectConversationFor(KEY, 'Mail', deps)).toBe('conv-held')
    expect(deps.created).toHaveLength(0)
  })

  it('re-stamps an entry it reads, so the 30-day cap means "unused", not "old"', async () => {
    const day = 24 * 60 * 60 * 1000
    const deps = host({ now: () => 5_000 * day })
    deps.storage.setItem(STORE_KEY, JSON.stringify({ id: 'conv-held', at: 1_000 * day }))
    deps.known = ['conv-held']
    await askObjectConversationFor(KEY, 'Mail', deps)
    expect(JSON.parse(deps.storage.getItem(STORE_KEY)!)).toEqual({ id: 'conv-held', at: 5_000 * day })
  })

  it('surfaces a refusal as an error, and the retry after it succeeds', async () => {
    const deps = host({
      create: async () => { throw new Error('Walnut answered 500 when asked for a conversation.') },
    })
    await expect(askObjectConversationFor(KEY, 'Mail', deps)).rejects.toThrow(/500/)
    expect(deps.storage.getItem(STORE_KEY)).toBeNull()

    // The flight is released, so pressing `Try again` really tries again.
    const working = host({ storage: deps.storage })
    expect(await askObjectConversationFor(KEY, 'Mail', working)).toBe('conv-1')
    expect(working.created).toHaveLength(1)
  })

  it('refuses a server that answers without naming the conversation', async () => {
    const deps = host({ create: async () => '' })
    await expect(askObjectConversationFor(KEY, 'Mail', deps)).rejects.toThrow(/did not name/)
  })

  it('works when storage refuses (private mode): a conversation per open, never a crash', async () => {
    const deps = host()
    const denied = () => { throw new Error('storage disabled') }
    const blind = {
      ...deps,
      storage: { getItem: denied, setItem: denied, removeItem: denied },
    }
    expect(await askObjectConversationFor(KEY, 'Mail', blind)).toBe('conv-1')
    // It cannot remember, so it asks for another one. Honest degradation, never a broken drawer.
    expect(await askObjectConversationFor(KEY, 'Mail', blind)).toBe('conv-2')
  })
})

describe('forgetAskObjectConversation', () => {
  it('drops only that object, under that agent', () => {
    const storage = new FakeStorage()
    storage.setItem(STORE_KEY, JSON.stringify({ id: 'conv-1', at: 1 }))
    storage.setItem(`walnut:ask-object:mentor:${KEY}`, JSON.stringify({ id: 'conv-2', at: 1 }))
    forgetAskObjectConversation(KEY, AGENT, storage)
    expect(storage.getItem(STORE_KEY)).toBeNull()
    expect(storage.getItem(`walnut:ask-object:mentor:${KEY}`)).not.toBeNull()
  })
})

/**
 * The prune has TWO rules, because the two kinds of key age differently.
 *
 * A conversation id is re-stamped every time it is read, so 30 days honestly means 30 days UNUSED. A
 * latch is stamped once, when it is claimed, and can never be re-stamped: the drawer reads it inside a
 * state initializer, StrictMode runs those twice, and a read that wrote would consume a preset without
 * sending it. Ageing a latch on that one stamp is the bug pinned below — an object asked about for more
 * than a month lost its latches on day 31, so the next open quoted the whole object into the existing
 * chat again and re-sent a canned question that had already been answered.
 */
describe('pruneAskObjectStore', () => {
  const day = 24 * 60 * 60 * 1000
  let storage: FakeStorage
  const now = 500 * day
  /** Keys as the module writes them: `<prefix><agent>:<object>` and `<flag><name>:<agent>:<object>`. */
  const conv = (object: string, agent = AGENT) => `walnut:ask-object:${agent}:${object}`
  const latch = (name: string, object: string, agent = AGENT) =>
    `walnut:ask-object-once:${name}:${agent}:${object}`

  beforeEach(() => {
    storage = new FakeStorage()
  })

  it('drops conversation ids unused for 30 days and keeps the rest', () => {
    storage.setItem(conv('fresh'), JSON.stringify({ id: 'a', at: now - 29 * day }))
    storage.setItem(conv('stale'), JSON.stringify({ id: 'b', at: now - 31 * day }))
    storage.setItem(latch('context', 'fresh'), JSON.stringify({ at: now - day }))

    expect(pruneAskObjectStore(storage, now)).toBe(1)
    expect([...storage.map.keys()].sort()).toEqual([
      latch('context', 'fresh'),
      conv('fresh'),
    ].sort())
  })

  it('keeps a latch for as long as its conversation, however old the latch is', () => {
    // A mail asked about every week for a year: the conversation is fresh, both latches were claimed on
    // day one. Expiring them re-quotes the object and re-sends a question the user did not click.
    storage.setItem(conv('mail:1'), JSON.stringify({ id: 'conv-1', at: now - day }))
    storage.setItem(latch('context', 'mail:1'), JSON.stringify({ at: now - 400 * day }))
    storage.setItem(latch('preset', 'mail:1#1abc2'), JSON.stringify({ at: now - 400 * day }))

    expect(pruneAskObjectStore(storage, now)).toBe(0)
    expect(storage.length).toBe(3)
  })

  it('takes a latch with the conversation it belongs to, so the store stays bounded', () => {
    storage.setItem(conv('mail:1'), JSON.stringify({ id: 'conv-1', at: now - 31 * day }))
    storage.setItem(latch('context', 'mail:1'), JSON.stringify({ at: now - day }))
    storage.setItem(latch('preset', 'mail:1#1abc2'), JSON.stringify({ at: now }))

    expect(pruneAskObjectStore(storage, now)).toBe(3)
    expect(storage.length).toBe(0)
  })

  it('keeps each agent\'s latches with that agent\'s own conversation', () => {
    storage.setItem(conv('mail:1'), JSON.stringify({ id: 'conv-1', at: now }))
    storage.setItem(conv('mail:1', 'mentor'), JSON.stringify({ id: 'conv-2', at: now - 31 * day }))
    storage.setItem(latch('preset', 'mail:1#1abc2'), JSON.stringify({ at: now - 200 * day }))
    storage.setItem(latch('preset', 'mail:1#1abc2', 'mentor'), JSON.stringify({ at: now }))

    expect(pruneAskObjectStore(storage, now)).toBe(2)
    expect([...storage.map.keys()].sort()).toEqual([conv('mail:1'), latch('preset', 'mail:1#1abc2')].sort())
  })

  it('sweeps a latch written before the agent was part of its key', () => {
    // The old shape names no agent, so it can never be matched to a chat again. Deliberately not
    // migrated: nothing in the key says WHICH agent took it, and guessing wrong silently suppresses a
    // send. The one-time cost is one more quote on the next ask about that object.
    storage.setItem(conv('mail:1'), JSON.stringify({ id: 'conv-1', at: now }))
    storage.setItem('walnut:ask-object-once:context:mail:1', JSON.stringify({ at: now }))
    expect(pruneAskObjectStore(storage, now)).toBe(1)
    expect([...storage.map.keys()]).toEqual([conv('mail:1')])
  })

  it('never touches a key outside its own namespace', () => {
    storage.setItem('walnut.deviceToken', 'secret')
    storage.setItem('walnut:prefs', '{}')
    storage.setItem(conv('stale'), JSON.stringify({ id: 'b', at: 0 }))
    pruneAskObjectStore(storage, now)
    expect(storage.getItem('walnut.deviceToken')).toBe('secret')
    expect(storage.getItem('walnut:prefs')).toBe('{}')
    expect(storage.getItem(conv('stale'))).toBeNull()
  })

  it('drops an entry with no readable timestamp — this module is the only writer', () => {
    storage.setItem(conv('legacy'), 'conv-bare-string')
    storage.setItem(conv('broken'), '{not json')
    storage.setItem(latch('preset', 'broken'), 'not-json-either')
    // ...and a key in the namespace in no shape this module has ever written.
    storage.setItem('walnut:ask-object-somethingelse', JSON.stringify({ at: now }))
    expect(pruneAskObjectStore(storage, now)).toBe(4)
    expect(storage.length).toBe(0)
  })

  it('survives a storage that throws on removal', () => {
    const hostile = new FakeStorage()
    hostile.setItem(conv('stale'), JSON.stringify({ id: 'b', at: 0 }))
    vi.spyOn(hostile, 'removeItem').mockImplementation(() => { throw new Error('quota') })
    expect(() => pruneAskObjectStore(hostile, now)).not.toThrow()
  })
})
