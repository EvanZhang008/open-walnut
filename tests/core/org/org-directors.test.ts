/**
 * Directors (src/core/org/org-directors.ts, src/core/task-director.ts; 2026-11-20, the user:
 * "leader default is director ... we can also de-promote or promote any task to director"):
 * a leader (an open task with an open worker) is a Director by default, Task.director 'yes' makes
 * any task one, 'no' takes a leader off, and a task that is no Director passes the Directors under
 * it up to the nearest one above.
 */
import { describe, it, expect } from 'vitest'
import { buildOrgTree, directorsOf, isDirector, type OrgDirector, type OrgTaskLike, type OrgTaskNode } from '../../../src/core/org/org-tree.js'
import * as viaAlias from '@open-walnut/org-tree'
import { applyDirector, directorRefusal, OrgNodeDirectorError, parseDirectorInput } from '../../../src/core/task-director.js'
import { projectTask } from '../../../src/core/task-projection.js'
import { rowToTask, taskToRow } from '../../../src/core/task-db.js'
import type { Task } from '../../../src/core/types.js'

let n = 0
function t(over: Partial<OrgTaskLike>): OrgTaskLike {
  n++
  const at = `2026-10-01T00:00:${String(n % 60).padStart(2, '0')}Z`
  return { id: `d${n}`, title: `task ${n}`, project: 'Garden', phase: 'TODO', created_at: at, updated_at: at, ...over }
}

const teamsOf = (all: OrgTaskLike[]): OrgTaskNode[] => buildOrgTree(all).projects.flatMap((p) => p.teams)
const shape = (ds: OrgDirector[]): unknown[] => ds.map((d) => [d.title, d.leads, shape(d.subs)])

