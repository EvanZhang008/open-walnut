/**
 * Ratchet: a thread is stored once, on the task that owns it (experiment threads_pop_up,
 * src/core/org/thread-popup.ts; 2026-11-20, the user: "when we reply in parent do we give both
 * parent and child a copy?", and the lead's answer: one record, a view above it).
 *
 * Fails when threads-store.ts gains an exported function nobody classified here (a new writer must
 * say why it writes only the record where it lives), when the move stops relocating under the
 * experiment (a copy left behind), and on the pure rules: a reply still open keeps its owner from
 * closing the thread, a decision keeps its ask id while only reworded, a viewer's counts never
 * gain a Needs you for a thread below. The server flow is tests/e2e/threads-pop-up.test.ts.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import * as store from '../../../src/core/org/threads-store.js'
import { emptyThreads, fileMessage, normalizeThreads, openThread, relocateThreadOut, updateThread, ThreadError, type ThreadsFile } from '../../../src/core/org/threads-model.js'
import { setThreadsPopUp, stampAskIds } from '../../../src/core/org/thread-popup-rules.js'
import { threadCounts } from '../../../src/core/org/thread-groups.js'
import { viewersOf, ownersBelow } from '../../../src/core/org/thread-popup.js'
import { orgPlaces } from '../../../src/core/org/thread-follow.js'
import { answeredText, ANSWERED_MAX } from '../../../src/core/org/thread-answered-notes.js'
import type { Task } from '../../../src/core/types.js'

const SRC = path.resolve(import.meta.dirname, '../../../src/core/org/threads-store.ts')

/** Each export of the store, and why it works on the one record where the thread lives. */
const WRITERS: Record<string, string> = {
  markNeedsBuzzed: 'stamps the record on the node that holds it',
  fileThreadMessage: 'files on the node holding the thread, following a move, never a copy',
  openNodeThread: 'a new record on the node that opens it',
  patchThread: 'changes the record in place',
  mergeThread: 'folds two records of one node into one',
  markMergedThere: 'marks the pointer a moved record left behind with the record it was merged into, in place',
  splitThread: 'one message becomes a new record on the same node',
  moveThread: 'under threads_pop_up the record leaves the old node whole (relocateThreadOut)',
  noteClosesTold: 'marks records in place',
  noteThreadsRechecked: 'marks records in place',
  setThreadAnswers: 'writes answers onto messages in place',
  writeOwnThreads: 'a task\'s own writes on its own records',
  placeTaskAsk: 'marks which of the task\'s own records holds its ask, in place',
  sweepClosedThreads: 'deletes records past their week',
  updateReplyDeliveries: 'moves a reply\'s delivery on the owner\'s record',
  writeThreadsFor: 'a letter\'s one thread, under an id of the letter, written on the node that holds it (human-inbox/letter-threads.ts follows a move first)',
}
// openNodeThreadChecks: openNodeThread's refusals alone, nothing written.
const READERS = ['threadTaskIds', 'readThreads', 'withTaskAsks', 'nodeView', 'listThreadNodes', 'threadHolder', 'hasOpenDeliveries', 'openNodeThreadChecks']

