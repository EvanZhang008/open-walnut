/**
 * A thread in needs whose decision a task already asks him is a pointer to that task's ask, never a
 * second ask (src/core/org/thread-task-ask.ts). Fails when a linked task asking ANOTHER decision
 * hides a thread, when an unlinked task or another area's task hides one, when the pointer outlives
 * the task's ask (completed, stopped asking, a new decision), or when the counts, the overdue clock
 * and the stored state disagree with the projection.
 */
import { describe, it, expect } from 'vitest'
import { askOwnerKept, askOwnerOf, askPointerSignature, sameThreadDecision, threadAskedIn, withAskPointers } from '../../../src/core/org/thread-task-ask.js'
import { askKey } from '../../../src/core/same-ask.js'
import { shownToHim, threadCounts, threadOverdue } from '../../../src/core/org/thread-view.js'
import type { OrgThread } from '../../../src/core/org/threads-model.js'
import type { Task } from '../../../src/core/types.js'

const NOW = Date.parse('2026-11-15T12:00:00Z')
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString()
const NODE = { id: 'lead-1' }
const REVIEW_ASK = 'Approve the Talos node image design review'

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id, title: `Task ${id}`, phase: 'NEED_ACTION', status: 'todo',
    user_status: { state: 'needs', source: 'session', ask: REVIEW_ASK, decision: { id: 'ask-aaaaaa', key: 'k1' } },
    ...over,
  } as Task
}

function thread(over: Partial<OrgThread> = {}): OrgThread {
  return {
    id: 'th-000001', title: 'Talos review', titled: true, state: 'needs',
    reply: '**Needs you:** approve the Talos node image design review. The doc covers boot flow, upgrade path and rollback.',
    tasks: ['t-owner'],
    messages: [{ id: 'tm-00000101', at: iso(30), text: 'Where is the Talos review?', via: 'chat' }],
    createdAt: iso(30), updatedAt: iso(26), by: 'task:lead-1', replyAt: iso(26),
    ...over,
  } as OrgThread
}

const byId = (...ts: Task[]) => new Map(ts.map((t) => [t.id, t] as const))

describe('words: a linked task asking the same decision', () => {
  it('the summary asking what its linked task asks makes the thread a pointer', () => {
    const p = threadAskedIn(thread(), NODE, byId(task('t-owner')))
    expect(p).toMatchObject({ task: 't-owner', title: 'Task t-owner', ask: REVIEW_ASK, via: 'words', decision: 'ask-aaaaaa' })
  })

  it('its ask reworded with more detail is still the same decision', () => {
    const t = thread({ ask: 'Please approve the Talos node image design review for the rollout', reply: undefined })
    expect(threadAskedIn(t, NODE, byId(task('t-owner')))?.via).toBe('words')
  })

  it.each([
    ['another target', 'Approve the Bottlerocket node image design review'],
    ['the opposite', 'Do not approve the Talos node image design review'],
    ['another decision of the same task', 'Merge the Talos node image change into mainline'],
  ])('a linked task asking %s never hides the thread', (_name, ask) => {
    const t = thread({ ask: REVIEW_ASK, reply: undefined, title: 'Talos' })
    expect(threadAskedIn(t, NODE, byId(task('t-owner', { user_status: { state: 'needs', source: 'session', ask } } as Partial<Task>)))).toBeNull()
  })

  it('the same words from a task the thread is not linked to are no evidence', () => {
    expect(threadAskedIn(thread({ tasks: [] }), NODE, byId(task('t-owner')))).toBeNull()
  })

  it('only a foldable question (its session, a Board choice), never a live prompt or a failure', () => {
    for (const source of ['prompt', 'error', 'letter'] as const) {
      expect(threadAskedIn(thread(), NODE, byId(task('t-owner', { user_status: { state: 'needs', source, ask: REVIEW_ASK } } as Partial<Task>))), source).toBeNull()
    }
    expect(threadAskedIn(thread(), NODE, byId(task('t-owner', { user_status: { state: 'needs', source: 'choice', ask: REVIEW_ASK } } as Partial<Task>)))?.via).toBe('words')
  })

  it('a task in another incoming-item area never points a thread at it', () => {
    expect(threadAskedIn(thread(), NODE, byId(task('t-owner', { router_area_id: 'area-x' })))).toBeNull()
    expect(threadAskedIn(thread(), { id: 'lead-1', router_area_id: 'area-x' }, byId(task('t-owner', { router_area_id: 'area-x' })))?.task).toBe('t-owner')
  })

  it('with an ask, only the ask counts: a matching title or summary never hides another decision', () => {
    const t = thread({ ask: 'Upgrade the Talos node image to the new kernel', title: REVIEW_ASK, reply: REVIEW_ASK })
    expect(threadAskedIn(t, NODE, byId(task('t-owner')))).toBeNull()
  })

  it('a short topic title is no decision: "Talos node image" never hides roll back against upgrade', () => {
    const rollback = task('t-owner', { user_status: { state: 'needs', source: 'session', ask: 'Roll back the Talos node image' } } as Partial<Task>)
    expect(threadAskedIn(thread({ ask: undefined, reply: undefined, title: 'Talos node image' }), NODE, byId(rollback))).toBeNull()
    expect(threadAskedIn(thread({ ask: 'Upgrade the Talos node image', reply: undefined, title: 'Talos node image' }), NODE, byId(rollback))).toBeNull()
    expect(sameThreadDecision('Talos node image', 'Roll back the Talos node image')).toBe(false)
    expect(sameThreadDecision('Upgrade the Talos node image', 'Roll back the Talos node image')).toBe(false)
  })

  it('a known miss stays a miss: one connecting word swapped is not trusted as the same decision', () => {
    // The strict matcher reads one replaced word as another target; the node names the owner instead (askOwner).
    expect(sameThreadDecision('Approve the Talos node image design review so the rollout can start?', 'Approve the Talos node image design review before the rollout starts?')).toBe(false)
  })
})

