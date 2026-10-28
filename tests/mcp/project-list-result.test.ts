/**
 * project_list's result shape (src/ops/core.ts projectListResult). 2026-10-27: one full list was
 * ~40,000 characters on a real board, over an agent's tool-result limit, so the op answers compact
 * by default and gives the details on request. The HTTP route keeps the full rows (web, iOS).
 */
import { describe, it, expect } from 'vitest'
import { projectListResult } from '../../src/ops/core.js'

const summary = 'x'.repeat(2000)
const body = {
  projects: Array.from({ length: 64 }, (_, i) => ({
    name: `Project ${i}`, source: 'local', order_index: i, favorite: i === 3,
    metadata: { summary, default_cwd: `/work/p${i}`, summary_task_count: 30 },
    counts: { todo: i, active: 1, done: 2 },
    ...(i % 2 ? { lead: { id: `lead-${i}`, title: `VP ${i}` } } : {}),
  })),
  inbox: { counts: { todo: 4, active: 0, done: 9 } },
}

describe('project_list result', () => {
  it('is compact by default: name, counts, lead, favorite only, and says how to get more', () => {
    const out = projectListResult(body, {}) as { projects: Array<Record<string, unknown>>; inbox: unknown; detail: string }
    expect(out.projects).toHaveLength(64)
    expect(out.projects[1]).toEqual({ name: 'Project 1', counts: { todo: 1, active: 1, done: 2 }, lead: { id: 'lead-1', title: 'VP 1' } })
    expect(out.projects[3]).toMatchObject({ favorite: true })
    expect(out.projects[0]).not.toHaveProperty('metadata')
    expect(out.inbox).toEqual(body.inbox)
    expect(out.detail).toContain('{"detail":true}')
    // The real-board shape that overflowed: 64 projects with long summaries. Compact stays small.
    expect(JSON.stringify(out, null, 2).length).toBeLessThan(12_000)
    expect(JSON.stringify(body, null, 2).length).toBeGreaterThan(130_000)
  })

  it('one project by name, case-insensitive, in full; an unknown name lists the names', () => {
    expect(projectListResult(body, { name: 'project 5' })).toEqual({ project: body.projects[5] })
    expect(projectListResult(body, { name: 'Inbox' })).toEqual({ inbox: body.inbox })
    const miss = projectListResult(body, { name: 'Nope' }) as { project: null; error: string }
    expect(miss.project).toBeNull()
    expect(miss.error).toContain('No project named "Nope"')
    expect(miss.error).toContain('Project 63')
  })

  it('detail:true is the route\'s full answer, unchanged', () => {
    expect(projectListResult(body, { detail: true })).toBe(body)
    // A name wins over detail.
    expect(projectListResult(body, { detail: true, name: 'Project 2' })).toEqual({ project: body.projects[2] })
  })
})