function task(over: Partial<Task> = {}): Task {
  return { id: 'x1', title: 'A task', phase: 'TODO', status: 'todo', project: 'Garden', priority: 'none', category: '', source: 'local',
    session_ids: [], description: '', summary: '', note: '', created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z', ...over } as Task
}

describe('isDirector', () => {
  it('yes and no win; auto is "leads an open worker"', () => {
    expect(isDirector('yes', 0)).toBe(true)
    expect(isDirector('yes', 3)).toBe(true)
    expect(isDirector('no', 0)).toBe(false)
    expect(isDirector('no', 2)).toBe(false)
    expect(isDirector(undefined, 0)).toBe(false)
    expect(isDirector(undefined, 1)).toBe(true)
  })

  it('is the same rule through the web alias', () => {
    expect(viaAlias.isDirector).toBe(isDirector)
    expect(viaAlias.directorsOf).toBe(directorsOf)
  })
})

describe('buildOrgTree director per node', () => {
  it('marks leaders, honours yes and no, and counts only open workers', () => {
    const lead = t({ title: 'Lead' })
    const w = t({ title: 'Worker', parent_task_id: lead.id })
    const solo = t({ title: 'Solo' })
    const promoted = t({ title: 'Promoted', director: 'yes' })
    const demoted = t({ title: 'Demoted', director: 'no' })
    const dw = t({ title: 'Demoted worker', parent_task_id: demoted.id })
    const old = t({ title: 'Old' })
    const oldW = t({ title: 'Old worker', parent_task_id: old.id, phase: 'COMPLETE' })
    const byTitle = new Map<string, OrgTaskNode>()
    const walk = (ns: OrgTaskNode[]) => { for (const x of ns) { byTitle.set(x.title, x); walk(x.workers) } }
    walk(teamsOf([lead, w, solo, promoted, demoted, dw, old, oldW]))
    expect(byTitle.get('Lead')!.director).toBe(true)
    expect(byTitle.get('Worker')!.director).toBe(false)
    expect(byTitle.get('Solo')!.director).toBe(false)
    expect(byTitle.get('Promoted')!.director).toBe(true)
    expect(byTitle.get('Demoted')!.director).toBe(false)
    // A team whose only worker is finished leads no one now.
    expect(byTitle.get('Old')!.director).toBe(false)
  })
})

describe('directorsOf', () => {
  // 2026-11-24, the user: only the first layer of leaders is listed, never a leader of a leader.
  it('lists only the first Director on each path; what is under a Director is never listed', () => {
    // top (auto) -> mid (no, leads) -> deep (auto, leads) -> leaf
    //           \-> plain (no team)
    const top = t({ title: 'Top' })
    const mid = t({ title: 'Mid', parent_task_id: top.id, director: 'no' })
    const deep = t({ title: 'Deep', parent_task_id: mid.id })
    const leaf = t({ title: 'Leaf', parent_task_id: deep.id })
    const plain = t({ title: 'Plain', parent_task_id: top.id })
    const ds = directorsOf(teamsOf([top, mid, deep, leaf, plain]))
    // Top leads Mid and Plain directly (2); Deep, a leader inside Top's team, is not listed.
    expect(shape(ds)).toEqual([['Top', 2, []]])
  })

  it('a no leader at the top lifts its sub-leaders to the top', () => {
    const boss = t({ title: 'Boss', director: 'no' })
    const a = t({ title: 'A', parent_task_id: boss.id })
    const aw = t({ title: 'A worker', parent_task_id: a.id })
    const ds = directorsOf(teamsOf([boss, a, aw]))
    expect(shape(ds)).toEqual([['A', 1, []]])
  })

  it('a yes task with no workers is a Director with no team; a yes inside a Director\'s team is not listed', () => {
    const lone = t({ title: 'Lone', director: 'yes' })
    const lead = t({ title: 'Lead' })
    const pick = t({ title: 'Pick', parent_task_id: lead.id, director: 'yes' })
    const ds = directorsOf(teamsOf([lone, lead, pick]))
    expect(ds.map((d) => d.title).sort()).toEqual(['Lead', 'Lone'])
    expect(ds.find((d) => d.title === 'Lone')).toMatchObject({ leads: 0, subs: [] })
    expect(shape(ds.filter((d) => d.title === 'Lead'))).toEqual([['Lead', 1, []]])
  })

  it('a task inside a Director\'s team that another project lists at its top is not listed there either', () => {
    const lead = t({ title: 'Lead' })
    const sub = t({ title: 'Sub', parent_task_id: lead.id })
    const subW = t({ title: 'Sub worker', parent_task_id: sub.id })
    const seen = new Set<string>()
    const first = directorsOf(teamsOf([lead, sub, subW]), seen)
    const subNode = teamsOf([lead, sub, subW])[0]!.workers[0]!
    expect(first.map((d) => d.title)).toEqual(['Lead'])
    expect(directorsOf([subNode], seen)).toEqual([])
  })

  it('keeps the tree order and lists each task once across calls (seen)', () => {
    const tasks = [t({ title: 'One', director: 'yes' }), t({ title: 'Two', director: 'yes' }), t({ title: 'Three', director: 'yes' })]
    const teams = teamsOf(tasks)
    expect(directorsOf(teams).map((d) => d.title)).toEqual(teams.map((x) => x.title))
    const seen = new Set<string>()
    expect(directorsOf(teams, seen)).toHaveLength(3)
    expect(directorsOf(teams, seen)).toEqual([])
  })

  it('no one is a Director when nobody leads and nobody chose yes', () => {
    expect(directorsOf(teamsOf([t({}), t({}), t({ director: 'no' })]))).toEqual([])
  })
})

describe('the Director write (task-director.ts)', () => {
  it('parses auto, yes, no and null; refuses anything else', () => {
    expect(parseDirectorInput(undefined)).toEqual({ ok: true, value: undefined })
    expect(parseDirectorInput(null)).toEqual({ ok: true, value: null })
    for (const v of ['auto', 'yes', 'no']) expect(parseDirectorInput(v)).toEqual({ ok: true, value: v })
    for (const v of ['YES', '', true, 1, {}, ['yes']]) expect(parseDirectorInput(v).ok).toBe(false)
  })

  it('stores yes and no, and deletes the field on auto and null', () => {
    const x = task()
    applyDirector(x, 'yes'); expect(x.director).toBe('yes')
    applyDirector(x, 'no'); expect(x.director).toBe('no')
    applyDirector(x, undefined); expect(x.director).toBe('no')
    applyDirector(x, 'auto'); expect('director' in x).toBe(false)
    applyDirector(x, 'yes'); applyDirector(x, null); expect('director' in x).toBe(false)
  })

  it('an org node refuses yes and no, and takes auto as a no-op', () => {
    for (const role of ['main', 'lead', 'router'] as const) {
      const node = task({ org_role: role })
      expect(directorRefusal(node, 'yes')).toBeInstanceOf(OrgNodeDirectorError)
      expect(() => applyDirector(node, 'no')).toThrow(OrgNodeDirectorError)
      expect('director' in node).toBe(false)
      expect(directorRefusal(node, 'auto')).toBeUndefined()
      applyDirector(node, null)
      expect('director' in node).toBe(false)
    }
    expect(new OrgNodeDirectorError('x', 'lead')).toMatchObject({ statusCode: 400, code: 'org_node_director' })
  })
})

describe('Task.director in the projection and the store', () => {
  it('projects yes / no, omits auto, and never on an org node', () => {
    expect(projectTask(task({ director: 'yes' })).director).toBe('yes')
    expect(projectTask(task({ director: 'no' })).director).toBe('no')
    expect('director' in projectTask(task())).toBe(false)
    expect('director' in projectTask(task({ org_role: 'lead', director: 'yes' }))).toBe(false)
  })

  it('rides the row payload and back (a field without a column is kept, not dropped)', () => {
    const row = taskToRow(task({ director: 'no' }))
    expect(JSON.parse(row.payload).director).toBe('no')
    expect(rowToTask(row).director).toBe('no')
    // A key a newer build wrote that this one does not know survives the same way.
    const future = taskToRow({ ...task(), some_future_field: 'kept' } as Task)
    expect((rowToTask(future) as unknown as Record<string, unknown>).some_future_field).toBe('kept')
  })
})

describe('directorWrite: what make and remove write', () => {
  it('takes a leader off with no, any other task back to auto; makes a leader auto and a lone task yes', async () => {
    const { directorWrite, isDirector } = await import('../../../src/core/org/org-directors.js')
    expect(directorWrite(false, 2)).toBe('no')
    expect(directorWrite(false, 0)).toBe('auto')
    expect(directorWrite(true, 2)).toBe('auto')
    expect(directorWrite(true, 0)).toBe('yes')
    // Each write gives the asked result under the shared rule (auto = undefined).
    for (const open of [0, 1, 3]) for (const make of [true, false]) {
      const w = directorWrite(make, open)
      expect(isDirector(w === 'auto' ? undefined : w, open)).toBe(make)
    }
  })
})
