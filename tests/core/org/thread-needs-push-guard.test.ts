/**
 * Guard: a thread that waits on the user buzzes his phone (2026-11-04, Walnut VP for the user: "Evan
 * wants no duplicates, not no reminders"; push/thread-push.ts).
 *
 * Fails when a move into needs is not seen (threads-model.ts enteredNeeds), when the buzz rules
 * drift (only needs, once per entry, never while he is in the chat, one buzz per absence shared with
 * the away letters), when the notification stops carrying the node and the thread, or when a write
 * of a threads file goes around threads-store.ts mutateThreads, the one write that hands every move
 * into needs to the push. The server flow is tests/e2e/thread-needs-push.test.ts.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { emptyThreads, enteredNeeds, fileMessage, mergeThreads, openThread, splitThreadMessage, updateThread, type ThreadsFile } from '../../../src/core/org/threads-model.js'
import { THREAD_PUSH_TYPE, lastThreadBuzz, planThreadBuzz, threadPushContent } from '../../../src/core/push/thread-push.js'
import { DECISION_QUIET_MS, planAwaySend } from '../../../src/core/human-inbox/away-thread.js'

const NOW = Date.parse('2026-11-04T03:00:00Z')
const iso = (agoMin: number) => new Date(NOW - agoMin * 60_000).toISOString()
const KIND = { user_kind: 'spending', user_kind_why: 'It buys a paid plan for the team' } as const
const NODE = 'task:lead-1' as const

function asked(): ThreadsFile {
  return fileMessage(emptyThreads('lead-1'), { text: 'should we buy the plan?', via: 'chat', at: iso(60) }).file
}

describe('a move into needs is seen (enteredNeeds)', () => {
  it('a node\'s write into needs counts; staying there, his own write, another state or a closed thread does not', () => {
    const f0 = asked()
    const id = f0.threads[0].id
    const f1 = updateThread(f0, id, { state: 'needs', ask: 'Buy the plan?', ...KIND }, NODE, iso(50)).file
    expect(enteredNeeds(f0, f1).map((t) => t.id)).toEqual([id])
    // Still needs, a new summary: no new entry.
    const f2 = updateThread(f1, id, { reply: 'Still waiting on the plan choice' }, NODE, iso(40)).file
    expect(enteredNeeds(f1, f2)).toEqual([])
    // Answered, working, pending never.
    for (const state of ['answered', 'working', 'pending'] as const) {
      expect(enteredNeeds(f0, updateThread(f0, id, { state }, NODE, iso(50)).file), state).toEqual([])
    }
    // Out and back in: a new entry.
    const out = updateThread(f2, id, { state: 'working' }, NODE, iso(30)).file
    expect(enteredNeeds(out, updateThread(out, id, { state: 'needs', ...KIND }, NODE, iso(20)).file).map((t) => t.id)).toEqual([id])
    // His own write never buzzes him.
    expect(enteredNeeds(f0, updateThread(f0, id, { state: 'needs' }, 'human', iso(50)).file)).toEqual([])
  })

  it('merge, split, reopen and the buzz mark itself: each counted once or not at all', () => {
    const f0 = asked()
    const a = f0.threads[0].id
    let f = updateThread(f0, a, { state: 'needs', ...KIND }, NODE, iso(50)).file
    // The buzz mark changes no state: no new entry, so it cannot buzz again.
    const marked = { ...f, threads: f.threads.map((t) => ({ ...t, needsBuzzedAt: iso(49) })) }
    expect(enteredNeeds(f, marked)).toEqual([])
    // A second ask merged into the needs thread: still needs, no new entry; its buzz mark is kept.
    let g = fileMessage(marked, { text: 'and the price?', via: 'chat', at: iso(45) }).file
    const b = g.threads.find((t) => t.id !== a)!.id
    const merged = mergeThreads(g, b, a, NODE, iso(44))
    expect(enteredNeeds(g, merged.file)).toEqual([])
    expect(merged.thread.needsBuzzedAt).toBe(iso(49))
    // The merged one buzzed: the mark moves with its messages into the other thread.
    g = updateThread(fileMessage(f0, { text: 'another', via: 'chat', at: iso(45) }).file, a, { state: 'working' }, NODE, iso(44)).file
    const c = g.threads.find((t) => t.id !== a)!.id
    g = { ...g, threads: g.threads.map((t) => (t.id === c ? { ...t, needsBuzzedAt: iso(43) } : t)) }
    expect(mergeThreads(g, c, a, NODE, iso(42)).thread.needsBuzzedAt).toBe(iso(43))
    // A message split out of a needs thread is a new thread that waits on no one yet.
    f = fileMessage(marked, { text: 'and the invoice?', via: 'follow-up', at: iso(40), threadId: a }).file
    const msg = f.threads.find((t) => t.id === a)!.messages.at(-1)!.id
    expect(enteredNeeds(f, splitThreadMessage(f, a, msg, NODE, iso(39)).file)).toEqual([])
    // Closed by him, reopened by the node straight into needs: a new entry.
    const closed = { ...marked, threads: marked.threads.map((t) => ({ ...t, closed: { how: 'acked' as const, at: iso(30), by: 'human' as const } })) }
    expect(enteredNeeds(closed, updateThread(closed, a, { reopen: true, state: 'needs', ...KIND }, NODE, iso(20)).file).map((t) => t.id)).toEqual([a])
  })

  it('a thread the node opens waiting on him is an entry too', () => {
    const f0 = emptyThreads('lead-1')
    const r = openThread(f0, { title: 'Answer the organizer', text: 'A mail asks for a date', from: 'mail', ...KIND }, NODE, iso(5))
    expect(r.thread.state).toBe('needs')
    expect(enteredNeeds(f0, r.file).map((t) => t.id)).toEqual([r.thread.id])
  })
})

describe('when it buzzes (planThreadBuzz)', () => {
  const away = { away: true, lastSeenAt: NOW - 120 * 60_000 }
  const base = { threadId: 'th-aaaaaaaaaaaa', away, threads: [], letters: [], now: NOW }
  it('buzzes while he is away; never while he is in the chat or when the node is no org node', () => {
    expect(planThreadBuzz(base)).toEqual({ buzz: true })
    expect(planThreadBuzz({ ...base, away: { away: false, lastSeenAt: NOW } })).toMatchObject({ buzz: false, reason: expect.stringMatching(/in the node's chat/) })
    expect(planThreadBuzz({ ...base, away: null })).toMatchObject({ buzz: false })
  })

  it('one buzz per absence: an unread letter or another thread\'s buzz of it lately keeps it quiet', () => {
    expect(planThreadBuzz({ ...base, letters: [{ createdAt: NOW - 10 * 60_000, read: false }] })).toMatchObject({ buzz: false, reason: expect.stringMatching(/unread letter/) })
    expect(planThreadBuzz({ ...base, letters: [{ createdAt: NOW - 10 * 60_000, read: true }] })).toEqual({ buzz: true })
    expect(planThreadBuzz({ ...base, letters: [{ createdAt: NOW - DECISION_QUIET_MS - 1, read: false }] })).toEqual({ buzz: true })
    const other = { id: 'th-bbbbbbbbbbbb', state: 'needs' as const, needsBuzzedAt: iso(5) }
    expect(planThreadBuzz({ ...base, threads: [other] })).toMatchObject({ buzz: false, reason: expect.stringMatching(/another thread/) })
    // He answered that one (it left needs), or it closed: like a letter he read, it holds nothing.
    expect(planThreadBuzz({ ...base, threads: [{ ...other, state: 'working' }] })).toEqual({ buzz: true })
    expect(planThreadBuzz({ ...base, threads: [{ ...other, closed: { how: 'acked', at: iso(1), by: 'human' } }] })).toEqual({ buzz: true })
    // Older than the decision clock, or before he was last back (another absence).
    expect(planThreadBuzz({ ...base, threads: [{ ...other, needsBuzzedAt: new Date(NOW - DECISION_QUIET_MS - 1).toISOString() }] })).toEqual({ buzz: true })
    expect(planThreadBuzz({ ...base, threads: [{ ...other, needsBuzzedAt: iso(130) }] })).toEqual({ buzz: true })
    // Its own earlier buzz does not silence its next entry.
    expect(planThreadBuzz({ ...base, threads: [{ ...other, id: base.threadId }] })).toEqual({ buzz: true })
  })

  it('an away letter counts a thread\'s buzz of the absence as the absence\'s buzz', () => {
    const mark = { taskId: 'lead-1', since: NOW - 120 * 60_000 }
    const needs = 'needs' as const
    const buzz = lastThreadBuzz([{ state: needs, needsBuzzedAt: iso(5) }, { state: needs, needsBuzzedAt: iso(200) }, { state: needs }, { state: 'working', needsBuzzedAt: iso(1) }], mark.since)
    expect(buzz).toBe(NOW - 5 * 60_000)
    // Nothing still waiting, or never back in the chat (since null) with only an answered thread: no buzz to count.
    expect(lastThreadBuzz([{ state: 'answered', needsBuzzedAt: iso(1) }], null)).toBeNull()
    for (const type of ['info', 'action_required'] as const) {
      expect(planAwaySend({ type }, mark, 's1', [], NOW, buzz), type).toMatchObject({ kind: 'new', quiet: true })
      // The decision clock ends it for both, as no "read" can.
      expect(planAwaySend({ type }, mark, 's1', [], NOW + DECISION_QUIET_MS, buzz), type).toMatchObject({ kind: 'new', quiet: false })
    }
    expect(planAwaySend({ type: 'info' }, mark, 's1', [], NOW, null)).toMatchObject({ kind: 'new', quiet: false })
  })
})

describe('what the phone gets', () => {
  it('the thread\'s title and ask, the node and the thread, a decision\'s priority, one banner per thread', () => {
    const c = threadPushContent({ id: 'th-aaaaaaaaaaaa', title: 'Buy the paid plan?', ask: 'Pick a plan for the team' }, { id: 'lead-1', org_role: 'lead', project: 'Walnut' })
    expect(c).toMatchObject({ title: 'Buy the paid plan?', body: 'Pick a plan for the team', priority: 10, collapseId: 'th-aaaaaaaaaaaa' })
    expect(c.data).toEqual({ type: THREAD_PUSH_TYPE, taskId: 'lead-1', threadId: 'th-aaaaaaaaaaaa', url: '/org?node=Walnut' })
    expect(threadPushContent({ id: 'th-1', title: 'x' }, { id: 'm', org_role: 'main' }).data?.url).toBe('/org?node=main')
  })
})

describe('no write of a threads file goes around the push', () => {
  const src = fs.readFileSync(path.resolve('src/core/org/threads-store.ts'), 'utf8')
  it('threads-store.ts writes the file in mutateThreads alone, and mutateThreads hands every move into needs on', () => {
    const writes = [...src.matchAll(/\b(?:updateJsonFile|writeJsonFile|writeFile|writeFileSync|rename)\s*[<(]/g)]
    expect(writes).toHaveLength(1)
    const body = src.slice(src.indexOf('async function mutateThreads'), src.indexOf('export async function markNeedsBuzzed'))
    expect(body).toContain('updateJsonFile')
    expect(body).toContain('enteredNeeds(cur, res.file)')
    expect(body).toContain('onThreadsEnteredNeeds(taskId')
  })

  it('no other file under src/ touches the threads directory', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue }
        if (!/\.(ts|tsx|mjs|js)$/.test(e.name) || p.endsWith(path.join('org', 'threads-store.ts'))) continue
        const text = fs.readFileSync(p, 'utf8')
        if (/['"]org['"]\s*,\s*['"]threads['"]|org\/threads\//.test(text)) offenders.push(path.relative(process.cwd(), p))
      }
    }
    walk(path.resolve('src'))
    expect(offenders).toEqual([])
  })
})