describe('every export of the threads store is classified', () => {
  it('a new export fails until it says how it keeps one record', () => {
    const exported = Object.keys(store).filter((k) => typeof (store as Record<string, unknown>)[k] === 'function').sort()
    expect(exported).toEqual([...Object.keys(WRITERS), ...READERS].sort())
  })

  it('under the experiment a move relocates: the copy-and-close step runs only with it off', () => {
    const src = fs.readFileSync(SRC, 'utf8')
    expect(src).toMatch(/const relocate = threadsPopUpNow\(\);/)
    expect(src).toMatch(/\(relocate \? relocateThreadOut : moveThreadOut\)\(f, threadId/)
  })
})

const AT = '2026-11-20T03:00:00.000Z'
const KIND = { user_kind: 'spending', user_kind_why: 'It buys orchard supplies with real money' } as const

function needsFile(): { file: ThreadsFile; id: string } {
  const r = openThread(emptyThreads('owner-1'), { title: 'Buy the 72-cell trays?', text: 'The budget covers one size.', from: 'task', state: 'needs', ...KIND }, 'task:owner-1', AT)
  return { file: r.file, id: r.thread.id }
}

describe('the pure rules', () => {
  it('relocateThreadOut leaves a pointer and no copy, which reads back, and refuses a closed thread as a move does', () => {
    const { file, id } = needsFile()
    const to = { task: 'lead-2', title: 'Garden VP' }
    const out = relocateThreadOut(file, id, to, 'human', AT)
    expect(out.thread.id).toBe(id)
    expect(out.file.threads).toHaveLength(1)
    const pointer = out.file.threads[0]
    expect(pointer).toMatchObject({ id, messages: [], movedTo: { task: 'lead-2' }, closed: { how: 'dropped' } })
    expect(pointer.opener).toBeUndefined()
    expect(pointer.reply).toBeUndefined()
    expect(normalizeThreads(JSON.parse(JSON.stringify(out.file)), 'owner-1').threads).toHaveLength(1)
    const closed = updateThread(file, id, { close: 'acked' }, 'human', AT).file
    expect(() => relocateThreadOut(closed, id, to, 'human', AT)).toThrow(ThreadError)
  })

  it('a reply still on its way keeps the owner from closing the thread or calling it answered; he still can', () => {
    setThreadsPopUp(true)
    const { file, id } = needsFile()
    const filed = fileMessage(file, { text: '72-cell', via: 'follow-up', threadId: id, at: AT, delivery: { state: 'pending', at: AT, via: 'lead-1' } }).file
    for (const patch of [{ close: 'dropped' as const, user_words: 'done' }, { state: 'answered' as const }]) {
      expect(() => updateThread(filed, id, patch, 'task:owner-1', AT)).toThrow(/reply_pending|not reached/)
    }
    expect(() => updateThread(filed, id, { close: 'acked' }, 'human', AT)).not.toThrow()
    const delivered = { ...filed, threads: filed.threads.map((t) => ({ ...t, messages: t.messages.map((m) => ({ ...m, delivery: { state: 'delivered' as const, at: AT } })) })) }
    expect(() => updateThread(delivered, id, { state: 'answered' }, 'task:owner-1', AT)).not.toThrow()
    // Off: today's rules, whatever a message carries.
    setThreadsPopUp(false)
    expect(() => updateThread(filed, id, { state: 'answered' }, 'task:owner-1', AT)).not.toThrow()
  })

  it('a decision gets an ask id when it enters needs, keeps it while reworded, and a new one when it comes back', () => {
    const { file, id } = needsFile()
    const a = stampAskIds(emptyThreads('owner-1'), file)
    const askA = a.threads[0].askId
    expect(askA).toMatch(/^ak-[a-f0-9]{10}$/)
    const reworded = stampAskIds(a, updateThread(a, id, { ask: 'Should we buy the 72-cell trays?' }, 'task:owner-1', AT).file)
    expect(reworded.threads[0].askId).toBe(askA)
    const out = stampAskIds(reworded, updateThread(reworded, id, { state: 'working' }, 'task:owner-1', AT).file)
    const back = stampAskIds(out, updateThread(out, id, { state: 'needs', reply: 'The budget covers one size; the 72-cell trays fit the shelf.', ...KIND }, 'task:owner-1', AT).file)
    expect(back.threads[0].askId).not.toBe(askA)
  })

  it('a viewer counts what waits below in shown and below, never in needs', () => {
    const below = needsFile().file.threads.map((t) => ({ ...t, owner: { task_id: 'owner-1', title: 'Order the seed trays' } }))
    const own = openThread(emptyThreads('lead-1'), { title: 'Its own', text: 'A finding of the lead.', from: 'node', state: 'answered' }, 'task:lead-1', AT).file.threads
    expect(threadCounts([...own, ...below])).toEqual({ shown: 2, needs: 0, below: 1, title: 'Its own', id: own[0].id })
    expect(threadCounts(below)).toMatchObject({ shown: 1, needs: 0, below: 1, title: 'Buy the 72-cell trays?' })
    // His reply on its way keeps it listed, never counted: it no longer waits on him.
    expect(threadCounts(below.map((t) => ({ ...t, state: 'working' as const })))).toEqual({ shown: 0, needs: 0 })
    // Off (no owner on any thread): the counts are today's.
    expect(threadCounts(own)).toEqual({ shown: 1, needs: 0, title: 'Its own', id: own[0].id })
  })

  it('the viewers of a task: every task above it, its lead, the lead\'s VP and Main', () => {
    const t = (id: string, extra: Partial<Task> = {}) => ({ id, title: id, phase: 'IN_PROGRESS', status: 'todo', created_at: AT, ...extra }) as Task
    const all = [
      t('main', { org_role: 'main' }), t('vp', { org_role: 'lead', project: 'Orchard' }),
      t('plan', { project: 'Orchard', parent_task_id: 'vp', threads_on: true }),
      t('trays', { project: 'Orchard', parent_task_id: 'plan', threads_on: true }),
      t('garden', { project: 'Garden', threads_on: true }),
    ]
    const p = orgPlaces(all)
    const byId = new Map(all.map((x) => [x.id, x] as const))
    expect([...viewersOf(byId.get('trays')!, byId, p)].sort()).toEqual(['main', 'plan', 'vp'])
    expect([...viewersOf(byId.get('trays')!, byId, null)].sort()).toEqual(['plan', 'vp'])
    expect(ownersBelow('plan', all, p).map((x) => x.id)).toEqual(['trays'])
    expect(ownersBelow('main', all, p).map((x) => x.id).sort()).toEqual(['garden', 'plan', 'trays', 'vp'])
  })

  it('the leaders\' riding line folds past its cap', () => {
    const lines = Array.from({ length: ANSWERED_MAX }, (_, i) => `- task ${i}`)
    const text = answeredText({ lines, folded: 6 })
    expect(text.split('\n')).toHaveLength(ANSWERED_MAX + 2)
    expect(text).toContain('- and 6 more answered earlier.')
  })
})
