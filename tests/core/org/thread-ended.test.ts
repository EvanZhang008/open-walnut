/**
 * A thread out of his sight whose work ended closes (2026-11-24, the threads inspection, item 3: 26
 * of his VP's pending threads named only completed tasks, some for three weeks, and nothing closed
 * them). src/core/org/thread-ended.ts endedWhy, closeEnded.
 *
 * Every state is classified: only pending closes; a thread that holds anything for him or a move of
 * the node stays open whatever its tasks say. The last test fails when a new state appears.
 */
import { describe, expect, it } from 'vitest'
import { closeEnded, ENDED_MS, endedWhy, HOLDS, QUIET_MS, type EndedTask } from '../../../src/core/org/thread-ended.js'
import { HELD_BY_THREAD } from '../../../src/core/org/thread-holds.js'
import { THREAD_STATES, type OrgThread, type ThreadsFile } from '../../../src/core/org/threads-model.js'

const NOW = Date.parse('2026-11-24T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const DAY = 24 * 3600_000
const LEAD = 'lead-1'
const tasks = (over: Partial<EndedTask> = {}) => new Map<string, EndedTask>([['t-fence', { id: 't-fence', phase: 'COMPLETE', completed_at: ago(4 * DAY), ...over }]])

/** His request, answered in the chat, handed to the fence task, set aside while it ran. */
const card = (over: Partial<OrgThread> = {}): OrgThread => ({
  id: 'th-fence01', title: 'Orchard fence', titled: true, state: 'pending', tasks: ['t-fence'],
  messages: [{ id: 'tm-fence0101', at: ago(10 * DAY), text: 'how tall should the orchard fence be?', via: 'chat', answer: { text: 'Two metres; the fence task builds it.', at: ago(10 * DAY - 60_000) } }],
  reply: 'The fence task builds it.', replyAt: ago(9 * DAY), createdAt: ago(10 * DAY), updatedAt: ago(9 * DAY), by: `task:${LEAD}`, ...over,
}) as OrgThread

describe('a thread whose work ended', () => {
  it('closes once every task it names completed three days ago, out of his sight and nothing of his open', () => {
    expect(endedWhy(card(), LEAD, tasks(), NOW)).toBe('work')
    const r = closeEnded({ version: 1, taskId: LEAD, threads: [card()] } as ThreadsFile, tasks(), NOW)
    expect(r.closed).toEqual([{ id: 'th-fence01', why: 'work' }])
    expect(r.file.threads[0].closed).toMatchObject({ how: 'dropped', by: 'agent' })
  })

  it('stays open while a task runs, completed less than three days ago, or is not in the store', () => {
    expect(endedWhy(card(), LEAD, tasks({ phase: 'IN_PROGRESS' }), NOW)).toBeNull()
    expect(endedWhy(card(), LEAD, tasks({ completed_at: ago(ENDED_MS - 60_000) }), NOW)).toBeNull()
    expect(endedWhy(card(), LEAD, new Map(), NOW)).toBeNull()
  })

  it('stays open while it holds anything for him or a word of his waits for an answer', () => {
    const keep: Array<[string, Partial<OrgThread>]> = [
      ['watched', { watched: { at: ago(DAY), by: 'human' } } as never],
      ['snoozed', { snoozed: { until: ago(-DAY), at: ago(DAY), by: 'human' } } as never],
      ['acknowledged, the AI still placing it', { ackedAt: ago(DAY) }],
      ['opened by a decision letter', { opener: { text: 'A letter asks about the fence.', at: ago(10 * DAY), from: 'letter', ref: 'lt-fence', by: `task:${LEAD}` } } as never],
      ['a decision letter', { letter: { id: 'lt-1', task: 't-fence', options: [] } } as never],
      ['the task\'s own ask', { reportAsk: { id: 'ask-1', at: ago(DAY) } } as never],
      ['his word unanswered', { messages: [...card().messages, { id: 'tm-fence0102', at: ago(5 * DAY), text: 'and the gate?', via: 'chat' }] } as never],
      ['his reply on its way', { messages: [{ ...card().messages[0], delivery: { state: 'pending', at: ago(DAY) } }] } as never],
    ]
    for (const [what, over] of keep) expect(endedWhy(card(over), LEAD, tasks(), NOW), what).toBeNull()
    // His question after the answer, and the node's status line rewriting the card since: still unanswered (review B1).
    const asked = card({ messages: [...card().messages, { id: 'tm-fence0104', at: ago(5 * DAY), text: 'and the gate too?', via: 'chat' }] as never,
      reply: 'Done: the fence is up.', replyAt: ago(4 * DAY), lineReplyAt: ago(4 * DAY) } as never)
    expect(endedWhy(asked, LEAD, tasks(), NOW)).toBeNull()
    // The node's own summary after it answers him.
    expect(endedWhy({ ...asked, lineReplyAt: undefined } as never, LEAD, tasks(), NOW)).toBe('work')
    // Acknowledged and placed long ago: like any other thread (review S3).
    expect(endedWhy(card({ ackedAt: ago(20 * DAY), ackPlaced: { to: 'waiting', by: 'walnut', at: ago(20 * DAY) } } as never), LEAD, tasks(), NOW)).toBe('work')
    // A task whose own thread still shows him a decision or a result there.
    const below = (state: string) => () => [{ id: 'th-below01', title: 'Fence gate: which latch?', state, needsAt: ago(DAY), messages: [], createdAt: ago(2 * DAY), updatedAt: ago(DAY), reply: 'Two latches fit.', replyAt: ago(DAY), by: 'task:t-fence' }] as never
    expect(endedWhy(card(), LEAD, tasks(), NOW, below('needs'))).toBeNull()
    expect(endedWhy(card(), LEAD, tasks(), NOW, below('pending'))).toBe('work')
    // A bare ok after the answer is no open word.
    const ok = card({ messages: [...card().messages, { id: 'tm-fence0103', at: ago(8 * DAY), text: 'ok, thanks', via: 'chat' }] as never })
    expect(endedWhy(ok, LEAD, tasks(), NOW)).toBe('work')
  })

  it('a thread naming no task closes after two weeks with nothing written, not before', () => {
    expect(endedWhy(card({ tasks: [] }), LEAD, tasks(), NOW)).toBeNull()
    const quiet = card({ tasks: [], updatedAt: ago(QUIET_MS + DAY), replyAt: ago(QUIET_MS + DAY), createdAt: ago(QUIET_MS + 2 * DAY),
      messages: [{ ...card().messages[0], at: ago(QUIET_MS + 2 * DAY), answer: { text: 'Noted.', at: ago(QUIET_MS + 2 * DAY) } }] as never })
    expect(endedWhy(quiet, LEAD, tasks(), NOW)).toBe('quiet')
    // One the node opened is one it keeps for him to follow: never closed for being quiet (review S2).
    expect(endedWhy({ ...quiet, opener: { text: 'You asked to hear when the permit comes.', at: ago(QUIET_MS + 3 * DAY), from: 'node', by: `task:${LEAD}` } } as never, LEAD, tasks(), NOW)).toBeNull()
  })

  it('every kind of item a thread holds for him keeps it open (thread-holds.ts HELD_BY_THREAD)', () => {
    const kinds = Object.entries(HELD_BY_THREAD).filter(([, held]) => !!held).map(([k]) => k).sort()
    expect(Object.keys(HOLDS).sort(), 'a new kind a thread holds: add it to HOLDS in thread-ended.ts').toEqual(kinds)
    const holding: Record<string, Partial<OrgThread>> = {
      letter: { letter: { id: 'lt-1', task: 't-fence', options: [] } } as never,
      ask: { reportAsk: { id: 'ask-1', at: ago(DAY) } } as never,
      choice: { choice: { board: 'b-1', id: 'c-1', options: [] } } as never,
    }
    for (const k of kinds) expect(endedWhy(card(holding[k]), LEAD, tasks(), NOW), k).toBeNull()
  })

  it('every state is classified: only pending closes here', () => {
    const CLOSES: Record<string, boolean> = { pending: true, new: false, working: false, needs: false, answered: false }
    expect([...THREAD_STATES].sort()).toEqual(Object.keys(CLOSES).sort())
    for (const state of THREAD_STATES) expect(endedWhy(card({ state }), LEAD, tasks(), NOW) === 'work', state).toBe(CLOSES[state])
  })
})