describe('restored the moment the task stops asking it', () => {
  it.each([
    ['completed', { phase: 'COMPLETE' }],
    ['done (legacy)', { status: 'done' }],
    ['asks nothing now', { user_status: { state: 'working' } }],
    ['asks another decision', { user_status: { state: 'needs', source: 'session', ask: 'Delete the old Talos staging cluster' } }],
  ] as const)('%s', (_name, over) => {
    const tasks = [task('t-owner', over as Partial<Task>)]
    expect(threadAskedIn(thread(), NODE, byId(...tasks))).toBeNull()
    const [read] = withAskPointers(NODE, [thread()], tasks)
    expect(read.state).toBe('needs')
    expect(read.askedIn).toBeUndefined()
  })

  it('a closed thread or one not waiting on him is never a pointer', () => {
    expect(threadAskedIn(thread({ closed: { how: 'acked', at: iso(1), by: 'human' } }), NODE, byId(task('t-owner')))).toBeNull()
    expect(threadAskedIn(thread({ state: 'answered' }), NODE, byId(task('t-owner')))).toBeNull()
  })
})

describe('owner: the node named the task', () => {
  const owner = { task: 't-owner', decision: 'ask-aaaaaa', ask: REVIEW_ASK, at: iso(2), by: 'task:lead-1' as const }
  const unlike = thread({ tasks: [], ask: 'Can you look at the Talos thing before Friday?', reply: 'Waiting on the review.', title: 'Talos' })

  it('points whatever the words while that task keeps the same decision id', () => {
    const reworded = task('t-owner', { user_status: { state: 'needs', source: 'session', ask: 'Sign off on the Talos image doc?', decision: { id: 'ask-aaaaaa', key: 'k2' } } } as Partial<Task>)
    expect(threadAskedIn({ ...unlike, askOwner: owner }, NODE, byId(reworded))).toMatchObject({ task: 't-owner', via: 'owner' })
  })

  it('a new decision id there restores the thread', () => {
    const other = task('t-owner', { user_status: { state: 'needs', source: 'session', ask: REVIEW_ASK, decision: { id: 'ask-bbbbbb', key: 'k3' } } } as Partial<Task>)
    expect(threadAskedIn({ ...unlike, askOwner: owner }, NODE, byId(other))).toBeNull()
  })

  it('with no decision id, only the same words as named hold it', () => {
    const noId = { ...owner, decision: undefined }
    const same = task('t-owner', { user_status: { state: 'needs', source: 'session', ask: REVIEW_ASK } } as Partial<Task>)
    const diff = task('t-owner', { user_status: { state: 'needs', source: 'session', ask: 'Delete the Talos staging cluster' } } as Partial<Task>)
    expect(threadAskedIn({ ...unlike, askOwner: noId }, NODE, byId(same))?.via).toBe('owner')
    expect(threadAskedIn({ ...unlike, askOwner: noId }, NODE, byId(diff))).toBeNull()
  })

  it('an owner whose ask does not fold (a live prompt, a failure, a letter) is never a pointer, and cannot be named', () => {
    for (const source of ['prompt', 'error', 'letter'] as const) {
      const t = task('t-owner', { user_status: { state: 'needs', source, ask: REVIEW_ASK, decision: { id: 'ask-aaaaaa', key: 'k' } } } as Partial<Task>)
      expect(threadAskedIn({ ...unlike, askOwner: owner }, NODE, byId(t)), source).toBeNull()
      expect(() => askOwnerOf('t-owner', NODE, t, 'agent', iso(0)), source).toThrow(/asks the user nothing/)
    }
  })

  it('an owner gone, finished, not asking, in another area or the node itself points nowhere', () => {
    expect(threadAskedIn({ ...unlike, askOwner: owner }, NODE, byId())).toBeNull()
    expect(threadAskedIn({ ...unlike, askOwner: owner }, NODE, byId(task('t-owner', { phase: 'COMPLETE' })))).toBeNull()
    expect(threadAskedIn({ ...unlike, askOwner: owner }, NODE, byId(task('t-owner', { router_area_id: 'area-x' })))).toBeNull()
    expect(threadAskedIn({ ...unlike, askOwner: { ...owner, task: 'lead-1' } }, NODE, byId(task('lead-1')))).toBeNull()
  })

  it('an owner with no saved decision identity never hides an ask', () => {
    const incomplete = { task: 't-owner', at: iso(2), by: 'agent' as const };
    expect(threadAskedIn({ ...unlike, askOwner: incomplete }, NODE, byId(task('t-owner')))).toBeNull();
  })

  it('askOwnerOf records the decision id and words, and refuses a task that asks nothing or is out of the area', () => {
    expect(askOwnerOf('t-owner', NODE, task('t-owner'), 'task:lead-1', iso(0))).toEqual({ task: 't-owner', decision: 'ask-aaaaaa', ask: REVIEW_ASK, at: iso(0), by: 'task:lead-1' })
    expect(() => askOwnerOf('t-owner', NODE, task('t-owner', { user_status: { state: 'working' } } as Partial<Task>), 'agent', iso(0))).toThrow(/asks the user nothing/)
    expect(() => askOwnerOf('t-owner', NODE, task('t-owner', { router_area_id: 'area-x' }), 'agent', iso(0))).toThrow(/No task/)
    expect(() => askOwnerOf('t-x', NODE, undefined, 'agent', iso(0))).toThrow(/No task/)
  })
})

