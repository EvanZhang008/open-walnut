/**
 * The status question lists every open thread of the task (src/core/sessions/status-threads.ts;
 * 2026-11-20, the user: "if there are multiple thread please ask for multiple thread"). The threads
 * are enumerated from a threads file on disk, so a thread the question leaves out fails here: an
 * open one (whatever its state, watched, snoozed) is listed by its ref, a closed one is not, and the
 * list stops at THREAD_LIST_MAX, newest first. Main and the leads keep their own thread rules and
 * get no block; a task that keeps no Threads gets none either.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-status-threads-prompt'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { threadQuestionFor, THREAD_LIST_MAX } from '../../../src/core/sessions/status-threads.js'
import type { OrgThread, ThreadsFile } from '../../../src/core/org/threads-model.js'

const TASK = 'orchard-task-1'
const BIG = 'orchard-task-2'
const at = (min: number) => new Date(Date.parse('2026-11-20T10:00:00Z') + min * 60_000).toISOString()

function thread(n: number, extra: Partial<OrgThread> = {}): OrgThread {
  return {
    id: `th-${(0xa00000 + n).toString(16)}`, title: `Orchard subject ${n}`, state: 'working', messages: [
      { id: `tm-${(0xb00000 + n).toString(16)}`, at: at(n), text: `Please look at subject ${n}`, via: 'chat' },
    ], createdAt: at(n), updatedAt: at(n), ...extra,
  }
}

const FIXTURE: OrgThread[] = [
  thread(1, { state: 'needs', ask: 'Pick the apple variety?' }),
  thread(2, { state: 'answered', reply: 'The pears are picked.' }),
  thread(3, { state: 'pending' }),
  thread(4, { watched: { at: at(4), by: 'human' } }),
  thread(5, { snoozed: { until: at(600), at: at(5), by: 'human' } }),
  thread(6, { opener: { text: 'The frost watch started.', at: at(6), from: 'node', by: `task:${TASK}` }, messages: [] }),
  thread(7, { state: 'answered', closed: { how: 'acked', at: at(8), by: 'human' } }),
]

async function writeThreads(taskId: string, threads: OrgThread[]): Promise<void> {
  const dir = path.join(WALNUT_HOME, 'org', 'threads')
  await fs.mkdir(dir, { recursive: true })
  const file: ThreadsFile = { version: 1, taskId, threads }
  await fs.writeFile(path.join(dir, `${taskId}.json`), JSON.stringify(file))
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await writeThreads(TASK, FIXTURE)
  await writeThreads(BIG, Array.from({ length: THREAD_LIST_MAX + 3 }, (_, i) => thread(i + 1)))
})

afterAll(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }) })

describe('the status question lists the task\'s threads', () => {
  it('every open thread in the file is in the prompt by its ref, a closed one is not', async () => {
    const { block, refs } = await threadQuestionFor({ id: TASK, threads_on: true })
    // A thread waiting on him is his to move: never asked (review round 1).
    const open = FIXTURE.filter((t) => !t.closed && t.state !== 'needs')
    expect(refs.size).toBe(open.length)
    for (const t of open) {
      const ref = [...refs.entries()].find(([, v]) => v.id === t.id)?.[0]
      expect(ref, `${t.id} is listed`).toBeDefined()
      expect(block).toContain(`${ref} "${t.title}" (${t.state})`)
    }
    expect(block).not.toContain('Orchard subject 7')
    expect(block).toContain('FOR_USER_THREAD: <ref> | <working | waiting | answered | done>')
    expect(block).toContain('FOR_USER_THREAD_NEW:')
    expect(block).toContain('stays on FOR_USER_ASK')
    // Small: the instruction and the list, no more.
    expect(Buffer.byteLength(block)).toBeLessThan(1200)
  })

  it('stops at THREAD_LIST_MAX, newest first', async () => {
    const { block, refs } = await threadQuestionFor({ id: BIG, threads_on: true })
    expect(refs.size).toBe(THREAD_LIST_MAX)
    expect(refs.get('t1')?.title).toBe(`Orchard subject ${THREAD_LIST_MAX + 3}`)
    expect(block).not.toContain('"Orchard subject 1"')
  })

  it('a task with no open thread is offered only the new-thread line', async () => {
    const { block, refs } = await threadQuestionFor({ id: 'orchard-task-none', threads_on: true })
    expect(refs.size).toBe(0)
    expect(block).toContain('FOR_USER_THREAD_NEW:')
    expect(block).not.toContain('FOR_USER_THREAD: <ref>')
  })

  it('Main, a lead and a task without Threads get no block', async () => {
    for (const task of [{ id: TASK, org_role: 'main' }, { id: TASK, org_role: 'lead' }, { id: TASK }, { id: TASK, threads_on: false }]) {
      expect((await threadQuestionFor(task)).block, JSON.stringify(task)).toBe('')
    }
  })
})
