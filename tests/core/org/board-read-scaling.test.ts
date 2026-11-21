/**
 * Every per-node read of the whole board grows with the board, never with the board squared
 * (2026-11-20, the health alarm "web: event-loop stall flight record": on 7,900 tasks and five open
 * leads, withTaskAsks -> treeAround -> teamKeysOf scanned every lead's projects for every task, and
 * the threads re-check scanned every task for every thread; together they held the event loop for
 * one to six seconds at a time).
 *
 * Each read below runs on a board and on one four times its size (tasks, leads, projects and
 * threads all grow together, as a real board does) while a Proxy counts every field read on a task.
 * Linear work reads about 4x as much; a scan inside a scan reads about 16x. A read that is added to
 * this pipeline later is measured with it, because the test runs the pipeline, not its parts.
 */
import { describe, it, expect } from 'vitest'
import type { Task } from '../../../src/core/types.js'
import type { OrgThread } from '../../../src/core/org/threads-model.js'
import { treeAround, teammatesIndex, relativeAsksIndex } from '../../../src/core/same-ask-tree.js'
import { threadDeadline } from '../../../src/core/org/thread-view.js'
import { threadsDueRecheck } from '../../../src/core/org/thread-recheck.js'
import { withTaskAsks } from '../../../src/core/org/threads-store.js'

const T0 = Date.parse('2026-11-20T12:00:00Z')
const iso = (ms: number) => new Date(T0 + ms).toISOString()

interface Board { tasks: Task[]; threads: OrgThread[]; nodeId: string; leadId: string; reads: () => number }

/** A board of `size` units: per unit 50 tasks (top-level tasks with two levels of subtasks), one lead with 5 projects, 3 threads. */
function board(size: number): Board {
  let reads = 0
  const raw: Task[] = [{ id: 'main', title: 'Main', org_role: 'main', project: '', phase: 'IN_PROGRESS', status: 'todo', created_at: iso(0) } as Task]
  for (let u = 0; u < size; u++) {
    const projects = Array.from({ length: 5 }, (_, p) => `Project ${u}-${p}`)
    raw.push({ id: `lead-${u}`, title: `Lead ${u}`, org_role: 'lead', project: projects[0], org_leads: projects.slice(1), parent_task_id: 'main', phase: 'IN_PROGRESS', status: 'todo', created_at: iso(u) } as Task)
    for (let i = 0; i < 50; i++) {
      const id = `t-${u}-${i}`
      const parent = i % 10 === 0 ? undefined : i % 10 < 4 ? `t-${u}-${i - (i % 10)}` : `t-${u}-${i - (i % 10) + 1}`
      raw.push({
        id, title: `Task ${id}`, project: projects[i % 5], parent_task_id: parent, created_at: iso(u * 100 + i),
        phase: i % 3 === 0 ? 'COMPLETE' : 'NEED_ACTION', status: i % 3 === 0 ? 'done' : 'todo',
        due_date: i % 4 === 0 ? iso(86_400_000) : undefined,
        ...(i % 7 === 1 ? { user_status: { state: 'needs', source: 'session', ask: `Pick a plan for ${id}?`, at: iso(0) } } : {}),
      } as Task)
    }
  }
  const tasks = raw.map((t) => new Proxy(t, { get(target, key, recv) { reads++; return Reflect.get(target, key, recv) } }))
  const threads: OrgThread[] = Array.from({ length: size * 3 }, (_, k) => ({
    id: `th-${k}`, title: `Thread ${k}`, ask: `Pick a plan for t-${k % size}-1?`, state: k % 2 ? 'needs' : 'working',
    tasks: [`t-${k % size}-${(k * 7) % 50}`, `t-${(k + 1) % size}-${(k * 3) % 50}`],
    messages: [], createdAt: iso(-86_400_000), updatedAt: iso(-86_400_000),
  } as OrgThread))
  return { tasks, threads, nodeId: 't-0-1', leadId: 'lead-0', reads: () => reads }
}

/** The field reads of `run` on the small board and on the 4x board. */
async function readsOf(run: (b: Board) => unknown | Promise<unknown>): Promise<{ small: number; big: number; ratio: number }> {
  const measure = async (size: number) => {
    const b = board(size)
    const before = b.reads()
    await run(b)
    return b.reads() - before
  }
  const small = await measure(10)
  const big = await measure(40)
  return { small, big, ratio: big / Math.max(1, small) }
}

// 4x the board reads about 4x; a nested scan reads about 16x. 6 leaves room for log-ish work.
const LINEAR_MAX = 6

describe('per-node reads of the board scale linearly with it', () => {
  const reads: Array<[string, (b: Board) => unknown | Promise<unknown>]> = [
    ['treeAround of a plain task', (b) => treeAround(b.nodeId, b.tasks)],
    ['treeAround of a lead', (b) => treeAround(b.leadId, b.tasks)],
    ['teammatesIndex, built and asked once', (b) => teammatesIndex(b.tasks)(b.tasks.find((t) => t.id === b.nodeId)!)],
    ['relativeAsksIndex, built and asked once', (b) => relativeAsksIndex(b.tasks)(b.tasks.find((t) => t.id === b.nodeId)!)],
    ['threadDeadline of every thread of a node', (b) => b.threads.map((t) => threadDeadline(t, b.tasks, T0))],
    ['threadsDueRecheck of a node', (b) => threadsDueRecheck(b.threads, T0, b.tasks)],
    ['withTaskAsks of a plain node', (b) => withTaskAsks(b.nodeId, b.threads, b.tasks)],
    ['withTaskAsks of a lead', (b) => withTaskAsks(b.leadId, b.threads, b.tasks)],
  ]
  for (const [name, run] of reads) {
    it(name, async () => {
      const r = await readsOf(run)
      expect(r.small, 'the read must touch the board at all, or this measures nothing').toBeGreaterThan(0)
      expect(r.ratio, `${name}: ${r.small} reads on the board, ${r.big} on one 4x its size`).toBeLessThanOrEqual(LINEAR_MAX)
    })
  }
})