describe('owner: a decision settled there stays settled', () => {
  const owner = { task: 't-owner', decision: 'ask-aaaaaa', ask: REVIEW_ASK, at: iso(3), by: 'task:lead-1' as const }
  const unlike = thread({ tasks: ['t-owner'], ask: 'Can you look at the Talos thing before Friday?', askOwner: owner })
  const answer = (over: Record<string, unknown> = {}) => ({ key: askKey(REVIEW_ASK), ask: REVIEW_ASK, text: 'Approved.', by: 'lead-1', byTitle: 'Lead', at: iso(2), askId: 'ask-aaaaaa', ...over })
  const settled = (over: Partial<Task> = {}) => task('t-owner', { phase: 'IN_PROGRESS', user_status: { state: 'waiting', kind: 'self' }, ...over } as Partial<Task>)

  it('answered there for him: a quiet pointer marked answered, never his raw needs again', () => {
    const t = settled({ ask_answered: answer() } as Partial<Task>)
    expect(threadAskedIn(unlike, NODE, byId(t), { nowMs: NOW })).toMatchObject({ task: 't-owner', via: 'owner', answered: true, ask: REVIEW_ASK, decision: 'ask-aaaaaa' })
    const [read] = withAskPointers(NODE, [unlike], [t], { nowMs: NOW })
    expect(read.state).toBe('pending')
    expect(threadCounts([read], NOW)).toMatchObject({ shown: 0, needs: 0 })
  })

  it('withdrawn by him for good: quiet too, past the answer hold', () => {
    const t = settled({ asks_answered: [answer({ withdrawn: true, at: iso(24 * 30) })] } as Partial<Task>)
    expect(threadAskedIn(unlike, NODE, byId(t), { nowMs: NOW })?.answered).toBe(true)
  })

  it('an answer taken back since, one past its hold, or one to another decision restores the thread', () => {
    const back = settled({ ask_answered: answer(), asks_withdrawn: [{ key: askKey(REVIEW_ASK), ask: REVIEW_ASK, at: iso(1) }] } as unknown as Partial<Task>)
    expect(threadAskedIn(unlike, NODE, byId(back), { nowMs: NOW })).toBeNull()
    const old = settled({ ask_answered: answer({ at: iso(24 * 8) }) } as Partial<Task>)
    expect(threadAskedIn(unlike, NODE, byId(old), { nowMs: NOW })).toBeNull()
    const other = settled({ ask_answered: answer({ key: askKey('Delete the Talos staging cluster'), ask: 'Delete the Talos staging cluster', askId: 'ask-zzzzzz' }) } as Partial<Task>)
    expect(threadAskedIn(unlike, NODE, byId(other), { nowMs: NOW })).toBeNull()
  })

  it('a real new decision asked there brings the thread back as his own ask, the old answer notwithstanding', () => {
    const t = task('t-owner', {
      ask_answered: answer(),
      user_status: { state: 'needs', source: 'session', ask: 'Pick the Talos rollout date', decision: { id: 'ask-bbbbbb', key: 'k9' } },
    } as Partial<Task>)
    expect(threadAskedIn(unlike, NODE, byId(t), { nowMs: NOW })).toBeNull()
    expect(withAskPointers(NODE, [unlike], [t], { nowMs: NOW })[0].state).toBe('needs')
  })

  it('the signature moves when an answer is recorded or taken back', () => {
    const a = askPointerSignature([unlike], [settled()])
    expect(askPointerSignature([unlike], [settled({ ask_answered: answer() } as Partial<Task>)])).not.toBe(a)
  })
})

