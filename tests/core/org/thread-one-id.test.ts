/**
 * One thread across a hand-off (experiment threads_one_id, src/core/org/thread-one-id.ts): the pure
 * decision (move to the task under the same id, or stay and only list the task) for every kind of
 * target and every thread state it treats, the switch on and off; what the node that handed it on
 * reads it by; and the lines the caller and the task get. The real server is in
 * tests/e2e/thread-one-id.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { handedFrom, handedPointer, isBelow, oneIdDecision, sameIdLineFor, sameIdTaskLine, stayWords, type OneIdStay } from '../../../src/core/org/thread-one-id.js'
import { handOffLine } from '../../../src/core/org/thread-follow.js'
import { emptyThreads, fileMessage, moveThreadIn, moveThreadOut, updateThread, type OrgThread } from '../../../src/core/org/threads-model.js'
import type { Task } from '../../../src/core/types.js'
import type { FollowTask } from '../../../src/core/org/thread-follow.js'

const at = (min: number) => new Date(Date.UTC(2026, 10, 25, 4, min)).toISOString()
type T = Pick<Task, 'id' | 'org_role' | 'threads_on' | 'phase' | 'status' | 'parent_task_id'>

const lead: T = { id: 'lead-orchard', org_role: 'lead', phase: 'IN_PROGRESS' }
const keeper: T = { id: 'task-fence', threads_on: true, phase: 'IN_PROGRESS', parent_task_id: lead.id }
const plain: T = { id: 'task-gate', phase: 'IN_PROGRESS', parent_task_id: lead.id }
const otherOpen = 'task-hedge'

function thread(patch: Partial<OrgThread> = {}): OrgThread {
  const f = fileMessage(emptyThreads(lead.id), { text: 'mend the orchard fence before the frost', via: 'chat', at: at(1), newThreadId: 'th-aaaaaaaaaaaa' })
  return { ...f.file.threads[0], state: 'working', ...patch }
}

const decide = (over: { on?: boolean; target?: T; thread?: OrgThread; ownTeam?: boolean; from?: T } = {}) => oneIdDecision({
  on: over.on ?? true, from: over.from ?? lead, target: over.target ?? keeper, thread: over.thread ?? thread(),
  ownTeam: over.ownTeam ?? true, isOpen: (id) => id === otherOpen,
})
const stayOf = (d: ReturnType<typeof oneIdDecision>): OneIdStay | 'move' => (d.move ? 'move' : d.stay)

describe('the decision: move to the task, or stay and list it', () => {
  it('moves a thread named for an open task of the caller\'s own team that keeps Threads', () => {
    expect(stayOf(decide())).toBe('move')
    // Every state that is the node's move or a result goes: new, working, answered.
    for (const state of ['new', 'working', 'answered'] as const) expect(stayOf(decide({ thread: thread({ state }) }))).toBe('move')
    // Tasks it lists that are done, the target itself or the caller count as nothing else held.
    expect(stayOf(decide({ thread: thread({ tasks: [keeper.id, lead.id, 'task-done'] }) }))).toBe('move')
  })

  it('switch off: exactly today, the thread stays and only lists the task', () => {
    expect(stayOf(decide({ on: false }))).toBe('off')
    expect(stayWords(decide({ on: false }))).toBeUndefined()
  })

  it('every kind of target', () => {
    // An Org node: the cross-node rule moves it (thread-follow.ts), as before.
    expect(stayOf(decide({ target: { ...keeper, org_role: 'lead' } }))).toBe('not_a_task')
    expect(stayOf(decide({ target: { ...keeper, org_role: 'router' } }))).toBe('not_a_task')
    // A task that keeps no Threads: listed, as before.
    expect(stayOf(decide({ target: plain }))).toBe('no_threads')
    // A finished task: nobody would keep it there.
    expect(stayOf(decide({ target: { ...keeper, phase: 'COMPLETE' } }))).toBe('closed_task')
    expect(stayOf(decide({ target: { ...keeper, status: 'done' } }))).toBe('closed_task')
    // A task in another team: the cross-node rule's (moved to that team's node), never to the task.
    expect(stayOf(decide({ ownTeam: false }))).toBe('not_own_team')
    // The caller itself.
    expect(stayOf(decide({ target: { ...keeper, id: lead.id } }))).toBe('not_own_team')
  })

  it('a thread holding something of the node\'s he acts on there stays, and says why', () => {
    const cases: Array<[Partial<OrgThread>, OneIdStay]> = [
      [{ state: 'needs', options: [{ id: 'a', label: 'Mend it' }, { id: 'b', label: 'Replace it' }] }, 'waits_on_him'],
      [{ askOwner: { task: keeper.id, at: at(2), by: `task:${lead.id}` } }, 'waits_on_him'],
      [{ letter: { id: 'lt-1', at: at(2) } as unknown as OrgThread['letter'] }, 'letter'],
      [{ choice: { board: 'b1', id: 'c1', at: at(2) } as unknown as OrgThread['choice'] }, 'choice'],
      [{ reportAsk: { decision: 'd1', at: at(2) } as unknown as OrgThread['reportAsk'] }, 'own_ask'],
      [{ watched: { at: at(2), by: 'human' } }, 'watched'],
      [{ state: 'pending', ackedAt: at(3) }, 'known'],
      [{ tasks: [keeper.id, otherOpen] }, 'other_tasks'],
    ]
    for (const [patch, why] of cases) {
      const d = decide({ thread: thread(patch) })
      expect(stayOf(d), why).toBe(why)
      expect(stayWords(d), why).toEqual(expect.any(String))
    }
  })

  it('a task with Threads on hands to its own subtask: its own team is the tasks below it', () => {
    const byId = new Map<string, T>([[lead.id, lead], [keeper.id, keeper], ['sub', { id: 'sub', threads_on: true, phase: 'IN_PROGRESS', parent_task_id: keeper.id }], ['far', { id: 'far', parent_task_id: 'sub' }]])
    expect(isBelow(byId.get('sub')!, keeper.id, byId)).toBe(true)
    expect(isBelow(byId.get('far')!, keeper.id, byId)).toBe(true)
    expect(isBelow(keeper, 'sub', byId)).toBe(false)
    // A loop in the parent chain ends.
    const loop = new Map<string, T>([['a', { id: 'a', parent_task_id: 'b' }], ['b', { id: 'b', parent_task_id: 'a' }]])
    expect(isBelow(loop.get('a')!, 'c', loop)).toBe(false)
    expect(stayOf(decide({ from: keeper, target: byId.get('sub')! }))).toBe('move')
  })
})

describe('what the node that handed it on reads it by', () => {
  const moved = () => {
    const t = thread({ tasks: [keeper.id] })
    const from = { ...emptyThreads(lead.id), threads: [t] }
    const out = moveThreadOut(from, t.id, { task: keeper.id, title: 'Fence' }, `task:${lead.id}`, at(5), 'handed it on', 'hand')
    const into = moveThreadIn(emptyThreads(keeper.id), out.thread, { task: lead.id, title: 'Orchard VP' }, `task:${lead.id}`, at(5), 'handed it on', 'hand', '')
    return { pointer: out.file.threads[0], copy: into.thread }
  }

  it('the task\'s copy names the node (movedFrom), the node keeps a pointer (movedTo)', () => {
    const { pointer, copy } = moved()
    expect(handedFrom(copy, lead.id)).toBe(true)
    expect(handedFrom(copy, 'lead-other')).toBe(false)
    expect(handedPointer(pointer)).toBe(true)
    // The work rule's move and the user's own move never read through.
    expect(handedPointer({ ...pointer, movedTo: { ...pointer.movedTo!, kind: 'work' } })).toBe(false)
    expect(handedPointer({ ...pointer, movedTo: { ...pointer.movedTo!, by: 'human' } })).toBe(false)
    expect(handedFrom({ ...copy, movedFrom: { ...copy.movedFrom!, by: 'human' } }, lead.id)).toBe(false)
    // A copy the task closed reads through no more.
    expect(handedFrom({ ...copy, closed: { how: 'acked', at: at(9), by: 'human' } }, lead.id)).toBe(false)
  })

  it('off again: what was moved reads as an ordinary moved thread (closed pointer, open copy)', () => {
    const { pointer, copy } = moved()
    expect(pointer.closed?.how).toBe('dropped')
    expect(pointer.movedTo).toMatchObject({ task: keeper.id, kind: 'hand' })
    expect(copy.closed).toBeUndefined()
    expect(copy.movedFrom).toMatchObject({ task: lead.id, kind: 'hand' })
    // An answer the task writes stays on its one record.
    const answered = updateThread({ ...emptyThreads(keeper.id), threads: [copy] }, copy.id, { state: 'answered', reply: 'The fence is mended.' }, `task:${keeper.id}`, at(8))
    expect(answered.thread.state).toBe('answered')
  })
})

describe('the lines', () => {
  it('the caller hears the same card; a stay says why; the switch off says today\'s words', () => {
    const same = handOffLine({ moved: [{ id: 'th-aaaaaaaaaaaa', title: 'Fence', to: { task: keeper.id, title: 'Mend the fence' }, same_card: true }], linked: [] })
    expect(same).toBe('Thread th-aaaaaaaaaaaa "Fence" is on Mend the fence\'s Threads now, same id: your Threads show that one card while it has something for the user.')
    const today = handOffLine({ moved: [{ id: 'th-aaaaaaaaaaaa', title: 'Fence', to: { task: 'lead-x', title: 'Other VP' } }], linked: [{ id: 'th-bbbbbbbbbbbb', title: 'Gate' }] })
    expect(today).toBe('Thread th-aaaaaaaaaaaa "Fence" moved to Other VP\'s Threads with the work; it is closed on yours. Thread th-bbbbbbbbbbbb "Gate" lists this task now.')
    const stays = handOffLine({ moved: [], linked: [{ id: 'th-bbbbbbbbbbbb', title: 'Gate', stays: 'it waits on the user now, and he answers it where he was asked' }] })
    expect(stays).toContain('lists this task now; it stays on yours: it waits on the user now')
  })

  it('the task hears which thread it is, in one short line, only for a thread that came to it', () => {
    const line = sameIdTaskLine('th-aaaaaaaaaaaa', 'Fence')
    expect(line).toBe('This work is thread th-aaaaaaaaaaaa "Fence", on your Threads now: answer the user there and open no second thread for it.')
    expect(Buffer.byteLength(line)).toBeLessThan(160)
    const r = { moved: [{ id: 'th-aaaaaaaaaaaa', title: 'Fence', to: { task: keeper.id }, same_card: true }, { id: 'th-cccccccccccc', title: 'Hedge', to: { task: 'lead-x' } }] }
    expect(sameIdLineFor(r, keeper.id)).toBe(line)
    expect(sameIdLineFor(r, 'lead-x')).toBe('')
    expect(sameIdLineFor(null, keeper.id)).toBe('')
  })
})

describe('the decision at a hand-off (thread-handoff.ts sameIdDecision), the one made before the send and at the move', () => {
  it('a node\'s own team is the tasks whose node it is; a task\'s, the tasks below it', async () => {
    const { sameIdDecision, withSameIdLine } = await import('../../../src/core/org/thread-handoff.js')
    const { handOffTo, orgPlaces } = await import('../../../src/core/org/thread-follow.js')
    const vp = { id: 'lead-orchard', title: 'Orchard VP', org_role: 'lead', project: 'Orchard', phase: 'IN_PROGRESS' } as FollowTask
    const other = { id: 'lead-garden', title: 'Garden VP', org_role: 'lead', project: 'Garden', phase: 'IN_PROGRESS' } as FollowTask
    const mine = { id: 'task-fence', title: 'Fence', project: 'Orchard', parent_task_id: vp.id, threads_on: true, phase: 'IN_PROGRESS' } as FollowTask
    const theirs = { id: 'task-bed', title: 'Bed', project: 'Garden', parent_task_id: other.id, threads_on: true, phase: 'IN_PROGRESS' } as FollowTask
    const sub = { id: 'task-post', title: 'Post', project: 'Orchard', parent_task_id: mine.id, threads_on: true, phase: 'IN_PROGRESS' } as FollowTask
    const p = orgPlaces([vp, other, mine, theirs, sub])
    const at = (from: FollowTask, target: FollowTask) => sameIdDecision({ from, target, thread: thread(), to: handOffTo(from, target, p), p })
    expect(at(vp, mine).move).toBe(true)
    expect(at(vp, theirs)).toEqual({ move: false, stay: 'not_own_team' })
    expect(at(mine, sub).move).toBe(true)
    expect(at(mine, theirs)).toEqual({ move: false, stay: 'not_own_team' })
    expect(withSameIdLine('Please mend it.', 'This work is thread th-x.')).toBe('Please mend it.\n\nThis work is thread th-x.')
    expect(withSameIdLine('Please mend it.', '')).toBe('Please mend it.')
  })
})

describe('which of two open copies is the thread (thread-one-id-view.ts leftoverHere)', () => {
  it('the one that arrived last: the task\'s, unless the node\'s came back from that task after it', async () => {
    const { leftoverHere } = await import('../../../src/core/org/thread-one-id-view.js')
    const handed = { movedFrom: { task: 'lead-orchard', title: 'Orchard VP', at: at(5), by: 'task:lead-orchard' as const, kind: 'hand' as const } }
    // A move to the task cut off before the node's copy closed: the node's is the leftover.
    expect(leftoverHere({}, handed, 'task-fence')).toBe(true)
    // The finished task gave it back (a read in the moment of that move sees both open): the node's is the thread.
    expect(leftoverHere({ movedFrom: { task: 'task-fence', title: 'Fence', at: at(9), by: 'agent', kind: 'work' } }, handed, 'task-fence')).toBe(false)
    // An older return from that task, then handed again: the task's copy is newer.
    expect(leftoverHere({ movedFrom: { task: 'task-fence', title: 'Fence', at: at(2), by: 'agent', kind: 'work' } }, handed, 'task-fence')).toBe(true)
    // A closed copy here is a pointer, never a leftover.
    expect(leftoverHere({ closed: { how: 'dropped', at: at(6), by: 'agent' } }, handed, 'task-fence')).toBe(false)
  })
})
