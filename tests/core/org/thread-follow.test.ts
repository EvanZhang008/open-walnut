/**
 * A thread goes with its work (src/core/org/thread-follow.ts, threads-model.ts moveThreadOut/In):
 * the pure rule that picks which of a lead's threads now belong to another lead, for every relation a
 * task's work can leave a node by, and the two steps a move writes. The routes and the real server
 * are in tests/e2e/thread-follow.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { orgNodesAbove, orgPlaces, ownerNodeOf, ownersKey, planThreadFollows, handOffLine, type FollowTask } from '../../../src/core/org/thread-follow.js'
import { addMovedMessages, emptyThreads, enteredNeeds, fileMessage, movedAway, moveThreadIn, moveThreadOut, normalizeThreads, setAnswers, updateThread, ThreadError, type OrgThread } from '../../../src/core/org/threads-model.js'

const at = (min: number) => new Date(Date.UTC(2026, 10, 8, 4, min)).toISOString()

const main: FollowTask = { id: 'main-1', title: 'Main', org_role: 'main', phase: 'IN_PROGRESS', created_at: at(0) } as FollowTask
const marina: FollowTask = { id: 'lead-marina', title: 'Marina VP', org_role: 'lead', project: 'Marina', phase: 'IN_PROGRESS', created_at: at(0) } as FollowTask
const walnut: FollowTask = { id: 'lead-walnut', title: 'Walnut VP', org_role: 'lead', project: 'Walnut', org_leads: ['Walnut-Idea'], phase: 'IN_PROGRESS', created_at: at(0) } as FollowTask
const task = (id: string, extra: Partial<FollowTask>): FollowTask => ({ id, title: `Task ${id}`, phase: 'IN_PROGRESS', ...extra }) as FollowTask

function threadListing(tasks: string[], id = 'th-aaaaaaaaaaaa'): OrgThread {
  let f = fileMessage(emptyThreads(marina.id), { text: 'what can we learn from this bot?', via: 'chat', at: at(1), newThreadId: id })
  f = { ...f, file: updateThread(f.file, id, { tasks, state: 'working' }, `task:${marina.id}`, at(2)).file }
  return f.file.threads[0]
}

function plan(threads: OrgThread[], tasks: FollowTask[], node: FollowTask = marina) {
  return planThreadFollows([{ node, threads }], orgPlaces([main, marina, walnut, ...tasks]))
}

describe('the node a task works for', () => {
  const p = orgPlaces([main, marina, walnut, task('w1', { parent_task_id: walnut.id }), task('w2', { parent_task_id: 'w1', project: 'Marina' }), task('p1', { project: 'Walnut-Idea' }), task('i1', { project: '' })])
  it('its nearest node above it, else its project\'s lead, else Main', () => {
    expect(ownerNodeOf(p.byId.get('w1')!, p)?.id).toBe(walnut.id)
    // The parent chain wins over the project: a worker's subtask filed in another project is still its team's.
    expect(ownerNodeOf(p.byId.get('w2')!, p)?.id).toBe(walnut.id)
    // A project the VP leads beside its own (org_leads).
    expect(ownerNodeOf(p.byId.get('p1')!, p)?.id).toBe(walnut.id)
    expect(ownerNodeOf(p.byId.get('i1')!, p)?.id).toBe(main.id)
    expect(ownerNodeOf(walnut, p)?.id).toBe(walnut.id)
  })
})

describe('which threads move (planThreadFollows)', () => {
  it('a task moved to another lead\'s project takes its thread there', () => {
    const moves = plan([threadListing(['t1'])], [task('t1', { project: 'Walnut' })])
    expect(moves).toEqual([expect.objectContaining({ threadId: 'th-aaaaaaaaaaaa', to: expect.objectContaining({ id: walnut.id }) })])
    expect(moves[0].why).toContain('"Task t1" is in Walnut VP\'s team')
  })

  it('a task put under another lead\'s task (adopted) takes it too', () => {
    expect(plan([threadListing(['t1'])], [task('t1', { project: 'Marina', parent_task_id: 'w1' }), task('w1', { parent_task_id: walnut.id })])).toHaveLength(1)
  })

  it('a task the lead handed to another lead and listed, even finished, takes it (the 2026-11-08 thread)', () => {
    expect(plan([threadListing(['t1'])], [task('t1', { parent_task_id: walnut.id, phase: 'COMPLETE', project: '' })])).toHaveLength(1)
  })

  it('a thread listing another lead itself goes to that lead', () => {
    expect(plan([threadListing([walnut.id])], [])).toEqual([expect.objectContaining({ to: expect.objectContaining({ id: walnut.id }) })])
  })

  it('stays while any of its tasks is still in this team, or it lists none, or its tasks are in no one\'s', () => {
    expect(plan([threadListing(['t1', 't2'])], [task('t1', { project: 'Walnut' }), task('t2', { project: 'Marina' })])).toEqual([])
    expect(plan([threadListing([])], [])).toEqual([])
    expect(plan([threadListing(['gone'])], [])).toEqual([])
    // Its work is now under Main alone (a project with no lead): nothing moves to Main by itself.
    expect(plan([threadListing(['t1'])], [task('t1', { project: 'Nowhere' })])).toEqual([])
    // Split between two other leads: no one node holds it.
    const third: FollowTask = { ...marina, id: 'lead-third', project: 'Third' }
    expect(planThreadFollows([{ node: marina, threads: [threadListing(['t1', 't2'])] }], orgPlaces([main, marina, walnut, third, task('t1', { project: 'Walnut' }), task('t2', { project: 'Third' })]))).toEqual([])
  })

  it('never to a closed lead, never a closed thread', () => {
    const closedWalnut = { ...walnut, phase: 'COMPLETE' } as FollowTask
    expect(planThreadFollows([{ node: marina, threads: [threadListing(['t1'])] }], orgPlaces([main, marina, closedWalnut, task('t1', { project: 'Walnut' })]))).toEqual([])
    const closed = { ...threadListing(['t1']), closed: { how: 'acked' as const, at: at(3), by: 'human' as const } }
    expect(plan([closed], [task('t1', { project: 'Walnut' })])).toEqual([])
  })

  it('a task the lead made (its parent link names the lead) moved to another lead\'s project takes it there', () => {
    const made = task('t1', { parent_task_id: marina.id, project: 'Walnut' })
    expect(ownerNodeOf(made, orgPlaces([main, marina, walnut, made]))?.id).toBe(walnut.id)
    expect(plan([threadListing(['t1'])], [made])).toEqual([expect.objectContaining({ to: expect.objectContaining({ id: walnut.id }) })])
    // Still in a project the lead answers for, or one no lead does: still the lead's.
    expect(plan([threadListing(['t1'])], [task('t1', { parent_task_id: marina.id, project: 'Marina' })])).toEqual([])
    expect(plan([threadListing(['t1'])], [task('t1', { parent_task_id: marina.id, project: 'Nowhere' })])).toEqual([])
  })

  it('a project delegated to another VP no longer grants its former lead ownership through an old parent', () => {
    const vp = { ...walnut, org_leads: ['Marina'] };
    const made = task('t1', { parent_task_id: marina.id, project: 'Marina' });
    expect(ownerNodeOf(made, orgPlaces([main, marina, vp, made]))?.id).toBe(vp.id);
  });

  it('a duplicate same-project lead does not take work from its actual parent during handover', () => {
    const newer = { ...marina, id: 'lead-newer', created_at: at(5) };
    const made = task('t1', { parent_task_id: newer.id, project: 'Marina' });
    const places = orgPlaces([main, marina, newer, made]);
    expect(ownerNodeOf(made, places)?.id).toBe(newer.id);
    expect(orgNodesAbove(made, places)).toEqual(new Set([newer.id, main.id]));
  });

  it('a thread handed here on purpose is never pulled back by its old tasks; the rule may still move it on', () => {
    const handed = { ...threadListing(['t1']), movedFrom: { task: walnut.id, title: 'Walnut VP', at: at(3), by: 'human' as const, kind: 'hand' as const } }
    // On Marina VP now, its old task still in Walnut's team: stays.
    expect(plan([handed], [task('t1', { project: 'Walnut' })])).toEqual([])
    // Moved by the rule before: back is fine (the work moved back).
    expect(plan([{ ...handed, movedFrom: { ...handed.movedFrom, kind: 'work' as const } }], [task('t1', { project: 'Walnut' })])).toHaveLength(1)
  })

  it('handed on through several nodes (A to B to C): never pulled back to any of them while the work stays; once it moves, it follows', () => {
    const third: FollowTask = { ...marina, id: 'lead-third', title: 'Third VP', project: 'Third' }
    const places = (t1: FollowTask) => orgPlaces([main, marina, walnut, third, t1])
    // Walnut handed it to Marina, Marina handed it to Third; t1 still does its work in Walnut's team.
    const atWalnut = task('t1', { project: 'Walnut' })
    const owners = ownersKey(['t1'], places(atWalnut))
    expect(owners).toBe(`t1=${walnut.id}`)
    const onThird = { ...threadListing(['t1']), movedFrom: { task: marina.id, title: 'Marina VP', at: at(4), by: 'human' as const, kind: 'hand' as const, owners } }
    expect(planThreadFollows([{ node: third, threads: [onThird] }], places(atWalnut))).toEqual([])
    // A task Third VP lists afterwards in Walnut's team does not pull it either: Third VP chose it.
    const later = task('t2', { project: 'Walnut' })
    expect(planThreadFollows([{ node: third, threads: [{ ...onThird, tasks: ['t1', 't2'] }] }], orgPlaces([main, marina, walnut, third, atWalnut, later]))).toEqual([])
    // The user then moves t1 into Marina's project: the work moved since the hand, so the thread follows it.
    expect(planThreadFollows([{ node: third, threads: [onThird] }], places(task('t1', { project: 'Marina' })))).toEqual([expect.objectContaining({ to: expect.objectContaining({ id: marina.id }) })])
  })

  it('Main\'s threads stay: every team is under Main', () => {
    expect(planThreadFollows([{ node: main, threads: [threadListing(['t1'])] }], orgPlaces([main, marina, walnut, task('t1', { project: 'Walnut' })]))).toEqual([])
  })

  it('a VP\'s thread about a task in a project it leads beside its own stays', () => {
    expect(planThreadFollows([{ node: walnut, threads: [threadListing(['p1'])] }], orgPlaces([main, marina, walnut, task('p1', { project: 'Walnut-Idea' })]))).toEqual([])
  })

  it('a lead whose project another VP took over hands every open thread to that VP', () => {
    const oldLead = { ...marina, id: 'lead-old', project: 'Walnut-Idea', phase: 'COMPLETE' } as FollowTask
    const moves = planThreadFollows([{ node: oldLead, threads: [threadListing([]), threadListing(['x'], 'th-bbbbbbbbbbbb')] }], orgPlaces([main, oldLead, walnut]))
    expect(moves.map((m) => [m.threadId, m.to.id])).toEqual([['th-aaaaaaaaaaaa', walnut.id], ['th-bbbbbbbbbbbb', walnut.id]])
    expect(moves[0].why).toContain('handed its project over to Walnut VP')
  })
})

describe('the move itself (moveThreadOut / moveThreadIn)', () => {
  const base = () => {
    let f = fileMessage(emptyThreads(marina.id), { text: 'learn from this bot', via: 'chat', at: at(1), newThreadId: 'th-aaaaaaaaaaaa', messageId: 'tm-aaaaaaaaaaaa' }).file
    f = setAnswers(f, new Map([['tm-aaaaaaaaaaaa', { text: 'Handed to research.', at: at(2) }]])).file
    f = updateThread(f, 'th-aaaaaaaaaaaa', { title: 'Bot lessons', state: 'needs', user_kind: 'user_own', user_kind_why: 'he asked to decide which lesson to adopt', tasks: ['t1'], pin: true }, `task:${marina.id}`, at(3)).file
    return f
  }

  it('keeps his messages, the answers, state, pin and tasks; the source closes pointing at it', () => {
    const src = base()
    const out = moveThreadOut(src, 'th-aaaaaaaaaaaa', { task: walnut.id, title: 'Walnut VP' }, 'agent', at(4), 'its work is in Walnut VP\'s team')
    const gone = out.file.threads[0]
    // A close an older release knows (acked | dropped), so going back to it never reopens it here.
    expect(gone.closed).toEqual({ how: 'dropped', at: at(4), by: 'agent', told: true })
    expect(movedAway(gone)).toBe(true)
    expect(gone.movedTo).toMatchObject({ task: walnut.id, title: 'Walnut VP', why: 'its work is in Walnut VP\'s team' })
    expect(gone.pinned).toBeUndefined()
    const dest = moveThreadIn(emptyThreads(walnut.id), out.thread, { task: marina.id, title: 'Marina VP' }, 'agent', at(4), 'its work is in Walnut VP\'s team')
    const t = dest.file.threads[0]
    expect(t).toMatchObject({ id: 'th-aaaaaaaaaaaa', title: 'Bot lessons', state: 'needs', tasks: ['t1'], pinned: expect.objectContaining({ by: `task:${marina.id}` }) })
    expect(t.messages[0]).toMatchObject({ id: 'tm-aaaaaaaaaaaa', text: 'learn from this bot', answer: { text: 'Handed to research.' } })
    expect(t.movedFrom).toMatchObject({ task: marina.id, title: 'Marina VP' })
    expect(t.closed).toBeUndefined()
    // A needs thread that moved in is no new entry: the phone does not buzz again for it.
    expect(enteredNeeds(emptyThreads(walnut.id), dest.file)).toEqual([])
  })

  it('a moved thread is not reopened or pinned where it left, and moving it again is refused there', () => {
    const out = moveThreadOut(base(), 'th-aaaaaaaaaaaa', { task: walnut.id, title: 'Walnut VP' }, 'agent', at(4))
    expect(() => updateThread(out.file, 'th-aaaaaaaaaaaa', { reopen: true }, 'human', at(5))).toThrow(/moved to Walnut VP/)
    expect(() => moveThreadOut(out.file, 'th-aaaaaaaaaaaa', { task: 'x', title: 'X' }, 'agent', at(5))).toThrow(ThreadError)
    // Nobody may close a thread as moved by hand: that is a move.
    expect(() => updateThread(base(), 'th-aaaaaaaaaaaa', { close: 'moved' as never }, 'human', at(5))).toThrow(/close must be one of acked, dropped/)
  })

  it('a move run again onto an open copy keeps what the copy got there and adds what the source has new', () => {
    const out = moveThreadOut(base(), 'th-aaaaaaaaaaaa', { task: walnut.id, title: 'Walnut VP' }, 'agent', at(4))
    let dest = moveThreadIn(emptyThreads(walnut.id), out.thread, { task: marina.id, title: 'Marina VP' }, 'agent', at(4)).file
    dest = fileMessage(dest, { text: 'target follow-up', via: 'follow-up', threadId: 'th-aaaaaaaaaaaa', at: at(6), messageId: 'tm-cccccccccccc' }).file
    dest = updateThread(dest, 'th-aaaaaaaaaaaa', { reply: 'Walnut VP is on it.' }, `task:${walnut.id}`, at(7)).file
    // A crash left the source open; he wrote there too, and the next pass moves it again.
    const src = fileMessage(base(), { text: 'source follow-up', via: 'follow-up', threadId: 'th-aaaaaaaaaaaa', at: at(5), messageId: 'tm-bbbbbbbbbbbb' }).file
    const again = moveThreadIn(dest, src.threads[0], { task: marina.id, title: 'Marina VP' }, 'agent', at(8))
    expect(again.prior?.reply).toBe('Walnut VP is on it.')
    const t = again.file.threads.find((x) => x.id === 'th-aaaaaaaaaaaa')!
    expect(again.file.threads).toHaveLength(1)
    expect(t.messages.map((m) => m.text)).toEqual(['learn from this bot', 'source follow-up', 'target follow-up'])
    expect(t.reply).toBe('Walnut VP is on it.')
  })

  it('a retried move onto a copy he closed there keeps his close and what was written there', () => {
    const out = moveThreadOut(base(), 'th-aaaaaaaaaaaa', { task: walnut.id, title: 'Walnut VP' }, 'agent', at(4))
    let dest = moveThreadIn(emptyThreads(walnut.id), out.thread, { task: marina.id, title: 'Marina VP' }, 'agent', at(4)).file
    dest = fileMessage(dest, { text: 'target message before ack', via: 'follow-up', threadId: 'th-aaaaaaaaaaaa', at: at(5), messageId: 'tm-cccccccccccc' }).file
    dest = updateThread(dest, 'th-aaaaaaaaaaaa', { close: 'acked' }, 'human', at(6)).file
    const t = moveThreadIn(dest, base().threads[0], { task: marina.id, title: 'Marina VP' }, 'agent', at(7)).file.threads[0]
    expect(t.closed?.how).toBe('acked')
    expect(t.messages.map((m) => m.text)).toEqual(['learn from this bot', 'target message before ack'])
  })

  it('moving in again (a retried move, or a move back) replaces the copy there: one thread, never two', () => {
    const out = moveThreadOut(base(), 'th-aaaaaaaaaaaa', { task: walnut.id, title: 'Walnut VP' }, 'agent', at(4))
    let dest = moveThreadIn(emptyThreads(walnut.id), out.thread, { task: marina.id, title: 'Marina VP' }, 'agent', at(4)).file
    dest = moveThreadIn(dest, out.thread, { task: marina.id, title: 'Marina VP' }, 'agent', at(5)).file
    expect(dest.threads).toHaveLength(1)
    // Back to Marina VP: its tombstone becomes the open thread again.
    const back = moveThreadIn(out.file, dest.threads[0], { task: walnut.id, title: 'Walnut VP' }, 'agent', at(6)).file
    expect(back.threads).toHaveLength(1)
    expect(back.threads[0].closed).toBeUndefined()
    expect(back.threads[0].movedTo).toBeUndefined()
  })

  it('his words written into the source while the copy was on its way join the copy; what the copy got meanwhile stays', () => {
    const out = moveThreadOut(base(), 'th-aaaaaaaaaaaa', { task: walnut.id, title: 'Walnut VP' }, 'agent', at(4))
    let dest = moveThreadIn(emptyThreads(walnut.id), out.thread, { task: marina.id, title: 'Marina VP' }, 'agent', at(4)).file
    dest = fileMessage(dest, { text: 'target follow-up', via: 'follow-up', threadId: 'th-aaaaaaaaaaaa', at: at(6), messageId: 'tm-cccccccccccc' }).file
    dest = updateThread(dest, 'th-aaaaaaaaaaaa', { reply: 'Walnut VP is on it.' }, `task:${walnut.id}`, at(7)).file
    const left = fileMessage(base(), { text: 'source follow-up', via: 'follow-up', threadId: 'th-aaaaaaaaaaaa', at: at(5), messageId: 'tm-bbbbbbbbbbbb' }).file.threads[0]
    const merged = addMovedMessages(dest, left, at(8)).threads[0]
    expect(merged.messages.map((m) => m.text)).toEqual(['learn from this bot', 'source follow-up', 'target follow-up'])
    expect(merged.reply).toBe('Walnut VP is on it.')
    expect(merged.messages[0].answer?.text).toBe('Handed to research.')
  })

  it('a release that knows only acked and dropped reads the source closed and the copy open: one open thread, never two', () => {
    const out = moveThreadOut(base(), 'th-aaaaaaaaaaaa', { task: walnut.id, title: 'Walnut VP' }, 'agent', at(4))
    // What v0.6.x keeps of a close: acked or dropped, else it drops the close (reopening the thread).
    const oldRead = (t: OrgThread) => (t.closed && ['acked', 'dropped'].includes(t.closed.how) ? 'closed' : 'open')
    expect(normalizeThreads(JSON.parse(JSON.stringify(out.file)), marina.id).threads.map(oldRead)).toEqual(['closed'])
  })

  it('the op outcome says where it went', () => {
    expect(handOffLine({ moved: [{ id: 'th-aaaaaaaaaaaa', title: 'Bot lessons', to: { task: walnut.id, title: 'Walnut VP' } }], linked: [] }))
      .toBe('Thread th-aaaaaaaaaaaa "Bot lessons" moved to Walnut VP\'s Threads with the work; it is closed on yours.')
    expect(handOffLine(null)).toBe('')
  })
})