describe('his own word in the task after it asked: settled there, never asked again', () => {
  const owner = { task: 't-owner', decision: 'ask-aaaaaa', ask: REVIEW_ASK, at: iso(5), by: 'task:lead-1' as const }
  const named = thread({ tasks: ['t-owner'], ask: 'Can you look at the Talos thing before Friday?', askOwner: owner })
  const linked = thread({ tasks: ['t-owner'], ask: REVIEW_ASK })
  const stopped = (memory: { id: string; ask: string; at: string } | null, over: Partial<Task> = {}) => task('t-owner', {
    phase: 'IN_PROGRESS', user_status: { state: 'working' },
    status_report: { state: 'working', now: 'On it', at: iso(1), ...(memory ? { last_ask: memory } : {}) },
    ...over,
  } as Partial<Task>)
  const lastAsk = { id: 'ask-aaaaaa', ask: REVIEW_ASK, at: iso(3) }
  const wrote = (at: string) => ({ nowMs: NOW, personAt: (id: string) => (id === 't-owner' ? at : undefined) })

  it('the named owner: he wrote to it after its last ask of that decision, it asks nothing now', () => {
    expect(threadAskedIn(named, NODE, byId(stopped(lastAsk)), wrote(iso(2)))).toMatchObject({ task: 't-owner', via: 'owner', answered: true })
    expect(withAskPointers(NODE, [named], [stopped(lastAsk)], wrote(iso(2)))[0].state).toBe('pending')
    // Finished after he answered: still settled, never asked again.
    expect(threadAskedIn(named, NODE, byId(stopped(lastAsk, { phase: 'COMPLETE' })), wrote(iso(2)))?.answered).toBe(true)
  })

  it('a linked task by words: the same evidence, the decision its report last asked', () => {
    expect(threadAskedIn(linked, NODE, byId(stopped(lastAsk)), wrote(iso(2)))).toMatchObject({ task: 't-owner', via: 'words', answered: true, decision: 'ask-aaaaaa' })
  })

  it.each([
    ['he wrote before it last asked', stopped(lastAsk), iso(4)],
    ['no word of his at all', stopped(lastAsk), ''],
    ['its report remembers another decision since', stopped({ id: 'ask-bbbbbb', ask: 'Pick the Talos rollout date', at: iso(2.5) }), iso(2)],
    ['it asks him another decision now', task('t-owner', { user_status: { state: 'needs', source: 'session', ask: 'Pick the Talos rollout date', decision: { id: 'ask-bbbbbb', key: 'k' } }, status_report: { state: 'needs', ask: 'Pick the Talos rollout date', ask_id: 'ask-bbbbbb', at: iso(2.5) } } as Partial<Task>), iso(2)],
    ['it asks him something that does not fold', task('t-owner', { user_status: { state: 'needs', source: 'prompt', ask: 'Allow Bash?' } } as Partial<Task>), iso(0.5)],
  ] as const)('restored: %s', (_name, t, at) => {
    const facts = at ? wrote(at) : { nowMs: NOW }
    expect(threadAskedIn(named, NODE, byId(t), facts)).toBeNull()
    expect(threadAskedIn(linked, NODE, byId(t), facts)).toBeNull()
  })

  it('a report that remembers nothing: the named owner counts from when it was named; words need the memory', () => {
    expect(threadAskedIn(named, NODE, byId(stopped(null)), wrote(iso(4)))?.answered).toBe(true)
    expect(threadAskedIn(named, NODE, byId(stopped(null)), wrote(iso(6)))).toBeNull()
    expect(threadAskedIn(linked, NODE, byId(stopped(null)), wrote(iso(4)))).toBeNull()
  })

  it('a live prompt or a failure for a moment over the same decision: a plain pointer, never answered, never his needs', () => {
    for (const source of ['prompt', 'error'] as const) {
      const t = task('t-owner', {
        user_status: { state: 'needs', source, ask: 'Allow Bash?' },
        status_report: { state: 'needs', ask: REVIEW_ASK, ask_id: 'ask-aaaaaa', at: iso(2) },
      } as Partial<Task>)
      expect(threadAskedIn(named, NODE, byId(t), wrote(iso(1))), source).toEqual({ task: 't-owner', title: 'Task t-owner', ask: REVIEW_ASK, via: 'owner', decision: 'ask-aaaaaa' })
      expect(threadAskedIn(linked, NODE, byId(t), wrote(iso(1))), source).toEqual({ task: 't-owner', title: 'Task t-owner', ask: REVIEW_ASK, via: 'words', decision: 'ask-aaaaaa' })
      // Its report asks another decision behind the prompt: the thread is his own ask.
      const other = task('t-owner', {
        user_status: { state: 'needs', source, ask: 'Allow Bash?' },
        status_report: { state: 'needs', ask: 'Pick the Talos rollout date', ask_id: 'ask-bbbbbb', at: iso(2) },
      } as Partial<Task>)
      expect(threadAskedIn(named, NODE, byId(other), wrote(iso(1))), source).toBeNull()
      expect(threadAskedIn(linked, NODE, byId(other), wrote(iso(1))), source).toBeNull()
    }
  })

  it('the signature moves with his word', () => {
    expect(askPointerSignature([named], [stopped(lastAsk)], wrote(iso(2)))).not.toBe(askPointerSignature([named], [stopped(lastAsk)], { nowMs: NOW }))
  })
})

