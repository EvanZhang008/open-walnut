/**
 * taskTextSource (web/src/utils/agent-text-source.ts): a task's stored words open where Walnut
 * recorded they were written, never in the task's current session.
 *
 * 2026-11-07: a status line an older session wrote ("see /home/me/notes/plan.md") opened that path
 * through the task's newer session, on another machine, so the user read a same-named file from the
 * wrong host. Every fixture here has the writer `s-old` and a current session `s-new` that must
 * never be the answer.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Task } from '@open-walnut/core'
import { openFromSource, sourceHostOf, taskTextSource, type AgentTextSource, type TaskTextField } from '../../web/src/utils/agent-text-source'

const CURRENT = 's-new'
const task = (over: Record<string, unknown> = {}): Task => ({
  id: 't1', title: 'T', session_ids: ['s-old', CURRENT], session_id: CURRENT, exec_session_id: CURRENT, ...over,
} as unknown as Task)
const status = (us: Record<string, unknown>) => task({ user_status: { state: 'waiting', ...us } })
const UNKNOWN: AgentTextSource = { unknownSource: true }
const PRIMARY: AgentTextSource = { host: '__local__' }
const FIELDS: TaskTextField[] = ['report', 'waiting', 'needs', 'line', 'summary', 'lastWords', 'result', 'partial']

describe('the writer of a task\'s stored words', () => {
  it('a report opens in the session that wrote it; a person\'s on the primary; none recorded is unknown', () => {
    expect(taskTextSource(status({ now: 'see /a.ts', reportBy: 'self', reportSessionId: 's-old' }), 'report')).toEqual({ sessionId: 's-old' })
    // A lead's report names its own session: still the writer, not the task's.
    expect(taskTextSource(status({ now: 'x', reportBy: 'task:lead', reportSessionId: 's-lead' }), 'report')).toEqual({ sessionId: 's-lead' })
    expect(taskTextSource(status({ now: 'x', reportBy: 'human', reportSessionId: 's-old' }), 'report')).toEqual(PRIMARY)
    expect(taskTextSource(status({ now: 'x', reportBy: 'self' }), 'report')).toEqual(UNKNOWN)
  })

  it('a wait answered above opens where the answer was written; else only the writer stored with the wait', () => {
    // Main answered the worker's ask: the words are Main's session's.
    const byMain = status({ waitingOn: 'acting on /srv/plan.md', reportSessionId: 's-old', waitingSessionId: 's-old', answeredFor: { by: 'task:main', byTitle: 'Main', at: 'x', ask: 'a', sessionId: 's-main' } })
    expect(taskTextSource(byMain, 'waiting')).toEqual({ sessionId: 's-main' })
    const byHuman = status({ waitingOn: 'x', reportSessionId: 's-old', answeredFor: { by: 'human', byTitle: 'You', at: 'x', ask: 'a' } })
    expect(taskTextSource(byHuman, 'waiting')).toEqual(PRIMARY)
    // An answer from an older server with no session: unknown, not the report's writer and not current.
    const noSid = status({ waitingOn: 'x', reportSessionId: 's-old', waitingSessionId: 's-old', answeredFor: { by: 'task:main', byTitle: 'Main', at: 'x', ask: 'a' } })
    expect(taskTextSource(noSid, 'waiting')).toEqual(UNKNOWN)
    // The report's own waiting_on: its stored writer.
    expect(taskTextSource(status({ waitingOn: 'the review', waitingBy: 'self', waitingSessionId: 's-old' }), 'waiting')).toEqual({ sessionId: 's-old' })
    expect(taskTextSource(status({ waitingOn: 'the review', waitingBy: 'human', waitingSessionId: 's-old' }), 'waiting')).toEqual(PRIMARY)
  })

  it('a wait Walnut generated never borrows the report\'s or the line\'s writer', () => {
    // A stuck or timed wait with a report's now beside it: the now's writer did not write the wait.
    const generated = status({ kind: 'stuck', waitingOn: 'Stopped: see /srv/a.ts', now: 'built /srv/a.ts', reportBy: 'self', reportSessionId: 's-old' })
    expect(taskTextSource(generated, 'waiting')).toEqual(UNKNOWN)
    // Even when the line says the same words, the line is no record of who wrote the wait.
    const sameAsLine = status({ waitingOn: 'the review of /a.ts', reportSessionId: 's-report', line: { text: 'the review of /a.ts', by: 'task:lead', at: 'x', sessionId: 's-lead' } })
    expect(taskTextSource(sameAsLine, 'waiting')).toEqual(UNKNOWN)
    // The line itself still opens where it was written.
    expect(taskTextSource(sameAsLine, 'line')).toEqual({ sessionId: 's-lead' })
    expect(taskTextSource(generated, 'report')).toEqual({ sessionId: 's-old' })
  })

  it('a needs line reads its own writer: the turn\'s last words, the session\'s ask; a letter\'s or a choice\'s is unknown', () => {
    const lw = { text: 'see /a.ts', at: 'x', session_id: 's-old' }
    expect(taskTextSource(task({ last_words: lw, user_status: { state: 'read', toRead: 'turn', reportSessionId: 's-report' } }), 'needs')).toEqual({ sessionId: 's-old' })
    expect(taskTextSource(task({ user_status: { state: 'read', toRead: 'turn' } }), 'needs')).toEqual(UNKNOWN)
    expect(taskTextSource(task({ user_status: { state: 'needs', source: 'session', ask: 'x', askSessionId: 's-old', reportSessionId: 's-other' } }), 'needs')).toEqual({ sessionId: 's-old' })
    expect(taskTextSource(task({ user_status: { state: 'needs', source: 'session', ask: 'old held ask', reportBy: 'human', reportSessionId: 's-other' } }), 'needs')).toEqual(UNKNOWN)
    expect(taskTextSource(task({ user_status: { state: 'needs', source: 'session', ask: 'x', askBy: 'human' } }), 'needs')).toEqual(PRIMARY)
    expect(taskTextSource(task({ user_status: { state: 'read', toRead: 'answer', waitingBy: 'human', reportSessionId: 's-other' } }), 'needs')).toEqual(PRIMARY)
    expect(taskTextSource(task({ user_status: { state: 'read', toRead: 'answer', waitingSessionId: 's-wait', reportSessionId: 's-other' } }), 'needs')).toEqual({ sessionId: 's-wait' })
    expect(taskTextSource(task({ user_status: { state: 'read', toRead: 'answer', reportBy: 'human' } }), 'needs')).toEqual(UNKNOWN)
    for (const source of ['letter', 'choice', 'prompt', 'error', 'thread']) {
      expect(taskTextSource(task({ last_words: lw, user_status: { state: 'needs', source, ask: 'x', reportSessionId: 's-old' } }), 'needs'), source).toEqual(UNKNOWN)
    }
  })

  it('a line, a summary, last words and a result each read their own stored writer', () => {
    expect(taskTextSource(status({ line: { text: 'x', by: 'self', at: 'x', sessionId: 's-old' } }), 'line')).toEqual({ sessionId: 's-old' })
    expect(taskTextSource(status({ line: { text: 'x', by: 'human', at: 'x' } }), 'line')).toEqual(PRIMARY)
    expect(taskTextSource(status({ line: { text: 'x', by: 'self', at: 'x' } }), 'line')).toEqual(UNKNOWN)
    expect(taskTextSource(task({ summary: 'x', summary_session_id: 's-old' }), 'summary')).toEqual({ sessionId: 's-old' })
    expect(taskTextSource(task({ summary: 'x' }), 'summary')).toEqual(UNKNOWN)
    expect(taskTextSource(task({ last_words: { text: 'x', at: 'x', session_id: 's-old' } }), 'lastWords')).toEqual({ sessionId: 's-old' })
    expect(taskTextSource(task({ result_report: { via: 'reply', at: 'x', by: 'task:t1', sessionId: 's-old', not_done: ['x'] } }), 'result')).toEqual({ sessionId: 's-old' })
    expect(taskTextSource(task({ result_report: { via: 'reply', at: 'x', by: 'human', host: 'local' } }), 'result')).toEqual(PRIMARY)
    // An older raw `by: human` may be a session caller Walnut could not resolve: never the primary by guess.
    expect(taskTextSource(task({ result_report: { via: 'complete', at: 'x', by: 'human' } }), 'result')).toEqual(UNKNOWN)
    expect(taskTextSource(task({ result_report: { via: 'complete', at: 'x', by: 'human', not_done: ['x'] } }), 'partial')).toEqual(UNKNOWN)
    expect(taskTextSource(task({ result_report: { via: 'reply', at: 'x', by: 'task:t1' } }), 'result')).toEqual(UNKNOWN)
  })

  it('a merged partial is unknown while the new result keeps its writer', () => {
    const t = task({ result_report: { via: 'reply', at: 'x', by: 'task:t1', sessionId: 's-new-writer', result: 'New result', not_done: ['Old hold', 'New limit'], not_done_by: 'unknown' } })
    expect(taskTextSource(t, 'result')).toEqual({ sessionId: 's-new-writer' })
    expect(taskTextSource(t, 'partial')).toEqual(UNKNOWN)
    const one = task({ result_report: { via: 'reply', at: 'x', by: 'human', host: 'local', not_done: ['New limit'] } })
    expect(taskTextSource(one, 'partial')).toEqual(PRIMARY)
  })

  it('never answers with the task\'s current session, and no task is unknown', () => {
    // A task whose stored words carry no writer at all, but that runs a session now.
    const bare = task({ user_status: { state: 'needs', source: 'session', ask: 'x', waitingOn: 'y', now: 'z' }, summary: 's', last_words: undefined })
    for (const f of FIELDS) {
      expect(taskTextSource(bare, f), f).toEqual(UNKNOWN)
      expect(sourceHostOf(taskTextSource(bare, f)), f).toEqual({ kind: 'unknown' })
      expect(taskTextSource(undefined, f), f).toEqual(UNKNOWN)
      expect(taskTextSource(null, f), f).toEqual(UNKNOWN)
      // The helper never attaches the task: a renderer must not fall back to its session.
      expect(taskTextSource(bare, f).task, f).toBeUndefined()
    }
  })

  it('end to end: the old writer\'s host is read on the click, the current session is never asked', async () => {
    const t = status({ now: 'see /home/me/plan.md', reportSessionId: 's-old' })
    const fetch = vi.fn(async (sid: string) => ({ host: sid === 's-old' ? 'old-box' : 'new-box' }))
    const open = vi.fn()
    await openFromSource(taskTextSource(t, 'report'), { path: '/home/me/plan.md' }, { lookup: { peek: () => null, fetch }, open, fail: vi.fn() })
    expect(fetch).toHaveBeenCalledExactlyOnceWith('s-old')
    expect(open).toHaveBeenCalledExactlyOnceWith({ path: '/home/me/plan.md', host: 'old-box' })

    // A person's report opens on the primary with no lookup, even when the task runs remotely now.
    const human = status({ now: 'x', reportBy: 'human', reportSessionId: CURRENT })
    const open2 = vi.fn()
    await openFromSource(taskTextSource(human, 'report'), { path: '/home/me/plan.md' }, { lookup: { peek: () => null, fetch }, open: open2, fail: vi.fn() })
    expect(open2).toHaveBeenCalledExactlyOnceWith({ path: '/home/me/plan.md', host: undefined })
    expect(fetch).toHaveBeenCalledOnce()
  })
})
