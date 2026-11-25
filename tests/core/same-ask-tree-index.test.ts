/**
 * The tree reads share one index per task list (same-ask-tree.ts treeIndexOf), and the readers that
 * must still see a finished task's decision ask for `allOpen` instead of copying every finished task.
 * 2026-11-24: withTaskAsks (once per node per pass) copied about 7,000 finished tasks and rebuilt
 * the id, children and team indexes each time; it was a quarter of the server's CPU in the memory
 * burst after a restart.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { tasksByIdOf, treeAround } from '../../src/core/same-ask-tree.js'
import type { Task } from '../../src/core/types.js'

const t = (id: string, over: Partial<Task> = {}): Task => ({
  id, title: id, project: 'Juniper', phase: 'IN_PROGRESS', status: 'todo', created_at: `2026-11-01T00:00:${id.length}Z`, ...over,
} as Task)
const done = { phase: 'COMPLETE' as const, status: 'done' as const }

/** A board with finished tasks in every place a tree reaches: a leader, a child, a teammate, a lead. */
function board(): Task[] {
  return [
    t('lead', { org_role: 'lead', ...done }),
    t('top', done),
    t('node', { parent_task_id: 'top' }),
    t('kid', { parent_task_id: 'node', ...done }),
    t('grand', { parent_task_id: 'kid' }),
    t('sib', { parent_task_id: 'top', ...done }),
    t('sib2', { parent_task_id: 'top' }),
    t('side', { project: 'Juniper' }),
    t('other', { project: 'Maple' }),
    t('main', { org_role: 'main' }),
    t('vp', { org_role: 'lead', project: 'Juniper' }),
    t('vp-kid', { parent_task_id: 'vp', ...done }),
  ]
}

/** What withTaskAsks and resolveDecisionOwner did before: open copies for membership. */
const openCopies = (all: readonly Task[]) => all.map((x) => x.phase === 'COMPLETE' || x.status === 'done'
  ? { ...x, phase: 'NEED_ACTION' as const, status: 'todo' as const } : x)
const shape = (rows: ReturnType<typeof treeAround>) => rows.map((r) => `${r.task.id}:${r.relation}`).sort()

describe('allOpen reads the tree the open copies read', () => {
  const all = board()
  for (const id of all.map((x) => x.id)) {
    it(`the tree around ${id}`, () => {
      expect(shape(treeAround(id, all, { allOpen: true }))).toEqual(shape(treeAround(id, openCopies(all))))
    })
  }

  it('hands out the real rows, never a copy', () => {
    const all2 = board()
    for (const row of treeAround('node', all2, { allOpen: true })) expect(all2).toContain(row.task)
  })

  it('without allOpen a finished teammate is still left out', () => {
    const all2 = board()
    expect(shape(treeAround('node', all2))).not.toContain('sib:team')
    expect(shape(treeAround('node', all2, { allOpen: true }))).toContain('sib:team')
  })
})

describe('one index per task list', () => {
  it('a list that grew is indexed again', () => {
    const all = board()
    expect(shape(treeAround('node', all))).not.toContain('late:descendant')
    all.push(t('late', { parent_task_id: 'node' }))
    expect(shape(treeAround('node', all))).toContain('late:descendant')
    expect(tasksByIdOf(all).get('late')?.id).toBe('late')
  })

  it('both opennesses on one list keep their own teams', () => {
    const all = board()
    const open = shape(treeAround('node', all))
    const every = shape(treeAround('node', all, { allOpen: true }))
    expect(shape(treeAround('node', all))).toEqual(open)
    expect(every).not.toEqual(open)
  })
})

describe('one answer per tree on a list', () => {
  // 2026-11-24: nodeView asked the same trees again for every node in a pass; the whole org for Main.
  it('a second read of a tree hands back the same rows in a new array a caller may edit', () => {
    const all = board()
    const a = treeAround('main', all)
    const b = treeAround('main', all)
    expect(b).not.toBe(a)
    expect(b).toEqual(a)
    b.forEach((row, i) => expect(row).toBe(a[i]))
    expect(Object.isFrozen(a[0])).toBe(true)
    b.length = 0
    expect(treeAround('main', all)).toEqual(a)
  })

  it('each task and each openness keeps its own answer', () => {
    const all = board()
    expect(shape(treeAround('node', all))).not.toEqual(shape(treeAround('node', all, { allOpen: true })))
    expect(shape(treeAround('vp', all))).not.toEqual(shape(treeAround('node', all)))
  })
})

describe('no tree read is handed a fresh copy of the board', () => {
  // A copy per call defeats the shared index and is the garbage this replaced. Every member of the
  // class: a call of treeAround or teammatesIndex whose task list argument is built in the call.
  const SRC = path.resolve(__dirname, '../../src')
  const files: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts')) files.push(p)
    }
  }
  walk(SRC)

  it('scans the callers', () => {
    const callers = files.filter((f) => /\b(treeAround|teammatesIndex|resolveDecisionOwner)\(/.test(fs.readFileSync(f, 'utf8')))
    expect(callers.length).toBeGreaterThan(3)
  })

  /** Which argument of each tree read is the task list. */
  const LIST_ARG: Record<string, number> = { treeAround: 1, teammatesIndex: 0, relativeAsksIndex: 0, resolveDecisionOwner: 2, bindDecisionOwner: 2, bindDecisionOwnerNow: 2 }
  /** The top-level arguments of the call that opens at `from` (just past its parenthesis). */
  const argsAt = (src: string, from: number): string[] => {
    const out: string[] = []
    let depth = 0, cur = ''
    for (let i = from; i < src.length; i++) {
      const c = src[i]!
      if (depth === 0 && (c === ')' || c === ',')) { out.push(cur.trim()); cur = ''; if (c === ')') break; continue }
      if ('([{'.includes(c)) depth++
      if (')]}'.includes(c)) depth--
      cur += c
    }
    return out
  }

  it('the argument reader finds the list in nested calls', () => {
    const src = 'treeAround(f(x), [...m.values()], { allOpen: true })'
    expect(argsAt(src, src.indexOf('(') + 1)).toEqual(['f(x)', '[...m.values()]', '{ allOpen: true }'])
  })

  it('passes a list it already holds', () => {
    const bad: string[] = []
    const call = new RegExp(`\\b(${Object.keys(LIST_ARG).join('|')})\\(`, 'g')
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8')
      for (const m of src.matchAll(call)) {
        if (/function\s+$/.test(src.slice(Math.max(0, m.index! - 20), m.index))) continue
        const list = argsAt(src, m.index! + m[0].length)[LIST_ARG[m[1]!]!] ?? ''
        if (/^\[\.\.\.|\.map\(|\.filter\(|\.slice\(/.test(list)) bad.push(`${path.relative(SRC, f)}: ${m[1]}(..., ${list.slice(0, 60)})`)
      }
    }
    expect(bad, 'a tree read built its own copy of the task list: pass the list (allOpen for finished tasks)').toEqual([])
  })
})