describe('the owner over a write that does not name it again (askOwnerKept)', () => {
  const askOwner = { task: 't-owner', decision: 'ask-aaaaaa', ask: REVIEW_ASK, at: iso(1), by: 'task:lead-1' as const }
  it.each([
    ['nothing it asks changed', { ask: 'Approve the review', title: 'T' }, { ask: 'Approve the review', title: 'T', reply: 'new summary' }, true],
    ['its ask said again with detail', { ask: REVIEW_ASK, title: 'T' }, { ask: `${REVIEW_ASK} for the rollout`, title: 'T' }, true],
    ['its ask now another decision', { ask: REVIEW_ASK, title: 'T' }, { ask: 'Roll back the Talos node image', title: 'T' }, false],
    ['an ask where there was none', { ask: undefined, title: 'T' }, { ask: REVIEW_ASK, title: 'T' }, false],
    ['its ask cleared', { ask: REVIEW_ASK, title: 'T' }, { ask: undefined, title: 'T' }, false],
    ['a new title, no ask, words still that decision', { ask: undefined, title: 'T' }, { ask: undefined, title: 'Review', reply: `Needs you: ${REVIEW_ASK}.` }, true],
    ['a new title, no ask, words of another', { ask: undefined, title: 'T' }, { ask: undefined, title: 'Rollback', reply: 'Roll back the Talos node image now.' }, false],
  ] as const)('%s', (_name, before, next, kept) => {
    expect(askOwnerKept(before as Partial<OrgThread> as OrgThread, { ...next, askOwner } as Partial<OrgThread> as OrgThread)).toBe(kept)
  })
})

