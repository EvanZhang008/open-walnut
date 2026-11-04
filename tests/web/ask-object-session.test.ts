/**
 * The session behind an "ask about this object" drawer (web/src/components/chat/ask-object-session.ts).
 *
 * Since 2026-09-25 an ask about a mail is an ordinary Ask Walnut session rendered by SessionPanel. What
 * this file pins is the part that decides WHICH session and WHAT gets sent:
 *   . one session per (agent, object), remembered across opens, forgotten on request;
 *   . a canned question is sent once per session, a different one still goes out;
 *   . the first message is the question alone: the object's context rides beside it as a hint;
 *   . one launch in flight per scope, and nothing remembered when the launch fails;
 *   . the 30-day prune, and that the OLD ask-object prune does not eat these keys.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  askSessionAsked,
  firstAskView,
  forgetAskSession,
  launchAskSession,
  objectContextHints,
  storeObjectContext,
  pruneAskSessions,
  readAskSession,
  withAsked,
  writeAskSession,
  type AskSessionLaunch,
} from '../../web/src/components/chat/ask-object-session'
import { pruneAskObjectStore } from '../../web/src/components/chat/ask-object-conversation'

class MemoryStorage {
  private map = new Map<string, string>()
  get length(): number { return this.map.size }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null }
  getItem(key: string): string | null { return this.map.get(key) ?? null }
  setItem(key: string, value: string): void { this.map.set(key, value) }
  removeItem(key: string): void { this.map.delete(key) }
  keys(): string[] { return [...this.map.keys()] }
}

const MAIL = { agentId: 'general', key: 'mail:["fixture:a","INBOX:1:31"]' }
const PAYLOAD: AskSessionLaunch = { cwd: '', message: 'x', walnutAgent: true }

let storage: MemoryStorage
beforeEach(() => { storage = new MemoryStorage() })

describe('which session is this object\'s', () => {
  it('remembers per agent AND object', () => {
    writeAskSession(MAIL, { taskId: 't1', sessionId: 's1', asked: [], at: 1 }, storage)
    expect(readAskSession(MAIL, storage)?.sessionId).toBe('s1')
    // The same mail under another agent is another session.
    expect(readAskSession({ ...MAIL, agentId: 'mentor' }, storage)).toBeNull()
    // Another mail under the same agent too.
    expect(readAskSession({ ...MAIL, key: 'mail:["fixture:a","INBOX:1:30"]' }, storage)).toBeNull()
  })

  it('forgets on request, so the next ask starts over', () => {
    writeAskSession(MAIL, { taskId: 't1', sessionId: 's1', asked: [], at: 1 }, storage)
    forgetAskSession(MAIL, storage)
    expect(readAskSession(MAIL, storage)).toBeNull()
  })

  it('treats a hand-edited or foreign value as absent, never as a session', () => {
    storage.setItem(`walnut:ask-session:general:${MAIL.key}`, '{"sessionId":"s1"}')
    expect(readAskSession(MAIL, storage)).toBeNull()
    storage.setItem(`walnut:ask-session:general:${MAIL.key}`, 'not json')
    expect(readAskSession(MAIL, storage)).toBeNull()
  })

  it('keeps a task whose session id is not known yet (an engine that mints its own)', () => {
    writeAskSession(MAIL, { taskId: 't1', asked: [], at: 1 }, storage)
    const record = readAskSession(MAIL, storage)
    expect(record?.taskId).toBe('t1')
    expect(record?.sessionId).toBeUndefined()
  })
})

describe('a canned question goes out once per session', () => {
  const SUMMARIZE = 'Summarize this mail in three short bullets.'
  const DRAFT = 'Draft a reply. Do not send it.'

  it('is asked once, and a different question is still asked', () => {
    const record = withAsked({ taskId: 't1', sessionId: 's1', asked: [], at: 1 }, SUMMARIZE, 2)
    expect(askSessionAsked(record, SUMMARIZE)).toBe(true)
    expect(askSessionAsked(record, DRAFT)).toBe(false)
    const both = withAsked(record, DRAFT, 3)
    expect(askSessionAsked(both, DRAFT)).toBe(true)
    expect(both.at).toBe(3)
  })

  it('does not record the same question twice, and re-stamps without a question', () => {
    const once = withAsked({ taskId: 't1', asked: [], at: 1 }, SUMMARIZE, 2)
    expect(withAsked(once, SUMMARIZE, 3).asked).toHaveLength(1)
    expect(withAsked(once, undefined, 9)).toMatchObject({ asked: once.asked, at: 9 })
  })

  it('an unknown session has asked nothing', () => {
    expect(askSessionAsked(null, SUMMARIZE)).toBe(false)
  })
})

describe('what Walnut knows of the object rides beside the question, never in it', () => {
  it('stores the context and names it as the object-context hint', async () => {
    const posts: Array<{ path: string; body: unknown }> = []
    const post = async (path: string, body: unknown) => { posts.push({ path, body }); return { id: 'hc-0123456789abcdef' } }
    // Test data only: an accented subject written as an escape.
    const id = await storeObjectContext('Mail you are asking about', 'Subject: caf\u00e9', post)
    expect(id).toBe('hc-0123456789abcdef')
    expect(posts).toEqual([{ path: '/api/v1/hints/context', body: { name: 'Mail you are asking about', text: 'Subject: caf\u00e9' } }])
    expect(objectContextHints(id)).toEqual({ 'object-context': { arg: 'hc-0123456789abcdef' } })
  })

  it('no context: nothing stored, no hint', async () => {
    let called = false
    expect(await storeObjectContext('Mail', '  \n', async () => { called = true; return { id: 'x' } })).toBe('')
    expect(called).toBe(false)
  })
})

describe('one launch per object', () => {
  it('shares one launch between two calls in flight, and remembers the answer', async () => {
    let calls = 0
    let release: (value: { taskId: string; sessionId?: string }) => void = () => {}
    const start = () => {
      calls += 1
      return new Promise<{ taskId: string; sessionId?: string }>((resolve) => { release = resolve })
    }
    const a = launchAskSession(MAIL, PAYLOAD, 'Summarize', { storage, start, now: () => 5 })
    const b = launchAskSession(MAIL, PAYLOAD, 'Summarize', { storage, start, now: () => 5 })
    release({ taskId: 't1', sessionId: 's1' })
    const [one, two] = await Promise.all([a, b])
    expect(calls).toBe(1)
    expect(one.record).toBe(two.record)
    // The second call's message was never sent: it says so, so the drawer can send it into the session.
    expect(one.joined).toBe(false)
    expect(two.joined).toBe(true)
    expect(readAskSession(MAIL, storage)).toMatchObject({ taskId: 't1', sessionId: 's1', at: 5 })
    expect(askSessionAsked(readAskSession(MAIL, storage), 'Summarize')).toBe(true)
  })

  it('remembers nothing when the server refuses, and a retry launches again', async () => {
    let calls = 0
    const refuse = () => { calls += 1; return Promise.reject(new Error('500')) }
    await expect(launchAskSession(MAIL, PAYLOAD, undefined, { storage, start: refuse })).rejects.toThrow('500')
    expect(readAskSession(MAIL, storage)).toBeNull()
    await expect(launchAskSession(MAIL, PAYLOAD, undefined, { storage, start: refuse })).rejects.toThrow('500')
    expect(calls).toBe(2)
  })

  it('two different objects launch independently', async () => {
    let calls = 0
    const start = () => { calls += 1; return Promise.resolve({ taskId: `t${calls}`, sessionId: `s${calls}` }) }
    const other = { ...MAIL, key: 'mail:["fixture:a","INBOX:1:30"]' }
    await Promise.all([
      launchAskSession(MAIL, PAYLOAD, undefined, { storage, start }),
      launchAskSession(other, PAYLOAD, undefined, { storage, start }),
    ])
    expect(calls).toBe(2)
    expect(readAskSession(MAIL, storage)?.sessionId).not.toBe(readAskSession(other, storage)?.sessionId)
  })
})

describe('pruning', () => {
  const DAY = 24 * 60 * 60 * 1000

  it('drops records unused for 30 days and anything under the prefix that is not a record', () => {
    const now = 100 * DAY
    writeAskSession(MAIL, { taskId: 'old', sessionId: 's-old', asked: [], at: now - 31 * DAY }, storage)
    const fresh = { ...MAIL, key: 'mail:fresh' }
    writeAskSession(fresh, { taskId: 'new', sessionId: 's-new', asked: [], at: now - DAY }, storage)
    storage.setItem('walnut:ask-session:junk', 'nope')
    storage.setItem('walnut:other', 'kept')
    expect(pruneAskSessions(storage, now)).toBe(2)
    expect(readAskSession(MAIL, storage)).toBeNull()
    expect(readAskSession(fresh, storage)?.sessionId).toBe('s-new')
    expect(storage.getItem('walnut:other')).toBe('kept')
  })

  it('is not in the old ask-object namespace, whose prune deletes every key it does not know', () => {
    writeAskSession(MAIL, { taskId: 't1', sessionId: 's1', asked: [], at: Date.now() }, storage)
    pruneAskObjectStore(storage, Date.now())
    expect(readAskSession(MAIL, storage)?.sessionId).toBe('s1')
  })
})

describe('firstAskView: the drawer draws from the remembered record, never a request first', () => {
  // 2026-11-04, the user: "the data is cache not sure why there is delay". The drawer used to show
  // "Opening..." until a fetch of the remembered session came back.
  const record = (over: Partial<{ sessionId: string; asked: string[] }> = {}) => ({ taskId: 't-1', at: 1, asked: [], ...over })

  it('composes at once when nothing is remembered', () => {
    expect(firstAskView(null, '')).toEqual({ kind: 'compose' })
  })

  it('opens a remembered session at once', () => {
    expect(firstAskView(record({ sessionId: 's-1' }), '')).toEqual({ kind: 'session', sessionId: 's-1' })
  })

  it('links a task still waiting for its session', () => {
    expect(firstAskView(record(), '')).toEqual({ kind: 'linking', taskId: 't-1' })
  })

  it('waits only for a canned question still to send', () => {
    expect(firstAskView(record({ sessionId: 's-1' }), 'Summarize this').kind).toBe('resolving')
    expect(firstAskView(null, 'Summarize this').kind).toBe('resolving')
  })
})
