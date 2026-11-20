/**
 * The candidate stage (src/core/org/reflection/candidates.ts) on its own: who judges a moment (one
 * node, never two), how an ask in Needs you is keyed and what it is shown, one candidate a thread
 * message, and the language check's false positives. Chinese test data as \u escapes.
 */
import { describe, it, expect, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-reflection-candidates'))

import type { Task } from '../../../src/core/types.js'
import { collectCandidates, EVIDENCE_MAX, type CandidateDeps, type ReflectionThread } from '../../../src/core/org/reflection/candidates.js'
import { localDate } from '../../../src/core/org/reflection/state.js'

const NOW = Date.parse('2026-11-20T20:00:00Z')
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString()
const SINCE = iso(23 * 60)

const main = { id: 'main-1', title: 'Main', org_role: 'main', phase: 'IN_PROGRESS', session_id: 'sess-main' } as Task
const vp = { id: 'vp-lagoon', title: 'Lagoon VP', project: 'Lagoon', org_role: 'lead', phase: 'IN_PROGRESS', session_id: 'sess-vp' } as Task
const vpOn = { ...vp, org_duties: { reflection: { on: true, at: iso(2000) } } } as Task
const worker = { id: 'w-pier', title: 'Rebuild the pier page', project: 'Lagoon', phase: 'IN_PROGRESS', session_id: 'sess-pier' } as Task
const ENGLISH = 'The page now loads the dock list first and the schedule after it, which makes it about a second faster for every visitor on the pier. '.repeat(2)
const CHINESE_SETTING = 'Talk to the user in Chinese; code and commits stay English.'

function deps(over: Partial<CandidateDeps> & { messages?: Record<string, Array<{ id: string; at: string; text: string }>>; threads?: Record<string, ReflectionThread[]> } = {}): CandidateDeps {
  return {
    readTranscript: async () => [],
    readMessages: async (id) => over.messages?.[id] ?? [],
    readThreads: async (id) => over.threads?.[id] ?? [],
    replyLanguage: async () => null,
    nowMs: () => NOW,
    ...over,
  }
}
const run = (node: Task, all: Task[], d: CandidateDeps, seen: string[] = []) => collectCandidates(node, all, SINCE, new Set(seen), d)

describe('one moment, one node', () => {
  it('leaves a task whose own lead reflects to that lead, for messages, asks and language alike', async () => {
    // Filed below Main and in the VP's project: both teams hold it (user-status.ts briefTeam).
    const asking = { ...worker, parent_task_id: main.id, user_status: { state: 'needs', source: 'session', at: iso(10), ask: 'Publish the second change too?', askSessionId: 'sess-pier' } } as unknown as Task
    const d = deps({ messages: { 'w-pier': [{ id: 'm1', at: iso(30), text: 'This is stupid, do not patch around it.' }] }, replyLanguage: async () => CHINESE_SETTING })
    expect((await run(main, [main, vpOn, asking], d)).candidates).toEqual([])
    // The VP judges them itself.
    expect((await run(vpOn, [main, vpOn, asking], d)).candidates.map((c) => c.signal).sort()).toEqual(['frustration', 'needs_ask'])
    // With the VP's reflection off, Main does.
    expect((await run(main, [main, vp, asking], d)).candidates.map((c) => c.signal).sort()).toEqual(['frustration', 'needs_ask'])
  })
})

describe('one moment, one node: by parent, and after a move', () => {
  it('judges a subtask filed under a reflecting VP (no project) once, by the VP', async () => {
    const vpBelowMain = { ...vpOn, parent_task_id: main.id } as Task
    const sub = { id: 'w-sub', title: 'Fix the dock list', parent_task_id: vp.id, phase: 'IN_PROGRESS', session_id: 'sess-sub' } as Task
    const d = deps({ messages: { 'w-sub': [{ id: 'm1', at: iso(30), text: 'This is stupid, do not patch around it.' }] } })
    const all = [main, vpBelowMain, sub]
    const byMain = (await run(main, all, d)).candidates.filter((c) => c.task.id === sub.id)
    const byVp = (await run(vpBelowMain, all, d)).candidates.filter((c) => c.task.id === sub.id)
    expect(byMain.length + byVp.length).toBe(1)
    expect(byVp).toHaveLength(1)
    // A completed VP runs no pass: Main covers its team.
    const done = { ...vpBelowMain, phase: 'COMPLETE', completed_at: iso(10) } as Task
    expect((await run(main, [main, done, sub], d)).candidates.filter((c) => c.task.id === sub.id)).toHaveLength(1)
  })

  it('keys a thread message by its own id, so a thread moved to another node is not judged again', async () => {
    const msg = { id: 'tm-bb0001', at: iso(30), text: 'The reply under the card used to show.', sid: 'sess-vp' }
    const first = (await run(vp, [vp], deps({ threads: { 'vp-lagoon': [{ id: 'th-bb0001', title: 'Pier', messages: [msg] }] } }))).candidates
    expect(first.map((c) => c.key)).toEqual(['tmsg:tm-bb0001'])
    const other = { ...vp, id: 'vp-garden', project: 'Garden' } as Task
    const moved = deps({ threads: { 'vp-garden': [{ id: 'th-bb0001', title: 'Pier', messages: [msg] }] } })
    expect((await run(other, [other], moved, ['tmsg:tm-bb0001'])).candidates).toEqual([])
  })
})

describe('an ask in Needs you', () => {
  const ask = (over: Record<string, unknown>) => ({ ...worker, user_status: { state: 'needs', source: 'session', ask: 'Publish the second change too?', ...over } }) as unknown as Task

  it('without a decision id is keyed by its source and words, never its time: judged once across reports', async () => {
    const first = (await run(vp, [vp, ask({ at: iso(30) })], deps())).candidates
    expect(first).toHaveLength(1)
    expect(first[0].key).toMatch(/^ask:w-pier:session:[a-f0-9]{12}$/)
    const again = await run(vp, [vp, ask({ at: iso(5), checkedAt: iso(4) })], deps(), [first[0].key])
    expect(again.candidates).toEqual([])
    // Another ask's words are another ask.
    expect((await run(vp, [vp, ask({ at: iso(5), ask: 'Rename the pier page?' })], deps(), [first[0].key])).candidates).toHaveLength(1)
  })

  it('reads his messages in the task and in the threads that went to it only: the newest few, each cut', async () => {
    const own = Array.from({ length: 35 }, (_, i) => ({ id: `m${i}`, at: iso(600 - i), text: i === 34 ? 'yes, '.repeat(200) : `note ${i}` }))
    const threads = { 'vp-lagoon': [
      { id: 'th-aa0001', title: 'Pier', tasks: ['w-pier'], messages: [{ id: 'tm-aa0001', at: iso(100), text: 'yes, publish both' }] },
      { id: 'th-aa0002', title: 'Garden', tasks: ['w-other'], messages: [{ id: 'tm-aa0002', at: iso(90), text: 'about the garden' }] },
      { id: 'th-aa0003', title: 'Loose', messages: [{ id: 'tm-aa0003', at: iso(80), text: 'something else' }] },
    ] }
    const [c] = (await run(vp, [vp, ask({ at: iso(20), askSessionId: 'sess-pier' })], deps({ messages: { 'w-pier': own }, threads }))).candidates
    const texts = c.evidence!.map((m) => m.text)
    expect(texts).toHaveLength(EVIDENCE_MAX)
    expect(texts.some((t) => t.includes('yes, publish both'))).toBe(true)
    expect(texts.some((t) => t.includes('garden') || t.includes('something else'))).toBe(false)
    expect(texts.every((t) => t.length <= 610)).toBe(true)
    expect(texts).not.toContain('note 0')
  })

  it('is only the session\'s own ask: errors, prompts, letters and choices are not candidates', async () => {
    for (const source of ['error', 'prompt', 'appro' + 'val', 'letter', 'choice', undefined]) {
      expect((await run(vp, [vp, ask({ at: iso(20), source, askSessionId: 'sess-pier' })], deps())).candidates).toEqual([])
    }
  })

  it('names the session that asked, and with none known is held, never sent to the current session', async () => {
    const [asked] = (await run(vp, [vp, ask({ at: iso(20), askSessionId: 'sess-older' })], deps())).candidates
    expect(asked.sessionId).toBe('sess-older')
    expect(asked.hold).toBeUndefined()
    const [unknown] = (await run(vp, [vp, ask({ at: iso(20) })], deps())).candidates
    expect(unknown.sessionId).toBe('')
    expect(unknown.hold).toBe('no_asking_session')
  })
})

describe('a thread message', () => {
  it('gives one candidate: its words first, the language check for the other answers', async () => {
    const threads = { 'vp-lagoon': [{ id: 'th-aa0001', title: 'Pier', messages: [
      { id: 'tm-aa0001', at: iso(60), text: 'The reply under the card used to show.', sid: 'sess-vp', answer: { text: ENGLISH, at: iso(58) } },
      { id: 'tm-aa0002', at: iso(40), text: 'how is it now', sid: 'sess-vp', answer: { text: ENGLISH, at: iso(38) } },
    ] }] }
    const { candidates } = await run(vp, [vp], deps({ threads, replyLanguage: async () => CHINESE_SETTING }))
    expect(candidates.map((c) => `${c.signal}:${c.messages[0]?.id}`)).toEqual(['regression:tm-aa0001', 'wrong_language:tm-aa0002'])
  })
})

describe('the language check', () => {
  const thread = (messages: ReflectionThread['messages']) => ({ 'vp-lagoon': [{ id: 'th-aa0001', title: 'Pier', messages }] })
  const lang = (threads: Record<string, ReflectionThread[]>, seen: string[] = [], node: Task = vp) =>
    run(node, [node], deps({ threads, replyLanguage: async () => CHINESE_SETTING }), seen).then((r) => r.candidates.filter((c) => c.signal === 'wrong_language'))

  it('runs only when the setting asks to answer in Chinese', async () => {
    const t = thread([{ id: 'tm-aa0001', at: iso(40), text: 'how is it', sid: 'sess-vp', answer: { text: ENGLISH, at: iso(38) } }])
    for (const setting of ['Reply in English.', 'Chinese food is fine', 'Talk to me in Chinese, but reply in English to reviews.']) {
      expect((await run(vp, [vp], deps({ threads: t, replyLanguage: async () => setting }))).candidates).toEqual([])
    }
    expect(await lang(t)).toHaveLength(1)
  })

  it('exempts an answer to a message that asks for English text', async () => {
    const t = thread([{ id: 'tm-aa0001', at: iso(40), text: 'write the email draft for the dock team', sid: 'sess-vp', answer: { text: ENGLISH, at: iso(38) } }])
    expect(await lang(t)).toEqual([])
  })

  it('looks at every bad answer, and keys one with no session by its thread', async () => {
    const t = { 'vp-lagoon': [{ id: 'th-aa0001', title: 'Pier', messages: [
      { id: 'tm-aa0001', at: iso(22 * 60), text: 'how is it', answer: { text: ENGLISH, at: iso(22 * 60 - 2) } },
      { id: 'tm-aa0002', at: iso(40), text: 'and now', answer: { text: ENGLISH, at: iso(38) } },
    ] }] }
    const bare = { ...vp, session_id: undefined } as Task
    const firstKey = `lang:th-aa0001:${localDate(Date.parse(iso(22 * 60 - 2)))}`
    const secondKey = `lang:th-aa0001:${localDate(Date.parse(iso(38)))}`
    const found = await lang(t, [], bare)
    expect(found[0].key).toBe(firstKey)
    // No session known: recorded only, never sent to the owner's current session.
    expect(found[0].hold).toBe('no_session')
    expect(found.every((c) => !c.key.startsWith('lang::'))).toBe(true)
    if (firstKey !== secondKey) expect((await lang(t, [firstKey], bare)).map((c) => c.key)).toEqual([secondKey])
  })

  it('measures only the session turns that answer him, not those after a peer\'s message', async () => {
    const messages = { 'w-pier': [{ id: 'm1', at: iso(60), text: 'how is the pier page' }] }
    const readTranscript = async () => [
      { role: 'user', text: 'how is the pier page', timestamp: iso(60), sentBy: 'person' },
      { role: 'assistant', text: '\u5feb\u597d\u4e86\u3002', timestamp: iso(58) },
      { role: 'user', text: 'Report from the dock task: build is green.', timestamp: iso(50), sentBy: 'agent' },
      { role: 'assistant', text: ENGLISH, timestamp: iso(48) },
    ] as never
    const d = deps({ messages, readTranscript, replyLanguage: async () => CHINESE_SETTING })
    expect((await run(vp, [vp, worker], d)).candidates).toEqual([])
    const answered = async () => [
      { role: 'user', text: 'how is the pier page', timestamp: iso(60), sentBy: 'person' },
      { role: 'assistant', text: ENGLISH, timestamp: iso(58) },
    ] as never
    expect((await run(vp, [vp, worker], { ...d, readTranscript: answered })).candidates.map((c) => c.key)).toEqual([`lang:sess-pier:${localDate(Date.parse(iso(58)))}`])
  })
})