describe('the read every surface shares', () => {
  it('reads pending with askedIn (an older phone keeps it out of sight too); the stored thread is untouched', () => {
    const stored = thread()
    const [read] = withAskPointers(NODE, [stored], [task('t-owner')])
    expect(read.state).toBe('pending')
    expect(read.askedIn?.task).toBe('t-owner')
    expect(stored.state).toBe('needs')
    expect((stored as { askedIn?: unknown }).askedIn).toBeUndefined()
    // Its conversation stays whole.
    expect(read.messages).toEqual(stored.messages)
    expect(read.reply).toBe(stored.reply)
  })

  it('counts: the pointer is no needs and not shown; the raw needs thread was; a pinned pointer shows, not as needs', () => {
    const other = thread({ id: 'th-000002', tasks: [], title: 'Budget', reply: 'Pick a budget.' })
    const tasks = [task('t-owner')]
    expect(threadCounts([thread(), other], NOW)).toMatchObject({ shown: 2, needs: 2 })
    const read = withAskPointers(NODE, [thread(), other], tasks)
    expect(threadCounts(read, NOW)).toMatchObject({ shown: 1, needs: 1, id: 'th-000002' })
    expect(shownToHim(read[0], new Set(), NOW)).toBe(false)
    const pinned = withAskPointers(NODE, [thread({ pinned: { at: iso(1), by: 'human' } })], tasks)
    expect(threadCounts(pinned, NOW)).toMatchObject({ shown: 1, needs: 0, pinned: 1 })
  })

  it('no overdue ask on the pointer: the task asking it is checked on its own clock', () => {
    expect(threadOverdue(thread(), NOW)?.why).toBe('needs')
    expect(threadOverdue(withAskPointers(NODE, [thread()], [task('t-owner')])[0], NOW)).toBeNull()
  })

  it('the signature moves with what a pointer reads of its tasks, so a cached count is never stale', () => {
    const a = askPointerSignature([thread()], [task('t-owner')])
    expect(askPointerSignature([thread()], [task('t-owner', { phase: 'COMPLETE' })])).not.toBe(a)
    expect(askPointerSignature([thread()], [task('t-owner', { user_status: { state: 'needs', source: 'session', ask: REVIEW_ASK, decision: { id: 'ask-cccccc', key: 'k' } } } as Partial<Task>)])).not.toBe(a)
    expect(askPointerSignature([thread()], [task('t-owner'), task('t-unrelated', { phase: 'COMPLETE' })])).toBe(a)
    expect(askPointerSignature([thread({ state: 'answered' })], [task('t-owner')])).toBe('')
  })
})
